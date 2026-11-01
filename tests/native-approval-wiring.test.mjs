/**
 * Native-approval wiring through the composition root (protocol §12, §9.7).
 *
 * The host bridge (`lib/host/approval.js`) and the settlement rules are covered
 * elsewhere. This suite is about the seams that only exist in the assembled
 * plugin, and it drives them through the real entry points:
 *
 *   - `Supervisor._startSession` with a real `Session` and a fake in-process
 *     carrier, so the state transitions and the `session.authz` push travel the
 *     same route they do in production;
 *   - the real `ApprovalService` and `BridgeStore` (temp data root), so a claim
 *     writes and reads the same durable records;
 *   - the real `ctx.on('approval/request', …)` registration, replayed through a
 *     waterfall that reproduces Cordis' sequential-chain semantics.
 *
 * The properties under test are the ones a reconnect or a stale table could
 * silently break: a locally known session is *not* authorized; A's push makes
 * it claimable; a revocation bites immediately; a lost channel settles claims
 * `unavailable` (never as a timeout); and a claim only survives if its request
 * was durably written with the configured deadline.
 * @module dsh-plugin-astrbot-bridge/tests/native-approval-wiring
 */

import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { ApprovalOutcome, MessageName, SessionState } from '../lib/constants.js';
import { normaliseConfig, Supervisor } from '../lib/index.js';
import { BridgeError } from '../lib/errors.js';
import { Router } from '../lib/router.js';
import { Session, buildCaps } from '../lib/session.js';
import { BridgeStore } from '../lib/store.js';

/**
 * Build a logger stub that also records every event, so audit claims can be
 * asserted instead of inferred from side effects.
 * @returns {object} logger with an `events` list and self-returning `child`.
 */
function recordingLogger() {
  /** @type {object[]} */
  const events = [];
  const push = (level) => (event, fields) => events.push({ level, event, ...(fields ?? {}) });
  /** @type {object} */
  const logger = {
    info: push('info'),
    warn: push('warn'),
    failure: push('failure'),
    debug: push('debug'),
    error: push('error'),
    events,
    child() {
      return logger;
    },
  };
  return logger;
}

/**
 * An in-process carrier pair that delivers on a later tick.
 *
 * It implements the same surface the real carriers do, so the session layer
 * cannot tell the difference; `hooks` are retained so a test can inject the
 * carrier-level state facts (`degraded`, `stale`) the real carriers report.
 */
class FakePair {
  constructor() {
    this.a = new FakeCarrier(this, 'a');
    this.b = new FakeCarrier(this, 'b');
    this.a.peer = this.b;
    this.b.peer = this.a;
  }

  /**
   * Deliver one hop on a later tick.
   *
   * Delivery is fire-and-forget, exactly like a real carrier: a peer that is
   * already closing rejects its own send, and that refusal must stay confined to
   * the delivering side instead of escaping as a process-level rejection.
   * @param {Function} deliver - delivery action.
   * @returns {void}
   */
  hop(deliver) {
    setImmediate(() => {
      try {
        Promise.resolve(deliver()).catch(() => {});
      } catch {
        // A stopped peer cannot accept the frame; the sender already saw that.
      }
    });
  }
}

/** One side of {@link FakePair}. */
class FakeCarrier {
  constructor(pair, name) {
    this.pair = pair;
    this.name = name;
    this.peer = null;
    this.hooks = null;
    this.stopped = true;
    this.pendingPlain = null;
  }

  async start(_cfg, hooks) {
    this.hooks = hooks;
    this.stopped = false;
  }

  async stop() {
    this.stopped = true;
  }

  async sendEnvelope(envelope) {
    const peer = this.peer;
    this.pair.hop(() => {
      void peer.hooks.onEnvelope(structuredClone(envelope));
    });
  }

  async sendPlain(object) {
    const peer = this.peer;
    return new Promise((resolve) => {
      this.pendingPlain = resolve;
      this.pair.hop(() => {
        void peer.hooks.onPlain(structuredClone(object));
      });
      // A responder that is not up yet never answers. Real HTTP carriers surface
      // that as a failed request, so the fake must settle instead of hanging —
      // but generously, so the ordinary reply hop always wins.
      setTimeout(() => {
        if (this.pendingPlain === resolve) {
          this.pendingPlain = null;
          resolve(undefined);
        }
      }, 250).unref?.();
    });
  }

  respondPlain(object) {
    const peer = this.peer;
    this.pair.hop(() => {
      peer.pendingPlain?.(structuredClone(object));
    });
  }

  alive() {
    return !this.stopped;
  }
}

/**
 * Capabilities for the peer (A) side of the fake channel.
 * @returns {object} caps.
 */
function peerCaps() {
  return buildCaps({
    side: 'A',
    host: 'astrbot',
    version: '0.1.0',
    transports: ['webhook'],
    tls: false,
    rolesInitiate: true,
    rolesExecute: true,
    approvals: { business_decision: true, cross_end_submit: true, native_tool: false },
    attachments: {
      mime: ['image/gif', 'image/jpeg', 'image/png', 'image/webp'],
      max_bytes: 10485760,
      max_count: 4,
      max_total_bytes: 20971520,
      max_pixels: 100000000,
      max_dimension: 8192,
    },
  });
}

/**
 * Build one assembled supervisor with a real store and a stub host context.
 *
 * Only the host edges are stubbed (`ctx.approval`, `ctx.on`, `ctx.tools`, the
 * agent registry and the attachment adapter): every bridge-side object below
 * the composition root is the production implementation.
 * @param {object} [options] - fixture options.
 * @param {number} [options.approvalTimeoutSeconds] - configured approval timeout.
 * @param {boolean} [options.remoteNativeApproval] - local native-approval switch.
 * @returns {Promise<object>} fixture.
 */
async function makeFixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'bridge-wiring-'));
  const logger = recordingLogger();
  const store = new BridgeStore({ dataRoot: root, logger });
  await store.init();

  /** @type {{listener: Function, options: object}[]} */
  const approvalListeners = [];
  /** @type {string[]} */
  const tools = [];
  const ctx = {
    approval: {},
    on(name, listener, registerOptions) {
      if (name !== 'approval/request') return () => {};
      const entry = { listener, options: registerOptions };
      approvalListeners.push(entry);
      return () => {
        const index = approvalListeners.indexOf(entry);
        if (index >= 0) approvalListeners.splice(index, 1);
      };
    },
    tools: {
      register(tool) {
        tools.push(tool.name);
        return () => {};
      },
    },
  };

  const settings = normaliseConfig({
    approvalTimeoutSeconds: options.approvalTimeoutSeconds ?? 45,
    remoteNativeApproval: options.remoteNativeApproval ?? true,
  });
  // A local agent registry that knows `session-1` exists. That fact alone must
  // never authorize a claim: A's table is the authority.
  const agentHost = {
    listSessions: () => [{ session_id: 'session-1', state: 'idle' }],
    dispose: async () => {},
  };
  const supervisor = new Supervisor({
    ctx,
    settings,
    connection: {
      id: 'default',
      mode: 'listen',
      transport: 'webhook',
      transportFallback: [],
      tlsEnabled: false,
      pskId: 'default',
      pskSecret: 'correct horse battery staple',
    },
    store,
    agentHost,
    attachmentHost: {},
    logger,
  });

  /**
   * Register the peer-side answers `_publishRequest` expects.
   * @param {object[]} forwarded - receives every inbound `approval.request`.
   * @returns {Router} peer router.
   */
  const peerRouterFor = (forwarded) => {
    const router = new Router({ logger });
    router.register(MessageName.APPROVAL_REQUEST, 'req', async (params) => {
      forwarded.push(params);
      return { approval_id: params.approval_id, accepted: true };
    });
    return router;
  };

  /** @type {Session[]} */
  const peers = [];

  return {
    root,
    store,
    logger,
    events: logger.events,
    ctx,
    approvalListeners,
    tools,
    peers,
    settings,
    supervisor,
    /**
     * Connect one fresh peer + session pair through `_startSession`.
     * @param {object[]} forwarded - receives inbound approval requests.
     * @returns {Promise<{pair: FakePair, peer: Session}>} connected pair.
     */
    async connect(forwarded) {
      const pair = new FakePair();
      const conn = { id: 'default', pskId: 'default', pskSecret: 'correct horse battery staple' };
      const peerRouter = peerRouterFor(forwarded);
      const peer = new Session(
        {
          conn,
          side: 'A',
          role: 'initiator',
          transportName: 'webhook',
          caps: peerCaps(),
          heartbeatS: 30,
          handshakeTimeoutMs: 2000,
          logger,
        },
        pair.a,
        { onMessage: (message) => peerRouter.dispatch(message) },
      );
      peerRouter.setReplySink(async (message) => peer.sendMessage(message));
      peers.push(peer);
      const wired = supervisor._startSession(pair.b, 'webhook');
      const peerStarted = peer.start();
      await Promise.all([wired, peerStarted]);
      return { pair, peer };
    },
    /**
     * Replay one harness request through the registered waterfall, exactly the
     * way Cordis composes it: registration order, first listener outermost.
     * @param {object} request - harness approval request.
     * @param {Function} inner - the local answerer behind the bridge.
     * @returns {Promise<string>} the value the host would record.
     */
    waterfall(request, inner) {
      const callbacks = approvalListeners.map((entry) => entry.listener);
      const next = () => (callbacks.shift() ?? inner)(request, next);
      return next();
    },
    /**
     * Push one authoritative `session.authz` through the real router.
     * @param {object} params - pushed table.
     * @returns {Promise<void>} resolution after the push was handled.
     */
    async pushAuthz(params) {
      await supervisor.router.dispatch({
        k: 'evt',
        m: MessageName.SESSION_AUTHZ,
        id: randomUUID(),
        ts: new Date().toISOString(),
        params,
      });
    },
    /**
     * Deliver one `approval.decision` from the peer through the real router.
     * @param {string} approvalId - approval identity.
     * @returns {Promise<void>} resolution after the decision was handled.
     */
    async pushDecision(approvalId, overrides = {}) {
      const record = await store.getApproval(approvalId);
      await supervisor.router.dispatch({
        k: 'evt',
        m: MessageName.APPROVAL_DECISION,
        id: randomUUID(),
        ts: new Date().toISOString(),
        params: {
          approval_id: approvalId,
          task_id: null,
          outcome: ApprovalOutcome.ALLOWED_ONCE,
          actor: 'astrbot_admin:admin',
          actor_kind: 'human',
          channel: 'im',
          reason: null,
          decided_at: new Date().toISOString(),
          request_digest: record?.request_digest ?? null,
          ...overrides,
        },
      });
    },
  };
}

/**
 * Tear one fixture down: settle the supervisor first (so its claims are closed
 * while the channel still exists), then every fake peer, then the store.
 * @param {object} fixture - fixture from `makeFixture`.
 * @returns {Promise<void>} resolution after teardown.
 */
async function teardown(fixture) {
  await fixture.supervisor.stop();
  for (const peer of fixture.peers) {
    await peer.close('draining', 'test', { notifyPeer: false });
  }
  await fixture.store.close();
}

/**
 * Wait until one predicate holds, so the assertion never depends on how many
 * microtask hops a claim needs in this process.
 * @param {() => boolean} predicate - condition.
 * @param {string} label - failure label.
 * @returns {Promise<void>} resolution once it holds.
 */
async function until(predicate, label) {
  for (let i = 0; i < 400; i += 1) {
    if (predicate()) return;
    // A durable write is real file I/O, so the wait has to yield the event loop
    // to the poll phase, not just drain microtasks.
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail(`timed out waiting for ${label}`);
}

/**
 * A harness approval request for one session.
 * @param {string} [sessionId] - owning session.
 * @returns {object} request.
 */
function harnessRequest(sessionId = 'session-1') {
  return { agent: { session: { id: sessionId } }, toolName: 'bash', reason: 'run the test suite' };
}

/** One grant as A pushes it. */
function grant(sessionId = 'session-1') {
  return {
    session_id: sessionId,
    purpose: null,
    granted_by: 'human',
    granted_by_id: 'astrbot_admin:admin',
    expires_at: null,
    created_by_task: null,
  };
}

test('a locally known session that A never authorized is handed back', async () => {
  const fixture = await makeFixture();
  const forwarded = [];
  try {
    await fixture.connect(forwarded);
    let uiCalls = 0;
    const outcome = await fixture.waterfall(harnessRequest(), async () => {
      uiCalls += 1;
      return ApprovalOutcome.REJECTED;
    });
    assert.equal(outcome, ApprovalOutcome.REJECTED, 'the local answerer keeps the request');
    assert.equal(uiCalls, 1, 'an unauthorized session must reach the deployment answerer');
    assert.equal(forwarded.length, 0, 'nothing may be forwarded for an unauthorized session');
    assert.equal(fixture.supervisor.services.approvals._bridge.pending.size, 0);
  } finally {
    await teardown(fixture);
  }
});

test('A authorizing the session makes it claimable and the answer is the host outcome', async () => {
  const fixture = await makeFixture({ approvalTimeoutSeconds: 45 });
  const forwarded = [];
  try {
    await fixture.connect(forwarded);
    await fixture.pushAuthz({ version: 1, grants: [grant()], allow_agent_create: false, max_agent_sessions: 0 });

    let uiCalls = 0;
    const outcome = fixture.waterfall(harnessRequest(), async () => {
      uiCalls += 1;
      return ApprovalOutcome.REJECTED;
    });
    await until(() => forwarded.length === 1, 'the question to reach A');
    assert.equal(uiCalls, 0, 'a claimed request short-circuits the local answerer');
    assert.equal(forwarded[0].approval_type, 'native_tool');
    assert.equal(forwarded[0].session_id, 'session-1');

    const approvalId = forwarded[0].approval_id;
    const stored = await fixture.store.getApproval(approvalId);
    assert.ok(stored !== null, 'the request is persisted before it is announced');
    assert.equal(stored.decided, false);
    // The deadline comes from `approvalTimeoutSeconds`, not from the 15 s sweep:
    // the host record carries it and the bridge arms its own timer from it.
    const remaining = Date.parse(stored.expires_at) - Date.now();
    assert.ok(remaining > 40_000 && remaining <= 45_000, `deadline came from the config (${remaining} ms)`);
    assert.ok(remaining > 15_000, 'the deadline must not depend on the sweep interval');
    const approvals = fixture.supervisor.services.approvals;
    // `confirmClaim` arms the deadline only after the durable write is visible,
    // so wait for the timer instead of assuming it is already there.
    await until(
      () => approvals._bridge.pending.get(approvalId)?.timer !== null,
      'the host deadline to be armed',
    );
    const pending = approvals._bridge.pending.get(approvalId);
    assert.ok(pending !== undefined, 'the claim is pending host-side');
    assert.equal(pending.expires_at, stored.expires_at, 'the host timer uses the persisted deadline');

    await fixture.pushDecision(approvalId);
    assert.equal(await outcome, ApprovalOutcome.ALLOWED_ONCE, 'A’s human answer becomes the host outcome');
    const decided = await fixture.store.getApproval(approvalId);
    assert.equal(decided.decided, true);
    assert.equal(decided.decision.outcome, ApprovalOutcome.ALLOWED_ONCE);
  } finally {
    await teardown(fixture);
  }
});

test('a revocation takes effect on the next claim and a stale version cannot undo it', async () => {
  const fixture = await makeFixture();
  const forwarded = [];
  try {
    await fixture.connect(forwarded);
    await fixture.pushAuthz({ version: 1, grants: [grant()], allow_agent_create: false, max_agent_sessions: 0 });
    await fixture.pushAuthz({
      version: 2,
      grants: [],
      revoked: ['session-1'],
      allow_agent_create: false,
      max_agent_sessions: 0,
    });
    let uiCalls = 0;
    const delegated = await fixture.waterfall(harnessRequest(), async () => {
      uiCalls += 1;
      return ApprovalOutcome.REJECTED;
    });
    assert.equal(delegated, ApprovalOutcome.REJECTED, 'a revoked session is no longer claimable');
    assert.equal(uiCalls, 1);
    assert.equal(forwarded.length, 0);

    // A late, lower-version push must not resurrect the grant.
    await fixture.pushAuthz({ version: 1, grants: [grant()], allow_agent_create: false, max_agent_sessions: 0 });
    const snapshot = await fixture.store.authzSnapshot();
    assert.equal(snapshot.version, 2, 'versions stay monotonic');
    const stillDelegated = await fixture.waterfall(harnessRequest(), async () => {
      uiCalls += 1;
      return ApprovalOutcome.CANCELLED;
    });
    assert.equal(stillDelegated, ApprovalOutcome.CANCELLED, 'a stale table cannot re-authorize a session');
    assert.equal(uiCalls, 2);
    assert.equal(forwarded.length, 0);
  } finally {
    await teardown(fixture);
  }
});

test('losing the channel settles a claim unavailable at once and late answers have no effect', async () => {
  const fixture = await makeFixture();
  const forwarded = [];
  try {
    const { pair } = await fixture.connect(forwarded);
    await fixture.pushAuthz({ version: 1, grants: [grant()], allow_agent_create: false, max_agent_sessions: 0 });
    const outcome = fixture.waterfall(harnessRequest(), async () => ApprovalOutcome.REJECTED);
    await until(() => forwarded.length === 1, 'the question to reach A');
    const approvalId = forwarded[0].approval_id;

    // The carrier reports degradation while the claim is still open: that is a
    // real state transition of the session, not a manual settlement call.
    pair.b.hooks.onState('degraded');
    assert.equal(await outcome, ApprovalOutcome.UNAVAILABLE, 'a lost channel is unavailable, never a timeout');
    assert.equal(fixture.supervisor.services.approvals._bridge.pending.size, 0);

    await fixture.pushDecision(approvalId);
    const stored = await fixture.store.getApproval(approvalId);
    assert.equal(stored.decision.outcome, ApprovalOutcome.UNAVAILABLE, 'a late answer cannot change the outcome');
    const applied = await fixture.supervisor.services.approvals.onDecisionEvent({
      approval_id: approvalId,
      request_digest: stored.request_digest,
      outcome: ApprovalOutcome.ALLOWED_ONCE,
      actor: 'astrbot_admin:admin',
      actor_kind: 'human',
      channel: 'im',
    });
    assert.equal(applied.applied, false, 'the request was already settled');
    assert.equal(fixture.supervisor.services.approvals._canClaim(harnessRequest()), false, 'the binding is gone');
  } finally {
    await teardown(fixture);
  }
});

test('ready keeps a live claim while a new sid settles the previous one', async () => {
  const first = [];
  const fixture = await makeFixture();
  try {
    await fixture.connect(first);
    await fixture.pushAuthz({ version: 1, grants: [grant()], allow_agent_create: false, max_agent_sessions: 0 });
    const oldOutcome = fixture.waterfall(harnessRequest(), async () => ApprovalOutcome.REJECTED);
    await until(() => first.length === 1, 'the first claim to reach A');
    const oldId = first[0].approval_id;

    // Transient phases and a redundant `ready` must not touch a live claim.
    const session = fixture.supervisor.currentSession;
    fixture.supervisor._onSessionState(session, SessionState.CONNECTING);
    fixture.supervisor._onSessionState(session, SessionState.HANDSHAKING);
    fixture.supervisor._onSessionState(session, SessionState.READY);
    // Give any wrongly scheduled settlement a full turn to show up.
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(
      fixture.supervisor.services.approvals._bridge.pending.has(oldId),
      true,
      'a plain ready must not kill requests claimed under the current sid',
    );

    // A reconnect produces a new sid: the old handle is unreachable.
    const second = [];
    const { peer: secondPeer } = await fixture.connect(second);
    assert.equal(await oldOutcome, ApprovalOutcome.UNAVAILABLE, 'a new sid fails the previous claim');
    assert.ok(secondPeer.sid !== session.sid, 'the replacement really is a new sid');

    let uiCalls = 0;
    const fresh = fixture.waterfall(harnessRequest(), async () => {
      uiCalls += 1;
      return ApprovalOutcome.REJECTED;
    });
    await until(() => second.length === 1, 'the replacement session to claim');
    assert.equal(uiCalls, 0, 'the authorization cache survives the reconnect');
    await fixture.pushDecision(second[0].approval_id, { outcome: ApprovalOutcome.REJECTED });
    assert.equal(await fresh, ApprovalOutcome.REJECTED);
  } finally {
    await teardown(fixture);
  }
});

test('a store failure while publishing fails the claim closed', async () => {
  const fixture = await makeFixture();
  const forwarded = [];
  try {
    await fixture.connect(forwarded);
    await fixture.pushAuthz({ version: 1, grants: [grant()], allow_agent_create: false, max_agent_sessions: 0 });
    fixture.store.putApproval = async () => {
      throw new BridgeError('draining');
    };
    let uiCalls = 0;
    const outcome = await fixture.waterfall(harnessRequest(), async () => {
      uiCalls += 1;
      return ApprovalOutcome.ALLOWED_ONCE;
    });
    assert.equal(outcome, ApprovalOutcome.UNAVAILABLE, 'an unwritten request can never be answered');
    assert.equal(uiCalls, 0, 'a claimed request must not fall back into the chain');
    assert.equal(forwarded.length, 0, 'nothing reached A');
    assert.equal(fixture.supervisor.services.approvals._bridge.pending.size, 0);
  } finally {
    await teardown(fixture);
  }
});

test('native approval is never gated on the negotiated capability', async () => {
  const fixture = await makeFixture();
  const forwarded = [];
  try {
    const { peer } = await fixture.connect(forwarded);
    // Negotiation is a logical AND and A declares `native_tool: false`, so the
    // negotiated value is false even though this side claims it. That value must
    // not switch claiming off: the capability is a local configuration fact.
    const negotiated = fixture.supervisor.currentSession.negotiated();
    assert.equal(negotiated.approvals.nativeTool, false, 'A never declares native_tool');
    assert.equal(peer.peerCaps.approvals.native_tool, true, 'this side does declare the capability');
    await fixture.pushAuthz({ version: 1, grants: [grant()], allow_agent_create: false, max_agent_sessions: 0 });
    const outcome = fixture.waterfall(harnessRequest(), async () => ApprovalOutcome.REJECTED);
    await until(() => forwarded.length === 1, 'the claim to reach A');
    assert.equal(forwarded.length, 1, 'claiming must not depend on the negotiated AND');
    await fixture.pushDecision(forwarded[0].approval_id);
    assert.equal(await outcome, ApprovalOutcome.ALLOWED_ONCE);
  } finally {
    await teardown(fixture);
  }
});

test('the local switch turns claiming off without touching the peer table', async () => {
  const fixture = await makeFixture({ remoteNativeApproval: false });
  const forwarded = [];
  try {
    await fixture.connect(forwarded);
    await fixture.pushAuthz({ version: 1, grants: [grant()], allow_agent_create: false, max_agent_sessions: 0 });
    const outcome = await fixture.waterfall(harnessRequest(), async () => ApprovalOutcome.REJECTED);
    assert.equal(outcome, ApprovalOutcome.REJECTED);
    assert.equal(forwarded.length, 0);
  } finally {
    await teardown(fixture);
  }
});

test('a closed session and a repeated stop settle each claim exactly once', async () => {
  const fixture = await makeFixture();
  const forwarded = [];
  try {
    const { peer } = await fixture.connect(forwarded);
    await fixture.pushAuthz({ version: 1, grants: [grant()], allow_agent_create: false, max_agent_sessions: 0 });
    const outcome = fixture.waterfall(harnessRequest(), async () => ApprovalOutcome.REJECTED);
    await until(() => forwarded.length === 1, 'the question to reach A');
    const approvalId = forwarded[0].approval_id;

    // Closing the local session is the real path into `draining` → `closed`;
    // it is what a peer close, a stale carrier and supervisor shutdown all use.
    const local = fixture.supervisor.currentSession;
    const closing = local.close('draining', 'peer shutdown', { notifyPeer: false });
    await until(() => local.state === SessionState.CLOSED, 'the session to report closed');
    await closing;
    void peer;
    assert.equal(await outcome, ApprovalOutcome.UNAVAILABLE, 'a closed session cannot answer');
    const settledAfterClose = fixture.events.filter(
      (entry) => entry.event === 'approval_settled' && entry.approval === approvalId,
    );
    assert.equal(settledAfterClose.length, 1, 'a claim is settled exactly once');
    assert.equal(settledAfterClose[0].source, 'channel');

    // `stop()` (and therefore `dispose`) must not settle it a second time.
    await fixture.supervisor.stop();
    await fixture.supervisor.stop();
    const settledTotal = fixture.events.filter(
      (entry) => entry.event === 'approval_settled' && entry.approval === approvalId,
    );
    assert.equal(settledTotal.length, 1, 'disposal must not re-settle a closed claim');
    assert.equal(fixture.supervisor.services?.approvals?._bridge ?? null, null);
  } finally {
    await teardown(fixture);
  }
});

test('a disconnected state also fails the claim as unavailable', async () => {
  const fixture = await makeFixture();
  const forwarded = [];
  try {
    await fixture.connect(forwarded);
    await fixture.pushAuthz({ version: 1, grants: [grant()], allow_agent_create: false, max_agent_sessions: 0 });
    const outcome = fixture.waterfall(harnessRequest(), async () => ApprovalOutcome.REJECTED);
    await until(() => forwarded.length === 1, 'the question to reach A');
    // `draining` and `disconnected` are the two names the real session layer and
    // the carrier emit when the path is gone.
    fixture.supervisor._onSessionState(fixture.supervisor.currentSession, SessionState.DRAINING);
    assert.equal(await outcome, ApprovalOutcome.UNAVAILABLE);
    assert.equal(fixture.supervisor.services.approvals._canClaim(harnessRequest()), false);
  } finally {
    await teardown(fixture);
  }
});

test('restart recovery runs through the supervisor when the first session is ready', async () => {
  const fixture = await makeFixture();
  const forwarded = [];
  const runningId = '77777777-7777-4777-8777-777777777777';
  await fixture.store.putTask({
    task_id: runningId,
    root_task_id: runningId,
    direction: 'inbound',
    status: 'running',
    kind: 'dsh_agent_run',
    origin: 'llm',
    session_id: 'session-1',
    eseq: 3,
    needs_human: false,
    updated_at: new Date().toISOString(),
  });
  try {
    // `_startSession` is the production startup path: the first ready session
    // must reconcile the durable task table instead of leaving `running` forever.
    await fixture.connect(forwarded);
    const running = await fixture.store.getTask(runningId);
    assert.equal(running.status, 'needs_human');
    assert.equal(running.error.code, 'execution_unknown');
  } finally {
    await teardown(fixture);
  }
});

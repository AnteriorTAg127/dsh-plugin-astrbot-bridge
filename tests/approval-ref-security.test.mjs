/**
 * Security of the inbound `approval_ref` (§12.1, §12.5 steps 3-4).
 *
 * A reference the peer attaches to `task.submit` is supposed to be *evidence of
 * a human decision*. Two shapes of it carry no binding at all:
 *
 *   - an **empty** `approval_id`, which names no approval; and
 *   - an **unknown** `approval_id`, which names an approval this side has never
 *     recorded.
 *
 * In both cases the digest is self-computed by whoever composed the frame, so
 * the `submit_digest` check — the only content binding — is trivially satisfiable
 * by the submitter. If such a frame were accepted, the approval gate would be
 * bypassable by simply omitting or inventing the identifier, which is exactly
 * what §12.5 point 5 exists to prevent.
 *
 * The assertions run through the real `TaskService`/`BridgeStore` on a temp data
 * root; only the host delivery edge is a counting stub.
 * @module dsh-plugin-astrbot-bridge/tests/approval-ref-security
 */

import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ApprovalOutcome, MessageName, TaskStatus } from '../lib/constants.js';
import { BridgeError } from '../lib/errors.js';
import { normaliseConfig, Supervisor } from '../lib/index.js';
import { Router } from '../lib/router.js';
import { Session, buildCaps } from '../lib/session.js';
import { BridgeStore } from '../lib/store.js';

/** A logger that records every event instead of printing it. */
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

/** An in-process carrier pair that delivers on a later tick. */
class FakePair {
  constructor() {
    this.a = new FakeCarrier(this, 'a');
    this.b = new FakeCarrier(this, 'b');
    this.a.peer = this.b;
    this.b.peer = this.a;
  }

  /**
   * Deliver one hop on a later tick, like a real carrier.
   * @param {Function} deliver - delivery action.
   * @returns {void}
   */
  hop(deliver) {
    setImmediate(() => {
      try {
        Promise.resolve(deliver()).catch(() => {});
      } catch {
        // A stopped peer cannot accept a frame; its sender already saw that.
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

  /**
   * Deliver one handshake frame and resolve with the peer's inline answer.
   * @param {object} object - plain frame.
   * @returns {Promise<object|undefined>} the peer's inline answer.
   */
  async sendPlain(object) {
    const peer = this.peer;
    return new Promise((resolve) => {
      this.pendingPlain = resolve;
      this.pair.hop(() => {
        void peer.hooks.onPlain(structuredClone(object));
      });
      setTimeout(() => {
        if (this.pendingPlain === resolve) {
          this.pendingPlain = null;
          resolve(undefined);
        }
      }, 250).unref?.();
    });
  }

  /**
   * Answer the frame currently waiting on this carrier.
   * @param {object} object - answer frame.
   * @returns {void}
   */
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

/** Capabilities the peer (A side) advertises. */
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
 * Build one assembled supervisor with a real store and a counting host edge.
 * @returns {Promise<object>} fixture.
 */
async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'bridge-refsec-'));
  const logger = recordingLogger();
  const store = new BridgeStore({ dataRoot: root, logger });
  await store.init();

  /** @type {object[]} */
  const deliveries = [];
  const ctx = {
    approval: {},
    on() {
      return () => {};
    },
    tools: { register: () => () => {} },
  };
  const settings = normaliseConfig({ approvalTimeoutSeconds: 300 });
  const agentHost = {
    listSessions: () => [{ session_id: 'session-1', state: 'idle' }],
    async deliver(input) {
      deliveries.push(input);
      return { strategy: 'followup', session_id: input.sessionId, degraded: [] };
    },
    async waitIdle() {
      return true;
    },
    async dispose() {},
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

  /** @type {Session[]} */
  const peers = [];

  return {
    root,
    store,
    logger,
    events: logger.events,
    supervisor,
    peers,
    deliveries,
    /** @type {Session|null} */
    peer: null,
    /**
     * Connect one peer over a real session and router.
     * @returns {Promise<Session>} the connected peer session.
     */
    async connect() {
      const pair = new FakePair();
      const conn = { id: 'default', pskId: 'default', pskSecret: 'correct horse battery staple' };
      const peerRouter = new Router({ logger });
      peerRouter.register(MessageName.APPROVAL_REQUEST, 'req', async (params) => ({
        approval_id: params.approval_id,
        accepted: true,
      }));
      peerRouter.register(MessageName.TASK_STATUS, 'req', async (params) => ({
        task_id: params.task_id,
        status: 'running',
      }));
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
      this.peer = peer;
      const wired = supervisor._startSession(pair.b, 'webhook');
      await Promise.all([wired, peer.start()]);
      return peer;
    },
    /**
     * Push one authoritative `session.authz` through the real router.
     * @param {object[]} grants - grants as A pushes them.
     * @returns {Promise<void>} resolution after the push was handled.
     */
    async pushAuthz(grants) {
      await supervisor.router.dispatch({
        k: 'evt',
        m: MessageName.SESSION_AUTHZ,
        id: randomUUID(),
        ts: new Date().toISOString(),
        params: { version: Date.now(), grants },
      });
    },
  };
}

/**
 * Tear one fixture down, supervisor first so its claims close while the channel
 * still exists.
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

/** One grant as A pushes it. */
function grant() {
  return {
    session_id: 'session-1',
    purpose: null,
    granted_by: 'human',
    granted_by_id: 'astrbot_admin:admin',
    expires_at: null,
    created_by_task: null,
  };
}

/**
 * Wait until one task leaves `pending_approval`.
 * @param {object} store - bridge store.
 * @param {string} taskId - task identity.
 * @param {number} [timeoutMs] - maximum wait.
 * @returns {Promise<object>} the settled task.
 */
async function waitStatus(store, taskId, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  let task = await store.getTask(taskId);
  while (Date.now() < deadline) {
    task = await store.getTask(taskId);
    if (task !== null && task.status !== TaskStatus.PENDING_APPROVAL) return task;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return task;
}

/** A `task.submit` parameter set as the peer sends it. */
function submitParams(overrides = {}) {
  const taskId = overrides.task_id ?? randomUUID();
  return {
    task_id: taskId,
    root_task_id: taskId,
    kind: 'dsh_agent_run',
    origin: 'llm',
    input_parts: [{ type: 'text', text: 'run the build' }],
    attachments: [],
    tool_hints: [],
    session_id: 'session-1',
    purpose: null,
    timeout_s: 60,
    meta: {},
    approval_ref: null,
    ...overrides,
  };
}

/**
 * Submit one frame whose `approval_ref` carries a correct self-computed digest
 * but an identifier that binds to nothing.
 * @param {object} fixture - fixture.
 * @param {string} approvalId - the identifier to forge.
 * @returns {Promise<object>} what the submission did.
 */
async function attemptUnboundRef(fixture, approvalId) {
  const tasks = fixture.supervisor.services.tasks;
  const params = submitParams();
  const ref = {
    approval_id: approvalId,
    submit_digest: await tasks.submitDigestOf(params),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    actor_kind: 'human',
  };
  /** @type {object|null} */
  let result = null;
  /** @type {unknown} */
  let refusal = null;
  try {
    result = await tasks.submitInbound({ ...params, approval_ref: ref });
  } catch (error) {
    refusal = error;
  }
  return { params, ref, result, refusal, task: await fixture.store.getTask(params.task_id) };
}

/**
 * Assert a forged reference neither ran nor was accepted.
 *
 * Refusing loudly (a `BridgeError`) and holding the frame are both acceptable;
 * what is not acceptable is an execution, an `accepted` reply, or a task that
 * the store considers runnable.
 * @param {object} fixture - fixture.
 * @param {object} attempt - result of `attemptUnboundRef`.
 * @returns {Promise<void>} resolution once the assertion holds.
 */
async function assertNotExecuted(fixture, attempt) {
  // Give any detached execution path the same window the other gates use.
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(
    fixture.deliveries.length,
    0,
    'an unbound approval reference must never reach the host agent',
  );
  assert.notEqual(
    attempt.result?.status,
    'accepted',
    'a reference that binds to no approval must not be accepted',
  );
  const task = await fixture.store.getTask(attempt.params.task_id);
  assert.notEqual(task, null, 'the submission must still be durable');
  assert.notEqual(task.status, TaskStatus.ACCEPTED, 'the stored task must not be accepted');
  assert.notEqual(task.status, TaskStatus.SUCCEEDED, 'the stored task must not have run');
}

test('an empty approval_id with a self-computed digest is not accepted', async () => {
  const fixture = await makeFixture();
  try {
    await fixture.connect();
    await fixture.pushAuthz([grant()]);
    const attempt = await attemptUnboundRef(fixture, '');
    await assertNotExecuted(fixture, attempt);
  } finally {
    await teardown(fixture);
  }
});

test('an unknown approval_id with a self-computed digest is not accepted', async () => {
  const fixture = await makeFixture();
  try {
    await fixture.connect();
    await fixture.pushAuthz([grant()]);
    const attempt = await attemptUnboundRef(fixture, randomUUID());
    await assertNotExecuted(fixture, attempt);
  } finally {
    await teardown(fixture);
  }
});

test('a refused submission replayed under the same task id is refused again, never accepted', async () => {
  const fixture = await makeFixture();
  try {
    await fixture.connect();
    await fixture.pushAuthz([grant()]);
    const first = await attemptUnboundRef(fixture, randomUUID());
    await assertNotExecuted(fixture, first);
    assert.equal(first.result?.status, TaskStatus.PENDING_APPROVAL);
    const refusedTask = await waitStatus(fixture.store, first.params.task_id);
    assert.equal(refusedTask.status, TaskStatus.REJECTED);
    const refusal = { code: refusedTask.error?.code };
    assert.equal(refusal.code, 'approval_lookup_failed');

    // §10.1: the same `task_id` is an idempotent replay — but replaying a task
    // that was never admitted may not turn the refusal into an `accepted`
    // receipt. The durable error is answered again and nothing is dispatched.
    const tasks = fixture.supervisor.services.tasks;
    let replay = null;
    /** @type {unknown} */
    let replayRefusal = null;
    try {
      replay = await tasks.submitInbound({ ...first.params, approval_ref: first.ref });
    } catch (error) {
      replayRefusal = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.equal(replay, null, 'a refused task may not be re-announced with a status');
    assert.ok(replayRefusal instanceof BridgeError, 'the replay must answer with the persisted refusal');
    assert.equal(replayRefusal.code, refusal.code, 'the persisted error code is replayed unchanged');
    assert.equal(fixture.deliveries.length, 0, 'a replay must not dispatch the refused task');

    const task = await fixture.store.getTask(first.params.task_id);
    assert.equal(task.status, TaskStatus.REJECTED, 'the refusal stays durable, not pending');
    assert.equal(task.error?.code, refusal.code, 'the durable error survives the replay');
    assert.equal(task.attempts, 0, 'the task must never have been attempted');
    assert.ok(
      fixture.events
        .filter((event) => event.event === 'task_accepted')
        .every((event) => event.status === TaskStatus.PENDING_APPROVAL),
      'a held task is only ever logged as pending, never as accepted',
    );

    // The replay is answered from the task record alone: it never reaches the
    // reference check, so no approval row was created or spent by either try.
    const approval = await fixture.store.getApproval(first.ref.approval_id);
    assert.equal(approval, null, 'an unbound reference leaves no approval row behind');
  } finally {
    await teardown(fixture);
  }
});

/**
 * Open and approve one real cross-end gate for a submission.
 * @param {object} fixture - fixture.
 * @param {object} params - submission the gate approves.
 * @returns {Promise<string>} approval identity.
 */
async function approveGate(fixture, params) {
  const tasks = fixture.supervisor.services.tasks;
  const approvals = fixture.supervisor.services.approvals;
  const approval = await approvals.requestSubmitApproval({
    task: {
      task_id: params.task_id,
      root_task_id: params.root_task_id,
      session_id: params.session_id,
    },
    tool: params.kind,
    reason: 'cross-end task submission',
    submitDigest: await tasks.submitDigestOf(params),
  });
  const result = await approvals.decide(approval.approval_id, {
    outcome: ApprovalOutcome.ALLOWED_ONCE,
    actor: 'astrbot_admin:admin',
    actor_kind: 'human',
    channel: 'im',
  });
  assert.equal(result.applied, true, 'the human answer must settle the gate');
  return approval.approval_id;
}

/**
 * Build an `approval_ref` for one submission.
 * @param {object} tasks - task service (for the digest).
 * @param {string} approvalId - approval identity.
 * @param {object} params - submission parameters.
 * @returns {Promise<object>} reference.
 */
async function refFor(tasks, approvalId, params) {
  return {
    approval_id: approvalId,
    submit_digest: await tasks.submitDigestOf(params),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    actor_kind: 'human',
  };
}

test('an approval for T1 cannot authorize T2', async () => {
  const fixture = await makeFixture();
  try {
    await fixture.connect();
    await fixture.pushAuthz([grant()]);
    const tasks = fixture.supervisor.services.tasks;
    const owner = submitParams();
    const approvalId = await approveGate(fixture, owner);

    const other = submitParams();
    const submitted = await tasks.submitInbound({ ...other, approval_ref: await refFor(tasks, approvalId, other) });
    assert.equal(submitted.status, TaskStatus.PENDING_APPROVAL);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(fixture.deliveries.length, 0, 'a borrowed gate must run nothing');
    const refused = await waitStatus(fixture.store, other.task_id);
    assert.equal(refused.status, TaskStatus.REJECTED, 'the refusal is durable, never runnable');
    assert.equal(refused.attempts, 0);
  } finally {
    await teardown(fixture);
  }
});

test('the authoritative row expiry rejects a ref that claims a future', async () => {
  const fixture = await makeFixture();
  try {
    await fixture.connect();
    await fixture.pushAuthz([grant()]);
    const tasks = fixture.supervisor.services.tasks;
    const params = submitParams();
    const approvalId = await approveGate(fixture, params);
    const record = await fixture.store.getApproval(approvalId);
    await fixture.store.putApproval({
      ...record,
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });

    const submitted = await tasks.submitInbound({ ...params, approval_ref: await refFor(tasks, approvalId, params) });
    assert.equal(submitted.status, TaskStatus.PENDING_APPROVAL);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const refused = await waitStatus(fixture.store, params.task_id);
    assert.equal(refused.status, TaskStatus.REJECTED);
    // The expired row is this endpoint's own gate, so its deadline is local
    // knowledge: it is reported as `approval_expired`, never re-queried or
    // downgraded to a grant. A remote refusal would be `approval_lookup_failed`
    // (§12.7.5), but there is no remote authority for this id.
    assert.equal(refused.error?.code, 'approval_expired');
    assert.equal(fixture.deliveries.length, 0);
  } finally {
    await teardown(fixture);
  }
});

test('a new sid fails a pending gate and parks its task', async () => {
  const fixture = await makeFixture();
  try {
    await fixture.connect();
    await fixture.pushAuthz([grant()]);
    const tasks = fixture.supervisor.services.tasks;
    const params = submitParams();
    const result = await tasks.submitInbound(params);
    assert.equal(result.status, 'pending_approval');
    const task = await fixture.store.getTask(params.task_id);
    const approvalId = String(task.approval_id);

    await fixture.supervisor.services.approvals.onSessionReady('default', 'sid-new');
    await fixture.supervisor.services.approvals.whenGatesSettled();

    const approval = await fixture.store.getApproval(approvalId);
    assert.equal(approval.decided, true);
    assert.equal(approval.decision.outcome, ApprovalOutcome.UNAVAILABLE);
    const parked = await fixture.store.getTask(params.task_id);
    assert.equal(parked.status, TaskStatus.NEEDS_HUMAN, 'the held task must not stay pending');

    const later = submitParams();
    const laterResult = await tasks.submitInbound({ ...later, approval_ref: await refFor(tasks, approvalId, later) });
    assert.equal(laterResult.status, TaskStatus.PENDING_APPROVAL);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const laterTask = await waitStatus(fixture.store, later.task_id);
    assert.equal(laterTask.status, TaskStatus.REJECTED);
    assert.equal(fixture.deliveries.length, 0, 'an old gate may never run on a new sid');
  } finally {
    await teardown(fixture);
  }
});

test('a gate without a connection binding is not evidence', async () => {
  const fixture = await makeFixture();
  try {
    await fixture.connect();
    await fixture.pushAuthz([grant()]);
    const tasks = fixture.supervisor.services.tasks;
    const params = submitParams();
    const approvalId = await approveGate(fixture, params);
    const record = await fixture.store.getApproval(approvalId);
    await fixture.store.putApproval({ ...record, conn: null });

    const submitted = await tasks.submitInbound({ ...params, approval_ref: await refFor(tasks, approvalId, params) });
    assert.equal(submitted.status, TaskStatus.PENDING_APPROVAL);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const refused = await waitStatus(fixture.store, params.task_id);
    assert.equal(refused.status, TaskStatus.REJECTED);
    assert.ok(
      ['approval_evidence_missing', 'approval_lookup_failed', 'approval_mismatch'].includes(refused.error?.code),
      `unexpected refusal ${refused.error?.code}`,
    );
    assert.equal(fixture.deliveries.length, 0);
  } finally {
    await teardown(fixture);
  }
});

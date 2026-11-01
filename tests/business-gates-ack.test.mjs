/**
 * Business gates on the assembled bridge: notification acknowledgement and the
 * inbound approval gate (§11.1, §11.2, §12.5 point 5).
 *
 * Two defects motivated this suite, and both are asserted here through the real
 * entry points rather than through a mocked service:
 *
 *   1. **Acknowledgement must leave the process.** A `task.event` received from
 *      the peer is a notification *the peer owns*. §11.1 makes the receiver the
 *      one that sends `event.ack` back as a **request**, because only the
 *      producer can retire its own outbox row. Marking a local row delivered on
 *      a peer-generated `notify_id` addresses nothing, so the producer would
 *      redeliver until it parked a finished task in `needs_human`.
 *   2. **An LLM-originated submission without an `approval_ref` may not run.**
 *      §12.5 point 5 makes the receiving end hold it in `pending_approval` and
 *      ask a human through the real `ApprovalService`; a human `allowed-once`
 *      runs it exactly once, a rejection runs it zero times.
 *
 * Everything below the composition root is the production implementation: a
 * real `Supervisor`, real `Session`/`Router`, real `BridgeStore` on a temp data
 * root, real `TaskService`/`NotifyService`/`ApprovalService`, and a real
 * in-process carrier pair. Only the host edges (`ctx.*`, the agent registry and
 * `deliver`/`waitIdle`) are stubs, because they are the model and IM boundaries.
 * @module dsh-plugin-astrbot-bridge/tests/business-gates-ack
 */

import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ApprovalOutcome, ApprovalType, MessageName, TaskEvent, TaskStatus } from '../lib/constants.js';
import { normaliseConfig, Supervisor } from '../lib/index.js';
import { BridgeError } from '../lib/errors.js';
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

/**
 * An in-process carrier pair that delivers on a later tick.
 *
 * It implements the surface the real carriers do, so the session layer cannot
 * tell the difference and the frames still travel the production path
 * (`Session` → `Router` → handler).
 */
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
   *
   * The four-step handshake carries `hello`/`hello_ack` out of band, so the
   * carrier must be able to return the ack on the same call; a responder that is
   * not up yet settles with `undefined` instead of hanging.
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
 * Build one assembled supervisor with a real store and stub host edges.
 * @param {object} [options] - fixture options.
 * @param {number} [options.approvalTimeoutSeconds] - approval deadline.
 * @returns {Promise<object>} fixture.
 */
async function makeFixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'bridge-gates-'));
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
  const settings = normaliseConfig({
    approvalTimeoutSeconds: options.approvalTimeoutSeconds ?? 300,
  });
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
  /** @type {object[]} */
  const forwardedApprovals = [];
  /** @type {object[]} */
  const acks = [];

  return {
    root,
    store,
    logger,
    events: logger.events,
    settings,
    supervisor,
    peers,
    deliveries,
    forwardedApprovals,
    acks,
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
      // The peer side answers exactly the requests the bridge sends it: an
      // approval question, an acknowledgement and a status refresh. Recording
      // them is how "the ack left the process" is proven instead of inferred.
      peerRouter.register(MessageName.APPROVAL_REQUEST, 'req', async (params) => {
        forwardedApprovals.push(params);
        return { approval_id: params.approval_id, accepted: true };
      });
      peerRouter.register(MessageName.EVENT_ACK, 'req', async (params) => {
        acks.push(params);
        return { notify_id: params.notify_id, delivered: true };
      });
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
    /**
     * Deliver one peer `approval.decision` through the real router.
     * @param {string} approvalId - approval identity.
     * @param {string} outcome - decided outcome.
     * @returns {Promise<void>} resolution after the decision was handled.
     */
    async pushDecision(approvalId, outcome) {
      const record = await store.getApproval(approvalId);
      await supervisor.router.dispatch({
        k: 'evt',
        m: MessageName.APPROVAL_DECISION,
        id: randomUUID(),
        ts: new Date().toISOString(),
        params: {
          approval_id: approvalId,
          task_id: record?.task_id ?? null,
          outcome,
          actor: 'astrbot_admin:admin',
          actor_kind: 'human',
          channel: 'im',
          reason: null,
          decided_at: new Date().toISOString(),
          request_digest: record?.request_digest ?? null,
        },
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

/**
 * Wait until a predicate holds, yielding to the poll phase so real file I/O can
 * complete.
 * @param {() => boolean} predicate - condition.
 * @param {string} label - failure label.
 * @returns {Promise<void>} resolution once it holds.
 */
async function until(predicate, label) {
  for (let i = 0; i < 500; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail(`timed out waiting for ${label}`);
}

/**
 * Wait until one persisted task reaches an expected status.
 *
 * Settlement is a durable write on a detached path, so the assertion waits for
 * the real condition instead of a fixed delay and reports what it saw.
 * @param {object} fixture - fixture.
 * @param {string} taskId - task identity.
 * @param {string} expected - expected status.
 * @returns {Promise<object>} the settled task.
 */
async function waitForStatus(fixture, taskId, expected) {
  let task = null;
  for (let i = 0; i < 500; i += 1) {
    task = await fixture.store.getTask(taskId);
    if (task?.status === expected) return task;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail(`task ${taskId} settled as ${task?.status}, expected ${expected}`);
  return task;
}

/**
 * Seed one outbound task, i.e. work this side sent to the peer.
 * @param {object} store - bridge store.
 * @param {string} [taskId] - task identity.
 * @returns {Promise<string>} the task identity.
 */
async function seedOutboundTask(store, taskId = randomUUID()) {
  const at = new Date().toISOString();
  await store.putTask({
    task_id: taskId,
    root_task_id: taskId,
    kind: 'astr_agent_run',
    origin: 'human',
    direction: 'outbound',
    status: TaskStatus.ACCEPTED,
    session_id: 'session-1',
    purpose: null,
    timeout_s: 60,
    input_parts: [{ type: 'text', text: 'do the thing' }],
    attachments: [],
    tool_hints: [],
    meta: {},
    approval_ref: null,
    eseq: 0,
    attempts: 1,
    needs_human: false,
    result: null,
    error: null,
    created_at: at,
    updated_at: at,
  });
  return taskId;
}

/** One grant as A pushes it. */
function grant(sessionId = 'session-1', grantedBy = 'human') {
  return {
    session_id: sessionId,
    purpose: null,
    granted_by: grantedBy,
    granted_by_id: 'astrbot_admin:admin',
    expires_at: null,
    created_by_task: null,
  };
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
 * Deliver one `task.event` over the wire, as the producer does.
 * @param {object} fixture - fixture.
 * @param {string} taskId - owning task.
 * @param {object} [overrides] - event overrides.
 * @returns {Promise<object>} the event parameters.
 */
async function produceEvent(fixture, taskId, overrides = {}) {
  const params = {
    task_id: taskId,
    root_task_id: taskId,
    eseq: 1,
    event: TaskEvent.COMPLETED,
    status: TaskStatus.SUCCEEDED,
    notify_id: randomUUID(),
    result: { summary: 'done', text: 'built', attachments: [], tool_audit: [], degraded: [] },
    error: null,
    decision: null,
    approval: null,
    ...overrides,
  };
  await fixture.peer.emit(MessageName.TASK_EVENT, params);
  return params;
}

test('a received notification is acknowledged to its producer over the wire', async () => {
  const fixture = await makeFixture();
  try {
    await fixture.connect();
    const taskId = await seedOutboundTask(fixture.store);
    const event = await produceEvent(fixture, taskId);

    await until(() => fixture.acks.length >= 1, 'the event.ack request');
    const ack = fixture.acks[0];
    assert.equal(ack.notify_id, event.notify_id, 'the ack names the notification it retires');
    assert.equal(ack.task_id, taskId);
    assert.equal(ack.root_task_id, taskId);
    assert.equal(ack.outcome, 'processed');
    // The defect was a *local* bookkeeping call: a bare `notify_id` row in this
    // side's own `notifies` table is exactly what that would leave behind.
    assert.equal(
      await fixture.store.get('notifies', event.notify_id),
      null,
      'acknowledging must not write a local outbox row for a peer notification',
    );
    const task = await fixture.store.getTask(taskId);
    assert.equal(task.status, TaskStatus.SUCCEEDED);
  } finally {
    await teardown(fixture);
  }
});

test('a redelivered notification is acknowledged again without a second wake', async () => {
  const fixture = await makeFixture();
  try {
    await fixture.connect();
    // A wake is delivered into a session the peer authorized, so the duplicate
    // case needs a live grant; otherwise the wake is suppressed and "not woken
    // twice" would hold for the wrong reason.
    await fixture.pushAuthz([grant()]);
    const taskId = await seedOutboundTask(fixture.store);
    const event = await produceEvent(fixture, taskId);
    await until(() => fixture.acks.length >= 1, 'the first ack');
    await until(() => fixture.deliveries.length >= 1, 'the wake');

    // The producer retries because the ack was slow: same `notify_id`, same
    // `eseq`. It must be answered (or the producer retries forever) but must not
    // wake the session a second time.
    await fixture.peer.emit(MessageName.TASK_EVENT, event);
    await until(() => fixture.acks.length >= 2, 'the duplicate ack');

    assert.deepEqual(
      fixture.acks.map((ack) => ack.outcome),
      ['processed', 'duplicate'],
    );
    assert.equal(fixture.deliveries.length, 1, 'a replayed event must not re-wake the session');
    const task = await fixture.store.getTask(taskId);
    assert.equal(task.eseq, 1, 'the replay must not advance the event sequence');
  } finally {
    await teardown(fixture);
  }
});

test('an event for an unknown task is still acknowledged, as rejected', async () => {
  const fixture = await makeFixture();
  try {
    await fixture.connect();
    const event = await produceEvent(fixture, randomUUID());

    await until(() => fixture.acks.length >= 1, 'the rejection ack');
    assert.equal(fixture.acks[0].outcome, 'rejected', 'the producer must learn it is not owed a retry');
    assert.equal(fixture.acks[0].notify_id, event.notify_id);
  } finally {
    await teardown(fixture);
  }
});

test('an inbound event.ack still retires this side\'s own notification', async () => {
  const fixture = await makeFixture();
  try {
    await fixture.connect();
    const taskId = await seedOutboundTask(fixture.store);
    const notifyId = await fixture.supervisor.services.tasks._emit(
      taskId,
      TaskEvent.PROGRESS,
      TaskStatus.ACCEPTED,
    );

    // The peer acknowledges our notification: this is the direction that must
    // keep its local `markDelivered` semantics (§11.1).
    const reply = await fixture.peer.call(MessageName.EVENT_ACK, {
      notify_id: notifyId,
      task_id: taskId,
      root_task_id: taskId,
      outcome: 'processed',
    });
    assert.equal(reply.delivered, true);
    const record = await fixture.store.get('notifies', notifyId);
    assert.equal(record.delivered, true, 'our own outbox row is the one that gets retired');
  } finally {
    await teardown(fixture);
  }
});

test('an LLM submission without an approval reference is held, not executed', async () => {
  const fixture = await makeFixture();
  try {
    await fixture.connect();
    await fixture.pushAuthz([grant()]);
    const params = submitParams();

    const result = await fixture.supervisor.services.tasks.submitInbound(params);
    assert.equal(result.status, 'pending_approval');
    assert.equal(fixture.deliveries.length, 0, 'nothing may execute before a human answered');

    const task = await fixture.store.getTask(params.task_id);
    assert.equal(task.status, TaskStatus.PENDING_APPROVAL);
    const approvalId = String(task.approval_id ?? '');
    assert.notEqual(approvalId, '', 'the held task names the approval that gates it');
    const approval = await fixture.store.getApproval(approvalId);
    assert.equal(approval.approval_type, ApprovalType.CROSS_END_SUBMIT);
    assert.equal(approval.decided, false);
    assert.equal(approval.task_id, params.task_id);
    assert.equal(fixture.forwardedApprovals.length, 1, 'the question must reach the peer\'s human');
    assert.equal(fixture.forwardedApprovals[0].approval_id, approvalId);
  } finally {
    await teardown(fixture);
  }
});

test('a human allow releases a held submission exactly once', async () => {
  const fixture = await makeFixture();
  try {
    await fixture.connect();
    await fixture.pushAuthz([grant()]);
    const params = submitParams();
    await fixture.supervisor.services.tasks.submitInbound(params);
    const task = await fixture.store.getTask(params.task_id);

    await fixture.pushDecision(task.approval_id, ApprovalOutcome.ALLOWED_ONCE);
    await until(() => fixture.deliveries.length >= 1, 'the released execution');
    const settled = await waitForStatus(fixture, params.task_id, TaskStatus.SUCCEEDED);
    assert.equal(settled.status, TaskStatus.SUCCEEDED, 'the released task ran to completion');
    assert.equal(fixture.deliveries.length, 1, 'a human decision releases one execution');

    // A second answer to the same approval changes nothing (§12.4).
    await fixture.pushDecision(task.approval_id, ApprovalOutcome.ALLOWED_ONCE);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(fixture.deliveries.length, 1, 'a second decision must not start a second run');
    assert.equal((await fixture.store.getTask(params.task_id)).status, TaskStatus.SUCCEEDED);
  } finally {
    await teardown(fixture);
  }
});

test('a human reject never executes the held submission', async () => {
  const fixture = await makeFixture();
  try {
    await fixture.connect();
    await fixture.pushAuthz([grant()]);
    const params = submitParams();
    await fixture.supervisor.services.tasks.submitInbound(params);
    const task = await fixture.store.getTask(params.task_id);

    await fixture.pushDecision(task.approval_id, ApprovalOutcome.REJECTED);
    const settled = await waitForStatus(fixture, params.task_id, TaskStatus.REJECTED);
    assert.equal(settled.status, TaskStatus.REJECTED);
    assert.equal(fixture.deliveries.length, 0, 'a rejection runs nothing');
    const approval = await fixture.store.getApproval(task.approval_id);
    assert.equal(approval.decision.outcome, ApprovalOutcome.REJECTED);
  } finally {
    await teardown(fixture);
  }
});

test('a submission approval reference is bound to its digest and spent once', async () => {
  const fixture = await makeFixture();
  try {
    await fixture.connect();
    await fixture.pushAuthz([grant()]);
    const tasks = fixture.supervisor.services.tasks;

    // Wrong digest: the reference cannot authorize content it never approved.
    const mismatched = submitParams();
    await assert.rejects(
      tasks.submitInbound({ ...mismatched, approval_ref: { approval_id: 'a1', submit_digest: 'nope', expires_at: new Date(Date.now() + 60_000).toISOString(), actor_kind: 'human' } }),
      (error) => error instanceof BridgeError && error.code === 'approval_digest_mismatch',
    );

    // An agent may never answer for a human (§12.3).
    const agentAttempt = submitParams();
    await assert.rejects(
      tasks.submitInbound({
        ...agentAttempt,
        approval_ref: {
          approval_id: 'a2',
          submit_digest: await tasks.submitDigestOf(agentAttempt),
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          actor_kind: 'agent',
        },
      }),
      (error) => error instanceof BridgeError && error.code === 'agent_cannot_approve',
    );

    // A human-allowed approval is single use: the first submission consumes it.
    const first = submitParams();
    const approvals = fixture.supervisor.services.approvals;
    const approval = await approvals.requestSubmitApproval({
      task: {
        task_id: first.task_id,
        root_task_id: first.task_id,
        session_id: first.session_id,
      },
      tool: first.kind,
      reason: 'cross-end task submission',
      submitDigest: await tasks.submitDigestOf(first),
    });
    await fixture.pushDecision(approval.approval_id, ApprovalOutcome.ALLOWED_ONCE);
    const decided = await fixture.store.getApproval(approval.approval_id);
    assert.equal(decided.decided, true);
    assert.equal(decided.submit_digest, await tasks.submitDigestOf(first));
    const refFor = async (params) => ({
      approval_id: approval.approval_id,
      submit_digest: await tasks.submitDigestOf(params),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      actor_kind: 'human',
    });
    const firstRef = await refFor(first);
    const held = await tasks.submitInbound({ ...first, approval_ref: firstRef });
    // The reply is immediate and honest: the task is held until the evidence is
    // proven, then accepted and dispatched exactly once.
    assert.equal(held.status, 'pending_approval');
    const accepted = await waitForStatus(fixture, first.task_id, TaskStatus.ACCEPTED);
    assert.equal(accepted.status, TaskStatus.ACCEPTED, 'an approved submission runs after verification');
    const deadline = Date.now() + 2000;
    while (fixture.deliveries.length < 1 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(fixture.deliveries.length, 1, 'exactly one execution');
    const consumed = await fixture.store.getApproval(approval.approval_id);
    assert.equal(consumed.consumed_by_task, first.task_id);

    const second = submitParams();
    const secondResult = await tasks.submitInbound({ ...second, approval_ref: await refFor(second) });
    assert.equal(secondResult.status, 'pending_approval');
    const refused = await waitForStatus(fixture, second.task_id, TaskStatus.REJECTED);
    assert.equal(refused.status, TaskStatus.REJECTED);
    assert.ok(
      [
        'approval_digest_mismatch',
        'approval_already_decided',
        'approval_mismatch',
        'approval_lookup_failed',
      ].includes(refused.error?.code),
      `unexpected refusal ${refused.error?.code}`,
    );
    assert.equal(fixture.deliveries.length, 1, 'the same gate is never spent twice');
  } finally {
    await teardown(fixture);
  }
});

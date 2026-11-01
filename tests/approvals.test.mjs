/**
 * Approval tests (protocol §12).
 *
 * The point of this suite is the *negative* space: nothing may approve, expire
 * into approval, or let an agent answer. Those properties are asserted directly,
 * because they are the ones a refactor can silently break.
 * @module dsh-plugin-astrbot-bridge/tests/approvals
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ApprovalService, normaliseApprovalOutcome } from '../lib/app/approvals.js';
import { BridgeError } from '../lib/errors.js';
import {
  attachApprovalBridge,
  createApprovalBridge,
  isGrant,
  normaliseOutcome,
} from '../lib/host/approval.js';
import { BridgeStore } from '../lib/store.js';

/**
 * Build an approval service fixture.
 * @param {object} [options] - fixture options.
 * @returns {Promise<object>} fixture.
 */
async function makeService(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'bridge-approvals-'));
  const store = new BridgeStore({ dataRoot: root });
  await store.init();
  const emitted = [];
  const calls = [];
  const session = {
    async emit(m, params) {
      emitted.push({ m, params });
    },
    async call(m, params) {
      calls.push({ m, params });
      if (options.requestFails === true) throw new BridgeError('timeout');
      return { approval_id: params.approval_id, accepted: true };
    },
  };
  let now = options.now ?? Date.now();
  /** @type {object[]} */
  const notifyEvents = [];
  const service = new ApprovalService({
    store,
    session,
    host: {},
    notify: {
      async emit(input) {
        notifyEvents.push(input);
        return String(input.task_id ?? '');
      },
    },
    config: { approvalTimeoutSeconds: 1800 },
    logger: null,
    now: () => now,
  });
  return {
    root,
    store,
    session,
    service,
    emitted,
    notifyEvents,
    calls,
    advance(ms) {
      now += ms;
    },
  };
}

/**
 * Build one inbound approval request.
 * @param {object} [overrides] - parameter overrides.
 * @returns {object} parameters.
 */
function approvalParams(overrides = {}) {
  return {
    approval_id: '55555555-5555-4555-8555-555555555555',
    approval_type: 'native_tool',
    task_id: null,
    root_task_id: null,
    session_id: null,
    tool: 'bash',
    reason: 'run the test suite',
    display_reason: { en: 'Run a shell command' },
    call_id: 'call-1',
    expires_at: new Date(Date.now() + 1800_000).toISOString(),
    notify_id: 'n-approval',
    origin_side: 'A',
    ...overrides,
  };
}

test('an approval request is queued and acknowledged without deciding', async () => {
  const { service, store } = await makeService();
  const result = await service.handleRequest(approvalParams());
  assert.equal(result.accepted, true);
  const record = await store.getApproval(approvalParams().approval_id);
  assert.equal(record.decided, false, 'queueing is not deciding');
  assert.equal(record.decision, null);
  await store.close();
});

test('a duplicate approval request is idempotent', async () => {
  const { service, store } = await makeService();
  await service.handleRequest(approvalParams());
  const second = await service.handleRequest(approvalParams());
  assert.equal(second.dedup, true);
  await store.close();
});

test('only the first decision applies and later answers are refused', async () => {
  const { service, store } = await makeService();
  await service.handleRequest(approvalParams());
  const first = await service.decide(approvalParams().approval_id, {
    outcome: 'allowed-once',
    actor: 'admin',
    actor_kind: 'human',
    channel: 'web',
  });
  assert.equal(first.applied, true);
  const second = await service.decide(approvalParams().approval_id, {
    outcome: 'rejected',
    actor: 'other-admin',
    actor_kind: 'human',
    channel: 'im',
  });
  assert.equal(second.applied, false);
  assert.equal(second.reason, 'already_answered');
  const record = await store.getApproval(approvalParams().approval_id);
  assert.equal(record.decision.outcome, 'allowed-once', 'the first answer wins');
  await store.close();
});

test('an agent can never answer an approval', async () => {
  const { service, store } = await makeService();
  await service.handleRequest(approvalParams());
  await assert.rejects(
    service.decide(approvalParams().approval_id, {
      outcome: 'allowed-once',
      actor: 'agent',
      actor_kind: 'agent',
      channel: 'web',
    }),
    (error) => error instanceof BridgeError && error.code === 'agent_cannot_approve',
  );
  assert.equal((await store.getApproval(approvalParams().approval_id)).decided, false);
  await store.close();
});

test('an inbound decision from an agent is rejected', async () => {
  const { service, store } = await makeService();
  await service.handleRequest(approvalParams());
  const record = await store.getApproval(approvalParams().approval_id);
  await assert.rejects(
    service.onDecisionEvent({
      approval_id: record.approval_id,
      outcome: 'allowed-once',
      actor: 'agent',
      actor_kind: 'agent',
      request_digest: record.request_digest,
    }),
    (error) => error instanceof BridgeError && error.code === 'agent_cannot_approve',
  );
  await store.close();
});

test('an expiry settles as rejected with the timeout channel', async () => {
  const fixture = await makeService();
  const { service, store, advance } = fixture;
  await service.handleRequest(approvalParams());
  advance(1802_000);
  const expired = await service.timeoutLoop();
  assert.equal(expired, 1);
  const record = await store.getApproval(approvalParams().approval_id);
  assert.equal(record.decided, true);
  assert.equal(record.decision.outcome, 'rejected', 'timeout is a rejection, never an approval');
  assert.equal(record.decision.channel, 'timeout');
  await store.close();
});

test('a timed-out approval emits task.event and never impersonates a human', async () => {
  const fixture = await makeService();
  const { service, store, advance, emitted, notifyEvents } = fixture;
  await store.putTask({
    task_id: 't-approval',
    root_task_id: 't-approval',
    status: 'pending_approval',
    direction: 'inbound',
    eseq: 0,
    updated_at: new Date().toISOString(),
  });
  await service.handleRequest(approvalParams({ task_id: 't-approval' }));
  // `expires_at` is built from the real clock, so advance clearly past it
  // rather than racing the millisecond boundary.
  advance(1802_000);
  await service.timeoutLoop();

  // A timeout is a system terminal event, never a fabricated human decision.
  assert.equal(emitted.some((entry) => entry.m === 'approval.decision'), false);
  const record = await store.getApproval(approvalParams().approval_id);
  assert.equal(record.decision.actor_kind, 'system');
  assert.equal(record.decision.channel, 'timeout');

  // The held task leaves `pending_approval` through the durable event channel.
  const task = await store.getTask('t-approval');
  assert.equal(task.status, 'needs_human');
  assert.equal(task.needs_human, true);
  assert.ok(
    notifyEvents.some(
      (entry) => entry.task_id === 't-approval' && entry.event === 'needs_human' && entry.status === 'needs_human',
    ),
    'the peer must receive a durable task.event, not a fake decision',
  );
  await store.close();
});

test('an approval digest mismatch is refused', async () => {
  const { service, store } = await makeService();
  await assert.rejects(
    service.handleRequest(approvalParams({ request_digest: 'wrong-digest' })),
    (error) => error instanceof BridgeError && error.code === 'approval_mismatch',
  );
  await store.close();
});

test('a decision with a mismatched digest is refused', async () => {
  const { service, store } = await makeService();
  await service.handleRequest(approvalParams());
  await assert.rejects(
    service.onDecisionEvent({
      approval_id: approvalParams().approval_id,
      outcome: 'allowed-once',
      actor: 'admin',
      actor_kind: 'human',
      request_digest: 'not-the-digest',
    }),
    (error) => error instanceof BridgeError && error.code === 'approval_mismatch',
  );
  await store.close();
});

test('an already-expired request is refused at intake', async () => {
  const { service, store } = await makeService();
  await assert.rejects(
    service.handleRequest(approvalParams({ expires_at: new Date(Date.now() - 1000).toISOString() })),
    (error) => error instanceof BridgeError && error.code === 'approval_expired',
  );
  await store.close();
});

test('a non-finite deadline is expired, never granted', async () => {
  const { service, store } = await makeService();
  const request = approvalParams();
  await service.handleRequest(request);
  const stored = await store.getApproval(request.approval_id);
  await store.putApproval({ ...stored, expires_at: 'not-a-date' });
  await assert.rejects(
    service.decide(request.approval_id, {
      outcome: 'allowed-once',
      actor: 'admin',
      actor_kind: 'human',
      channel: 'web',
    }),
    (error) => error instanceof BridgeError && error.code === 'approval_expired',
  );
  assert.equal((await store.getApproval(request.approval_id)).decided, false);
  await store.close();
});

test('a malformed intake deadline is refused instead of queued', async () => {
  const { service, store } = await makeService();
  await assert.rejects(
    service.handleRequest(approvalParams({ expires_at: 'not-a-date' })),
    (error) => error instanceof BridgeError && error.code === 'approval_expired',
  );
  await store.close();
});

test('the authenticated peer side, not the payload, is recorded as origin', async () => {
  const { service, store, session } = await makeService();
  session.peerCaps = { side: 'A' };
  const request = approvalParams({ origin_side: 'B' });
  await service.handleRequest(request);
  const stored = await store.getApproval(request.approval_id);
  assert.equal(stored.origin_side, 'A');
  await store.close();
});

test('startup recovery parks a held task whose gate can no longer settle', async () => {
  const { service, store, notifyEvents } = await makeService();
  const taskId = '77777777-7777-4777-8777-777777777777';
  await store.putTask({
    task_id: taskId,
    root_task_id: taskId,
    direction: 'inbound',
    status: 'pending_approval',
    eseq: 0,
    needs_human: false,
    updated_at: new Date().toISOString(),
  });
  await store.putApproval({
    approval_id: 'recover-ap',
    approval_type: 'cross_end_submit',
    task_id: taskId,
    source: 'local',
    conn: 'default|old-sid',
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    decided: true,
    decision: {
      outcome: 'rejected',
      actor: 'admin',
      actor_kind: 'human',
      channel: 'web',
      decided_at: new Date().toISOString(),
    },
  });
  service.onSessionReady('default', '22222222-2222-4222-8222-222222222222');
  await service.whenGatesSettled();
  const parked = await store.getTask(taskId);
  assert.equal(parked.status, 'needs_human');
  assert.equal(parked.needs_human, true);
  assert.ok(notifyEvents.some((event) => event.event === 'needs_human'));
  await store.close();
});

test('deciding an unknown approval is refused', async () => {
  const { service, store } = await makeService();
  await assert.rejects(
    service.decide('unknown-approval', {
      outcome: 'allowed-once',
      actor: 'admin',
      actor_kind: 'human',
      channel: 'web',
    }),
    (error) => error instanceof BridgeError && error.code === 'approval_mismatch',
  );
  await store.close();
});

test('an unsupported approval type is refused as capability_unavailable', async () => {
  const { service, store } = await makeService();
  await assert.rejects(
    service.handleRequest(approvalParams({ approval_type: 'not_a_type' })),
    (error) => error instanceof BridgeError && error.code === 'capability_unavailable',
  );
  await store.close();
});

test('lookup refuses a mirror or pending row as authority', async () => {
  const { service, store } = await makeService();
  // A peer-originated request is a mirror, never authority for a lookup answer.
  await service.handleRequest(approvalParams());
  await assert.rejects(
    service.lookup({
      approval_id: approvalParams().approval_id,
      task_id: 't-lookup',
      root_task_id: 't-lookup',
      session_id: null,
      submit_digest: 'x',
    }),
    (error) => error instanceof BridgeError && error.code === 'approval_mismatch',
  );
  await assert.rejects(
    service.lookup({
      approval_id: 'unknown',
      task_id: 't-lookup',
      root_task_id: 't-lookup',
      session_id: null,
      submit_digest: 'x',
    }),
    (error) => error instanceof BridgeError && error.code === 'approval_mismatch',
  );
  await store.close();
});

test('a failed publish denies instead of granting or re-entering the chain', async () => {
  const { service, store } = await makeService({ requestFails: true });
  const { createApprovalBridge: make } = await import('../lib/host/approval.js');
  const { attachApprovalBridge: attach } = await import('../lib/host/approval.js');
  const forwarded = [];
  service._bridge = make(
    {
      canClaim: () => true,
      forward: async (record) => {
        forwarded.push(record);
        // Simulate the peer refusing to queue the question.
        throw new BridgeError('timeout');
      },
      confirmClaim: async () => true,
    },
    { info() {}, warn() {}, failure() {} },
  );
  const outcome = await service._bridge.listener({ toolName: 'bash' }, async () => 'rejected');
  // Once claimed, the chain behind this listener is gone: calling `next()` again
  // would replay the request into the wrong listener, so a failed publish is
  // `unavailable` — fail closed, and certainly never a grant.
  assert.equal(outcome, 'unavailable', 'a failed forward must never become an approval');
  assert.notEqual(outcome, 'allowed-once');
  assert.equal(service._bridge.pending.size, 0);
  assert.equal(forwarded.length, 1);
  void attach;
  await store.close();
});

test('the bridge claims a bound request and short-circuits the local UI', async () => {
  const listeners = [];
  const ctx = {
    on(event, listener, options) {
      listeners.push({ event, listener, options });
      return () => {};
    },
  };
  const settled = [];
  const forwarded = [];
  const bridge = createApprovalBridge(
    {
      canClaim: () => true,
      forward: async (record) => {
        forwarded.push(record);
      },
      confirmClaim: async () => true,
      onSettled: (record, outcome) => settled.push({ record, outcome }),
    },
    { info() {}, warn() {}, failure() {} },
  );
  const dispose = attachApprovalBridge(ctx, bridge);
  assert.equal(listeners.length, 1);
  assert.equal(listeners[0].event, 'approval/request');
  assert.deepEqual(listeners[0].options, { prepend: true }, 'the bridge must sit outside the UI forwarder');

  let uiCalled = false;
  const pendingOutcome = listeners[0].listener({ toolName: 'bash' }, async () => {
    uiCalled = true;
    return 'rejected';
  });
  // Let `forward` and `confirmClaim` run.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(forwarded.length, 1);
  assert.equal(uiCalled, false, 'a claimed request must not also be shown to the local UI');

  const [record] = forwarded;
  assert.equal(bridge.settleExternal(record.approval_id, 'allowed-once'), true);
  assert.equal(await pendingOutcome, 'allowed-once');
  assert.equal(bridge.settleExternal(record.approval_id, 'rejected'), false, 'a second answer is discarded');
  assert.equal(settled.length, 1);
  dispose();
});

test('an unbound request is handed back without any bridge state', async () => {
  const ctx = { on: () => () => {} };
  const forwarded = [];
  const bridge = createApprovalBridge(
    {
      canClaim: () => false,
      forward: async (record) => forwarded.push(record),
      confirmClaim: async () => true,
    },
    { info() {}, warn() {}, failure() {} },
  );
  attachApprovalBridge(ctx, bridge);
  const outcome = await bridge.listener({ toolName: 'bash' }, async () => 'rejected');
  assert.equal(outcome, 'rejected');
  assert.equal(forwarded.length, 0, 'a handed-back request must not be published');
  assert.equal(bridge.pending.size, 0, 'a handed-back request must not create a pending entry');
});

test('a request withdrawn by the host settles cancelled and refuses late answers', async () => {
  const controller = new AbortController();
  const bridge = createApprovalBridge(
    { canClaim: () => true, forward: async () => {}, confirmClaim: async () => true },
    { info() {}, warn() {}, failure() {} },
  );
  const pendingOutcome = bridge.listener(
    { toolName: 'bash', signal: controller.signal },
    async () => 'unavailable',
  );
  await new Promise((resolve) => setImmediate(resolve));
  const approvalId = [...bridge.pending.keys()][0];
  controller.abort();
  assert.equal(await pendingOutcome, 'cancelled');
  assert.equal(bridge.settleExternal(approvalId, 'allowed-once'), false);
});

test('a claimed request that reaches its deadline settles rejected', async () => {
  let now = Date.now();
  const bridge = createApprovalBridge(
    { canClaim: () => true, forward: async () => {}, confirmClaim: async () => true },
    { info() {}, warn() {}, failure() {} },
    () => now,
  );
  const pendingOutcome = bridge.listener({ toolName: 'bash' }, async () => 'unavailable');
  await new Promise((resolve) => setImmediate(resolve));
  const approvalId = [...bridge.pending.keys()][0];
  assert.equal(bridge.armDeadline(approvalId, new Date(now + 20).toISOString()), true);
  now += 40;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(await pendingOutcome, 'rejected', 'expiry is a rejection, never a grant');
});

test('a failed forward fails closed without re-entering the chain', async () => {
  const bridge = createApprovalBridge(
    {
      canClaim: () => true,
      forward: async () => {
        throw new BridgeError('timeout');
      },
      confirmClaim: async () => true,
    },
    { info() {}, warn() {}, failure() {} },
  );
  let chainReentered = false;
  const outcome = await bridge.listener({ toolName: 'bash' }, async () => {
    chainReentered = true;
    return 'allowed-once';
  });
  assert.equal(outcome, 'unavailable');
  assert.equal(chainReentered, false, 'a claim must never fall back into the chain');
  assert.equal(bridge.pending.size, 0);
});

test('an unconfirmed claim fails closed', async () => {
  const bridge = createApprovalBridge(
    { canClaim: () => true, forward: async () => {}, confirmClaim: async () => false },
    { info() {}, warn() {}, failure() {} },
  );
  const outcome = await bridge.listener({ toolName: 'bash' }, async () => 'allowed-once');
  assert.equal(outcome, 'unavailable', 'an unconfirmed claim is a denial, not a hand-back');
  assert.equal(bridge.pending.size, 0);
});

test('channel loss fails every claimed handle as unavailable', async () => {
  const bridge = createApprovalBridge(
    { canClaim: () => true, forward: async () => {}, confirmClaim: async () => true },
    { info() {}, warn() {}, failure() {} },
  );
  const first = bridge.listener({ toolName: 'bash' }, async () => 'unavailable');
  const second = bridge.listener({ toolName: 'bash' }, async () => 'unavailable');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(bridge.pending.size, 2);
  assert.equal(bridge.failAll('channel'), 2);
  assert.equal(await first, 'unavailable');
  assert.equal(await second, 'unavailable');
});

test('two concurrent requests without a callId stay independent', async () => {
  const bridge = createApprovalBridge(
    { canClaim: () => true, forward: async () => {}, confirmClaim: async () => true },
    { info() {}, warn() {}, failure() {} },
  );
  const first = bridge.listener({ toolName: 'bash' }, async () => 'unavailable');
  const second = bridge.listener({ toolName: 'bash' }, async () => 'unavailable');
  await new Promise((resolve) => setImmediate(resolve));
  const ids = [...bridge.pending.keys()];
  assert.equal(ids.length, 2, 'each request gets its own bridge id');
  assert.notEqual(ids[0], ids[1]);
  bridge.settleExternal(ids[0], 'allowed-once');
  assert.equal(await first, 'allowed-once');
  assert.equal(bridge.pending.size, 1, 'settling one must not settle the other');
  bridge.settleExternal(ids[1], 'rejected');
  assert.equal(await second, 'rejected');
});

test('a new sid fails handles claimed under the previous one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-approvals-'));
  const store = new BridgeStore({ dataRoot: root });
  await store.init();
  const service = new ApprovalService({
    store,
    session: { async emit() {}, async call() { return { accepted: true }; } },
    host: {},
    notify: { async emit() {} },
    config: { approvalTimeoutSeconds: 1800 },
    logger: { info() {}, warn() {}, failure() {}, debug() {} },
    remoteApprovalEnabled: true,
  });
  service._bridge = {
    pending: new Map([['a1', {}]]),
    failAll: (source) => (source === 'session' ? 1 : 0),
    settleExternal: () => false,
    dispose: () => {},
  };
  service.onSessionReady('default', 'sid-1');
  assert.equal(service.onSessionReady('default', 'sid-2'), 1, 'a new sid invalidates the old handles');
  assert.equal(service.onSessionReady('default', 'sid-2'), 0, 'the same sid does not');
  await store.close();
});

test('only allowed-once is a grant and unknown outcomes fail closed', () => {
  assert.equal(isGrant('allowed-once'), true);
  for (const outcome of ['rejected', 'cancelled', 'unavailable', 'bogus', undefined, null]) {
    assert.equal(isGrant(outcome), false);
  }
  assert.equal(normaliseOutcome('allowed-once'), 'allowed-once');
  assert.equal(normaliseOutcome('bogus'), 'unavailable');
  assert.equal(normaliseApprovalOutcome('bogus'), 'unavailable');
  assert.equal(normaliseApprovalOutcome('cancelled'), 'cancelled');
});

test('no source file can rewrite the approval policy', async () => {
  const root = new URL('..', import.meta.url).pathname;
  const libDir = join(root, 'lib');
  const files = [];
  const walk = async (directory) => {
    for (const entry of await readdir(directory)) {
      const path = join(directory, entry);
      const info = await stat(path);
      if (info.isDirectory()) await walk(path);
      else if (entry.endsWith('.js')) files.push(path);
    }
  };
  await walk(libDir);
  assert.ok(files.length >= 15);
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    // The durable policy write path and the live policy switch are both
    // forbidden: rewriting either would let a `never` session become `ask`.
    assert.ok(!/setApprovalPolicy\s*\(/.test(text), `${file} must not switch the session policy`);
    assert.ok(!/approval\.setPolicy\s*\(/.test(text), `${file} must not switch a live policy`);
    assert.ok(!/policy\s*:\s*['"]ask['"]/.test(text), `${file} must not force the ask policy`);
  }
});

/**
 * Task and notification tests (protocol §9.3–§9.6, §10, §11, §16).
 *
 * These exercise the guarantees an operator actually depends on: submit returns
 * immediately, a duplicate never executes twice, an unknown outcome parks the
 * task instead of re-running it, and a wake-up cannot storm a session.
 * @module dsh-plugin-astrbot-bridge/tests/tasks
 */

import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { BridgeError } from '../lib/errors.js';
import { BridgeStore } from '../lib/store.js';
import { NotifyService, trimResult } from '../lib/app/notify.js';
import { TaskService, mapEventToStatus } from '../lib/app/tasks.js';

/**
 * Build a fake agent host with controllable behaviour.
 * @param {object} [behaviour] - overrides.
 * @returns {object} fake host.
 */
function fakeHost(behaviour = {}) {
  const deliveries = [];
  return {
    deliveries,
    listSessions: () => [{ session_id: 's1', state: 'idle' }],
    async deliver(input) {
      deliveries.push(input);
      if (behaviour.deliverThrows !== undefined) throw behaviour.deliverThrows;
      return { strategy: 'followup', session_id: input.sessionId, degraded: [] };
    },
    async waitIdle() {
      return behaviour.idle !== false;
    },
    cancel: () => behaviour.cancelable !== false,
  };
}

/**
 * Build a fake session that records emitted messages.
 * @returns {object} fake session.
 */
function fakeSession() {
  const emitted = [];
  const calls = [];
  return {
    emitted,
    calls,
    async emit(m, params) {
      emitted.push({ m, params });
    },
    async call(m, params) {
      calls.push({ m, params });
      if (m === 'task.submit') return { task_id: params.task_id, status: 'accepted', session_id: null, dedup: false };
      if (m === 'task.status') return { task_id: params.task_id, status: 'running' };
      return {};
    },
  };
}

/**
 * Build a task service fixture on a temporary data root.
 * @param {object} [options] - fixture options.
 * @returns {Promise<object>} fixture.
 */
async function makeService(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'bridge-tasks-'));
  const store = new BridgeStore({ dataRoot: root });
  await store.init();
  if (options.authorized !== false) {
    // The peer is the authority on authorization; every fixture starts with one
    // granted session so tests exercise the task path, not the denial path.
    // `granted_by: 'human'` is the §12.5 point 5 corroboration: only a session a
    // human granted can carry a human submission past the approval gate, so a
    // grant without it would park every fixture task in `pending_approval`.
    await store.applyAuthz({
      version: 1,
      grants: [{ session_id: 's1', purpose: 'code-review', granted_by: 'human' }],
    });
  }
  const host = options.host ?? fakeHost();
  const session = options.session ?? fakeSession();
  const notify = new NotifyService({
    store,
    session,
    host,
    config: { wakeMaxChain: 8, wakeRatePerMinute: 10 },
    logger: null,
  });
  const tasks = new TaskService({
    store,
    session,
    host,
    notify,
    config: {
      wakeMaxChain: 8,
      wakeRatePerMinute: 10,
      imageMaxCount: 4,
      imageMaxBytes: 10_485_760,
      imageTotalMaxBytes: 20_971_520,
      imageAllowedMime: ['image/gif', 'image/jpeg', 'image/png', 'image/webp'],
    },
    logger: null,
  });
  return { root, store, host, session, notify, tasks };
}

/**
 * Build a valid `task.submit` parameter set.
 * @param {object} [overrides] - parameter overrides.
 * @returns {object} parameters.
 */
function submitParams(overrides = {}) {
  return {
    task_id: '11111111-1111-4111-8111-111111111111',
    root_task_id: '11111111-1111-4111-8111-111111111111',
    kind: 'dsh_agent_run',
    // The default is a *human* submission whose target session a human granted:
    // that is the one path §12.5 point 5 lets through without an approval
    // reference. LLM-originated submissions are exercised explicitly by the
    // approval tests below, which must keep parking in `pending_approval`.
    origin: 'human',
    input_parts: [{ type: 'text', text: 'do the thing' }],
    attachments: [],
    tool_hints: [],
    session_id: 's1',
    purpose: 'code-review',
    timeout_s: 60,
    meta: {},
    approval_ref: null,
    ...overrides,
  };
}

test('submit validates its parameters strictly', async () => {
  const { tasks, store } = await makeService();
  for (const bad of [
    submitParams({ kind: 'other' }),
    submitParams({ origin: 'agent' }),
    submitParams({ input_parts: [] }),
    submitParams({ input_parts: [{ type: 'image' }] }),
    submitParams({ timeout_s: 0 }),
    submitParams({ attachments: undefined }),
    submitParams({ meta: [] }),
  ]) {
    await assert.rejects(
      tasks.submitInbound(bad),
      (error) => error instanceof BridgeError && error.code === 'bad_params',
    );
  }
  await store.close();
});

test('submit answers immediately with an accepted status', async () => {
  const { tasks, store, host } = await makeService();
  const result = await tasks.submitInbound(submitParams());
  assert.equal(result.status, 'accepted');
  assert.equal(result.dedup, false);
  assert.equal(result.task_id, submitParams().task_id);
  assert.equal(host.deliveries.length, 0, 'execution must not have started before the reply');
  await store.close();
});

test('a duplicate submit is idempotent and never runs twice', async () => {
  const host = fakeHost();
  const { tasks, store } = await makeService({ host });
  const first = await tasks.submitInbound(submitParams());
  await new Promise((resolve) => setImmediate(resolve));
  const second = await tasks.submitInbound(submitParams());
  assert.equal(first.dedup, false);
  assert.equal(second.dedup, true);
  assert.equal(second.task_id, first.task_id, 'a duplicate answers for the same task');
  // Execution is detached by design, so the run is observed at its real
  // delivery condition instead of a fixed delay: the body must be delivered and
  // the persisted record must settle. The deadline only bounds the wait — a
  // task that never settles fails here with the observed state, it is not
  // papered over with a longer sleep.
  const deadline = Date.now() + 5_000;
  let task = null;
  while (Date.now() < deadline) {
    task = await store.getTask(first.task_id);
    if (host.deliveries.length >= 1 && task?.status === 'succeeded') break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(
    host.deliveries.length >= 1 && task?.status === 'succeeded',
    `the task never settled within the deadline (deliveries=${host.deliveries.length}, status=${task?.status})`,
  );
  assert.equal(host.deliveries.length, 1, 'the task body must run exactly once');
  assert.equal(task.task_id, first.task_id, 'the persisted record keeps the submitted id');
  assert.equal(task.status, 'succeeded', 'the duplicate must not disturb the persisted state');
  await store.close();
});

test('an unauthorized session is refused', async () => {
  const { tasks, store } = await makeService();
  await assert.rejects(
    tasks.submitInbound(submitParams({ session_id: 'not-authorized' })),
    (error) => error instanceof BridgeError && error.code === 'session_not_authorized',
  );
  await store.close();
});

test('an authorized session is accepted', async () => {
  const { tasks, store } = await makeService();
  const result = await tasks.submitInbound(submitParams());
  assert.equal(result.status, 'accepted');
  await store.close();
});

// The two tests below are the counterweight to the fixture's `origin: 'human'`
// default: they prove the approval gate is still enforced and was not flattened
// away by making every submission look human.
test('an LLM submission is held for a human despite a human grant', async () => {
  const { tasks, store, host } = await makeService();
  const params = submitParams({ origin: 'llm', task_id: '22222222-2222-4222-8222-222222222222' });
  const result = await tasks.submitInbound(params);
  assert.equal(result.status, 'pending_approval', 'origin llm must never run unattended');
  await new Promise((resolve) => setImmediate(resolve));
  const task = await store.getTask(params.task_id);
  assert.equal(task.status, 'pending_approval');
  assert.equal(task.needs_human, true, 'an unwired approval gate is fail-closed');
  assert.equal(host.deliveries.length, 0, 'nothing may execute before a human answered');
  await store.close();
});

test('a human submission into an agent-created grant is held for a human', async () => {
  const { tasks, store, host } = await makeService({ authorized: false });
  // `granted_by` is the corroboration that cannot be forged by the payload: an
  // agent-created session does not carry a human command through the gate.
  await store.applyAuthz({
    version: 1,
    grants: [{ session_id: 's1', purpose: 'code-review', granted_by: 'agent_auto' }],
  });
  const result = await tasks.submitInbound(submitParams());
  assert.equal(result.status, 'pending_approval');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await store.getTask(submitParams().task_id)).status, 'pending_approval');
  assert.equal(host.deliveries.length, 0);
  await store.close();
});

test('a spent gate is parked and executes nothing', async () => {
  const { tasks, store, host } = await makeService();
  const taskId = '88888888-8888-4888-8888-888888888888';
  await store.putTask({
    task_id: taskId,
    root_task_id: taskId,
    direction: 'inbound',
    status: 'pending_approval',
    kind: 'dsh_agent_run',
    origin: 'llm',
    session_id: 's1',
    eseq: 0,
    needs_human: false,
    updated_at: new Date().toISOString(),
  });
  await store.putApproval({
    approval_id: 'spent-gate',
    approval_type: 'cross_end_submit',
    task_id: taskId,
    source: 'local',
    gate_scope: 'inbound_release',
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    decided: true,
    decision: {
      outcome: 'allowed-once',
      actor: 'admin',
      actor_kind: 'human',
      channel: 'web',
      decided_at: new Date().toISOString(),
    },
  });
  // Another task already spent the decision: accepting this one would run on a
  // human answer it does not own.
  assert.equal(await store.claimApprovalConsumption('spent-gate', 'other-task'), true);
  await tasks._settleSubmitApproval(await store.getApproval('spent-gate'), true);
  const parked = await store.getTask(taskId);
  assert.equal(parked.status, 'needs_human');
  assert.equal(parked.needs_human, true);
  assert.equal(host.deliveries.length, 0, 'a spent gate must execute nothing');
  const accepted = (await store.list('notifies'))
    .filter((record) => record.payload?.task_id === taskId)
    .map((record) => record.payload.event);
  assert.equal(accepted.includes('accepted'), false, 'a refused claim must never announce acceptance');
  await store.close();
});

test('a local gate is claimed before the task is accepted', async () => {
  const { tasks, store, host } = await makeService();
  const taskId = '88888888-8888-4888-8888-888888888889';
  await store.putTask({
    task_id: taskId,
    root_task_id: taskId,
    direction: 'inbound',
    status: 'pending_approval',
    kind: 'dsh_agent_run',
    origin: 'llm',
    session_id: 's1',
    timeout_s: 60,
    input_parts: [{ type: 'text', text: 'do the thing' }],
    attachments: [],
    tool_hints: [],
    approval_id: 'gate-order',
    eseq: 0,
    needs_human: false,
    updated_at: new Date().toISOString(),
  });
  await store.putApproval({
    approval_id: 'gate-order',
    approval_type: 'cross_end_submit',
    task_id: taskId,
    source: 'local',
    gate_scope: 'inbound_release',
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    decided: true,
    decision: {
      outcome: 'allowed-once',
      actor: 'admin',
      actor_kind: 'human',
      channel: 'web',
      decided_at: new Date().toISOString(),
    },
  });
  const original = store.claimApprovalConsumption.bind(store);
  /** @type {string|null} */
  let statusAtClaim = null;
  store.claimApprovalConsumption = async (approvalId, claimedTaskId) => {
    statusAtClaim = (await store.getTask(claimedTaskId)).status;
    return original(approvalId, claimedTaskId);
  };

  await tasks._settleSubmitApproval(await store.getApproval('gate-order'), true);

  // The one-shot claim saw the still-held task: a failed claim could never leave
  // a durably accepted task behind.
  assert.equal(statusAtClaim, 'pending_approval');
  const accepted = (await store.list('notifies'))
    .filter((record) => record.payload?.task_id === taskId)
    .map((record) => record.payload.event);
  assert.ok(accepted.includes('accepted'), 'the claim must precede acceptance');
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && host.deliveries.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(host.deliveries.length, 1, 'an allowed gate executes exactly once');
  await store.close();
});

test('a throwing gate claim parks the task without accepting it', async () => {
  const { tasks, store, host } = await makeService();
  const taskId = '88888888-8888-4888-8888-888888888890';
  await store.putTask({
    task_id: taskId,
    root_task_id: taskId,
    direction: 'inbound',
    status: 'pending_approval',
    kind: 'dsh_agent_run',
    origin: 'llm',
    session_id: 's1',
    eseq: 0,
    needs_human: false,
    approval_id: 'gate-throws',
    updated_at: new Date().toISOString(),
  });
  await store.putApproval({
    approval_id: 'gate-throws',
    approval_type: 'cross_end_submit',
    task_id: taskId,
    source: 'local',
    gate_scope: 'inbound_release',
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    decided: true,
    decision: {
      outcome: 'allowed-once',
      actor: 'admin',
      actor_kind: 'human',
      channel: 'web',
      decided_at: new Date().toISOString(),
    },
  });
  store.claimApprovalConsumption = async () => {
    throw new BridgeError('draining');
  };

  await tasks._settleSubmitApproval(await store.getApproval('gate-throws'), true);

  const parked = await store.getTask(taskId);
  assert.equal(parked.status, 'needs_human');
  assert.equal(parked.error.code, 'approval_settlement_lost');
  assert.equal(host.deliveries.length, 0, 'a failed claim must execute nothing');
  const accepted = (await store.list('notifies'))
    .filter((record) => record.payload?.task_id === taskId)
    .map((record) => record.payload.event);
  assert.equal(accepted.includes('accepted'), false, 'a failed claim must never announce acceptance');
  await store.close();
});

test('restart recovery parks an acceptance whose gate was never spent', async () => {
  const { tasks, store, host } = await makeService();
  const taskId = '99999999-9999-4999-8999-999999999991';
  await store.putTask({
    task_id: taskId,
    root_task_id: taskId,
    direction: 'inbound',
    status: 'accepted',
    kind: 'dsh_agent_run',
    origin: 'llm',
    session_id: 's1',
    eseq: 1,
    needs_human: false,
    updated_at: new Date().toISOString(),
  });
  await store.putApproval({
    approval_id: 'gate-unspent',
    approval_type: 'cross_end_submit',
    task_id: taskId,
    source: 'local',
    conn: 'default|sid-1',
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    decided: true,
    decision: {
      outcome: 'allowed-once',
      actor: 'admin',
      actor_kind: 'human',
      channel: 'web',
      decided_at: new Date().toISOString(),
    },
  });
  await store.putTask({ ...(await store.getTask(taskId)), approval_id: 'gate-unspent' });
  const report = await tasks.recoverAfterRestart();
  assert.ok(report.needs_human.includes(taskId));
  assert.equal((await store.getTask(taskId)).status, 'needs_human');
  assert.equal(host.deliveries.length, 0, 'an unspent gate must never execute after restart');
  await store.close();
});

test('restart recovery parks a running task and a claimed-but-pending task', async () => {
  const { tasks, store, host } = await makeService();
  const runningId = '99999999-9999-4999-8999-999999999992';
  const pendingId = '99999999-9999-4999-8999-999999999993';
  await store.putTask({
    task_id: runningId,
    root_task_id: runningId,
    direction: 'inbound',
    status: 'running',
    kind: 'dsh_agent_run',
    origin: 'llm',
    session_id: 's1',
    eseq: 3,
    needs_human: false,
    updated_at: new Date().toISOString(),
  });
  await store.putTask({
    task_id: pendingId,
    root_task_id: pendingId,
    direction: 'inbound',
    status: 'pending_approval',
    kind: 'dsh_agent_run',
    origin: 'llm',
    session_id: 's1',
    eseq: 1,
    needs_human: false,
    approval_id: 'gate-claimed',
    updated_at: new Date().toISOString(),
  });
  await store.putApproval({
    approval_id: 'gate-claimed',
    approval_type: 'cross_end_submit',
    task_id: pendingId,
    source: 'local',
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  });
  assert.equal(await store.claimApprovalConsumption('gate-claimed', pendingId), true);

  const report = await tasks.recoverAfterRestart();
  assert.ok(report.needs_human.includes(runningId));
  assert.ok(report.needs_human.includes(pendingId));
  assert.equal((await store.getTask(runningId)).status, 'needs_human');
  assert.equal((await store.getTask(pendingId)).status, 'needs_human');
  assert.equal(host.deliveries.length, 0);
  await store.close();
});

test('restart recovery resumes a queued task without a second queued event', async () => {
  const { tasks, store, host } = await makeService();
  const taskId = '99999999-9999-4999-8999-999999999994';
  await store.putTask({
    task_id: taskId,
    root_task_id: taskId,
    direction: 'inbound',
    status: 'queued',
    kind: 'dsh_agent_run',
    origin: 'llm',
    session_id: 's1',
    timeout_s: 60,
    input_parts: [{ type: 'text', text: 'resume me' }],
    attachments: [],
    tool_hints: [],
    eseq: 2,
    needs_human: false,
    updated_at: new Date().toISOString(),
  });
  const report = await tasks.recoverAfterRestart();
  assert.ok(report.resumed.includes(taskId));
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && host.deliveries.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(host.deliveries.length, 1, 'a queued task resumes exactly once');
  const events = (await store.list('notifies'))
    .filter((record) => record.payload?.task_id === taskId)
    .map((record) => record.payload.event);
  assert.equal(events.filter((event) => event === 'queued').length, 0, 'restart must not re-announce queued');
  assert.equal(events.filter((event) => event === 'running').length, 1);
  await store.close();
});

test('restart recovery resumes an accepted task only after its gate was consumed', async () => {
  const { tasks, store, host } = await makeService();
  const taskId = '99999999-9999-4999-8999-999999999995';
  await store.putTask({
    task_id: taskId,
    root_task_id: taskId,
    direction: 'inbound',
    status: 'accepted',
    kind: 'dsh_agent_run',
    origin: 'llm',
    session_id: 's1',
    timeout_s: 60,
    input_parts: [{ type: 'text', text: 'resume the spent gate' }],
    attachments: [],
    tool_hints: [],
    approval_id: 'gate-consumed',
    eseq: 1,
    needs_human: false,
    updated_at: new Date().toISOString(),
  });
  await store.putApproval({
    approval_id: 'gate-consumed',
    approval_type: 'cross_end_submit',
    task_id: taskId,
    source: 'local',
    gate_scope: 'inbound_release',
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    decided: true,
    decision: {
      outcome: 'allowed-once',
      actor: 'admin',
      actor_kind: 'human',
      channel: 'web',
      decided_at: new Date().toISOString(),
    },
  });
  assert.equal(await store.claimApprovalConsumption('gate-consumed', taskId), true);
  const report = await tasks.recoverAfterRestart();
  assert.ok(report.resumed.includes(taskId));
  const deadline = Date.now() + 5_000;
  let resumed = null;
  while (Date.now() < deadline) {
    resumed = await store.getTask(taskId);
    if (host.deliveries.length > 0 && resumed?.status === 'succeeded') break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(host.deliveries.length, 1, 'a consumed gate authorizes exactly one resume');
  assert.equal(resumed.status, 'succeeded');
  await store.close();
});

test('execution progresses through persisted states to succeeded', async () => {
  const { tasks, store } = await makeService();
  await tasks.submitInbound(submitParams());
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const task = await store.getTask(submitParams().task_id);
    if (task.status === 'succeeded') break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const task = await store.getTask(submitParams().task_id);
  assert.equal(task.status, 'succeeded');
  assert.equal(task.result.summary, 'completed');
  const notify = (await store.list('notifies')).map((record) => record.payload.event);
  assert.ok(notify.includes('completed'));
  await store.close();
});

test('a timed-out execution parks the task for a human', async () => {
  const { tasks, store } = await makeService({ host: fakeHost({ idle: false }) });
  await tasks.submitInbound(submitParams({ timeout_s: 1 }));
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const task = await store.getTask(submitParams().task_id);
    if (task.status === 'needs_human') break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const task = await store.getTask(submitParams().task_id);
  assert.equal(task.status, 'needs_human');
  assert.equal(task.needs_human, true);
  await store.close();
});

test('a delivery failure with an unknown outcome never claims success', async () => {
  const host = fakeHost({ deliverThrows: new BridgeError('timeout') });
  const { tasks, store } = await makeService({ host });
  await tasks.submitInbound(submitParams());
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const task = await store.getTask(submitParams().task_id);
    if (task.status === 'needs_human') break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const task = await store.getTask(submitParams().task_id);
  assert.equal(task.status, 'needs_human');
  assert.equal(task.error.code, 'timeout');
  await store.close();
});

test('status reports task_not_found for an unknown task', async () => {
  const { tasks, store } = await makeService();
  await assert.rejects(
    tasks.status({ task_id: 'nope' }),
    (error) => error instanceof BridgeError && error.code === 'task_not_found',
  );
  await store.close();
});

test('outbound submit returns the task id without waiting for execution', async () => {
  const { tasks, store, session } = await makeService();
  const result = await tasks.submitOutbound({ text: 'hello peer', purpose: 'code-review' });
  assert.match(result.task_id, /^[0-9a-f-]{36}$/);
  assert.equal(result.status, 'accepted');
  assert.equal(session.calls.length, 1);
  assert.equal(session.calls[0].m, 'task.submit');
  const stored = await store.getTask(result.task_id);
  assert.equal(stored.direction, 'outbound');
  await store.close();
});

test('an outbound submit whose reply never arrives is parked, not resent', async () => {
  const session = fakeSession();
  const attempts = [];
  session.call = async (m) => {
    attempts.push(m);
    throw new BridgeError('timeout');
  };
  const { tasks, store } = await makeService({ session });
  await assert.rejects(
    tasks.submitOutbound({ text: 'unreachable' }),
    (error) => error instanceof BridgeError && error.code === 'timeout',
  );
  const tasksOpen = (await store.list('tasks')).filter((record) => record.direction === 'outbound');
  assert.equal(tasksOpen.length, 1);
  assert.equal(tasksOpen[0].status, 'needs_human');
  assert.deepEqual(attempts, ['task.submit'], 'the submission is attempted exactly once');
  await store.close();
});

test('an inbound event advances state and is deduplicated by notify_id', async () => {
  const { tasks, store, notify } = await makeService();
  await store.putTask({
    task_id: 'out1',
    root_task_id: 'out1',
    status: 'accepted',
    direction: 'outbound',
    eseq: 0,
    updated_at: new Date().toISOString(),
  });
  const event = {
    task_id: 'out1',
    root_task_id: 'out1',
    eseq: 1,
    event: 'completed',
    status: 'succeeded',
    notify_id: 'n-1',
    result: { summary: 'ok', text: 'done', attachments: [] },
    error: null,
    decision: null,
    approval: null,
  };
  await tasks.onEvent(event);
  assert.equal((await store.getTask('out1')).status, 'succeeded');
  const acks = (await store.list('notifies')).length;
  await tasks.onEvent(event);
  assert.equal((await store.getTask('out1')).eseq, 1, 'a duplicate must not advance eseq again');
  assert.ok(acks >= 1);
  void notify;
  await store.close();
});

test('an out-of-order event is dropped without advancing state', async () => {
  const { tasks, store } = await makeService();
  await store.putTask({
    task_id: 'out2',
    root_task_id: 'out2',
    status: 'running',
    direction: 'outbound',
    eseq: 5,
    updated_at: new Date().toISOString(),
  });
  await tasks.onEvent({
    task_id: 'out2',
    eseq: 4,
    event: 'failed',
    status: 'failed',
    notify_id: 'n-2',
    error: { code: 'x' },
  });
  const task = await store.getTask('out2');
  assert.equal(task.eseq, 5);
  assert.equal(task.status, 'running');
  await store.close();
});

test('cancelling a task marks it canceled and emits an event', async () => {
  const { tasks, store, session } = await makeService();
  await store.putTask({
    task_id: 'c1',
    root_task_id: 'c1',
    status: 'running',
    direction: 'inbound',
    session_id: 's1',
    eseq: 0,
    updated_at: new Date().toISOString(),
  });
  const result = await tasks.cancel({ task_id: 'c1', reason: 'user_cancelled' });
  assert.equal(result.status, 'canceled');
  assert.ok(session.emitted.some((entry) => entry.params.event === 'canceled'));
  await store.close();
});

test('an uncancellable task reports cancel_unsupported instead of lying', async () => {
  const { tasks, store } = await makeService({ host: fakeHost({ cancelable: false }) });
  await store.putTask({
    task_id: 'c2',
    root_task_id: 'c2',
    status: 'running',
    direction: 'inbound',
    session_id: 's1',
    eseq: 0,
    updated_at: new Date().toISOString(),
  });
  const result = await tasks.cancel({ task_id: 'c2' });
  assert.equal(result.status, 'cancel_unsupported');
  assert.equal((await store.getTask('c2')).status, 'running');
  await store.close();
});

test('the wake chain limit suppresses further automatic wake-ups', async () => {
  const { tasks, store, notify } = await makeService();
  await store.putTask({
    task_id: 'w1',
    root_task_id: 'w1',
    status: 'accepted',
    direction: 'outbound',
    session_id: 's1',
    eseq: 0,
    updated_at: new Date().toISOString(),
  });
  let allowed = 0;
  for (let index = 1; index <= 12; index += 1) {
    const decision = await notify.authoriseWake('w1', 's1');
    if (decision.allowed) allowed += 1;
    else {
      assert.equal(decision.code, 'wake_chain_exceeded');
      break;
    }
  }
  assert.equal(allowed, 8, 'the chain limit is eight wake-ups per root task');
  void tasks;
  await store.close();
});

test('trimResult enforces the §11.4 whitelist and the length limits', () => {
  const result = trimResult({
    summary: 's'.repeat(2000),
    text: 't'.repeat(9000),
    attachments: Array.from({ length: 40 }, () => ({
      blob_id: 'b',
      media_type: 'image/png',
      bytes: 1,
      sha256: 'x',
      width: 1,
      height: 1,
      extra: 'must not survive',
    })),
    tool_audit: [{ tool: 'bash', outcome: 'ok', code: '' }],
    degraded: ['model_without_vision'],
    prompt: 'must not survive',
    path: '/etc/passwd',
  });
  assert.equal(result.summary.length, 1024);
  assert.equal(result.text.length, 4096);
  assert.ok(result.attachments.length <= 16);
  assert.equal(result.attachments[0].extra, undefined);
  assert.equal(result.prompt, undefined);
  assert.equal(result.path, undefined);
  assert.deepEqual(result.degraded, ['model_without_vision']);
});

test('mapEventToStatus covers every status-bearing event', () => {
  assert.equal(mapEventToStatus('completed'), 'succeeded');
  assert.equal(mapEventToStatus('failed'), 'failed');
  assert.equal(mapEventToStatus('canceled'), 'canceled');
  assert.equal(mapEventToStatus('needs_decision'), 'needs_decision');
  assert.equal(mapEventToStatus('needs_approval'), 'needs_approval');
  assert.equal(mapEventToStatus('needs_human'), 'needs_human');
  assert.equal(mapEventToStatus('progress'), null);
  assert.equal(mapEventToStatus('unknown-event'), null);
});

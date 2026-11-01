/**
 * Store tests (protocol §10.1, §10.2, §16.1; PRD §5).
 *
 * Persistence is the foundation of "no work is silently lost", so these tests
 * cover restart survival, illegal transitions, idempotency records and the
 * wake accounting budget.
 * @module dsh-plugin-astrbot-bridge/tests/store
 */

import assert from 'node:assert/strict';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { BridgeError } from '../lib/errors.js';
import { BridgeStore, safeKey, unsafeKey } from '../lib/store.js';

/**
 * Open a store on a fresh temporary directory.
 * @returns {Promise<{store: BridgeStore, root: string}>} store fixture.
 */
async function freshStore() {
  const root = await mkdtemp(join(tmpdir(), 'bridge-store-'));
  const store = new BridgeStore({ dataRoot: root });
  await store.init();
  return { store, root };
}

/**
 * Build one task record.
 * @param {string} taskId - task identity.
 * @param {string} [status] - initial status.
 * @returns {object} task record.
 */
function task(taskId, status = 'accepted') {
  return {
    task_id: taskId,
    root_task_id: taskId,
    status,
    direction: 'inbound',
    eseq: 0,
    needs_human: false,
    updated_at: new Date().toISOString(),
  };
}

test('record keys survive a round trip through the safe alphabet', () => {
  for (const key of ['tasks', 'a:b', 'conn:default:task.status:uuid', 'a/b', 'ünïcode', 'x:y']) {
    assert.equal(unsafeKey(safeKey(key)), key);
    assert.match(safeKey(key), /^[A-Za-z0-9_-]+$/);
  }
});

test('a task survives a restart of the store', async () => {
  const { store, root } = await freshStore();
  await store.putTask(task('t1'));
  await store.transition('t1', 'queued');
  await store.close();

  const reopened = new BridgeStore({ dataRoot: root });
  await reopened.init();
  const loaded = await reopened.getTask('t1');
  assert.equal(loaded.status, 'queued');
  await reopened.close();
});

test('records are written as individual documents outside the repository', async () => {
  const { store, root } = await freshStore();
  await store.putTask(task('t2'));
  const tables = await readdir(root);
  assert.ok(tables.includes('tasks'));
  assert.ok(!root.includes('/lib/'), 'data must never be written into the plugin source tree');
  await store.close();
});

test('an illegal transition is refused and the record is untouched', async () => {
  const { store } = await freshStore();
  await store.putTask(task('t3', 'accepted'));
  const before = await store.getTask('t3');
  const after = await store.transition('t3', 'succeeded');
  assert.equal(after.status, 'accepted');
  assert.equal(after.updated_at, before.updated_at);
  await store.close();
});

test('a legal chain of transitions is applied', async () => {
  const { store } = await freshStore();
  await store.putTask(task('t4'));
  for (const status of ['queued', 'running', 'succeeded']) {
    await store.transition('t4', status);
    assert.equal((await store.getTask('t4')).status, status);
  }
  await store.close();
});

test('transitioning an unknown task raises task_not_found', async () => {
  const { store } = await freshStore();
  await assert.rejects(
    store.transition('missing', 'queued'),
    (error) => error instanceof BridgeError && error.code === 'task_not_found',
  );
  await store.close();
});

test('the open-task list excludes terminal tasks and paginates', async () => {
  const { store } = await freshStore();
  for (let index = 0; index < 5; index += 1) await store.putTask(task(`o${index}`));
  await store.transition('o0', 'queued');
  await store.transition('o0', 'running');
  await store.transition('o0', 'succeeded');
  const first = await store.listOpenTasks(2);
  assert.equal(first.tasks.length, 2);
  assert.ok(first.tasks.every((entry) => entry.status !== 'succeeded'));
  assert.ok(first.next_cursor !== null);
  const second = await store.listOpenTasks(2, first.next_cursor);
  assert.equal(second.tasks.length, 2);
  await store.close();
});

test('idempotent replies expire', async () => {
  let now = 1000;
  const root = await mkdtemp(join(tmpdir(), 'bridge-store-'));
  const store = new BridgeStore({ dataRoot: root, now: () => now });
  await store.init();
  await store.cacheReply('k', { ok: true }, 100);
  assert.deepEqual(await store.getCachedReply('k'), { ok: true });
  now += 200;
  assert.equal(await store.getCachedReply('k'), null);
  await store.close();
});

test('the notification outbox tracks attempts and gives up after the limit', async () => {
  const { store } = await freshStore();
  await store.enqueueNotify('n1', { task_id: 't' });
  const pending = await store.pendingNotifies();
  assert.equal(pending.length, 1);
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const updated = await store.markAttempt('n1');
    assert.equal(updated.attempts, attempt);
    if (attempt === 5) assert.equal(updated.undelivered, true);
  }
  assert.equal(await store.markDelivered('n1'), true);
  await store.close();
});

test('an approval accepts exactly one decision', async () => {
  const { store } = await freshStore();
  await store.putApproval({ approval_id: 'a1', expires_at: new Date(Date.now() + 60_000).toISOString() });
  const first = await store.decideApproval('a1', { outcome: 'allowed-once', actor: 'human' });
  assert.equal(first.applied, true);
  const second = await store.decideApproval('a1', { outcome: 'rejected', actor: 'human' });
  assert.equal(second.applied, false);
  assert.equal(second.reason, 'already_answered');
  assert.equal((await store.getApproval('a1')).decision.outcome, 'allowed-once');
  await store.close();
});

test('concurrent approval decisions keep one durable winner', async () => {
  const { store } = await freshStore();
  await store.putApproval({ approval_id: 'race-a', expires_at: new Date(Date.now() + 60_000).toISOString() });
  const [first, second] = await Promise.all([
    store.decideApproval('race-a', { outcome: 'allowed-once', actor: 'alice', actor_kind: 'human' }),
    store.decideApproval('race-a', { outcome: 'rejected', actor: 'bob', actor_kind: 'human' }),
  ]);
  const winners = [first, second].filter((result) => result.applied === true);
  const losers = [first, second].filter((result) => result.applied === false);
  assert.equal(winners.length, 1, 'exactly one decision may apply');
  assert.equal(losers.length, 1);
  assert.equal(losers[0].reason, 'already_answered');
  // The loser reports the stored winner, never its own discarded answer.
  assert.equal(losers[0].record.decision.outcome, winners[0].record.decision.outcome);
  const stored = await store.getApproval('race-a');
  assert.equal(stored.decision.outcome, winners[0].record.decision.outcome);
  await store.close();
});

test('a human decision never settles an unparseable or expired deadline', async () => {
  const { store } = await freshStore();
  await store.putApproval({ approval_id: 'exp-a', expires_at: 'not-a-date' });
  const invalid = await store.decideApproval('exp-a', {
    outcome: 'allowed-once',
    actor: 'alice',
    actor_kind: 'human',
  });
  assert.equal(invalid.applied, false);
  assert.equal(invalid.reason, 'expired');
  assert.equal((await store.getApproval('exp-a')).decided, undefined);

  await store.putApproval({ approval_id: 'exp-b', expires_at: new Date(Date.now() - 1000).toISOString() });
  const overdue = await store.decideApproval('exp-b', {
    outcome: 'allowed-once',
    actor: 'alice',
    actor_kind: 'human',
  });
  assert.equal(overdue.applied, false);
  assert.equal(overdue.reason, 'expired');
  // System settlement is the path that turns expiry into a terminal rejection.
  const system = await store.decideApproval('exp-b', {
    outcome: 'rejected',
    actor: 'system',
    actor_kind: 'system',
  });
  assert.equal(system.applied, true);
  await store.close();
});

test('an approval is consumed exactly once even under concurrency', async () => {
  const { store } = await freshStore();
  await store.putApproval({ approval_id: 'consume-a', expires_at: new Date(Date.now() + 60_000).toISOString() });
  const [first, second] = await Promise.all([
    store.claimApprovalConsumption('consume-a', 'task-1'),
    store.claimApprovalConsumption('consume-a', 'task-2'),
  ]);
  assert.equal([first, second].filter(Boolean).length, 1, 'only one task may spend the gate');
  const stored = await store.getApproval('consume-a');
  assert.ok(['task-1', 'task-2'].includes(stored.consumed_by_task));
  assert.equal(await store.claimApprovalConsumption('consume-a', 'task-3'), false);
  await store.close();
});

test('concurrent decision answers keep one durable winner', async () => {
  const { store } = await freshStore();
  await store.putDecision({ decision_id: 'race-d', expires_at: new Date(Date.now() + 60_000).toISOString() });
  const [first, second] = await Promise.all([
    store.answerDecision('race-d', { choice: 'main' }),
    store.answerDecision('race-d', { choice: 'dev' }),
  ]);
  assert.equal([first, second].filter((result) => result.applied === true).length, 1);
  const loser = [first, second].find((result) => result.applied === false);
  assert.equal(loser.reason, 'already_answered');
  assert.equal(loser.record.answer.choice, first.applied ? 'main' : 'dev');
  await store.close();
});

test('a mirror import enriches decided_at/expiry and keeps consumption', async () => {
  const { store } = await freshStore();
  const now = Date.now();
  await store.putApproval({
    approval_id: 'mirror-a',
    approval_type: 'cross_end_submit',
    task_id: 't-1',
    root_task_id: 't-1',
    session_id: null,
    source: 'peer_request',
    expires_at: new Date(now + 60_000).toISOString(),
  });
  const mirror = {
    approval_id: 'mirror-a',
    approval_type: 'cross_end_submit',
    task_id: 't-1',
    root_task_id: 't-1',
    session_id: null,
    submit_digest: 'submit-1',
    conn: 'default|sid-1',
    released_by_task: 't-1',
    evidence: { submit_digest: 'submit-1' },
    decision: {
      outcome: 'allowed-once',
      actor: 'admin',
      actor_kind: 'human',
      channel: 'web',
      decided_at: new Date(now).toISOString(),
    },
    expires_at: new Date(now + 120_000).toISOString(),
    origin_side: 'A',
  };
  const stored = await store.importApprovalMirror(mirror);
  assert.equal(stored.source, 'peer_lookup');
  assert.equal(stored.decision.decided_at, mirror.decision.decided_at);
  assert.equal(stored.expires_at, mirror.expires_at);
  assert.equal(await store.claimApprovalConsumption('mirror-a', 't-1'), true);

  const refreshed = await store.importApprovalMirror({
    ...mirror,
    expires_at: new Date(now + 240_000).toISOString(),
  });
  assert.equal(refreshed.expires_at, new Date(now + 240_000).toISOString());
  assert.equal(refreshed.consumed_by_task, 't-1', 'a repeated lookup must not reset consumption');

  const conflicting = await store.importApprovalMirror({
    ...mirror,
    decision: { ...mirror.decision, outcome: 'rejected' },
  });
  assert.equal(conflicting, null, 'different evidence is refused, never merged');
  await store.close();
});

test('a decision accepts exactly one answer', async () => {
  const { store } = await freshStore();
  await store.putDecision({ decision_id: 'd1', expires_at: new Date(Date.now() + 60_000).toISOString() });
  assert.equal((await store.answerDecision('d1', { choice: 'main' })).applied, true);
  const second = await store.answerDecision('d1', { choice: 'dev' });
  assert.equal(second.applied, false);
  assert.equal(second.reason, 'already_answered');
  await store.close();
});

test('authorization versions are monotonic and revocation applies', async () => {
  const { store } = await freshStore();
  assert.equal((await store.authzSnapshot()).version, 0);
  const applied = await store.applyAuthz({
    version: 3,
    grants: [
      { session_id: 's1', purpose: 'code-review', granted_by: 'human' },
      { session_id: 's2', purpose: 'code-review', granted_by: 'agent_auto' },
    ],
    revoked: ['s2'],
    allow_agent_create: true,
    max_agent_sessions: 5,
  });
  assert.equal(applied.applied, true);
  assert.equal(await store.isAuthorized('s1'), true);
  assert.equal(await store.isAuthorized('s2'), false, 'a revoked grant is not authorized');
  const stale = await store.applyAuthz({ version: 2, grants: [] });
  assert.equal(stale.applied, false, 'an older version is ignored');
  assert.equal(await store.isAuthorized('s1'), true);
  await store.close();
});

test('an expired grant is not authorized', async () => {
  const { store } = await freshStore();
  await store.applyAuthz({
    version: 1,
    grants: [{ session_id: 's1', expires_at: new Date(Date.now() - 1000).toISOString() }],
  });
  assert.equal(await store.isAuthorized('s1'), false);
  await store.close();
});

test('agent session counting only counts agent-auto grants', async () => {
  const { store } = await freshStore();
  await store.applyAuthz({
    version: 1,
    grants: [
      { session_id: 's1', granted_by: 'human' },
      { session_id: 's2', granted_by: 'agent_auto' },
      { session_id: 's3', granted_by: 'agent_auto' },
    ],
  });
  assert.equal(await store.countAgentSessions(), 2);
  await store.close();
});

test('the wake chain limit and rate limit are both persisted', async () => {
  const { store, root } = await freshStore();
  assert.equal((await store.bumpWake('root', 's1', { maxChain: 2, ratePerMinute: 10 })).allowed, true);
  assert.equal((await store.bumpWake('root', 's1', { maxChain: 2, ratePerMinute: 10 })).allowed, true);
  const third = await store.bumpWake('root', 's1', { maxChain: 2, ratePerMinute: 10 });
  assert.equal(third.allowed, false);
  assert.equal(third.code, 'wake_chain_exceeded');
  await store.close();

  const reopened = new BridgeStore({ dataRoot: root });
  await reopened.init();
  assert.equal(await reopened.wakeCount('root'), 2, 'the budget survives a restart');
  await reopened.close();
});

test('the rate limit rejects a burst from one session', async () => {
  const { store } = await freshStore();
  assert.equal((await store.bumpWake('r2', 's1', { maxChain: 99, ratePerMinute: 2 })).allowed, true);
  assert.equal((await store.bumpWake('r2', 's1', { maxChain: 99, ratePerMinute: 2 })).allowed, true);
  const blocked = await store.bumpWake('r2', 's1', { maxChain: 99, ratePerMinute: 2 });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.code, 'wake_rate_limited');
  await store.close();
});

test('cleanup deletes only terminal tasks older than the retention window', async () => {
  const { store } = await freshStore();
  // Seed the old record directly: `putTask` stamps `updated_at` with "now",
  // which is exactly the behaviour that makes a *real* old record old.
  await store.put('tasks', 'old', {
    ...task('old', 'succeeded'),
    updated_at: new Date(Date.now() - 10 * 86400_000).toISOString(),
  });
  await store.putTask(task('fresh', 'running'));
  const removed = await store.cleanupExpired(7);
  assert.equal(removed, 1);
  assert.equal(await store.getTask('old'), null);
  assert.notEqual(await store.getTask('fresh'), null);
  await store.close();
});

test('writes after close are refused instead of silently dropped', async () => {
  const { store } = await freshStore();
  await store.close();
  await assert.rejects(
    store.putTask(task('late')),
    (error) => error instanceof BridgeError && error.code === 'draining',
  );
});

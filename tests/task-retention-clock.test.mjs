/**
 * Task retention measured on the real clock (protocol §10.1, PRD §5).
 *
 * A retention sweep is only meaningful if "three days old" is measured the same
 * way the record's age was written. These tests therefore never seed an age by
 * handing a stale `updated_at` to `putTask` — that is the shape that made a
 * previous failure look like a cleanup bug while the store was behaving
 * correctly. Instead every record is written through the production path
 * (`putTask` / `transition` / `enqueueNotify` / `cacheReply`), and time is
 * advanced either with the store's injected clock or with Node's fake timers,
 * so the sweep is exercised against a record that really is old.
 *
 * The suites cover both durable backends — the file unit and the real
 * `dsh-storage` + `dsh-storage-json` hub — and re-open each one afterwards,
 * because a record that is deleted only in memory is not retention.
 *
 * Deletion is conservative by design: only terminal work that no pending
 * notification still references may go, and `needs_human` records are kept so a
 * retry can never be silently dropped.
 * @module dsh-plugin-astrbot-bridge/tests/task-retention-clock
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { BridgeStore } from '../lib/store.js';

/** Milliseconds in one day, the unit `retentionDays` is expressed in. */
const DAY = 24 * 60 * 60 * 1000;

/** Logger that keeps the test output readable. */
const SILENT = { info() {}, warn() {}, failure() {}, debug() {}, child() { return SILENT; } };

/**
 * Import a host package, reporting why it is unavailable.
 * @param {string} specifier - package name.
 * @returns {Promise<{module: object|null, reason: string|null}>} resolution.
 */
async function tryImport(specifier) {
  try {
    return { module: await import(specifier), reason: null };
  } catch (error) {
    return { module: null, reason: error.message };
  }
}

/**
 * Open a clock-driven store on a fresh file root.
 * @param {number} startMs - initial store clock.
 * @returns {Promise<{store: BridgeStore, root: string, clock: {now: number}}>} fixture.
 */
async function fileStore(startMs) {
  const root = await mkdtemp(join(tmpdir(), 'bridge-retention-'));
  const clock = { now: startMs };
  const store = new BridgeStore({ dataRoot: root, now: () => clock.now, logger: SILENT });
  await store.init();
  return { store, root, clock };
}

/**
 * Write a task through the production path and walk it to a terminal status.
 *
 * `transition` is used rather than a raw `put` so the record's `updated_at` is
 * produced exactly as a deployment produces it.
 * @param {BridgeStore} store - target store.
 * @param {string} taskId - task identity.
 * @param {string} status - status to reach.
 * @returns {Promise<void>} resolution after the final write.
 */
async function settleTask(store, taskId, status) {
  await store.putTask({ task_id: taskId, root_task_id: taskId, status: 'accepted', eseq: 0, needs_human: false });
  if (status === 'accepted') return;
  if (status === 'running') {
    await store.transition(taskId, 'queued');
    await store.transition(taskId, 'running');
    return;
  }
  if (status === 'needs_human') {
    await store.transition(taskId, 'queued');
    await store.transition(taskId, 'running');
    await store.transition(taskId, 'needs_human', { needs_human: true });
    return;
  }
  await store.transition(taskId, 'queued');
  await store.transition(taskId, 'running');
  await store.transition(taskId, status);
}

test('a terminal task written three days ago is collected; live and paged tasks are kept', async () => {
  const start = Date.parse('2026-10-01T00:00:00.000Z');
  const { store, root, clock } = await fileStore(start);
  try {
    await settleTask(store, 'done', 'succeeded');
    await settleTask(store, 'failed-task', 'failed');
    await settleTask(store, 'live', 'running');
    await settleTask(store, 'queued', 'accepted');
    await settleTask(store, 'human', 'needs_human');

    // Three days of real elapsed time, then the sweep a deployment schedules.
    clock.now = start + 3 * DAY + 1000;
    const removed = await store.cleanupExpired(3);

    assert.equal(removed, 2, 'exactly the two terminal tasks outside the window are removed');
    assert.equal(await store.getTask('done'), null);
    assert.equal(await store.getTask('failed-task'), null);
    assert.equal((await store.getTask('live'))?.status, 'running', 'running work is never retention');
    assert.equal((await store.getTask('queued'))?.status, 'accepted', 'queued work is never retention');
    assert.equal((await store.getTask('human'))?.status, 'needs_human', 'a task parked for a human is never retention');

    // A task that is terminal but flagged for a human must also survive: the
    // flag survives the status (`NotifyService` sets it on a finished task when
    // delivery gave up), and staying alive is what lets the retry report.
    await store.putTask({ task_id: 'flagged', root_task_id: 'flagged', status: 'succeeded', needs_human: true });
    clock.now = start + 10 * DAY;
    await store.cleanupExpired(3);
    assert.notEqual(await store.getTask('flagged'), null, 'needs_human wins over terminal');
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a caller-supplied updated_at never rewinds or extends a record', async () => {
  const start = Date.parse('2026-10-01T00:00:00.000Z');
  const { store, root, clock } = await fileStore(start);
  try {
    const stale = new Date(start - 10 * DAY).toISOString();
    // Business code passes `updated_at` for readability; the store owns age.
    await store.putTask({ task_id: 'fresh', root_task_id: 'fresh', status: 'succeeded', updated_at: stale });
    const stored = await store.getTask('fresh');
    assert.equal(stored.updated_at, new Date(start).toISOString(), 'the store clock stamps updated_at');
    assert.notEqual(stored.updated_at, stale, 'a supplied timestamp is not trusted');

    // A future timestamp must not buy extra life either.
    const future = new Date(start + 365 * DAY).toISOString();
    await store.putTask({ ...stored, updated_at: future });
    assert.equal((await store.getTask('fresh')).updated_at, new Date(start).toISOString());

    // Nothing is old yet, so nothing is collected even though a caller claimed
    // the record was ten days old.
    assert.equal(await store.cleanupExpired(3), 0);
    assert.notEqual(await store.getTask('fresh'), null);

    // After the real window elapses on the store clock, the same record is old.
    clock.now = start + 3 * DAY + 1000;
    assert.equal(await store.cleanupExpired(3), 1);
    assert.equal(await store.getTask('fresh'), null);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('an undelivered notification keeps its task until it is acknowledged', async () => {
  const start = Date.parse('2026-10-01T00:00:00.000Z');
  const { store, root, clock } = await fileStore(start);
  try {
    // The production order: the outbox record is written before the event is
    // sent, and the task is already terminal when delivery is still pending.
    await store.enqueueNotify('notify-1', { task_id: 'awaiting-ack', event: 'completed' });
    await settleTask(store, 'awaiting-ack', 'succeeded');

    clock.now = start + 3 * DAY + 1000;
    assert.equal(await store.cleanupExpired(3), 0, 'a pending delivery is live work for the outbox');
    assert.notEqual(await store.getTask('awaiting-ack'), null, 'the task the retry reports against must exist');
    assert.equal((await store.pendingNotifies()).length, 1, 'the notification itself is untouched');

    // Once acknowledged, both the notification and then the task become history.
    await store.markDelivered('notify-1');
    assert.equal(await store.cleanupExpired(3), 2, 'delivered notification and its terminal task are both history');
    assert.equal(await store.getTask('awaiting-ack'), null);
    assert.deepEqual(await store.pendingNotifies(), []);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('expired idempotent replies are deleted by their storage key', async () => {
  const start = Date.parse('2026-10-01T00:00:00.000Z');
  const { store, root, clock } = await fileStore(start);
  try {
    // `cacheReply` keys the record by `${conn}:${m}:${id}` — the record body has
    // no `id` field, so deleting by a body field would address nothing.
    await store.cacheReply('conn:default:req:1', { ok: true }, DAY);
    assert.deepEqual(await store.getCachedReply('conn:default:req:1'), { ok: true });

    clock.now = start + 1 * DAY + 1000;
    assert.equal(await store.getCachedReply('conn:default:req:1'), null, 'the reply itself expired');
    assert.equal(await store.cleanupExpired(3), 0, 'a TTL expiry is not yet a retention expiry');

    clock.now = start + 4 * DAY;
    assert.equal(await store.cleanupExpired(3), 1);
    assert.deepEqual(await store.list('replies'), [], 'the document must really be gone, not just counted');
    assert.equal(await store.get('replies', 'conn:default:req:1'), null);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('approval and decision records are never deleted by retention', async () => {
  const start = Date.parse('2026-10-01T00:00:00.000Z');
  const { store, root, clock } = await fileStore(start);
  try {
    await store.putApproval({ approval_id: 'ap-1', decided: false, decision: null });
    await store.putDecision({ decision_id: 'd-1', answered: false, answer: null });
    clock.now = start + 365 * DAY;
    await store.cleanupExpired(3);
    // One-off answers are the idempotency record for a human decision: deleting
    // them would let a replayed answer be applied twice.
    assert.notEqual(await store.getApproval('ap-1'), null, 'an approval waits for its human, not for the clock');
    assert.notEqual(await store.get('decisions', 'd-1'), null, 'a decision waits for its human, not for the clock');
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('an undecided approval or unanswered decision still owns its terminal task', async () => {
  const start = Date.parse('2026-10-01T00:00:00.000Z');
  const { store, root, clock } = await fileStore(start);
  try {
    // `requestDecision` / `requestApproval` write the question first and then
    // attach it to the task, so a terminal task can legitimately be waiting on a
    // human answer.
    await settleTask(store, 'waits-approval', 'succeeded');
    await store.putApproval({ approval_id: 'ap-open', task_id: 'waits-approval', decided: false, decision: null });
    await settleTask(store, 'waits-decision', 'succeeded');
    await store.putDecision({ decision_id: 'd-open', task_id: 'waits-decision', answered: false, answer: null });
    // Answered work is history: the record no longer protects its task.
    await settleTask(store, 'answered', 'succeeded');
    await store.putDecision({ decision_id: 'd-done', task_id: 'answered', answered: true, answer: { choice: 'a' } });

    clock.now = start + 30 * DAY;
    assert.equal(await store.cleanupExpired(3), 1, 'only the fully answered task is history');
    assert.notEqual(await store.getTask('waits-approval'), null, 'an unanswered approval keeps its task');
    assert.notEqual(await store.getTask('waits-decision'), null, 'an unanswered decision keeps its task');
    assert.equal(await store.getTask('answered'), null);
    // The question records themselves are never retention: they are the
    // one-answer idempotency record (§12.4, §9.8).
    assert.notEqual(await store.getApproval('ap-open'), null);
    assert.notEqual(await store.get('decisions', 'd-open'), null);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('the file backend keeps the same retention across a reopen', async () => {
  const start = Date.parse('2026-10-01T00:00:00.000Z');
  const { store, root, clock } = await fileStore(start);
  try {
    await settleTask(store, 'old', 'succeeded');
    await settleTask(store, 'live', 'running');
  } finally {
    await store.close();
  }
  // Re-open the same durable root with the clock advanced: retention must be a
  // property of the stored record, not of the process that wrote it.
  clock.now = start + 3 * DAY + 1000;
  const reopened = new BridgeStore({ dataRoot: root, now: () => clock.now, logger: SILENT });
  await reopened.init();
  try {
    assert.equal(await reopened.cleanupExpired(3), 1);
    assert.equal(await reopened.getTask('old'), null);
    assert.equal((await reopened.getTask('live'))?.status, 'running');
  } finally {
    await reopened.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('the default clock collects a task three days after a real (fake-timer) write', async (t) => {
  // No injected clock here: this proves the shipped production path, where the
  // store reads `Date.now()` itself.
  const start = Date.parse('2026-10-01T00:00:00.000Z');
  t.mock.timers.enable({ apis: ['Date'], now: start });
  const root = await mkdtemp(join(tmpdir(), 'bridge-retention-'));
  const store = new BridgeStore({ dataRoot: root, logger: SILENT });
  await store.init();
  try {
    await settleTask(store, 'timer-old', 'succeeded');
    await settleTask(store, 'timer-live', 'running');
    assert.equal((await store.getTask('timer-old')).updated_at, new Date(start).toISOString());

    t.mock.timers.tick(3 * DAY + 1000);
    assert.equal(await store.cleanupExpired(3), 1);
    assert.equal(await store.getTask('timer-old'), null);
    assert.equal((await store.getTask('timer-live'))?.status, 'running');
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('the host json hub deletes the same records and they stay deleted after a reopen', async (t) => {
  const cordis = await tryImport('@deepseek-ai/cordis');
  const storage = await tryImport('@deepseek-ai/dsh-storage');
  const json = await tryImport('@deepseek-ai/dsh-storage-json');
  if (cordis.module === null || storage.module === null || json.module === null) {
    t.skip(`real host packages unavailable (${cordis.reason ?? storage.reason ?? json.reason})`);
    return;
  }
  const storagesRoot = await mkdtemp(join(tmpdir(), 'bridge-retention-hub-'));
  const start = Date.parse('2026-10-01T00:00:00.000Z');
  const clock = { now: start };
  const ctx = new cordis.module.Context();
  await ctx.plugin(storage.module.default);
  await ctx.plugin(json.module, { root: storagesRoot });
  try {
    const store = new BridgeStore({ storage: ctx.storage, now: () => clock.now, logger: SILENT });
    await store.init();
    assert.equal(store._unit.constructor.name, 'HostUnit', 'the hub backend must be the one under test');
    try {
      await settleTask(store, 'hub-old', 'succeeded');
      await settleTask(store, 'hub-live', 'running');
      await store.enqueueNotify('hub-notify', { task_id: 'hub-pending', event: 'completed' });
      await settleTask(store, 'hub-pending', 'succeeded');

      clock.now = start + 3 * DAY + 1000;
      assert.equal(await store.cleanupExpired(3), 1, 'only the unreferenced terminal task is history');
      assert.equal(await store.getTask('hub-old'), null);
      assert.equal((await store.getTask('hub-live'))?.status, 'running');
      assert.notEqual(await store.getTask('hub-pending'), null, 'the pending outbox reference still owns its task');
    } finally {
      await store.close();
    }

    // Re-open against the same hub: the deletion must have reached the medium.
    const reopened = new BridgeStore({ storage: ctx.storage, now: () => clock.now, logger: SILENT });
    await reopened.init();
    try {
      assert.equal(await reopened.getTask('hub-old'), null, 'a deleted record must not come back after a reopen');
      assert.equal((await reopened.getTask('hub-live'))?.status, 'running');
      assert.notEqual(await reopened.getTask('hub-pending'), null);
    } finally {
      await reopened.close();
    }
  } finally {
    await rm(storagesRoot, { recursive: true, force: true });
  }
});

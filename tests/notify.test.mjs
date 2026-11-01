/**
 * Session surface and notification tests (protocol §9.7, §11, §16.6).
 * @module dsh-plugin-astrbot-bridge/tests/notify
 */

import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { NotifyService } from '../lib/app/notify.js';
import { SessionService } from '../lib/app/sessions.js';
import { BridgeError } from '../lib/errors.js';
import { BridgeStore } from '../lib/store.js';

/**
 * Build a session-service fixture.
 * @param {object} [options] - fixture options.
 * @returns {Promise<object>} fixture.
 */
async function makeSessions(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'bridge-sessions-'));
  const store = new BridgeStore({ dataRoot: root });
  await store.init();
  const created = [];
  const host = {
    listSessions: () => options.sessions ?? [{ session_id: 's1', state: 'idle' }],
    async createSession(input) {
      created.push(input);
      return input.sessionId;
    },
  };
  const service = new SessionService({
    store,
    host,
    config: {
      id: 'default',
      allowedSessionPurposes: options.allowedSessionPurposes ?? [],
    },
    logger: null,
  });
  return { root, store, host, service, created };
}

test('list returns only authorized sessions and hides the rest', async () => {
  const { service, store } = await makeSessions();
  await store.applyAuthz({
    version: 1,
    grants: [
      { session_id: 's1', purpose: 'code-review', granted_by: 'human' },
      { session_id: 's2', purpose: 'ops', granted_by: 'human' },
    ],
  });
  const result = await service.list({});
  assert.equal(result.authz_version, 1);
  assert.deepEqual(
    result.sessions.map((entry) => entry.session_id),
    ['s1', 's2'],
  );
  const filtered = await service.list({ purpose: 'ops' });
  assert.deepEqual(
    filtered.sessions.map((entry) => entry.session_id),
    ['s2'],
  );
  await store.close();
});

test('list omits an expired grant', async () => {
  const { service, store } = await makeSessions();
  await store.applyAuthz({
    version: 1,
    grants: [{ session_id: 's1', expires_at: new Date(Date.now() - 1000).toISOString() }],
  });
  const result = await service.list({});
  assert.equal(result.sessions.length, 0);
  await store.close();
});

test('create is refused when the peer has not granted creation', async () => {
  const { service, store } = await makeSessions();
  await assert.rejects(
    service.create({ request_id: 'r1', purpose: 'code-review' }),
    (error) => error instanceof BridgeError && error.code === 'session_create_denied',
  );
  await store.close();
});

test('create is refused once the quota is exhausted', async () => {
  const { service, store } = await makeSessions();
  await store.applyAuthz({
    version: 1,
    grants: [{ session_id: 's-existing', granted_by: 'agent_auto' }],
    allow_agent_create: true,
    max_agent_sessions: 1,
  });
  await assert.rejects(
    service.create({ request_id: 'r2', purpose: 'code-review' }),
    (error) => error instanceof BridgeError && error.code === 'session_quota_exceeded',
  );
  await store.close();
});

test('create auto-authorizes inside the quota and is idempotent per request id', async () => {
  const { service, store, created } = await makeSessions();
  await store.applyAuthz({ version: 1, grants: [], allow_agent_create: true, max_agent_sessions: 2 });
  const first = await service.create({ request_id: 'r3', purpose: 'code-review', title: 'review' });
  assert.equal(first.authorized, true);
  assert.equal(first.granted_by, 'agent_auto');
  assert.equal(created.length, 1);
  const second = await service.create({ request_id: 'r3', purpose: 'code-review' });
  assert.equal(second.session_id, first.session_id);
  assert.equal(second.dedup, true);
  assert.equal(created.length, 1, 'a repeated request id must not create a second session');
  assert.equal(await store.isAuthorized(first.session_id), true);
  await store.close();
});

test('create respects the local purpose allow-list', async () => {
  const { service, store } = await makeSessions({ allowedSessionPurposes: ['code-review'] });
  await store.applyAuthz({ version: 1, grants: [], allow_agent_create: true, max_agent_sessions: 2 });
  await assert.rejects(
    service.create({ request_id: 'r4', purpose: 'ops' }),
    (error) => error instanceof BridgeError && error.code === 'session_not_authorized',
  );
  await store.close();
});

test('select refuses an unauthorized session', async () => {
  const { service, store } = await makeSessions();
  await assert.rejects(
    service.select({ task_id: 't1', session_id: 'nope' }),
    (error) => error instanceof BridgeError && error.code === 'session_not_authorized',
  );
  await store.close();
});

test('select points an existing task at an authorized session', async () => {
  const { service, store } = await makeSessions();
  await store.applyAuthz({ version: 1, grants: [{ session_id: 's1' }] });
  await store.putTask({
    task_id: 't1',
    root_task_id: 't1',
    status: 'accepted',
    direction: 'outbound',
    eseq: 0,
    updated_at: new Date().toISOString(),
  });
  const result = await service.select({ task_id: 't1', session_id: 's1' });
  assert.deepEqual(result, { ok: true });
  assert.equal((await store.getTask('t1')).session_id, 's1');
  await store.close();
});

test('manage supports exactly rename and archive', async () => {
  const { service, store } = await makeSessions();
  await store.applyAuthz({ version: 1, grants: [{ session_id: 's1' }] });
  assert.deepEqual(await service.manage({ session_id: 's1', action: 'rename', title: 'new' }), {
    session_id: 's1',
    action: 'rename',
    applied: true,
  });
  const listed = await service.list({});
  assert.equal(listed.sessions[0].title, 'new');
  await service.manage({ session_id: 's1', action: 'archive' });
  assert.equal(await service.isDeliverable('s1'), false, 'an archived session cannot receive deliveries');
  await assert.rejects(
    service.manage({ session_id: 's1', action: 'delete' }),
    (error) => error instanceof BridgeError && error.code === 'bad_params',
  );
  await store.close();
});

test('authz pushes are applied only when newer', async () => {
  const { service, store } = await makeSessions();
  assert.equal((await service.onAuthz({ version: 2, grants: [{ session_id: 's1' }] })).applied, true);
  assert.equal((await service.onAuthz({ version: 1, grants: [] })).applied, false);
  assert.equal(await store.isAuthorized('s1'), true);
  await store.close();
});

test('an ack for an unknown notification is refused as event_not_found', async () => {
  const { store } = await makeSessions();
  const notify = new NotifyService({
    store,
    session: { async emit() {}, async call() { return {}; } },
    host: {},
    config: { wakeMaxChain: 8, wakeRatePerMinute: 10 },
    logger: null,
  });
  await assert.rejects(
    notify.onAck({ notify_id: 'missing' }),
    (error) => error instanceof BridgeError && error.code === 'event_not_found',
  );
  await store.close();
});

test('an ack marks a notification delivered', async () => {
  const { store } = await makeSessions();
  const notify = new NotifyService({
    store,
    session: { async emit() {}, async call() { return {}; } },
    host: {},
    config: { wakeMaxChain: 8, wakeRatePerMinute: 10 },
    logger: null,
  });
  await store.enqueueNotify('n1', { task_id: 't' });
  const result = await notify.onAck({ notify_id: 'n1' });
  assert.deepEqual(result, { notify_id: 'n1', delivered: true });
  assert.equal(await store.markDelivered('n1'), true);
  assert.equal((await store.pendingNotifies()).length, 0);
  await store.close();
});

test('the resend loop reseals the same business message with a new seq', async () => {
  const { store } = await makeSessions();
  const emitted = [];
  const notify = new NotifyService({
    store,
    session: {
      async emit(m, params) {
        emitted.push({ m, params });
      },
      async call() {
        return {};
      },
    },
    host: {},
    config: { wakeMaxChain: 8, wakeRatePerMinute: 10 },
    logger: null,
  });
  await store.putTask({
    task_id: 't1',
    root_task_id: 't1',
    status: 'accepted',
    direction: 'outbound',
    eseq: 0,
    updated_at: new Date().toISOString(),
  });
  await notify.emit({ task_id: 't1', event: 'running', status: 'running' });
  const first = emitted.at(-1).params;
  notify._stopped = false;
  await notify.resendOnce();
  const second = emitted.at(-1).params;
  assert.equal(second.notify_id, first.notify_id, 'the business identity is preserved');
  assert.equal(second.eseq, first.eseq);
  notify.stop();
  await store.close();
});

test('a wake-up with no target session is skipped, not guessed', async () => {
  const { store } = await makeSessions();
  const deliveries = [];
  const notify = new NotifyService({
    store,
    session: { async emit() {}, async call() { return {}; } },
    host: {
      async deliver(input) {
        deliveries.push(input);
      },
    },
    config: { wakeMaxChain: 8, wakeRatePerMinute: 10 },
    logger: null,
  });
  await notify.wake({ task: { task_id: 't1', session_id: null }, event: 'completed', text: 'x', rootTaskId: 't1' });
  assert.equal(deliveries.length, 0);
  await store.close();
});

test('a wake-up parks the task for a human after three failed deliveries', { timeout: 20_000 }, async () => {
  const { store } = await makeSessions();
  let attempts = 0;
  const notify = new NotifyService({
    store,
    session: { async emit() {}, async call() { return {}; } },
    host: {
      async deliver() {
        attempts += 1;
        throw new BridgeError('session_not_found');
      },
    },
    config: { wakeMaxChain: 8, wakeRatePerMinute: 10 },
    logger: null,
  });
  await store.putTask({
    task_id: 't2',
    root_task_id: 't2',
    status: 'accepted',
    direction: 'outbound',
    session_id: 's1',
    eseq: 0,
    updated_at: new Date().toISOString(),
  });
  const task = await store.getTask('t2');
  await notify.wake({ task, event: 'completed', text: 'x', rootTaskId: 't2' });
  assert.equal(attempts, 3, 'the wake-up is retried three times, not forever');
  assert.equal((await store.getTask('t2')).needs_human, true);
  await store.close();
});

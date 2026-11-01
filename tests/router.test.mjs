/**
 * Router tests (protocol §5.5, §9.1, §10.1).
 * @module dsh-plugin-astrbot-bridge/tests/router
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BridgeError } from '../lib/errors.js';
import { Router } from '../lib/router.js';

/**
 * Build a router whose replies are collected instead of sent.
 * @returns {{router: Router, replies: object[]}} fixture.
 */
function makeRouter() {
  const router = new Router();
  const replies = [];
  router.setReplySink(async (message) => replies.push(message));
  return { router, replies };
}

/**
 * Build one request message.
 * @param {string} m - message name.
 * @param {string} id - request identity.
 * @param {object} [params] - parameters.
 * @returns {object} message.
 */
function request(m, id, params = {}) {
  return { k: 'req', m, id, ts: new Date().toISOString(), params };
}

test('a successful request is answered with ok:true and the handler result', async () => {
  const { router, replies } = makeRouter();
  router.register('task.status', 'req', async () => ({ status: 'running' }));
  await router.dispatch(request('task.status', 'r1', { task_id: 't' }));
  assert.equal(replies.length, 1);
  assert.equal(replies[0].k, 'rep');
  assert.equal(replies[0].m, 'task.status');
  assert.equal(replies[0].ok, true);
  assert.deepEqual(replies[0].result, { status: 'running' });
  assert.equal(replies[0].reply_to, 'r1');
  assert.notEqual(replies[0].id, 'r1', 'a reply carries its own identity');
});

test('a throwing handler is answered with the protocol error, not a rejection', async () => {
  const { router, replies } = makeRouter();
  router.register('task.status', 'req', async () => {
    throw new BridgeError('task_not_found');
  });
  await router.dispatch(request('task.status', 'r2'));
  assert.equal(replies.length, 1);
  assert.equal(replies[0].ok, false);
  assert.equal(replies[0].error.code, 'task_not_found');
});

test('an unexpected error becomes internal_error without leaking its message', async () => {
  const { router, replies } = makeRouter();
  router.register('task.status', 'req', async () => {
    throw new Error('/secret/path leaked');
  });
  await router.dispatch(request('task.status', 'r3'));
  assert.equal(replies[0].error.code, 'internal_error');
  assert.ok(!JSON.stringify(replies[0]).includes('secret'));
});

test('an unknown message name is answered with unknown_message', async () => {
  const { router, replies } = makeRouter();
  await router.dispatch(request('not.a.message', 'r4'));
  assert.equal(replies[0].ok, false);
  assert.equal(replies[0].error.code, 'unknown_message');
});

test('a request with no registered handler is answered with unknown_message', async () => {
  const { router, replies } = makeRouter();
  await router.dispatch(request('session.create', 'r5'));
  assert.equal(replies[0].error.code, 'unknown_message');
});

test('an event failure is swallowed and never answered', async () => {
  const { router, replies } = makeRouter();
  router.register('task.event', 'evt', async () => {
    throw new BridgeError('task_not_found');
  });
  await router.dispatch({ k: 'evt', m: 'task.event', id: 'e1', ts: '', params: {} });
  assert.equal(replies.length, 0, 'an event has no reply channel');
});

test('an unknown event is dropped silently', async () => {
  const { router, replies } = makeRouter();
  await router.dispatch({ k: 'evt', m: 'not.a.message', id: 'e2', ts: '', params: {} });
  assert.equal(replies.length, 0);
});

test('a reply is never dispatched as a request', async () => {
  const { router } = makeRouter();
  await assert.rejects(
    router.dispatch({ k: 'rep', m: 'task.status', id: 'x', reply_to: 'y', ok: true, result: {} }),
    (error) => error instanceof BridgeError && error.code === 'unknown_message_kind',
  );
});

test('a malformed message is rejected before dispatch', async () => {
  const { router } = makeRouter();
  await assert.rejects(
    router.dispatch({ k: 'req', m: 'task.status', ts: '' }),
    (error) => error instanceof BridgeError && error.code === 'bad_params',
  );
  await assert.rejects(router.dispatch(null), BridgeError);
});

test('register returns a disposer that removes exactly its own handler', async () => {
  const { router, replies } = makeRouter();
  let calls = 0;
  const dispose = router.register('task.status', 'req', async () => {
    calls += 1;
    return {};
  });
  await router.dispatch(request('task.status', 'a1'));
  dispose();
  await router.dispatch(request('task.status', 'a2'));
  assert.equal(calls, 1);
  assert.equal(replies[1].error.code, 'unknown_message');
});

test('the idempotency cache expires and is pruned', async () => {
  let now = 1000;
  const router = new Router({ now: () => now, replyTtlMs: 100 });
  const replies = [];
  router.setReplySink(async (message) => replies.push(message));
  let runs = 0;
  router.register('task.status', 'req', async () => {
    runs += 1;
    return { runs };
  });
  await router.dispatch(request('task.status', 'same'));
  await router.dispatch(request('task.status', 'same'));
  assert.equal(runs, 1);
  now += 200;
  await router.dispatch(request('task.status', 'same'));
  assert.equal(runs, 2, 'after the TTL the request runs again');
  assert.equal(router.pruneReplies(), 0);
});

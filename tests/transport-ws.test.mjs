/**
 * WebSocket carrier tests (protocol §7.2).
 *
 * Both endpoints run in this process on a loopback random port, so the tests
 * cover the real `ws` handshake, subprotocol negotiation, text-frame framing
 * and teardown rather than a stub.
 * @module dsh-plugin-astrbot-bridge/tests/transport-ws
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BridgeError } from '../lib/errors.js';
import { Session, buildCaps } from '../lib/session.js';
import { BRIDGE_SUBPROTOCOL, WsTransport } from '../lib/transport/ws.js';

/**
 * Build caps for one endpoint.
 * @param {'A'|'B'} side - endpoint side.
 * @returns {object} caps.
 */
function capsFor(side) {
  return buildCaps({
    side,
    host: side === 'A' ? 'astrbot' : 'dsh',
    version: '0.1.0',
    transports: ['ws'],
    tls: false,
    rolesInitiate: true,
    rolesExecute: true,
    approvals: { business_decision: true, cross_end_submit: true, native_tool: side === 'B' },
    attachments: {
      mime: ['image/gif', 'image/jpeg', 'image/png', 'image/webp'],
      max_bytes: 10_485_760,
      max_count: 4,
      max_total_bytes: 20_971_520,
      max_pixels: 64_000_000,
      max_dimension: 8192,
    },
  });
}

/**
 * Start a listening session and return its bound port.
 * @param {object} conn - connection credentials.
 * @returns {Promise<{session: Session, transport: WsTransport, port: number}>} listener.
 */
async function startListener(conn) {
  const transport = new WsTransport();
  const session = new Session(
    {
      conn: { ...conn, mode: 'listen', host: '127.0.0.1', port: 0, path: '/dsh-bridge', tlsEnabled: false },
      side: 'B',
      role: 'responder',
      transportName: 'ws',
      caps: capsFor('B'),
      handshakeTimeoutMs: 3000,
    },
    transport,
  );
  // A listener stops accepting when the test tears it down, so its start
  // settles either ready or closed; capturing it keeps the failure handled.
  const started = session.start().catch((error) => error);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (transport._server?.address()) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const port = transport._server.address().port;
  return { session, transport, port, started };
}

/**
 * Dial a listening endpoint with a client session.
 * @param {object} conn - connection credentials.
 * @param {number} port - listener port.
 * @returns {Promise<{session: Session, transport: WsTransport}>} initiator.
 */
async function startDialer(conn, port) {
  const transport = new WsTransport();
  const session = new Session(
    {
      conn: { ...conn, mode: 'connect', host: '127.0.0.1', port, path: '/dsh-bridge', tlsEnabled: false },
      side: 'A',
      role: 'initiator',
      transportName: 'ws',
      caps: capsFor('A'),
      handshakeTimeoutMs: 3000,
    },
    transport,
  );
  transport._startServer = async () => {};
  await transport.start({ ...conn, mode: 'connect', host: '127.0.0.1', port, path: '/dsh-bridge', tlsEnabled: false }, {
    onPlain: (object) => session._onPlain(object),
    onEnvelope: (envelope) => session._onEnvelope(envelope),
    onProbe: (object) => session._onProbe(object),
    onState: (state) => session._onTransportState(state),
  });
  session._setState('handshaking');
  await session._handshakeAsInitiator();
  session._becomeReady();
  return { session, transport };
}

test('ws carrier completes a real handshake over loopback', async () => {
  const conn = { id: 'default', pskId: 'default', pskSecret: 'correct horse battery staple' };
  const listener = await startListener(conn);
  const dialer = await startDialer(conn, listener.port);
  await listener.started;
  assert.equal(listener.session.state, 'ready');
  assert.equal(listener.session.state, 'ready');
  assert.equal(dialer.session.sid, listener.session.sid);
  await dialer.session.close('draining', 'test');
  await listener.session.close('draining', 'test');
});

test('ws carrier moves a request and its reply', async () => {
  const conn = { id: 'default', pskId: 'default', pskSecret: 'correct horse battery staple' };
  const listener = await startListener(conn);
  const { Router } = await import('../lib/router.js');
  const router = new Router();
  router.register('task.status', 'req', async () => ({ task_id: 'x', status: 'queued' }));
  router.setReplySink(async (message) => listener.session.sendMessage(message));
  listener.session._onMessage = (message) => router.dispatch(message);

  const dialer = await startDialer(conn, listener.port);
  await listener.started;
  const result = await dialer.session.call('task.status', { task_id: 'x' }, 5);
  assert.deepEqual(result, { task_id: 'x', status: 'queued' });
  await dialer.session.close('draining', 'test');
  await listener.session.close('draining', 'test');
});

test('ws carrier rejects a peer that does not offer the bridge subprotocol', async () => {
  const conn = { id: 'default', pskId: 'default', pskSecret: 'correct horse battery staple' };
  const listener = await startListener(conn);
  const { WebSocket } = await import('ws');
  const socket = new WebSocket(`ws://127.0.0.1:${listener.port}/dsh-bridge`, 'other-protocol');
  const outcome = await new Promise((resolve) => {
    socket.on('open', () => resolve('open'));
    socket.on('error', () => resolve('error'));
    socket.on('close', () => resolve('closed'));
    setTimeout(() => resolve('timeout'), 3000);
  });
  // Either the upgrade is refused or the subprotocol is not selected: both are
  // acceptable, silently accepting `other-protocol` is not.
  assert.notEqual(socket.protocol, BRIDGE_SUBPROTOCOL);
  assert.ok(['error', 'closed', 'timeout'].includes(outcome));
  socket.terminate();
  await listener.session.close('draining', 'test');
});

test('ws carrier answers GET /health and rejects credential headers', async () => {
  const conn = { id: 'default', pskId: 'default', pskSecret: 'correct horse battery staple' };
  const listener = await startListener(conn);
  const health = await fetch(`http://127.0.0.1:${listener.port}/dsh-bridge/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { v: 1, ok: true });

  const forbidden = await fetch(`http://127.0.0.1:${listener.port}/dsh-bridge/frames`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer leaks' },
    body: '{}',
  });
  assert.equal(forbidden.status, 401);
  const body = await forbidden.json();
  assert.equal(body.error.code, 'auth_header_forbidden');
  await listener.session.close('draining', 'test');
});

test('ws carrier fails with not_ready instead of sending on a closed socket', async () => {
  const transport = new WsTransport();
  await assert.rejects(
    transport.sendEnvelope({ v: 1, type: 'data', conn: 'default', seq: 0, ct: 'aa' }),
    (error) => error instanceof BridgeError && error.code === 'not_ready',
  );
});

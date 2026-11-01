/**
 * HTTP webhook carrier tests (protocol §7.3).
 *
 * Both sides run in this process on loopback, so the tests exercise the real
 * `/hello`, `/frames` and `/probe` endpoints, the batch contract and the
 * degradation path when reverse delivery stops working.
 * @module dsh-plugin-astrbot-bridge/tests/transport-webhook
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BridgeError } from '../lib/errors.js';
import { Session, buildCaps } from '../lib/session.js';
import { WEBHOOK_PROBE_FAIL, WebhookTransport } from '../lib/transport/webhook.js';

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
    transports: ['webhook'],
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
 * Build a connection record for one endpoint.
 * @param {object} conn - credentials.
 * @param {'listen'|'connect'} mode - carrier mode.
 * @param {number} port - bound or target port.
 * @returns {object} connection configuration.
 */
function connConfig(conn, mode, port) {
  return {
    ...conn,
    mode,
    host: '127.0.0.1',
    port,
    path: '/dsh-bridge',
    tlsEnabled: false,
    allowPrivateAddr: false,
  };
}

/**
 * Start a listening webhook endpoint.
 * @param {object} conn - credentials.
 * @returns {Promise<{session: Session, transport: WebhookTransport, port: number}>} listener.
 */
async function startListener(conn) {
  const transport = new WebhookTransport();
  const session = new Session(
    {
      conn: connConfig(conn, 'listen', 0),
      side: 'B',
      role: 'responder',
      transportName: 'webhook',
      caps: capsFor('B'),
      handshakeTimeoutMs: 3000,
    },
    transport,
  );
  const started = session.start().catch((error) => error);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (transport._server?.address()) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return { session, transport, port: transport._server.address().port, started };
}

/**
 * Start a dialing webhook endpoint and complete its handshake.
 * @param {object} conn - credentials.
 * @param {number} port - listener port.
 * @returns {Promise<{session: Session, transport: WebhookTransport}>} initiator.
 */
async function startDialer(conn, port) {
  const transport = new WebhookTransport();
  const session = new Session(
    {
      conn: connConfig(conn, 'connect', port),
      side: 'A',
      role: 'initiator',
      transportName: 'webhook',
      caps: capsFor('A'),
      handshakeTimeoutMs: 3000,
    },
    transport,
  );
  await session.start();
  return { session, transport };
}

test('webhook completes a handshake and moves a request over loopback', async () => {
  const conn = { id: 'default', pskId: 'default', pskSecret: 'correct horse battery staple' };
  const listener = await startListener(conn);
  const { Router } = await import('../lib/router.js');
  const router = new Router();
  router.register('task.status', 'req', async () => ({ task_id: 'x', status: 'succeeded' }));
  router.setReplySink(async (message) => listener.session.sendMessage(message));
  listener.session._onMessage = (message) => router.dispatch(message);

  const dialer = await startDialer(conn, listener.port);
  assert.equal(dialer.session.state, 'ready');
  assert.equal(dialer.session.sid, listener.session.sid);
  const result = await dialer.session.call('task.status', { task_id: 'x' }, 5);
  assert.deepEqual(result, { task_id: 'x', status: 'succeeded' });
  await dialer.session.close('draining', 'test');
  await listener.session.close('draining', 'test');
});

test('webhook rejects a batch whose frames are not ascending', async () => {
  const conn = { id: 'default', pskId: 'default', pskSecret: 'correct horse battery staple' };
  const listener = await startListener(conn);
  const response = await fetch(`http://127.0.0.1:${listener.port}/dsh-bridge/frames`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      v: 1,
      conn: 'default',
      sid: 'x',
      batch_id: 'b',
      frames: [
        { v: 1, type: 'data', conn: 'default', seq: 5, ct: 'AAAA' },
        { v: 1, type: 'data', conn: 'default', seq: 4, ct: 'AAAA' },
      ],
    }),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'bad_batch');
  await listener.session.close('draining', 'test');
});

test('webhook rejects an oversized batch with frame_too_large', async () => {
  const conn = { id: 'default', pskId: 'default', pskSecret: 'correct horse battery staple' };
  const listener = await startListener(conn);
  const response = await fetch(`http://127.0.0.1:${listener.port}/dsh-bridge/frames`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: 'x'.repeat(9 * 1024 * 1024),
  });
  assert.equal(response.status, 413);
  await listener.session.close('draining', 'test');
});

test('webhook rejects a non-JSON content type and a compressed body', async () => {
  const conn = { id: 'default', pskId: 'default', pskSecret: 'correct horse battery staple' };
  const listener = await startListener(conn);
  const wrongType = await fetch(`http://127.0.0.1:${listener.port}/dsh-bridge/frames`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: '{}',
  });
  assert.equal(wrongType.status, 415);
  const compressed = await fetch(`http://127.0.0.1:${listener.port}/dsh-bridge/frames`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
    body: '{}',
  });
  assert.equal(compressed.status, 415);
  await listener.session.close('draining', 'test');
});

test('webhook answers an authenticated probe with probe_ack', async () => {
  const conn = { id: 'default', pskId: 'default', pskSecret: 'correct horse battery staple' };
  const listener = await startListener(conn);
  const dialer = await startDialer(conn, listener.port);
  // The dialer signs probes with the derived K_probe; a real probe must verify.
  dialer.transport.setProbeSigner((probe) => dialer.session._signProbeObject(probe));
  const answered = await dialer.transport.probeOnce();
  assert.equal(answered, true);
  assert.equal(dialer.transport.probeFailures, 0);
  await dialer.session.close('draining', 'test');
  await listener.session.close('draining', 'test');
});

test('webhook degrades after 3 probe failures and reports transport_degraded', async () => {
  const conn = { id: 'default', pskId: 'default', pskSecret: 'correct horse battery staple' };
  const transport = new WebhookTransport({ probeIntervalMs: 10 });
  const states = [];
  const session = new Session(
    {
      conn: connConfig(conn, 'connect', 1),
      side: 'A',
      role: 'initiator',
      transportName: 'webhook',
      caps: capsFor('A'),
      handshakeTimeoutMs: 300,
    },
    transport,
    { onState: (state) => states.push(state) },
  );
  // A closed port: every probe fails.
  await transport.start(connConfig(conn, 'connect', 1), {
    onPlain: () => {},
    onEnvelope: () => {},
    onProbe: () => undefined,
    onState: (state) => states.push(state),
  });
  transport.setProbeSigner((probe) => probe);
  for (let attempt = 0; attempt < WEBHOOK_PROBE_FAIL; attempt += 1) {
    assert.equal(await transport.probeOnce(), false);
  }
  assert.equal(transport.degraded, true);
  assert.ok(states.includes('degraded'));
  assert.equal(transport.alive(), false, 'a degraded carrier must not claim liveness');
  await transport.stop();
  void session;
});

test('webhook transport surfaces a rejected hello as an auth failure', async () => {
  const conn = { id: 'default', pskId: 'default', pskSecret: 'wrong-secret-value-here' };
  const listenerConn = { id: 'default', pskId: 'default', pskSecret: 'right-secret-value-here' };
  const listener = await startListener(listenerConn);
  const transport = new WebhookTransport();
  const session = new Session(
    {
      conn: connConfig(conn, 'connect', listener.port),
      side: 'A',
      role: 'initiator',
      transportName: 'webhook',
      caps: capsFor('A'),
      handshakeTimeoutMs: 300,
    },
    transport,
  );
  await assert.rejects(
    session.start(),
    (error) => error instanceof BridgeError && ['psk_mismatch', 'timeout'].includes(error.code),
  );
  await listener.session.close('draining', 'test');
});

test('webhook refuses to dial a private address unless explicitly allowed', async () => {
  const transport = new WebhookTransport();
  const session = new Session(
    {
      conn: {
        id: 'default',
        pskId: 'default',
        pskSecret: 'correct horse battery staple',
        mode: 'connect',
        host: '192.168.1.10',
        port: 8765,
        path: '/dsh-bridge',
        allowPrivateAddr: false,
      },
      side: 'A',
      role: 'initiator',
      transportName: 'webhook',
      caps: capsFor('A'),
      handshakeTimeoutMs: 300,
    },
    transport,
  );
  await assert.rejects(
    session.start(),
    (error) => error instanceof BridgeError && error.code === 'config_invalid',
  );
});

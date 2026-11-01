/**
 * HTTP long-poll carrier tests (protocol §7.4).
 *
 * Long polling is the fallback that keeps *reverse* delivery alive, so the
 * tests focus on the poll contract: MAC rejection, 204 on an empty window,
 * retention until ack, and the sid/state errors that must trigger a
 * re-handshake rather than a silent stall.
 * @module dsh-plugin-astrbot-bridge/tests/transport-longpoll
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BridgeError } from '../lib/errors.js';
import { Session, buildCaps } from '../lib/session.js';
import { LongPollTransport } from '../lib/transport/longpoll.js';
import { PollQueue } from '../lib/transport/base.js';

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
    transports: ['longpoll'],
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
  return { ...conn, mode, host: '127.0.0.1', port, path: '/dsh-bridge', tlsEnabled: false };
}

/**
 * Start a long-poll listener.
 * @param {object} conn - credentials.
 * @returns {Promise<{session: Session, transport: LongPollTransport, port: number}>} listener.
 */
async function startListener(conn) {
  const transport = new LongPollTransport();
  const session = new Session(
    {
      conn: connConfig(conn, 'listen', 0),
      side: 'B',
      role: 'responder',
      transportName: 'longpoll',
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
 * Start a long-poll dialer.
 * @param {object} conn - credentials.
 * @param {number} port - listener port.
 * @param {number} [pollWaitS] - long-poll wait window.
 * @returns {Promise<{session: Session, transport: LongPollTransport}>} initiator.
 */
async function startDialer(conn, port, pollWaitS = 1) {
  const transport = new LongPollTransport({ pollWaitS });
  const session = new Session(
    {
      conn: connConfig(conn, 'connect', port),
      side: 'A',
      role: 'initiator',
      transportName: 'longpoll',
      caps: capsFor('A'),
      handshakeTimeoutMs: 3000,
    },
    transport,
  );
  await session.start();
  transport.setSessionIdentity(session.sid, 'A');
  return { session, transport };
}

test('longpoll completes a handshake over loopback', async () => {
  const conn = { id: 'default', pskId: 'default', pskSecret: 'correct horse battery staple' };
  const listener = await startListener(conn);
  const dialer = await startDialer(conn, listener.port);
  await listener.started;
  assert.equal(dialer.session.state, 'ready');
  assert.equal(listener.session.state, 'ready');
  assert.equal(dialer.session.sid, listener.session.sid);
  await dialer.session.close('draining', 'test');
  await listener.session.close('draining', 'test');
});

test('longpoll poll without a valid MAC is rejected as poll_auth_failed', async () => {
  const conn = { id: 'default', pskId: 'default', pskSecret: 'correct horse battery staple' };
  const listener = await startListener(conn);
  const url = `http://127.0.0.1:${listener.port}/dsh-bridge/poll?conn=default&sid=x&side=A&wait=0&max=1&ts=1&nonce=abc&target=poll`;
  const response = await fetch(url);
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, 'poll_auth_failed');
  await listener.session.close('draining', 'test');
});

test('longpoll serves 204 when the window has no frame', async () => {
  const conn = { id: 'default', pskId: 'default', pskSecret: 'correct horse battery staple' };
  const listener = await startListener(conn);
  const { signMock } = { signMock: 'ok' };
  void signMock;
  listener.transport.verifyPoll = () => {};
  const url = `http://127.0.0.1:${listener.port}/dsh-bridge/poll?conn=default&sid=x&side=A&wait=0&max=1&ts=1&nonce=abc&target=poll&mac=x`;
  const response = await fetch(url);
  assert.equal(response.status, 204);
  await listener.session.close('draining', 'test');
});

test('longpoll retains a frame until it is acknowledged', async () => {
  const conn = { id: 'default', pskId: 'default', pskSecret: 'correct horse battery staple' };
  const listener = await startListener(conn);
  listener.transport.verifyPoll = () => {};
  listener.transport.verifyPollAck = () => {};
  const envelope = { v: 1, type: 'data', conn: 'default', seq: 9, ct: 'AAAA' };
  listener.transport._queue.push(envelope);
  const url = `http://127.0.0.1:${listener.port}/dsh-bridge/poll?conn=default&sid=x&side=A&wait=0&max=4&ts=1&nonce=abc&target=poll&mac=x`;

  const first = await fetch(url);
  assert.equal(first.status, 200);
  const body = await first.json();
  assert.equal(body.frames.length, 1);
  assert.equal(listener.transport.retained, 1, 'a delivered frame stays queued until acked');

  const ack = await fetch(`http://127.0.0.1:${listener.port}/dsh-bridge/poll/ack`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ v: 1, conn: 'default', sid: 'x', side: 'A', ts: 2, target: 'poll_ack', nonce: 'n', acks: ['data#9'], mac: 'x' }),
  });
  assert.equal(ack.status, 204);
  assert.equal(listener.transport.retained, 0);

  const second = await fetch(url);
  assert.equal(second.status, 204);
  await listener.session.close('draining', 'test');
});

test('longpoll ack with a bad MAC is refused', async () => {
  const conn = { id: 'default', pskId: 'default', pskSecret: 'correct horse battery staple' };
  const listener = await startListener(conn);
  listener.transport.verifyPollAck = () => {
    throw new BridgeError('poll_auth_failed');
  };
  const response = await fetch(`http://127.0.0.1:${listener.port}/dsh-bridge/poll/ack`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ v: 1, acks: [], mac: 'bad' }),
  });
  assert.equal(response.status, 401);
  await listener.session.close('draining', 'test');
});

test('poll queue drops the oldest frame on overflow and reports it', () => {
  const overflow = [];
  const queue = new PollQueue({ retentionFrames: 2, onOverflow: (envelope) => overflow.push(envelope.seq) });
  queue.push({ v: 1, type: 'data', conn: 'c', seq: 0, ct: 'a' });
  queue.push({ v: 1, type: 'data', conn: 'c', seq: 1, ct: 'a' });
  queue.push({ v: 1, type: 'data', conn: 'c', seq: 2, ct: 'a' });
  assert.equal(queue.size, 2);
  assert.deepEqual(overflow, [0]);
  assert.deepEqual(queue.take(5).map((envelope) => envelope.seq), [1, 2]);
  assert.equal(queue.ack(['data#1']), 1);
  assert.equal(queue.size, 1);
});

test('poll queue expires an unacked frame instead of resending the ciphertext', () => {
  let now = 1_000;
  const expired = [];
  const queue = new PollQueue({
    redeliverAfterS: 30,
    now: () => now,
    onExpired: (envelope) => expired.push(envelope.seq),
  });
  queue.push({ v: 1, type: 'data', conn: 'c', seq: 4, ct: 'a' });
  now += 31_000;
  queue.expire();
  assert.deepEqual(expired, [4]);
  assert.equal(queue.size, 0);
});

test('longpoll reports a stale session instead of polling forever', async () => {
  const conn = { id: 'default', pskId: 'default', pskSecret: 'correct horse battery staple' };
  const transport = new LongPollTransport({ pollWaitS: 1 });
  const states = [];
  transport.verifyPoll = () => {};
  // A listener that always answers 409: the client must stop and report it.
  const http = await import('node:http');
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/dsh-bridge/poll')) {
      res.statusCode = 409;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ v: 1, error: { code: 'sid_mismatch', message: 'x', retryable: false } }));
      return;
    }
    if (req.url?.startsWith('/dsh-bridge/hello')) {
      res.statusCode = 401;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ v: 1, error: { code: 'poll_auth_failed', message: 'x', retryable: false } }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await transport.start(
    { ...connConfig(conn, 'connect', port), retentionFrames: 16 },
    {
      onPlain: () => {},
      onEnvelope: () => {},
      onProbe: () => undefined,
      onState: (state) => states.push(state),
    },
  );
  transport.setSessionIdentity('sid-under-test', 'A');
  for (let attempt = 0; attempt < 60 && !states.includes('stale'); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(states.includes('stale'), 'a 409 poll must be reported as a stale session');
  // The poll loop exits on a stale identity, so teardown cannot wait for it.
  await transport.stop();
  await new Promise((resolve) => server.close(resolve));
});

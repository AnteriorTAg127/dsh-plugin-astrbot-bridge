/**
 * Webhook dual-endpoint tests (protocol §7.0, §7.3).
 *
 * The defect these cover: a webhook endpoint used one `host`/`port` pair for both
 * "where I bind" and "where my peer is", so a `listen` endpoint POSTed reverse
 * traffic back at its own socket and a `connect` endpoint had no inbound server
 * to receive it. Both roles now listen, and the peer address is configuration
 * only — never derived from an inbound request.
 *
 * Every case drives real `node:http` sockets on loopback with real sessions, so
 * the sealed frames below are the ones the wire would carry.
 * @module dsh-plugin-astrbot-bridge/tests/webhook-dual-endpoint
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { test } from 'node:test';

import { BridgeError } from '../lib/errors.js';
import { Router } from '../lib/router.js';
import { Session, buildCaps } from '../lib/session.js';
import { bindTarget, peerBaseUrl, peerTarget, sameEndpoint } from '../lib/transport/base.js';
import { WebhookTransport } from '../lib/transport/webhook.js';

/** Path prefix every endpoint shares. */
const PATH = '/dsh-bridge';

/** Credentials shared by both endpoints of a connection. */
const CREDENTIALS = Object.freeze({ id: 'default', pskId: 'default', pskSecret: 'correct horse battery staple' });

/**
 * Reserve two distinct loopback ports.
 *
 * Both sockets are held open at once so the kernel cannot hand out the same
 * port twice; they are closed before the carriers bind, which is the only way
 * to learn the peer's port before either endpoint starts.
 * @returns {Promise<[number, number]>} two free ports.
 */
async function reservePorts() {
  const servers = await Promise.all(
    [0, 1].map(() => new Promise((resolve, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve(server));
    })),
  );
  const ports = servers.map((server) => server.address().port);
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  assert.notEqual(ports[0], ports[1]);
  return ports;
}

/**
 * Yield to the pending HTTP callbacks of both endpoints.
 * @returns {Promise<void>} resolution after the event loop drained one turn.
 */
function tick() {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

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
 * Build one endpoint's connection configuration.
 *
 * `host`/`port` keep their historical meaning so the test also proves the new
 * fields win: for the listener they name a wildcard bind that is *not* the peer,
 * exactly the shape that used to make the endpoint post to itself.
 * @param {'listen'|'connect'} mode - carrier mode.
 * @param {number} bindPort - local port to bind.
 * @param {number} peerPort - port of the opposite endpoint.
 * @param {object} [overrides] - extra or replacement fields.
 * @returns {object} connection configuration.
 */
function endpointConfig(mode, bindPort, peerPort, overrides = {}) {
  return {
    ...CREDENTIALS,
    mode,
    host: mode === 'listen' ? '0.0.0.0' : '127.0.0.1',
    port: mode === 'listen' ? 8765 : peerPort,
    bindHost: '127.0.0.1',
    bindPort,
    peerHost: '127.0.0.1',
    peerPort,
    path: PATH,
    tlsEnabled: false,
    allowPrivateAddr: false,
    ...overrides,
  };
}

/**
 * Record every inbound HTTP request one carrier serves.
 * @param {WebhookTransport} transport - carrier to instrument.
 * @returns {{hello: string[], frames: string[], probe: string[], total: () => number}} recorder.
 */
function recordInbound(transport) {
  const hello = [];
  const frames = [];
  const probe = [];
  for (const [method, sink] of [['_onHello', hello], ['_onFrames', frames], ['_onProbe', probe]]) {
    const original = transport[method].bind(transport);
    transport[method] = async (req, res) => {
      sink.push(req.url);
      return original(req, res);
    };
  }
  return { hello, frames, probe, total: () => hello.length + frames.length + probe.length };
}

/**
 * Start one endpoint and wait until its session is ready.
 * @param {'A'|'B'} side - endpoint side.
 * @param {'listen'|'connect'} mode - carrier mode.
 * @param {object} cfg - connection configuration.
 * @param {object} [hooks] - extra session hooks.
 * @returns {Promise<{session: Session, transport: WebhookTransport, inbound: object,
 *   start: Promise<unknown>}>} endpoint.
 */
async function startEndpoint(side, mode, cfg, hooks = {}) {
  const transport = new WebhookTransport();
  const inbound = recordInbound(transport);
  const session = new Session(
    {
      conn: cfg,
      side,
      role: mode === 'connect' ? 'initiator' : 'responder',
      transportName: 'webhook',
      caps: capsFor(side),
      handshakeTimeoutMs: 5000,
    },
    transport,
    hooks,
  );
  const start = session.start();
  return { session, transport, inbound, start };
}

/**
 * Start a listener, then a dialer that handshakes against it.
 * @returns {Promise<{listener: object, dialer: object, ports: [number, number]}>} both endpoints.
 */
async function startPair() {
  const ports = await reservePorts();
  const [portA, portB] = ports;
  const listener = await startEndpoint('B', 'listen', endpointConfig('listen', portB, portA));
  for (let attempt = 0; attempt < 200 && listener.transport.boundPort === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(listener.transport.boundPort, portB, 'the listener must bind its configured bind port');
  const dialer = await startEndpoint('A', 'connect', endpointConfig('connect', portA, portB));
  await dialer.start;
  await listener.start;
  return { listener, dialer, ports };
}

/**
 * Close both endpoints of one pair.
 * @param {object} listener - responder endpoint.
 * @param {object} dialer - initiator endpoint.
 * @returns {Promise<void>} resolution after teardown.
 */
async function closePair(listener, dialer) {
  await dialer.session.close('draining', 'test').catch(() => {});
  await listener.session.close('draining', 'test').catch(() => {});
}

test('listen and connect bind and target different addresses', async () => {
  const [portA, portB] = await reservePorts();
  const listenCfg = endpointConfig('listen', portB, portA);
  const connectCfg = endpointConfig('connect', portA, portB);

  // The listen endpoint's own bind address is on 8765 (historical `port`), so a
  // peer URL built from `host`/`port` would point at itself.
  assert.deepEqual(bindTarget(listenCfg), { host: '127.0.0.1', port: portB });
  assert.deepEqual(peerTarget(listenCfg), { host: '127.0.0.1', port: portA });
  assert.equal(peerBaseUrl(listenCfg), `http://127.0.0.1:${portA}${PATH}`);

  assert.deepEqual(bindTarget(connectCfg), { host: '127.0.0.1', port: portA });
  assert.deepEqual(peerTarget(connectCfg), { host: '127.0.0.1', port: portB });
  assert.equal(peerBaseUrl(connectCfg), `http://127.0.0.1:${portB}${PATH}`);
});

test('both webhook roles own an inbound listener so reverse events have somewhere to land', async () => {
  const { listener, dialer, ports } = await startPair();
  try {
    assert.equal(listener.session.state, 'ready');
    assert.equal(dialer.session.state, 'ready');
    assert.equal(dialer.session.sid, listener.session.sid, 'both endpoints must agree on the session id');
    // A connect-mode webhook used to leave `_server === null`, which made reverse
    // delivery impossible even when the peer was reachable.
    assert.equal(dialer.transport.boundPort, ports[0], 'the dialing endpoint must also serve its bind port');
    assert.notEqual(dialer.transport.boundPort, ports[1], 'the dialing endpoint must not bind its peer port');

    // Both inbound endpoints answer the unauthenticated health probe.
    for (const port of ports) {
      const response = await fetch(`http://127.0.0.1:${port}${PATH}/health`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { v: 1, ok: true });
    }
  } finally {
    await closePair(listener, dialer);
  }
});

test('sealed frames travel in both directions and never come back to their sender', async () => {
  const { listener, dialer } = await startPair();
  const router = new Router();
  router.register('task.status', 'req', async () => ({ task_id: 't1', status: 'succeeded' }));
  const atListener = [];
  const atDialer = [];
  listener.session._onMessage = async (message) => {
    atListener.push(message);
    await router.dispatch(message, { session: listener.session });
  };
  router.setReplySink(async (message) => listener.session.sendMessage(message));
  dialer.session._onMessage = async (message) => {
    atDialer.push(message);
  };

  try {
    // Baseline includes the handshake POSTs each side served.
    const listenerInboundAtStart = listener.inbound.total();
    const dialerInboundAtStart = dialer.inbound.total();

    // initiator → responder: a request and its reply.
    const reply = await dialer.session.call('task.status', { task_id: 't1' }, 5);
    assert.deepEqual(reply, { task_id: 't1', status: 'succeeded' });
    assert.equal(atListener.length, 1);
    assert.equal(atListener[0].m, 'task.status');
    await tick();
    // The request landed on the listener's inbound endpoint. Its reply travels
    // back inside that same POST response (§7.3 rule 2), so the dialer's own
    // inbound endpoint must NOT see it.
    assert.equal(listener.inbound.total(), listenerInboundAtStart + 1, 'the listener should serve the request only');
    assert.equal(dialer.inbound.total(), dialerInboundAtStart, 'the inline reply must not be posted to the dialer');

    // responder → initiator: the direction that used to be broken. The listener
    // must POST to the configured peer, not to the port it bound.
    const listenerInboundBeforeReverse = listener.inbound.total();
    const dialerInboundBeforeReverse = dialer.inbound.total();
    await listener.session.emit('task.event', { task_id: 't1', status: 'running' });
    for (let attempt = 0; attempt < 100 && atDialer.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(atDialer.length, 1, 'the reverse event must reach the dialing endpoint');
    assert.equal(atDialer[0].m, 'task.event');
    assert.deepEqual(atDialer[0].params, { task_id: 't1', status: 'running' });
    await tick();

    // A frame is never received by the endpoint that sent it: the listener's own
    // inbound endpoint must stay untouched by the frame it just emitted, while
    // the dialer's inbound endpoint is where that frame actually arrived. This is
    // the exact self-post defect: the old code posted to `host:port`, which in
    // listen mode is the endpoint's own bind address.
    assert.equal(
      listener.inbound.total(),
      listenerInboundBeforeReverse,
      'the listener POSTed its own reverse frame back into its own inbound endpoint',
    );
    assert.equal(
      dialer.inbound.total(),
      dialerInboundBeforeReverse + 1,
      'the reverse frame must arrive at the dialer inbound endpoint',
    );
    assert.equal(listener.inbound.frames.length, 2, 'the listener serves the handshake batch and the request');
    assert.equal(listener.inbound.probe.length, 0, 'neither endpoint posts a probe into its own endpoint');
  } finally {
    await closePair(listener, dialer);
  }
});

test('both endpoints probe each other with a signed probe and stay out of degradation', async () => {
  const { listener, dialer } = await startPair();
  try {
    // Sessions install the K_probe signer, so these are the real MACs.
    assert.equal(await listener.transport.probeOnce(), true);
    assert.equal(await dialer.transport.probeOnce(), true);
    assert.equal(listener.transport.probeFailures, 0);
    assert.equal(dialer.transport.probeFailures, 0);
    assert.equal(listener.transport.degraded, false);
    assert.equal(dialer.transport.degraded, false);
    assert.equal(listener.transport.alive(), true);
    assert.equal(dialer.transport.alive(), true);
    assert.equal(listener.inbound.probe.length, 1, 'the listener should have answered one probe');
    assert.equal(dialer.inbound.probe.length, 1, 'the dialer should have answered one probe');
  } finally {
    await closePair(listener, dialer);
  }
});

test('the peer address comes from configuration and is never read off the wire', async () => {
  const { listener, dialer, ports } = await startPair();
  try {
    const [portA] = ports;
    const before = peerBaseUrl(listener.session.conn);

    // An inbound request cannot move the outbound target: headers would be the
    // only place to smuggle one in, and the carrier rejects those outright.
    const response = await fetch(`http://127.0.0.1:${listener.transport.boundPort}${PATH}/frames`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        v: 1,
        conn: 'default',
        sid: listener.session.sid,
        batch_id: 'b1',
        peer_base: 'http://192.0.2.9:9/dsh-bridge',
        peerHost: '192.0.2.9',
        peerPort: 9,
        frames: [],
      }),
    });
    assert.equal(response.status, 400, 'an empty batch is refused');
    assert.equal(peerBaseUrl(listener.session.conn), before, 'the peer target moved after an inbound request');

    // A peer that *is* this endpoint is refused at start rather than after the
    // first frame, because a self-post is a configuration mistake.
    const selfTransport = new WebhookTransport();
    await assert.rejects(
      selfTransport.start(
        endpointConfig('listen', listener.transport.boundPort, listener.transport.boundPort),
        { onPlain() {}, onEnvelope() {}, onState() {} },
      ),
      (error) => error instanceof BridgeError && error.code === 'config_invalid',
    );
    assert.equal(selfTransport.boundPort, 0, 'a refused endpoint must not leave a socket bound');

    // Half a peer address is a mistake, not a trigger to guess the other half.
    assert.throws(() => peerTarget({ ...endpointConfig('listen', portA, portA), peerPort: undefined }),
      (error) => error instanceof BridgeError && error.code === 'config_invalid');
    assert.throws(() => peerTarget({ ...endpointConfig('listen', portA, portA), peerHost: undefined }),
      (error) => error instanceof BridgeError && error.code === 'config_invalid');
  } finally {
    await closePair(listener, dialer);
  }
});

test('a listen endpoint without a peer accepts inbound frames and fails outbound closed', async () => {
  const [portB] = await reservePorts();
  const transport = new WebhookTransport();
  const inbound = recordInbound(transport);
  const cfg = endpointConfig('listen', portB, portB);
  delete cfg.peerHost;
  delete cfg.peerPort;
  await transport.start(cfg, { onPlain() {}, onEnvelope() {}, onProbe: () => undefined, onState() {} });
  try {
    assert.equal(peerTarget(cfg), null);
    assert.equal(transport.boundPort, portB, 'the endpoint still serves its bind port');
    const health = await fetch(`http://127.0.0.1:${portB}${PATH}/health`);
    assert.equal(health.status, 200);

    // No peer means no reverse path: refuse loudly instead of posting to itself.
    await assert.rejects(
      transport.sendEnvelope({ v: 1, type: 'data', conn: 'default', seq: 1, ct: 'AAAA' }),
      (error) => error instanceof BridgeError && error.code === 'config_invalid',
    );
    // Probing would only count a configuration choice as a network fault.
    assert.equal(await transport.probeOnce(), false);
    assert.equal(transport.probeFailures, 0);
    assert.equal(transport.degraded, false);
    assert.deepEqual(inbound.frames, [], 'nothing may be posted into its own frames endpoint');
  } finally {
    await transport.stop();
  }
});

test('an endpoint comparison refuses itself but not a remote peer sharing its port', () => {
  assert.equal(sameEndpoint({ host: '127.0.0.1', port: 8765 }, { host: '127.0.0.1', port: 8765 }), true);
  assert.equal(sameEndpoint({ host: '127.0.0.1', port: 8765 }, { host: 'localhost', port: 8765 }), true);
  assert.equal(sameEndpoint({ host: '0.0.0.0', port: 8765 }, { host: '127.0.0.1', port: 8765 }), true);
  assert.equal(sameEndpoint({ host: '::', port: 8765 }, { host: '[::1]', port: 8765 }), true);
  // A wildcard bind covers this host only; a remote peer on the same port is a
  // normal deployment and must not be refused as "self".
  assert.equal(sameEndpoint({ host: '0.0.0.0', port: 8765 }, { host: '192.168.1.50', port: 8765 }), false);
  assert.equal(sameEndpoint({ host: '0.0.0.0', port: 8765 }, { host: '127.0.0.1', port: 9000 }), false);
  assert.equal(sameEndpoint({ host: '10.1.1.1', port: 8765 }, { host: '10.1.1.2', port: 8765 }), false);
});

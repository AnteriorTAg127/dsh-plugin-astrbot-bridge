/**
 * Handshake and framing tests (protocol §4, §5, §6).
 *
 * The carrier is a fake pair that moves objects in the same process, so these
 * tests exercise the real state machine, real crypto and real timeouts without
 * opening sockets. Socket behaviour is covered by the per-carrier suites.
 * @module dsh-plugin-astrbot-bridge/tests/handshake
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FrameType, Limits } from '../lib/constants.js';
import { BridgeError } from '../lib/errors.js';
import { Router } from '../lib/router.js';
import { Session, buildCaps } from '../lib/session.js';

/**
 * A pair of in-memory carriers that deliver synchronously on a later tick.
 *
 * It implements the same six-method surface the real carriers do, so the
 * session layer cannot tell the difference.
 */
class FakePair {
  constructor() {
    this.a = new FakeCarrier(this, 'a');
    this.b = new FakeCarrier(this, 'b');
    this.a.peer = this.b;
    this.b.peer = this.a;
    this.dropAfter = Number.POSITIVE_INFINITY;
    this.sent = [];
  }

  /**
   * Count one delivery and decide whether to drop it.
   * @param {string} from - carrier name that produced the delivery.
   * @param {Function} deliver - delivery action.
   * @returns {void}
   */
  hop(from, deliver) {
    this.sent.push(from);
    if (this.sent.length > this.dropAfter) return;
    setImmediate(deliver);
  }
}

/** One side of {@link FakePair}. */
class FakeCarrier {
  constructor(pair, name) {
    this.pair = pair;
    this.name = name;
    this.peer = null;
    this.hooks = null;
    this.stopped = true;
  }

  get name2() {
    return 'webhook';
  }

  async start(_cfg, hooks) {
    this.hooks = hooks;
    this.stopped = false;
  }

  async stop() {
    this.stopped = true;
  }

  async sendEnvelope(envelope) {
    const peer = this.peer;
    this.pair.hop(this.name, () => {
      void peer.hooks.onEnvelope(structuredClone(envelope));
    });
  }

  async sendPlain(object) {
    const peer = this.peer;
    return new Promise((resolve) => {
      this.pendingPlain = resolve;
      this.pair.hop(this.name, () => {
        void peer.hooks.onPlain(structuredClone(object));
      });
      // A responder that rejects the hello never replies. Real HTTP carriers
      // surface that as a 401, so the fake must fail the pending call instead
      // of leaving it unsettled forever.
      setImmediate(() => {
        setImmediate(() => {
          if (this.pendingPlain === resolve) {
            this.pendingPlain = null;
            resolve(undefined);
          }
        });
      });
    });
  }

  respondPlain(object) {
    const peer = this.peer;
    this.pair.hop(this.name, () => {
      peer.pendingPlain?.(structuredClone(object));
    });
  }

  alive() {
    return !this.stopped;
  }
}

/**
 * Build the caps used by both fake endpoints.
 * @param {'A'|'B'} side - endpoint side.
 * @param {boolean} nativeTool - whether native approval forwarding is claimed.
 * @returns {object} caps object.
 */
function capsFor(side, nativeTool) {
  return buildCaps({
    side,
    host: side === 'A' ? 'astrbot' : 'dsh',
    version: '0.1.0',
    transports: ['longpoll', 'webhook', 'ws'],
    tls: false,
    rolesInitiate: true,
    rolesExecute: true,
    approvals: { business_decision: true, cross_end_submit: true, native_tool: nativeTool },
    attachments: {
      mime: ['image/gif', 'image/jpeg', 'image/png', 'image/webp'],
      max_bytes: Limits.MAX_IMAGE_BYTES,
      max_count: Limits.MAX_IMAGE_COUNT,
      max_total_bytes: Limits.MAX_TOTAL_IMAGE_BYTES,
      max_pixels: Limits.MAX_IMAGE_PIXELS,
      max_dimension: Limits.MAX_IMAGE_DIMENSION,
    },
  });
}

/**
 * Create a connected session pair.
 * @param {object} [options] - pair options.
 * @param {string} [options.pskId] - PSK id.
 * @param {string} [options.pskSecret] - PSK secret used by both sides.
 * @param {boolean} [options.nativeTool] - B-side native approval claim.
 * @returns {{pair: FakePair, a: Session, b: Session, messages: object[]}} pair.
 */
function makePair(options = {}) {
  const pair = new FakePair();
  const pskId = options.pskId ?? 'default';
  const pskSecret = options.pskSecret ?? 'correct horse battery staple';
  const conn = { id: 'default', pskId, pskSecret };
  const messages = [];
  const routerB = new Router();
  routerB.register('task.status', 'req', async () => ({ task_id: 'x', status: 'running' }));
  routerB.setReplySink(async (message) => sessionB.sendMessage(message));

  const sessionA = new Session(
    {
      conn,
      side: 'A',
      role: 'initiator',
      transportName: 'webhook',
      caps: capsFor('A', false),
      heartbeatS: 30,
      handshakeTimeoutMs: 300,
    },
    pair.a,
    { onMessage: (message) => messages.push({ side: 'A', message }) },
  );
  let sessionB;
  sessionB = new Session(
    {
      conn,
      side: 'B',
      role: 'responder',
      transportName: 'webhook',
      caps: capsFor('B', options.nativeTool ?? true),
      heartbeatS: 30,
      handshakeTimeoutMs: 300,
    },
    pair.b,
    {
      onMessage: async (message) => {
        messages.push({ side: 'B', message });
        await routerB.dispatch(message);
      },
    },
  );
  return { pair, a: sessionA, b: sessionB, messages, routerB };
}

test('handshake reaches ready on both sides with matching transcript', async () => {
  const { a, b } = makePair();
  const responder = b.start();
  await a.start();
  await responder;

  assert.equal(a.state, 'ready');
  assert.equal(b.state, 'ready');
  assert.equal(a.sid, b.sid);
  assert.match(a.sid, /^[0-9a-f-]{36}$/);
  assert.equal(a.peerCaps.side, 'B');
  assert.equal(b.peerCaps.side, 'A');
  // seq 0 is consumed by auth/auth_ack, so the next data frame is seq 1.
  // Each direction consumed exactly seq 0 (its handshake frame).
  assert.equal(a.receiveExpected, 1);
  assert.equal(b.receiveExpected, 1);
  await a.close('draining', 'test');
  await b.close('draining', 'test');
});

test('negotiated capabilities intersect both declarations', async () => {
  const { a, b } = makePair({ nativeTool: true });
  const responder = b.start();
  await a.start();
  await responder;
  const negotiated = a.negotiated();
  assert.equal(negotiated.roles.initiateTask, true);
  assert.equal(negotiated.approvals.nativeTool, false, 'A never claims native_tool');
  assert.deepEqual(negotiated.mime, ['image/gif', 'image/jpeg', 'image/png', 'image/webp']);
  assert.equal(negotiated.limits.maxChunkBytes, Limits.MAX_CHUNK_BYTES);
  assert.ok(negotiated.features.includes('event.ack'));
  assert.ok(a.peerSupports('task.cancel'));
  await a.close('draining', 'test');
  await b.close('draining', 'test');
});

test('a wrong PSK fails as psk_mismatch and never reaches ready', async () => {
  const pair = new FakePair();
  const good = { id: 'default', pskId: 'default', pskSecret: 'secret-one-long-enough' };
  const bad = { id: 'default', pskId: 'default', pskSecret: 'secret-two-long-enough' };
  const a = new Session(
    {
      conn: good,
      side: 'A',
      role: 'initiator',
      transportName: 'webhook',
      caps: capsFor('A', false),
      handshakeTimeoutMs: 300,
    },
    pair.a,
  );
  const b = new Session(
    {
      conn: bad,
      side: 'B',
      role: 'responder',
      transportName: 'webhook',
      caps: capsFor('B', true),
      handshakeTimeoutMs: 300,
    },
    pair.b,
  );
  const events = [];
  b._onSecurityEvent = (event) => events.push(event);
  // Teardown must happen exactly once: the handshake catch both reports the
  // fatal event and closes, so a second close would mean the failure was
  // handled twice (the double-`_fail` hazard).
  let closeCalls = 0;
  const closeSession = b.close.bind(b);
  b.close = (...args) => {
    closeCalls += 1;
    return closeSession(...args);
  };
  const responder = b.start().catch(() => {});
  await assert.rejects(a.start(), (error) => error instanceof BridgeError);
  await responder;
  assert.notEqual(b.state, 'ready');
  assert.equal(events.length, 1, 'the responder reports the fatal event exactly once');
  assert.equal(events[0].code, 'psk_mismatch');
  assert.equal(events[0].fatal, true);
  assert.equal(events[0].conn, 'default');
  assert.equal(closeCalls, 1, 'the responder tears the session down once');
  assert.equal(b.state, 'closed');
  assert.notEqual(a.state, 'ready');
});

test('a missing PSK is a configuration error, never a plaintext connection', async () => {
  const pair = new FakePair();
  const a = new Session(
    {
      conn: { id: 'default', pskId: 'default', pskSecret: '' },
      side: 'A',
      role: 'initiator',
      transportName: 'webhook',
      caps: capsFor('A', false),
    },
    pair.a,
  );
  await assert.rejects(
    a.start(),
    (error) => error instanceof BridgeError && error.code === 'psk_not_configured',
  );
  assert.equal(a.state, 'config_error');
});

test('the configured handshakeTimeoutMs drives the real timeout, not the default', async () => {
  // A carrier that accepts the handshake hooks but never delivers `hello`, so
  // the responder parks in `_waitForHandshake` until its timeout fires.
  const silentCarrier = {
    async start(_conn, hooks) {
      this.hooks = hooks;
    },
    async sendPlain() {
      return undefined;
    },
    respondPlain() {},
    async stop() {},
  };
  const session = new Session(
    {
      conn: { id: 'default', pskId: 'default', pskSecret: 'a'.repeat(40) },
      side: 'B',
      role: 'responder',
      transportName: 'webhook',
      caps: capsFor('B', true),
      // Far below Limits.HANDSHAKE_TIMEOUT_MS (10 s): if the instance value were
      // ignored the call below would take 10 s instead of ~250 ms.
      handshakeTimeoutMs: 250,
    },
    silentCarrier,
  );
  const started = Date.now();
  await assert.rejects(
    session.start(),
    (error) => error instanceof BridgeError && error.code === 'timeout',
  );
  const elapsedMs = Date.now() - started;
  assert.equal(session.handshakeTimeoutMs, 250);
  assert.ok(
    elapsedMs < 2_000,
    `the configured 250 ms timeout must be honoured (took ${elapsedMs} ms)`,
  );
  assert.equal(session.state, 'closed');
});

test('an unrepresentable handshakeTimeoutMs is a configuration error', async () => {
  // `setTimeout` turns 0, negatives and NaN into 1 ms, which would look like a
  // peer that timed out instantly. Such a value is a config mistake, so it must
  // be refused before the handshake starts.
  const silentCarrier = {
    async start(_conn, hooks) {
      this.hooks = hooks;
    },
    async sendPlain() {
      return undefined;
    },
    respondPlain() {},
    async stop() {},
  };
  for (const value of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const session = new Session(
      {
        conn: { id: 'default', pskId: 'default', pskSecret: 'a'.repeat(40) },
        side: 'B',
        role: 'responder',
        transportName: 'webhook',
        caps: capsFor('B', true),
        handshakeTimeoutMs: value,
      },
      silentCarrier,
    );
    await assert.rejects(
      session.start(),
      (error) =>
        error instanceof BridgeError &&
        error.code === 'config_invalid' &&
        error.details?.field === 'handshakeTimeoutMs',
      `handshakeTimeoutMs=${value} must be rejected as config_invalid`,
    );
    assert.equal(session.state, 'config_error');
  }
});

test('both endpoints configured as the same side is rejected', async () => {
  const pair = new FakePair();
  const conn = { id: 'default', pskId: 'default', pskSecret: 'a'.repeat(40) };
  const a = new Session(
    {
      conn,
      side: 'A',
      role: 'initiator',
      transportName: 'webhook',
      caps: capsFor('A', false),
      handshakeTimeoutMs: 300,
    },
    pair.a,
  );
  // The responder expects the opposite side; an "A" peer is invalid.
  const a2 = new Session(
    {
      conn,
      side: 'A',
      role: 'responder',
      transportName: 'webhook',
      caps: capsFor('A', false),
      handshakeTimeoutMs: 300,
    },
    pair.b,
  );
  const responder = a2.start().catch((error) => error);
  const initiatorError = await a.start().catch((error) => error);
  const responderError = await responder;
  assert.ok(initiatorError instanceof BridgeError || responderError instanceof BridgeError);
});

test('a replayed hello is rejected as hello_replay', async () => {
  const pair = new FakePair();
  const conn = { id: 'default', pskId: 'default', pskSecret: 'correct horse battery staple' };
  const initiator = new Session(
    {
      conn,
      side: 'A',
      role: 'initiator',
      transportName: 'webhook',
      caps: capsFor('A', false),
      handshakeTimeoutMs: 300,
    },
    pair.a,
  );
  const responderSession = new Session(
    {
      conn,
      side: 'B',
      role: 'responder',
      transportName: 'webhook',
      caps: capsFor('B', true),
      handshakeTimeoutMs: 300,
    },
    pair.b,
  );
  const started = responderSession.start();
  await initiator.start();
  await started;

  // Replay the exact consumed hello against a fresh responder instance, which
  // is where the hello_id/nonce_c cache is meaningful (§4.6 rule 2).
  const freshPair = new FakePair();
  const fresh = new Session(
    {
      conn,
      side: 'B',
      role: 'responder',
      transportName: 'webhook',
      caps: capsFor('B', true),
      handshakeTimeoutMs: 300,
    },
    freshPair.b,
  );
  const events = [];
  fresh._onSecurityEvent = (event) => events.push(event);
  fresh._setState('handshaking');
  fresh._helloReplay = new Map();
  await fresh.start().catch(() => {});
  // Reuse the consumed handshake identity on the same responder: the first
  // `hello` was accepted, so a second one with that id must be refused.
  const replayed = structuredClone(initiator._hello);
  fresh._helloReplay.clear();
  assert.throws(
    () => {
      fresh._acceptHello(replayed);
      fresh._acceptHello(replayed);
    },
    (error) => error instanceof BridgeError && error.code === 'hello_replay',
  );
  await initiator.close('draining', 'test');
  await responderSession.close('draining', 'test');
  await fresh.close('draining', 'test');
});

test('req/rep round-trips through the router and replies are paired', async () => {
  const { a, b } = makePair();
  const responder = b.start();
  await a.start();
  await responder;

  const result = await a.call('task.status', { task_id: 'x' }, 5);
  assert.deepEqual(result, { task_id: 'x', status: 'running' });
  await a.close('draining', 'test');
  await b.close('draining', 'test');
});

test('an unregistered request is answered with unknown_message', async () => {
  const { a, b } = makePair();
  const responder = b.start();
  await a.start();
  await responder;
  await assert.rejects(
    a.call('session.list', {}, 5),
    (error) => error instanceof BridgeError && error.code === 'unknown_message',
  );
  await a.close('draining', 'test');
  await b.close('draining', 'test');
});

test('the router executes a duplicated request id only once', async () => {
  const { pair } = makePair();
  const router = new Router();
  let runs = 0;
  router.register('task.status', 'req', async () => {
    runs += 1;
    return { runs };
  });
  const replies = [];
  router.setReplySink(async (message) => replies.push(message));

  const request = {
    k: 'req',
    m: 'task.status',
    id: '11111111-1111-4111-8111-111111111111',
    ts: new Date().toISOString(),
    params: {},
  };
  await router.dispatch(request);
  await router.dispatch(structuredClone(request));
  assert.equal(runs, 1, 'the handler must not run twice for one request id');
  assert.equal(replies.length, 2, 'the cached reply is resent, not re-executed');
  assert.equal(replies[0].result.runs, 1);
  assert.equal(replies[1].result.runs, 1);
  assert.equal(router.cachedReplies, 1);
  void pair;
});

test('concurrent calls get strictly increasing, duplicate-free seq', async () => {
  const { pair, a, b } = makePair();
  const sent = [];
  const original = pair.a.sendEnvelope.bind(pair.a);
  pair.a.sendEnvelope = async (envelope) => {
    sent.push(envelope.seq);
    return original(envelope);
  };
  const responder = b.start();
  await a.start();
  await responder;
  sent.length = 0;

  const count = 100;
  await Promise.all(
    Array.from({ length: count }, (_, index) => a.call('task.status', { task_id: String(index) }, 5)),
  );
  assert.equal(sent.length, count);
  const unique = new Set(sent);
  assert.equal(unique.size, count, 'no seq may be reused: that would reuse a nonce');
  const sorted = [...sent].sort((left, right) => left - right);
  assert.deepEqual(sent, sorted, 'enqueue order must equal seq order');
  // seq 0 belongs to `auth`; every later number is a request from this side.
  assert.equal(sorted[0], 1);
  await a.close('draining', 'test');
  await b.close('draining', 'test');
});

test('a replayed data frame is rejected as replay_detected and closes the session', async () => {
  const { pair, a, b } = makePair();
  const responder = b.start();
  await a.start();
  await responder;

  const captured = [];
  const original = pair.a.sendEnvelope.bind(pair.a);
  pair.a.sendEnvelope = async (envelope) => {
    captured.push(structuredClone(envelope));
    return original(envelope);
  };
  await a.call('task.status', { task_id: 'x' }, 5);
  const events = [];
  b._onSecurityEvent = (event) => events.push(event);
  const frame = captured.at(-1);
  await b._onEnvelope(structuredClone(frame));
  assert.ok(events.some((event) => event.code === 'replay_detected' && event.fatal));
  await a.close('draining', 'test');
});

test('a tampered frame is rejected as aead_failed', async () => {
  const { pair, a, b } = makePair();
  const responder = b.start();
  await a.start();
  await responder;

  // Capture a valid frame without delivering it, so the receive window has not
  // consumed its seq yet; the tamper detection must come from the AEAD tag.
  const captured = [];
  const original = pair.a.sendEnvelope.bind(pair.a);
  pair.a.sendEnvelope = async (envelope) => {
    captured.push(structuredClone(envelope));
  };
  await a.send(FrameType.PING, { n: 99 });

  const events = [];
  b._onSecurityEvent = (event) => events.push(event);
  const tampered = structuredClone(captured.at(-1));
  const bytes = Buffer.from(tampered.ct, 'base64url');
  bytes[bytes.length - 1] ^= 0xff;
  tampered.ct = bytes.toString('base64url');
  await b._onEnvelope(tampered);
  assert.ok(events.some((event) => event.code === 'aead_failed' && event.fatal));
  await a.close('draining', 'test');
});

test('ping is answered with pong and keeps the session alive', async () => {
  const { pair, a, b } = makePair();
  const responder = b.start();
  await a.start();
  await responder;

  const pongs = [];
  const original = pair.b.sendEnvelope.bind(pair.b);
  pair.b.sendEnvelope = async (envelope) => {
    if (envelope.type === FrameType.PONG) pongs.push(envelope);
    return original(envelope);
  };
  await a.send(FrameType.PING, { n: 7 });
  for (let index = 0; index < 20 && pongs.length === 0; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(pongs.length, 1, 'the responder must answer one ping with one pong');
  await a.close('draining', 'test');
  await b.close('draining', 'test');
});

test('closing the session drains pending calls instead of hanging them', async () => {
  const { a, b } = makePair();
  const responder = b.start();
  await a.start();
  await responder;
  // A request nobody answers: the responder has no handler for this name.
  const pending = a.call('session.list', {}, 30).catch((error) => error);
  await a.close('draining', 'test');
  const outcome = await pending;
  assert.ok(outcome instanceof BridgeError);
  await b.close('draining', 'test');
});

/**
 * Long-poll MAC projection tests (protocol §7.4).
 *
 * §7.4 does not MAC the raw wire objects. The poll query carries `target` while
 * the MAC input names the same field `mac_target`, `max`/`ts`/`wait` are
 * integers rather than decimal strings, and the ack MAC input drops `v`. These
 * tests pin that projection in both directions, because a disagreement between
 * signer and verifier shows up as an unexplained `poll_auth_failed` at runtime
 * rather than as a failing type check.
 * @module dsh-plugin-astrbot-bridge/tests/longpoll-mac-projection
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { test } from 'node:test';

import { Limits } from '../lib/constants.js';
import { macObject } from '../lib/crypto.js';
import { Session, buildCaps } from '../lib/session.js';
import { LongPollTransport } from '../lib/transport/longpoll.js';

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
 * Start a long-poll listener on an ephemeral port.
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

test('poll query MAC input renames target to mac_target and keeps integers', () => {
  const transport = new LongPollTransport({ pollWaitS: 7 });
  transport._cfg = { id: 'default', mode: 'connect', host: '127.0.0.1', port: 1, path: '/dsh-bridge', tlsEnabled: false };
  transport._sid = 'sid-1';
  transport._side = 'A';
  const signed = [];
  transport.signPoll = (object) => {
    signed.push(structuredClone(object));
    return 'mac-value';
  };

  const query = transport._buildPollQuery();

  // The wire keeps `target`, and never grows a `mac_target` member.
  assert.equal(query.target, 'poll');
  assert.equal(Object.hasOwn(query, 'mac_target'), false);
  assert.equal(query.mac, 'mac-value');

  assert.equal(signed.length, 1);
  const macObject = signed[0];
  assert.deepEqual(Object.keys(macObject).sort(), [
    'conn',
    'mac_target',
    'max',
    'nonce',
    'sid',
    'side',
    'ts',
    'wait',
  ]);
  assert.equal(macObject.mac_target, 'poll');
  assert.equal('target' in macObject, false);
  assert.equal('mac' in macObject, false);
  // Numbers, not decimal strings: JCS would serialize "25" and 25 differently.
  assert.equal(typeof macObject.wait, 'number');
  assert.equal(typeof macObject.max, 'number');
  assert.equal(typeof macObject.ts, 'number');
  assert.equal(macObject.wait, 7);
  assert.equal(macObject.max, Limits.POLL_MAX_FRAMES);
  assert.equal(macObject.sid, 'sid-1');
  assert.equal(macObject.side, 'A');
  assert.equal(macObject.conn, 'default');
  assert.ok(Number.isSafeInteger(macObject.ts) && macObject.ts > 0);
});

test('inbound poll is verified with the identical projection', async () => {
  const conn = { id: 'default', pskId: 'default', pskSecret: 'correct horse battery staple' };
  const listener = await startListener(conn);
  try {
    const seen = [];
    listener.transport.verifyPoll = (object) => {
      seen.push(structuredClone(object));
    };
    const url = `http://127.0.0.1:${listener.port}/dsh-bridge/poll`
      + '?conn=default&sid=x&side=A&wait=0&max=4&ts=1761737001000&nonce=abcdefgh&target=poll&mac=deadbeef';
    const response = await fetch(url);
    assert.equal(response.status, 204);

    assert.equal(seen.length, 1);
    const macObject = seen[0];
    assert.equal(macObject.mac_target, 'poll');
    assert.equal('target' in macObject, false);
    assert.equal(macObject.wait, 0);
    assert.equal(macObject.max, 4);
    assert.equal(macObject.ts, 1_761_737_001_000);
    assert.equal(macObject.mac, 'deadbeef');
  } finally {
    await listener.session.close('draining', 'test');
  }
});

test('inbound poll refuses a non-integer or out-of-range numeric member', async () => {
  const conn = { id: 'default', pskId: 'default', pskSecret: 'correct horse battery staple' };
  const listener = await startListener(conn);
  try {
    listener.transport.verifyPoll = () => {};
    const base = 'conn=default&sid=x&side=A&nonce=abcdefgh&target=poll&mac=deadbeef';
    const cases = [
      `wait=1.5&max=4&ts=1&${base}`,
      `wait=03&max=4&ts=1&${base}`,
      `wait=26&max=4&ts=1&${base}`,
      `wait=0&max=0&ts=1&${base}`,
      `wait=0&max=33&ts=1&${base}`,
      `wait=0&max=4&ts=1e3&${base}`,
      // `target` must be exactly `poll`; `mac_target` is not a wire alias.
      `wait=0&max=4&ts=1&conn=default&sid=x&side=A&nonce=abcdefgh&target=mac_target&mac=deadbeef`,
    ];
    for (const query of cases) {
      const response = await fetch(`http://127.0.0.1:${listener.port}/dsh-bridge/poll?${query}`);
      assert.equal(response.status, 401, query);
      assert.equal((await response.json()).error.code, 'poll_auth_failed', query);
    }
  } finally {
    await listener.session.close('draining', 'test');
  }
});

test('poll ack is signed with mac_target poll_ack and no v', () => {
  const transport = new LongPollTransport({});
  const signed = [];
  transport.signPollAck = (object) => {
    signed.push(structuredClone(object));
    return 'mac-value';
  };

  // `_sendAck` posts to the peer, so only its MAC projection is under test here.
  return (async () => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        assert.equal(body.target, 'poll_ack');
        assert.equal(body.v, 1);
        assert.equal(body.mac, 'mac-value');
        assert.deepEqual(body.acks, ['data#1', 'evt#2']);
        res.statusCode = 204;
        res.end();
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      transport._cfg = {
        id: 'default',
        mode: 'connect',
        host: '127.0.0.1',
        port: server.address().port,
        path: '/dsh-bridge',
        tlsEnabled: false,
      };
      transport._sid = 'sid-1';
      transport._side = 'A';
      await transport._sendAck(['data#1', 'evt#2']);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }

    assert.equal(signed.length, 1);
    const macObject = signed[0];
    assert.deepEqual(Object.keys(macObject).sort(), ['acks', 'conn', 'mac_target', 'nonce', 'sid', 'side', 'ts']);
    assert.equal(macObject.mac_target, 'poll_ack');
    assert.equal('target' in macObject, false);
    assert.equal('v' in macObject, false);
    assert.equal('mac' in macObject, false);
    assert.equal(typeof macObject.ts, 'number');
    assert.deepEqual(macObject.acks, ['data#1', 'evt#2']);
  })();
});

test('inbound ack is verified with the identical projection', async () => {
  const conn = { id: 'default', pskId: 'default', pskSecret: 'correct horse battery staple' };
  const listener = await startListener(conn);
  try {
    const seen = [];
    listener.transport.verifyPollAck = (object) => {
      seen.push(structuredClone(object));
    };
    const response = await fetch(`http://127.0.0.1:${listener.port}/dsh-bridge/poll/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        v: 1,
        conn: 'default',
        sid: 'x',
        side: 'A',
        ts: 1_761_737_001_100,
        target: 'poll_ack',
        nonce: 'abcdefgh',
        acks: ['data#1'],
        mac: 'deadbeef',
        // Unknown members must stay outside the MAC input (§17).
        extra: 'ignored',
      }),
    });
    assert.equal(response.status, 204);

    assert.equal(seen.length, 1);
    const macObject = seen[0];
    assert.equal(macObject.mac_target, 'poll_ack');
    assert.equal('target' in macObject, false);
    assert.equal('extra' in macObject, false);
    assert.equal(typeof macObject.ts, 'number');
    assert.deepEqual(macObject.acks, ['data#1']);
    assert.equal(macObject.mac, 'deadbeef');
  } finally {
    await listener.session.close('draining', 'test');
  }
});

test('a real poll then ack round-trip authenticates on both hops', async () => {
  const conn = { id: 'default', pskId: 'default', pskSecret: 'correct horse battery staple' };
  const listener = await startListener(conn);
  // A genuine handshake is required: the HTTP MAC keys only exist once the
  // session is ready, and stubbing them would test the stub, not the projection.
  const dialerTransport = new LongPollTransport({ pollWaitS: 0 });
  const dialer = new Session(
    {
      conn: connConfig(conn, 'connect', listener.port),
      side: 'A',
      role: 'initiator',
      transportName: 'longpoll',
      caps: capsFor('A'),
      handshakeTimeoutMs: 3000,
    },
    dialerTransport,
  );
  try {
    await dialer.start();
    await listener.started;
    // The handshake leaves the pull loop running with `wait=0`, which polls in
    // a tight loop. Stop it and let the in-flight round settle so this test
    // drives both hops itself; the session keys stay loaded, which is what the
    // MAC projection needs.
    dialerTransport._stopPolling();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (dialerTransport._pollTimer === null) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    dialerTransport._sid = dialer.sid;
    dialerTransport._side = 'A';

    // Hop 1: `_buildPollQuery()` signs the §7.4 projection; the peer verifies it
    // with the same construction and accepts the empty window (204).
    const query = dialerTransport._buildPollQuery();
    const encoded = new URLSearchParams(
      Object.entries(query).map(([key, value]) => [key, String(value)]),
    ).toString();
    const polled = await fetch(`http://127.0.0.1:${listener.port}/dsh-bridge/poll?${encoded}`);
    assert.equal(polled.status, 204);

    // Hop 2: `_sendAck()` signs the ack projection; the peer verifies it and
    // answers 204. An unknown ref is a no-op in the queue, so this asserts the
    // MAC contract without depending on frame dispatch.
    await dialerTransport._sendAck(['data#5']);
  } finally {
    await dialer.close('draining', 'test');
    await listener.session.close('draining', 'test');
  }
});

// ---------------------------------------------------------------------------
// Adversarial half: the projection is only worth pinning if the *wrong* shapes
// are refused. These cases sign with the session's real HTTP keys (independently
// of `LongPollTransport`), so they fail if a raw-query fallback is ever added.
// ---------------------------------------------------------------------------

/**
 * Start a listener plus a dialer and wait for `ready` on both sides.
 *
 * The handshake is what installs the HTTP MAC keys, so it cannot be stubbed.
 * The dialer's pull loop is then stopped: these cases drive `/poll` themselves
 * and a competing long-poll would consume the frames under assertion.
 * @param {object} [options] - options.
 * @param {number} [options.pollWaitS] - dialer wait window.
 * @returns {Promise<object>} pair context.
 */
async function startReadyPair(options = {}) {
  const conn = { id: 'default', pskId: 'default', pskSecret: 'correct horse battery staple' };
  const listenerTransport = new LongPollTransport();
  const listener = new Session(
    {
      conn: connConfig(conn, 'listen', 0),
      side: 'B',
      role: 'responder',
      transportName: 'longpoll',
      caps: capsFor('B'),
      handshakeTimeoutMs: 3000,
    },
    listenerTransport,
  );
  const started = listener.start().catch((error) => error);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (listenerTransport._server?.address()) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const port = listenerTransport._server.address().port;

  const dialerTransport = new LongPollTransport({ pollWaitS: options.pollWaitS ?? 0 });
  const dialer = new Session(
    {
      conn: connConfig(conn, 'connect', port),
      side: 'A',
      role: 'initiator',
      transportName: 'longpoll',
      caps: capsFor('A'),
      handshakeTimeoutMs: 3000,
    },
    dialerTransport,
  );
  await dialer.start();
  await started;
  dialerTransport._stopPolling();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (dialerTransport._pollTimer === null) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(listener.state, 'ready');
  assert.equal(dialer.state, 'ready');
  return { conn, listener, listenerTransport, dialer, dialerTransport, port };
}

/**
 * Tear a pair down without letting one failure mask the other.
 * @param {object} pair - pair context.
 * @returns {Promise<void>} resolution after teardown.
 */
async function closePair(pair) {
  for (const session of [pair.dialer, pair.listener]) {
    try {
      await session.close('draining', 'test');
    } catch {
      // Already closed by the case under test.
    }
  }
}

/**
 * Build the canonical §7.4 poll fields with a fresh nonce.
 * @param {object} pair - pair context.
 * @param {object} [overrides] - field overrides.
 * @returns {object} fields.
 */
function pollFields(pair, overrides = {}) {
  return {
    conn: pair.conn.id,
    sid: pair.listener.sid,
    side: 'A',
    wait: 0,
    max: 4,
    ts: Date.now(),
    nonce: randomBytes(16).toString('base64url'),
    ...overrides,
  };
}

/**
 * Sign the canonical projection with the A→B HTTP key.
 * @param {object} pair - pair context.
 * @param {object} fields - canonical fields.
 * @returns {string} base64url MAC.
 */
function signProjected(pair, fields) {
  return macObject(pair.listener._keys.kHttpA2b, {
    conn: fields.conn,
    mac_target: 'poll',
    max: fields.max,
    nonce: fields.nonce,
    side: fields.side,
    sid: fields.sid,
    ts: fields.ts,
    wait: fields.wait,
  });
}

/**
 * Sign the shape the defect used: raw query, `target`, stringified numbers.
 * @param {object} pair - pair context.
 * @param {object} fields - wire fields.
 * @returns {string} base64url MAC.
 */
function signRaw(pair, fields) {
  return macObject(pair.listener._keys.kHttpA2b, {
    conn: fields.conn,
    max: String(fields.max),
    nonce: fields.nonce,
    side: fields.side,
    sid: fields.sid,
    target: 'poll',
    ts: String(fields.ts),
    wait: String(fields.wait),
  });
}

/**
 * Build a poll URL from explicit wire values and MAC.
 * @param {object} pair - pair context.
 * @param {object} fields - wire fields (may differ from the signed ones).
 * @param {string} mac - MAC to send.
 * @returns {string} absolute URL.
 */
function pollUrl(pair, fields, mac) {
  const encoded = new URLSearchParams(
    Object.entries({
      conn: fields.conn,
      sid: fields.sid,
      side: fields.side,
      wait: String(fields.wait),
      max: String(fields.max),
      ts: String(fields.ts),
      nonce: fields.nonce,
      target: 'poll',
      mac,
    }).map(([key, value]) => [key, String(value)]),
  ).toString();
  return `http://127.0.0.1:${pair.port}/dsh-bridge/poll?${encoded}`;
}

/**
 * Sign a poll-ack body under one HTTP direction key.
 * @param {object} pair - pair context.
 * @param {object} body - wire body without `mac`.
 * @param {'A'|'B'} direction - key direction.
 * @returns {string} base64url MAC.
 */
function signAck(pair, body, direction = 'A') {
  const key = direction === 'A'
    ? pair.listener._keys.kHttpA2b
    : pair.listener._keys.kHttpB2a;
  return macObject(key, {
    acks: body.acks,
    conn: body.conn,
    mac_target: 'poll_ack',
    nonce: body.nonce,
    side: body.side,
    sid: body.sid,
    ts: body.ts,
  });
}

test('a raw-query poll MAC (target + stringified numbers) is refused', async () => {
  const pair = await startReadyPair();
  try {
    const fields = pollFields(pair);
    const response = await fetch(pollUrl(pair, fields, signRaw(pair, fields)));
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, 'poll_auth_failed');
    // The projection is not merely *preferred*: it is the only accepted shape.
    const good = pollFields(pair);
    const projected = await fetch(pollUrl(pair, good, signProjected(pair, good)));
    assert.notEqual(projected.status, 401, 'a correctly projected poll must still authenticate');
  } finally {
    await closePair(pair);
  }
});

test('a poll whose wire member differs from the signed projection is refused', async () => {
  const pair = await startReadyPair();
  try {
    for (const [name, wireValue] of [['max', 5], ['wait', 1], ['ts', Date.now() + 1]]) {
      const signed = pollFields(pair);
      const mac = signProjected(pair, signed);
      const tamp = { ...signed, [name]: wireValue };
      const response = await fetch(pollUrl(pair, tamp, mac));
      assert.equal(response.status, 401, `tampered ${name} must be refused`);
    }
    // A tampered sid is a session-identity failure, not a MAC failure: §15
    // gives `sid_mismatch` its own 409 face and the peer re-handshakes on it.
    const signed = pollFields(pair);
    const tamped = { ...signed, sid: 'someone-else' };
    const stale = await fetch(pollUrl(pair, tamped, signProjected(pair, signed)));
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).error.code, 'sid_mismatch');
  } finally {
    await closePair(pair);
  }
});

test('a replayed poll (same sid, side, nonce) is refused on the second use', async () => {
  const pair = await startReadyPair();
  try {
    const fields = pollFields(pair);
    const mac = signProjected(pair, fields);
    const url = pollUrl(pair, fields, mac);
    assert.equal((await fetch(url)).status, 204, 'the first use is legitimate');
    // Same nonce, freshly MACed: only the nonce cache can catch this, so it
    // also proves the replay guard is not bypassed by a valid signature. The
    // refusal must keep its own §15 face: a 401 here would read as "wrong keys"
    // to both sides and suppress the re-handshake.
    const replay = await fetch(url);
    assert.equal(replay.status, 409, 'a reused nonce must not be served');
    assert.equal((await replay.json()).error.code, 'replay_detected');
    // A *new* nonce is a new request and must still work.
    const fresh = pollFields(pair);
    assert.equal((await fetch(pollUrl(pair, fresh, signProjected(pair, fresh)))).status, 204);
  } finally {
    await closePair(pair);
  }
});

test('duplicate or malformed numeric query members are refused', async () => {
  const pair = await startReadyPair();
  try {
    const base = pollFields(pair);
    const mac = signProjected(pair, base);
    const url = pollUrl(pair, base, mac);
    assert.equal((await fetch(`${url}&max=4`)).status, 401, 'a repeated max must be refused');
    assert.equal((await fetch(`${url}&mac=x`)).status, 401, 'a repeated mac must be refused');

    for (const value of ['0', '33', '4.0', '1e1', ' 4']) {
      const fields = pollFields(pair);
      const response = await fetch(pollUrl(pair, { ...fields, max: value }, signProjected(pair, fields)));
      assert.equal(response.status, 401, `max=${value} must be refused`);
    }
    for (const value of ['-1', '26', '2.5']) {
      const fields = pollFields(pair);
      const response = await fetch(pollUrl(pair, { ...fields, wait: value }, signProjected(pair, fields)));
      assert.equal(response.status, 401, `wait=${value} must be refused`);
    }
  } finally {
    await closePair(pair);
  }
});

test('a poll for a stale sid answers 409 sid_mismatch, not 401', async () => {
  const pair = await startReadyPair();
  try {
    // A MAC-valid poll naming the previous session proves the refusal comes
    // from the session layer, and that its 409 survives the auth `catch`.
    const fields = pollFields(pair, { sid: 'previous-session' });
    const response = await fetch(pollUrl(pair, fields, signProjected(pair, fields)));
    assert.equal(response.status, 409, 'a stale sid must not be reported as an auth failure');
    assert.equal((await response.json()).error.code, 'sid_mismatch');

    // A structural failure is still 401: `bad_params` is not on the allowlist.
    const malformed = { ...pollFields(pair), max: 'abc' };
    const refused = await fetch(pollUrl(pair, malformed, signProjected(pair, malformed)));
    assert.equal(refused.status, 401, 'bad_params must not masquerade as a session signal');
    assert.equal((await refused.json()).error.code, 'poll_auth_failed');
  } finally {
    await closePair(pair);
  }
});

test('poll ack keeps replay_detected and not_ready instead of folding them into 401', async () => {
  const pair = await startReadyPair();
  try {
    /**
     * Build one ack body.
     * @param {object} [overrides] - member overrides.
     * @returns {object} body without `mac`.
     */
    const ackBody = (overrides = {}) => ({
      v: 1,
      conn: 'default',
      sid: pair.listener.sid,
      side: 'A',
      ts: Date.now(),
      target: 'poll_ack',
      nonce: randomBytes(16).toString('base64url'),
      acks: ['data#1'],
      ...overrides,
    });
    const postAck = (body) => fetch(`http://127.0.0.1:${pair.port}/dsh-bridge/poll/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, mac: signAck(pair, body, 'A') }),
    });

    const first = ackBody();
    assert.equal((await postAck(first)).status, 204);
    const replayed = await postAck(first);
    assert.equal(replayed.status, 409, 'a reused ack nonce must not be reported as an auth failure');
    assert.equal((await replayed.json()).error.code, 'replay_detected');

    // Sign while the keys are still loaded, then drop them: the responder's
    // verifier then raises `not_ready` (425), which the peer must retry rather
    // than read as a key mismatch.
    const coldBody = ackBody();
    const coldMac = signAck(pair, coldBody, 'A');
    pair.listener._keys = null;
    const cold = await fetch(`http://127.0.0.1:${pair.port}/dsh-bridge/poll/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...coldBody, mac: coldMac }),
    });
    assert.equal(cold.status, 425, 'not_ready must keep its 425 face');
    assert.equal((await cold.json()).error.code, 'not_ready');
  } finally {
    await closePair(pair);
  }
});

test('poll fails closed when no verifier is installed', async () => {
  // Out of range deliberately: an out-of-range write that succeeds is a bug.
  const transport = new LongPollTransport();
  const conn = { id: 'default', pskId: 'default', pskSecret: 'correct horse battery staple' };
  let port;
  try {
    await transport.start(connConfig(conn, 'listen', 0), {
      onPlain: () => {},
      onEnvelope: () => {},
      onState: () => {},
    });
    port = transport._server.address().port;
    const encoded = new URLSearchParams({
      conn: 'default',
      sid: 'x',
      side: 'A',
      wait: '0',
      max: '4',
      ts: String(Date.now()),
      nonce: randomBytes(16).toString('base64url'),
      target: 'poll',
      mac: randomBytes(32).toString('base64url'),
    }).toString();
    const response = await fetch(`http://127.0.0.1:${port}/dsh-bridge/poll?${encoded}`);
    assert.equal(response.status, 401, 'an unauthenticated read must never be answered');
    assert.equal((await response.json()).error.code, 'poll_auth_failed');
  } finally {
    await transport.stop();
  }
});

test('poll ack requires the projection, the requesting-side key, and real refs', async () => {
  const pair = await startReadyPair();
  try {
    pair.listenerTransport._queue.push({ v: 1, type: 'data', conn: 'default', seq: 7, ct: 'AAAA' });
    const fields = pollFields(pair);
    const polled = await fetch(pollUrl(pair, fields, signProjected(pair, fields)));
    assert.equal(polled.status, 200);
    const delivered = await polled.json();
    assert.equal(delivered.frames.length, 1);
    assert.equal(`data#${delivered.frames[0].seq}`, 'data#7');
    assert.equal(pair.listenerTransport.retained, 1, 'delivery alone must not drop a frame');

    /**
     * Build one ack body.
     * @param {object} [overrides] - member overrides.
     * @returns {object} body without `mac`.
     */
    const ackBody = (overrides = {}) => ({
      v: 1,
      conn: 'default',
      sid: pair.listener.sid,
      side: 'A',
      ts: Date.now(),
      target: 'poll_ack',
      nonce: randomBytes(16).toString('base64url'),
      acks: ['data#7'],
      ...overrides,
    });
    const post = (body, direction = 'A') => fetch(`http://127.0.0.1:${pair.port}/dsh-bridge/poll/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, mac: signAck(pair, body, direction) }),
    });

    // A MAC over the whole raw body (`v`/`target` included) is a different JCS
    // message and must not be accepted.
    const rawBody = ackBody();
    const rawMac = macObject(pair.listener._keys.kHttpA2b, { ...rawBody });
    const rawResponse = await fetch(`http://127.0.0.1:${pair.port}/dsh-bridge/poll/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...rawBody, mac: rawMac }),
    });
    assert.equal(rawResponse.status, 401, 'a raw-body ack MAC must be refused');
    assert.equal(pair.listenerTransport.retained, 1);

    // The ack travels in the requester's direction: B→A key is the wrong one.
    assert.equal((await post(ackBody(), 'B')).status, 401, 'the ack must use the requesting-side key');
    assert.equal(pair.listenerTransport.retained, 1);

    // Acking a ref that was never delivered must not release anything.
    assert.equal((await post(ackBody({ acks: ['data#8'] }))).status, 204);
    assert.equal(pair.listenerTransport.retained, 1, 'data#7 must survive an ack for data#8');

    assert.equal((await post(ackBody())).status, 204);
    assert.equal(pair.listenerTransport.retained, 0, 'the acked frame is released');
  } finally {
    await closePair(pair);
  }
});

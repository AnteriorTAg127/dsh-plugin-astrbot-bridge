/**
 * Golden-vector suite (protocol §18.6, items 1–13).
 *
 * Every expectation comes from `tests/fixtures/protocol_vectors_v1.json`, a
 * read-only copy of the frozen `开发/v0.1/vectors.json`. Nothing here hard-codes
 * an expected hex string: a mismatch must point at the implementation, never at
 * a duplicated constant.
 * @module dsh-plugin-astrbot-bridge/tests/vectors
 */

import assert from 'node:assert/strict';
import { hkdfSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { LABEL } from '../lib/constants.js';
import {
  approvalRequestDigest,
  assertHandshakeValue,
  b64u,
  b64uDec,
  handshakeKey,
  handshakeTranscript,
  hkdfExpand,
  hkdfExtract,
  inputPartsDigest,
  jcsAscii,
  jcsFrame,
  macObject,
  openFrame,
  pskMaster,
  sealFrame,
  sessionKeys,
  sha256,
  submitDigest,
  verifyMac,
} from '../lib/crypto.js';
import { BridgeError } from '../lib/errors.js';
import { ReplayWindow } from '../lib/replay.js';

const V = JSON.parse(readFileSync(new URL('./fixtures/protocol_vectors_v1.json', import.meta.url), 'utf8'));
const I = V.inputs;

const NONCE_C = Buffer.from(I.nonce_c_hex, 'hex');
const NONCE_S = Buffer.from(I.nonce_s_hex, 'hex');
const PSK = pskMaster(I.psk_id, I.psk_secret);
const KEYS = sessionKeys(PSK, NONCE_C, NONCE_S);
const K_HELLO = handshakeKey(PSK, 'hello');
const K_HELLO_ACK = handshakeKey(PSK, 'hello_ack');
const K_PROBE = handshakeKey(PSK, 'probe');
const K_PROBE_ACK = handshakeKey(PSK, 'probe_ack');

/**
 * Recompute a §5.2 frame nonce independently of `lib/crypto.js`.
 * @param {'A'|'B'} side - sender side.
 * @param {number} seq - sequence number.
 * @returns {Buffer} 12-byte nonce.
 */
function nonceOf(side, seq) {
  const nonce = Buffer.alloc(12);
  nonce.writeUInt32BE(side === 'A' ? 10 : 11, 0);
  nonce.writeBigUInt64BE(BigInt(seq), 4);
  return nonce;
}

test('vector 01: jcs_ascii matches every published example', () => {
  for (const example of V.jcs_examples) {
    assert.equal(jcsAscii(example.in), example.out);
  }
});

test('vector 02: psk_master matches the fixture', () => {
  assert.equal(PSK.toString('hex'), V.keys.psk_master_hex);
});

test('vector 03: jcs_ascii(hello without mac) has the fixture length', () => {
  assert.equal(Buffer.byteLength(jcsAscii(V.hello_without_mac)), V.jcs_hello_len);
  assert.equal(Buffer.byteLength(jcsAscii(V.hello_ack_without_mac)), V.jcs_hello_ack_len);
});

test('vector 04: hello and hello_ack MACs match the fixture', () => {
  assert.equal(macObject(K_HELLO, V.hello_without_mac), V.hellos.hello_mac);
  assert.equal(macObject(K_HELLO_ACK, V.hello_ack_without_mac), V.hellos.hello_ack_mac);
  assert.ok(verifyMac(K_HELLO, V.hello_without_mac, V.hellos.hello_mac));
  assert.ok(verifyMac(K_HELLO_ACK, V.hello_ack_without_mac, V.hellos.hello_ack_mac));
  assert.ok(!verifyMac(K_HELLO, V.hello_ack_without_mac, V.hellos.hello_ack_mac));
});

test('vector 05: transcript digest and th match the fixture', () => {
  const th = handshakeTranscript(V.hello_without_mac, V.hello_ack_without_mac);
  assert.equal(th.toString('hex'), V.hellos.transcript_sha256_hex);
  assert.equal(b64u(th), V.hellos.th_b64u);
});

test('vector 06: PRK and the four session keys match the fixture', () => {
  assert.equal(KEYS.prk.toString('hex'), V.keys.prk_hex);
  assert.equal(KEYS.kA2b.toString('hex'), V.keys.k_a2b_hex);
  assert.equal(KEYS.kB2a.toString('hex'), V.keys.k_b2a_hex);
  assert.equal(KEYS.kHttpA2b.toString('hex'), V.keys.k_http_a2b_hex);
  assert.equal(KEYS.kHttpB2a.toString('hex'), V.keys.k_http_b2a_hex);
});

/** Build the §5.1 envelope a fixture frame corresponds to. */
function envelopeOf(frame) {
  return { v: 1, type: frame.type, conn: I.conn, seq: frame.seq, ct: frame.ct };
}

test('vector 07: sealing the auth payload reproduces ct and opens back', () => {
  const frame = V.frames[0];
  const sealed = sealFrame(KEYS, 'A', frame.type, I.conn, frame.seq, frame.payload);
  assert.deepEqual(sealed, envelopeOf(frame));
  assert.deepEqual(openFrame(KEYS, 'A', sealed), frame.payload);
});

test('vector 08: opening the auth_ack frame yields the fixture transcript', () => {
  const frame = V.frames[1];
  const opened = openFrame(KEYS, 'B', envelopeOf(frame));
  assert.deepEqual(opened, frame.payload);
  assert.equal(opened.th, V.hellos.th_b64u);
  assert.equal(opened.role, 'responder');
});

test('vector 09: every data, ping and close frame reproduces its ct', () => {
  for (const frame of V.frames) {
    const sealed = sealFrame(KEYS, frame.sender_side, frame.type, I.conn, frame.seq, frame.payload);
    assert.equal(sealed.ct, frame.ct, `${frame.type}#${frame.seq}`);
    assert.deepEqual(openFrame(KEYS, frame.sender_side, envelopeOf(frame)), frame.payload);
  }
});

test('vector 10: input_parts_digest, submit_digest and HTTP MACs match', () => {
  assert.equal(inputPartsDigest(V.digests.text_parts), V.digests.input_parts_digest_b64u);
  assert.equal(submitDigest(V.digests.submit_projection), V.digests.submit_digest_b64u);
  assert.equal(macObject(K_PROBE, V.macs.probe_object), V.macs.probe_mac);
  assert.equal(macObject(K_PROBE_ACK, V.macs.probe_ack_object), V.macs.probe_ack_mac);
  assert.equal(macObject(KEYS.kHttpA2b, V.macs.poll_object), V.macs.poll_mac);
  // §7.4: the poll_ack MAC uses the *requesting* side's direction. The fixture
  // request is side A, so its acknowledgment is authenticated with A→B.
  assert.equal(macObject(KEYS.kHttpA2b, V.macs.poll_ack_object), V.macs.poll_ack_mac);
});

test('vector 11: tampered ct fails as aead_failed; replayed seq is rejected', () => {
  const frame = V.frames[3];
  const body = b64uDec(frame.ct);
  body[0] ^= 0xff;
  assert.throws(
    () => openFrame(KEYS, 'A', { ...envelopeOf(frame), ct: b64u(body) }),
    (error) => error instanceof BridgeError && error.code === 'aead_failed' && error.fatal,
  );

  const window = new ReplayWindow(0);
  assert.ok(window.accept(0));
  assert.ok(window.accept(1));
  assert.throws(
    () => window.accept(1),
    (error) => error instanceof BridgeError && error.code === 'replay_detected' && error.fatal,
  );
});

test('vector 12: an old auth_ack cannot be replayed into a new session', () => {
  const frame = V.frames[1];
  const otherKeys = sessionKeys(PSK, NONCE_C, Buffer.alloc(32, 7));
  assert.throws(
    () => openFrame(otherKeys, 'B', envelopeOf(frame)),
    (error) => error instanceof BridgeError && error.code === 'aead_failed',
  );
  const opaque = new BridgeError('stale_session');
  assert.equal(opaque.code, 'stale_session');
  assert.ok(opaque.fatal);
});

test('vector 13: hkdfExpand is expand-only and differs from hkdfSync', () => {
  const prk = Buffer.from(V.keys.prk_hex, 'hex');
  const info = Buffer.from(`${LABEL} a2b`, 'utf8');
  assert.equal(hkdfExpand(prk, info, 32).toString('hex'), V.keys.k_a2b_hex);

  // hkdfSync always extracts first, so handing it the PRK as IKM must not
  // reproduce the fixture key. If it did, this build would be using it.
  const viaSync = Buffer.from(hkdfSync('sha256', prk, Buffer.alloc(0), info, 32));
  assert.notEqual(viaSync.toString('hex'), V.keys.k_a2b_hex);
  assert.equal(hkdfExtract(Buffer.alloc(32), PSK).length, 32);
});

test('vector 14: the fixture label is the constant used for derivation and AAD', () => {
  assert.equal(V.label, LABEL);
  for (const frame of V.frames) {
    assert.equal(frame.aad, `${LABEL}|${frame.type}|${I.conn}|${frame.seq}`);
  }
});

test('vector 15: frame nonces bind direction and sequence', () => {
  for (const frame of V.frames) {
    assert.equal(frame.nonce, b64u(nonceOf(frame.sender_side, frame.seq)));
  }
});

test('vector 16: submit_digest covers the projection only', () => {
  const projection = V.digests.submit_projection;
  assert.equal(submitDigest(projection), V.digests.submit_digest_b64u);
  assert.notEqual(V.digests.submit_digest_b64u, V.digests.input_parts_digest_b64u);
  assert.notEqual(
    submitDigest({ ...projection, purpose: `${projection.purpose}-x` }),
    V.digests.submit_digest_b64u,
  );
  assert.notEqual(
    submitDigest({ ...projection, attachments: [] }),
    V.digests.submit_digest_b64u,
  );
});

test('vector 17: approval request_digest is stable and field-sensitive', () => {
  const input = {
    tool: 'bash',
    reason: 'run tests',
    callId: 'call-1',
    sessionId: 'sid-1',
    taskId: 'task-1',
  };
  const digest = approvalRequestDigest(input);
  assert.equal(digest, approvalRequestDigest({ ...input }));
  assert.notEqual(digest, approvalRequestDigest({ ...input, tool: 'fs_write' }));
  assert.notEqual(digest, approvalRequestDigest({ ...input, callId: null }));
});

test('vector 18: jcs_frame allows payload text that jcs_ascii refuses', () => {
  const payload = { text: '请为这个函数写单元测试。' };
  assert.equal(jcsFrame(payload), JSON.stringify(payload));
  assert.throws(
    () => jcsAscii(payload),
    (error) => error instanceof BridgeError && error.code === 'bad_handshake_encoding',
  );
  assert.equal(jcsFrame({ a: null }), '{"a":null}');
  // `null` is serializable in both profiles (§2.5 lists it as identical); the
  // "handshake objects carry no null" rule is a separate shape check.
  assert.equal(jcsAscii({ a: null }), '{"a":null}');
  assert.throws(
    () => assertHandshakeValue({ a: null }),
    (error) => error instanceof BridgeError && error.code === 'bad_handshake_encoding',
  );
  assert.throws(() => assertHandshakeValue({ a: '中' }), BridgeError);
  assert.doesNotThrow(() => assertHandshakeValue(V.hello_without_mac));
  assert.throws(() => jcsAscii({ a: 1.5 }), BridgeError);
  assert.equal(sha256('x').length, 32);
  assert.equal(b64uDec('AAECAwQFBgcICQoLDA0ODw').length, 16);
});

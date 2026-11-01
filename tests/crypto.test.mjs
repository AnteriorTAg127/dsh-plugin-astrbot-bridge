/**
 * Crypto unit tests beyond the golden vectors.
 *
 * The vectors prove the suite is byte-compatible with the other
 * implementation; these tests pin the *properties* the protocol relies on:
 * HKDF is expand-only, the profile serializers are canonical, the AEAD binding
 * separates direction/type/seq/conn, and no failure path leaks text.
 * @module dsh-plugin-astrbot-bridge/tests/crypto
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LABEL } from '../lib/constants.js';
import {
  assertHandshakeValue,
  b64u,
  b64uDec,
  constantTimeEqual,
  frameAad,
  frameNonce,
  handshakeKey,
  hkdfExpand,
  hkdfExtract,
  inputPartsDigest,
  jcsAscii,
  jcsFrame,
  lengthPrefixed,
  macObject,
  openFrame,
  pskMaster,
  sealFrame,
  sessionKeys,
  sha256,
  verifyMac,
} from '../lib/crypto.js';
import { BridgeError } from '../lib/errors.js';

const PSK = pskMaster('conn-a', 'a'.repeat(43));
const NONCE_C = Buffer.alloc(32, 1);
const NONCE_S = Buffer.alloc(32, 2);
const KEYS = sessionKeys(PSK, NONCE_C, NONCE_S);

test('hkdfExpand is expand-only and reproducible', () => {
  const prk = hkdfExtract(Buffer.alloc(32), PSK);
  const info = Buffer.from(`${LABEL} test`, 'utf8');
  const first = hkdfExpand(prk, info, 32);
  assert.equal(first.length, 32);
  assert.deepEqual(hkdfExpand(prk, info, 32), first);
  assert.notDeepEqual(hkdfExpand(prk, Buffer.from('other'), 32), first);
  assert.equal(hkdfExpand(prk, info, 64).length, 64);
  assert.throws(() => hkdfExpand(prk, info, 255 * 32 + 1), /out of range/);
});

test('handshake keys are all distinct and never equal a session key', () => {
  const names = ['hello', 'hello_ack', 'probe', 'probe_ack'];
  const derived = names.map((name) => handshakeKey(PSK, name));
  const hex = new Set(derived.map((value) => value.toString('hex')));
  assert.equal(hex.size, names.length);
  for (const value of derived) {
    for (const sessionKey of [KEYS.kA2b, KEYS.kB2a, KEYS.kHttpA2b, KEYS.kHttpB2a]) {
      assert.notEqual(value.toString('hex'), sessionKey.toString('hex'));
    }
  }
});

test('pskMaster is sensitive to id, secret and label', () => {
  const base = pskMaster('id', 'secret');
  assert.notEqual(base.toString('hex'), pskMaster('id2', 'secret').toString('hex'));
  assert.notEqual(base.toString('hex'), pskMaster('id', 'secret2').toString('hex'));
  assert.notEqual(base.toString('hex'), pskMaster('', 'secret').toString('hex'));
  // The separator byte is load-bearing: id+secret must not collide with a
  // different id/secret split that concatenates to the same text.
  assert.notEqual(
    pskMaster('id', 'secre').toString('hex'),
    pskMaster('ids', 'ecret').toString('hex'),
  );
  assert.equal(base.length, 32);
});

test('session keys change whenever either nonce changes', () => {
  const other = sessionKeys(PSK, NONCE_C, Buffer.alloc(32, 3));
  assert.notEqual(other.prk.toString('hex'), KEYS.prk.toString('hex'));
  assert.notEqual(other.kA2b.toString('hex'), KEYS.kA2b.toString('hex'));
  assert.notEqual(other.kHttpB2a.toString('hex'), KEYS.kHttpB2a.toString('hex'));
  assert.throws(() => sessionKeys(PSK, Buffer.alloc(31), NONCE_S), /32 bytes/);
});

test('seal/open round-trips non-ASCII payloads and enforces direction', () => {
  const payload = { k: 'evt', m: 'task.event', params: { text: '中文任务' } };
  const envelope = sealFrame(KEYS, 'B', 'data', 'default', 7, payload);
  assert.deepEqual(openFrame(KEYS, 'B', envelope), payload);
  // Wrong direction key must fail: A→B and B→A keys are separate.
  assert.throws(
    () => openFrame(KEYS, 'A', envelope),
    (error) => error instanceof BridgeError && error.code === 'aead_failed',
  );
  // A different conn, type or seq changes the AAD and must fail.
  assert.throws(() => openFrame(KEYS, 'B', { ...envelope, conn: 'other' }), BridgeError);
  assert.throws(() => openFrame(KEYS, 'B', { ...envelope, type: 'ping' }), BridgeError);
  assert.throws(() => openFrame(KEYS, 'B', { ...envelope, seq: 8 }), BridgeError);
});

test('envelope validation rejects malformed shapes before decrypting', () => {
  const envelope = sealFrame(KEYS, 'A', 'data', 'default', 0, { n: 1 });
  for (const bad of [
    null,
    {},
    { ...envelope, v: 2 },
    { ...envelope, type: 5 },
    { ...envelope, conn: 5 },
    { ...envelope, seq: -1 },
    { ...envelope, seq: 1.5 },
    { ...envelope, ct: 'not base64url!' },
    { ...envelope, ct: '' },
  ]) {
    assert.throws(() => openFrame(KEYS, 'A', bad), BridgeError);
  }
});

test('frame nonce and AAD use the normative byte layout', () => {
  const nonce = frameNonce('A', 258);
  assert.equal(nonce.length, 12);
  assert.equal(nonce.readUInt32BE(0), 10);
  assert.equal(nonce.readBigUInt64BE(4), 258n);
  assert.equal(frameNonce('B', 258).readUInt32BE(0), 11);
  assert.equal(frameAad('data', 'default', 2).toString('utf8'), `${LABEL}|data|default|2`);
});

test('jcsAscii is canonical, ordered, and strict about numbers', () => {
  assert.equal(jcsAscii({ b: 1, a: [true, 'x'] }), '{"a":[true,"x"],"b":1}');
  assert.equal(jcsAscii({ s: 'a"b\\c' }), '{"s":"a\\"b\\\\c"}');
  assert.equal(jcsAscii({ k: [1, 2, { n: false }] }), '{"k":[1,2,{"n":false}]}');
  assert.equal(jcsAscii({}), '{}');
  assert.equal(jcsAscii([]), '[]');
  // JS has one number type, so a float is only observable as a non-integer.
  assert.throws(() => jcsAscii({ a: 0.5 }), BridgeError);
  assert.throws(() => jcsAscii({ a: Number.NaN }), BridgeError);
  assert.throws(() => jcsAscii({ '中': 1 }), BridgeError);
  assert.throws(() => jcsAscii(undefined), BridgeError);
});

test('jcsFrame keeps non-ASCII text raw and does not escape slashes', () => {
  const payload = { text: '为什么 // 不是注释？', path: 'a/b', quote: 'x"y' };
  const text = jcsFrame(payload);
  assert.ok(text.includes('为什么'));
  assert.ok(text.includes('a/b'));
  assert.ok(!text.includes('\\u'));
  assert.deepEqual(JSON.parse(text), payload);
});

test('assertHandshakeValue rejects null, non-ASCII and floats anywhere', () => {
  assert.doesNotThrow(() => assertHandshakeValue({ v: 1, side: 'A', caps: { pv: [1], tls: false } }));
  assert.throws(() => assertHandshakeValue({ a: null }), BridgeError);
  assert.throws(() => assertHandshakeValue({ a: { b: null } }), BridgeError);
  assert.throws(() => assertHandshakeValue({ a: ['ok', null] }), BridgeError);
  assert.throws(() => assertHandshakeValue({ a: '中' }), BridgeError);
  assert.throws(() => assertHandshakeValue({ a: 0.5 }), BridgeError);
});

test('MAC verification is constant-time and rejects malformed input', () => {
  const key = handshakeKey(PSK, 'probe');
  const object = { v: 1, type: 'probe', conn: 'c', nonce: 'AAECAwQFBgcICQoLDA0ODw', ts: 1 };
  const mac = macObject(key, object);
  assert.ok(verifyMac(key, object, mac));
  assert.ok(!verifyMac(key, { ...object, ts: 2 }, mac));
  assert.ok(!verifyMac(key, object, 'not-base64url'));
  assert.ok(!verifyMac(key, object, undefined));
  assert.ok(!verifyMac(key, object, b64u(Buffer.alloc(31))));
  assert.ok(constantTimeEqual(Buffer.from('ab'), Buffer.from('ab')));
  assert.ok(!constantTimeEqual(Buffer.from('ab'), Buffer.from('ac')));
  assert.ok(!constantTimeEqual(Buffer.from('ab'), Buffer.from('abc')));
});

test('lengthPrefixed and inputPartsDigest follow the normative framing', () => {
  assert.equal(lengthPrefixed(Buffer.from('abc')).toString('hex'), '00000003616263');
  const parts = [{ type: 'text', text: 'a' }, { type: 'text', text: 'bb' }];
  const expected = sha256(
    Buffer.concat([
      Buffer.from('0000000161', 'hex'),
      Buffer.from('000000026262', 'hex'),
    ]),
  );
  assert.equal(inputPartsDigest(parts), b64u(expected));
  // A 4n+1 length can never be valid base64 (RFC 4648 §3.2).
  assert.throws(() => b64uDec('a'.repeat(5)), BridgeError);
  assert.throws(() => b64uDec('a'.repeat(5) + '!'), BridgeError);
  assert.equal(b64uDec('a'.repeat(4)).length, 3);
});

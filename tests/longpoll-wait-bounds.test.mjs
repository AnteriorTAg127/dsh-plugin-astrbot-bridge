/**
 * Long-poll wait-window construction bounds (protocol §7.4).
 *
 * The listening side accepts `wait` only as an integer in `[0, 25]`; the
 * sending side must therefore never build a query outside that window. These
 * tests pin the single place the outbound value is chosen — the carrier
 * constructor — for every shape a caller can pass: absent, the extremes of the
 * window, out-of-range integers, non-integers, `NaN`/`Infinity`, and strings.
 * The rule is fail-closed without silent coercion, so an illegal value throws
 * `config_invalid` instead of being clamped or stringified into a query the
 * peer would refuse as `bad_params`.
 * @module dsh-plugin-astrbot-bridge/tests/longpoll-wait-bounds
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Limits } from '../lib/constants.js';
import { BridgeError } from '../lib/errors.js';
import { LongPollTransport } from '../lib/transport/longpoll.js';

/** Connection configuration the query builder needs; never dialled here. */
const CFG = Object.freeze({
  id: 'default',
  mode: 'connect',
  host: '127.0.0.1',
  port: 1,
  path: '/dsh-bridge',
  tlsEnabled: false,
});

/**
 * Build a poll query through a real transport instance.
 * @param {object} [options] - constructor options.
 * @returns {{transport: LongPollTransport, query: Record<string, string|number>, signed: object[]}} query and captured MAC objects.
 */
function buildQuery(options) {
  const transport = new LongPollTransport(options);
  transport._cfg = { ...CFG };
  transport._sid = 'sid-1';
  transport._side = 'A';
  const signed = [];
  transport.signPoll = (object) => {
    signed.push(object);
    return 'mac-value';
  };
  return { transport, query: transport._buildPollQuery(), signed };
}

/**
 * Assert that one query carries a wire-legal `wait` (§7.4).
 *
 * Mirrors the inbound rule: the MAC object holds the integer itself, and its
 * decimal encoding is the canonical shortest form the listener parses back.
 * @param {number} expected - the window the constructor was given.
 * @param {Record<string, string|number>} query - built query.
 * @param {object[]} signed - captured MAC objects.
 * @returns {void}
 */
function assertLegalWait(expected, query, signed) {
  assert.equal(query.wait, expected);
  assert.equal(typeof query.wait, 'number');
  assert.equal(Number.isInteger(query.wait), true);
  assert.ok(query.wait >= 0 && query.wait <= Limits.POLL_WAIT_MAX_S, `wait ${query.wait} outside the §7.4 window`);
  // The MAC input carries the same number, not a string (JCS distinguishes them).
  assert.equal(signed.length, 1);
  assert.equal(signed[0].wait, expected);
  assert.equal(typeof signed[0].wait, 'number');
  // Encoded form must satisfy the listener's strict decimal-integer rule.
  const encoded = String(query.wait);
  assert.match(encoded, /^(?:0|[1-9][0-9]*)$/);
  assert.equal(Number(encoded), expected);
}

test('an absent wait window defaults to the protocol maximum', () => {
  for (const options of [undefined, {}, { pollWaitS: undefined }]) {
    const { transport, query, signed } = buildQuery(options);
    assert.equal(transport.pollWaitS, Limits.POLL_WAIT_MAX_S);
    assert.equal(transport.pollWaitS, 25);
    assertLegalWait(25, query, signed);
  }
});

test('wait=0 is preserved: it asks the peer for an immediate answer', () => {
  const { transport, query, signed } = buildQuery({ pollWaitS: 0 });
  assert.equal(transport.pollWaitS, 0);
  assertLegalWait(0, query, signed);
});

test('the maximum window is preserved as an integer', () => {
  const { transport, query, signed } = buildQuery({ pollWaitS: Limits.POLL_WAIT_MAX_S });
  assert.equal(transport.pollWaitS, 25);
  assertLegalWait(25, query, signed);
});

test('out-of-range, non-integer, and mistyped windows are refused, never clamped or coerced', () => {
  const refused = [
    ['above the maximum', 60],
    ['one past the maximum', 26],
    ['negative', -1],
    ['fractional', 1.5],
    ['NaN', Number.NaN],
    ['positive Infinity', Number.POSITIVE_INFINITY],
    ['negative Infinity', Number.NEGATIVE_INFINITY],
    ['numeric string at the maximum', '25'],
    ['numeric string above the maximum', '60'],
    ['non-numeric string', 'abc'],
    ['null', null],
    ['boolean', true],
    ['object', {}],
  ];
  for (const [label, value] of refused) {
    assert.throws(
      () => new LongPollTransport({ pollWaitS: value }),
      (error) => {
        assert.ok(error instanceof BridgeError, `${label}: expected BridgeError, got ${error?.constructor?.name}`);
        assert.equal(error.code, 'config_invalid', `${label}: expected config_invalid, got ${error.code}`);
        assert.deepEqual(error.details, { field: 'pollWaitS' });
        return true;
      },
      `${label} must fail closed`,
    );
  }
});

test('every constructible transport signs a legal wait on repeated polls', () => {
  for (const expected of [0, 1, 25]) {
    const transport = new LongPollTransport({ pollWaitS: expected });
    transport._cfg = { ...CFG };
    transport._sid = 'sid-1';
    transport._side = 'A';
    const signed = [];
    transport.signPoll = (object) => {
      signed.push(object);
      return 'mac-value';
    };
    for (let round = 0; round < 3; round += 1) {
      const query = transport._buildPollQuery();
      assert.equal(query.wait, expected);
      assert.equal(signed[round].wait, expected);
      assert.ok(Number.isInteger(signed[round].wait));
      assert.ok(signed[round].wait >= 0 && signed[round].wait <= Limits.POLL_WAIT_MAX_S);
    }
  }
});

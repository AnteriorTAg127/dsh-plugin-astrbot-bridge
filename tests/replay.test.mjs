/**
 * Replay-window tests (protocol §5.4).
 *
 * The window is the only place that decides whether a ciphertext may reach the
 * application twice, so every branch is asserted: in-order, out-of-order inside
 * the window, duplicate, too far behind, and far ahead.
 * @module dsh-plugin-astrbot-bridge/tests/replay
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BridgeError } from '../lib/errors.js';
import { ReplayWindow } from '../lib/replay.js';

/**
 * Assert that a callback fails with one exact protocol code.
 * @param {() => unknown} operation - operation expected to throw.
 * @param {string} code - expected `BridgeError.code`.
 * @returns {void}
 */
function expectCode(operation, code, { fatal = true } = {}) {
  assert.throws(
    operation,
    (error) => error instanceof BridgeError && error.code === code && error.fatal === fatal,
  );
}

test('accepts a strictly increasing sequence', () => {
  const window = new ReplayWindow(0);
  for (let seq = 0; seq < 200; seq += 1) {
    assert.ok(window.accept(seq));
    assert.equal(window.expected, seq + 1);
  }
});

test('accepts reordering inside the 64-slot window', () => {
  const window = new ReplayWindow(0);
  window.accept(0);
  window.accept(5);
  assert.ok(window.accept(1));
  assert.ok(window.accept(4));
  assert.ok(window.accept(2));
  assert.ok(window.accept(3));
  assert.equal(window.expected, 6);
  expectCode(() => window.accept(3), 'replay_detected');
  expectCode(() => window.accept(5), 'replay_detected');
  expectCode(() => window.accept(0), 'replay_detected');
});

test('rejects a duplicate at the expected position', () => {
  const window = new ReplayWindow(0);
  window.accept(0);
  expectCode(() => window.accept(0), 'replay_detected');
});

test('rejects a sequence that slid out of the window', () => {
  const window = new ReplayWindow(0);
  for (let seq = 0; seq < 100; seq += 1) window.accept(seq);
  expectCode(() => window.accept(10), 'replay_out_of_window');
  assert.ok(window.accept(100));
});

test('rejects a sequence at or beyond the window edge', () => {
  const window = new ReplayWindow(0);
  expectCode(() => window.accept(64), 'replay_out_of_window');
  assert.ok(window.accept(63));
  expectCode(() => window.accept(200), 'replay_out_of_window');
});

test('rejects negative and non-integer sequences as malformed', () => {
  const window = new ReplayWindow(0);
  expectCode(() => window.accept(-1), 'bad_frame', { fatal: false });
  expectCode(() => window.accept(1.5), 'bad_frame', { fatal: false });
  expectCode(() => window.accept(Number.NaN), 'bad_frame', { fatal: false });
});

test('a new session resets the window', () => {
  const window = new ReplayWindow(0);
  window.accept(0);
  window.accept(1);
  window.reset();
  assert.equal(window.expected, 0);
  assert.ok(window.accept(0));
  window.reset(10);
  assert.equal(window.expected, 10);
  assert.ok(window.accept(10));
});

test('out-of-order acceptance never allows a second delivery of the same seq', () => {
  const window = new ReplayWindow(0);
  const seen = new Set();
  const order = [0, 3, 1, 2, 5, 4, 9, 8, 7, 6];
  for (const seq of order) {
    assert.ok(window.accept(seq));
    seen.add(seq);
  }
  assert.equal(seen.size, order.length);
  for (const seq of order) {
    expectCode(() => window.accept(seq), 'replay_detected');
  }
});

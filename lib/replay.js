/**
 * 64-bit replay window for one receive direction (protocol §5.4).
 *
 * The window tolerates reordering, which HTTP carriers produce when several
 * batches are in flight, and rejects everything else: a duplicate, a frame that
 * slid out of the window, or a frame too far ahead. All three are fatal,
 * because continuing would let a replayed ciphertext reach the application.
 * @module dsh-plugin-astrbot-bridge/replay
 */

import { BridgeError } from './errors.js';

const WINDOW_BITS = 64n;
const ONE = 1n;

/** One receive-direction replay window. */
export class ReplayWindow {
  /**
   * @param {number} [start] - next expected sequence number.
   */
  constructor(start = 0) {
    /** Next expected sequence number. */
    this._expected = start;
    /**
     * Received-bitmap. Bit `i` describes `seq = _expected - 1 - i`: 1 means
     * already accepted, 0 means not yet seen.
     */
    this._bits = 0n;
  }

  /** Next expected sequence number. */
  get expected() {
    return this._expected;
  }

  /**
   * Accept or reject one sequence number.
   * @param {number} seq - received sequence number.
   * @returns {boolean} always true when the frame is accepted.
   * @throws {BridgeError} `bad_frame` for a non-integer,
   *   `replay_detected` for a duplicate,
   *   `replay_out_of_window` for a sequence outside the window.
   */
  accept(seq) {
    if (!Number.isInteger(seq) || seq < 0) throw new BridgeError('bad_frame');

    if (seq < this._expected) {
      const offset = BigInt(this._expected - 1 - seq);
      if (offset >= WINDOW_BITS) throw new BridgeError('replay_out_of_window');
      const mask = ONE << offset;
      if ((this._bits & mask) !== 0n) throw new BridgeError('replay_detected');
      this._bits |= mask;
      return true;
    }

    const ahead = BigInt(seq - this._expected);
    if (ahead >= WINDOW_BITS) throw new BridgeError('replay_out_of_window');
    // Shift past every skipped slot (which stay unmarked, so they may still
    // arrive out of order) and mark the slot of `seq` itself.
    this._bits = (this._bits << (ahead + ONE)) | ONE;
    this._expected = seq + 1;
    return true;
  }

  /**
   * Reset the window for a new session.
   * @param {number} [start] - new next expected sequence number.
   * @returns {void}
   */
  reset(start = 0) {
    this._expected = start;
    this._bits = 0n;
  }
}

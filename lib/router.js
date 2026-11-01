/**
 * Message router: request/reply pairing, idempotent replay cache and event
 * fan-out (protocol §5.5, §9.1, §10.1).
 *
 * The router is the only place that decides "this request was already answered
 * with these bytes", so it is also the guard that makes `task.submit` and every
 * other `req` safe to retry after a reconnect.
 * @module dsh-plugin-astrbot-bridge/router
 */

import { randomUUID } from 'node:crypto';

import { MessageKind, MESSAGE_NAMES } from './constants.js';
import { BridgeError, asBridgeError } from './errors.js';
import { defaultLogger } from './log.js';

/** Reply-cache TTL in milliseconds (§10.1: 24 h). */
const REPLY_TTL_MS = 24 * 60 * 60 * 1000;

/** One message router per session. */
export class Router {
  /**
   * @param {object} [options] - router options.
   * @param {() => number} [options.now] - injectable clock in milliseconds.
   * @param {number} [options.replyTtlMs] - idempotent reply cache TTL.
   * @param {import('./log.js').Logger} [options.logger] - structured logger.
   */
  constructor(options = {}) {
    this.now = options.now ?? (() => Date.now());
    this.replyTtlMs = options.replyTtlMs ?? REPLY_TTL_MS;
    this.logger = options.logger ?? defaultLogger.child('router');
    /** @type {Map<string, {handler: Function, kind: 'req'|'evt'}>} */
    this._handlers = new Map();
    /** @type {Map<string, {at: number, reply: object}>} */
    this._replies = new Map();
    /** @type {(message: object) => Promise<void>|void} */
    this._replySink = () => {};
  }

  /**
   * Install the sink that puts a `rep` message on the wire.
   * @param {(message: object) => Promise<void>|void} sink - reply sender.
   * @returns {void}
   */
  setReplySink(sink) {
    this._replySink = sink;
  }

  /**
   * Register a handler for one message name.
   * @param {string} m - message name from `MessageName`.
   * @param {'req'|'evt'} kind - expected message kind.
   * @param {(params: object, context: object) => Promise<object|void>|object|void} handler - handler.
   * @returns {() => void} disposer.
   */
  register(m, kind, handler) {
    if (!MESSAGE_NAMES.includes(m)) throw new BridgeError('unknown_message');
    this._handlers.set(`${kind}:${m}`, { handler, kind });
    return () => {
      const current = this._handlers.get(`${kind}:${m}`);
      if (current !== undefined && current.handler === handler) this._handlers.delete(`${kind}:${m}`);
    };
  }

  /**
   * Dispatch one inbound message.
   *
   * A request is executed at most once per `id`: the second delivery returns
   * the cached reply without running the handler again (§10.1).
   * @param {object} message - §9.1 message object.
   * @param {object} [context] - session context handed to the handler.
   * @returns {Promise<void>} resolution after the reply (if any) was queued.
   */
  async dispatch(message, context = {}) {
    if (message === null || typeof message !== 'object') throw new BridgeError('bad_frame');
    if (typeof message.m !== 'string' || !MESSAGE_NAMES.includes(message.m)) {
      if (message.k === MessageKind.REQ) {
        await this._sendReply(message, null, new BridgeError('unknown_message'));
        return;
      }
      this.logger.debug('unknown_event_ignored', { m: typeof message.m === 'string' ? message.m : null });
      return;
    }
    if (message.k !== MessageKind.REQ && message.k !== MessageKind.EVT) {
      throw new BridgeError('unknown_message_kind');
    }
    if (typeof message.id !== 'string' || message.id.length === 0) {
      throw new BridgeError('bad_params', { details: { field: 'id' } });
    }

    const handler = this._handlers.get(`${message.k}:${message.m}`);
    if (handler === undefined) {
      if (message.k === MessageKind.REQ) {
        await this._sendReply(message, null, new BridgeError('unknown_message'));
      }
      return;
    }

    if (message.k === MessageKind.EVT) {
      try {
        await handler.handler(message.params ?? {}, { ...context, message });
      } catch (error) {
        // An event has no reply channel; a failure is logged, not propagated,
        // and must never become a protocol-level disconnect (§1.3).
        this.logger.failure('event_handler_failed', asBridgeError(error), { m: message.m });
      }
      return;
    }

    const cached = this._replies.get(message.id);
    if (cached !== undefined && this.now() - cached.at <= this.replyTtlMs) {
      // Idempotent replay: resend the same business answer, never re-execute.
      await this._replySink({ ...cached.reply, id: randomUUID(), reply_to: message.id });
      return;
    }

    let result;
    try {
      result = await handler.handler(message.params ?? {}, { ...context, message });
    } catch (error) {
      const failure = asBridgeError(error);
      const reply = this._buildReply(message, null, failure);
      this._replies.set(message.id, { at: this.now(), reply });
      await this._replySink({ ...reply, id: randomUUID(), reply_to: message.id });
      return;
    }
    const reply = this._buildReply(message, result ?? {}, null);
    this._replies.set(message.id, { at: this.now(), reply });
    await this._replySink({ ...reply, id: randomUUID(), reply_to: message.id });
  }

  /**
   * Build the reusable part of a reply message.
   * @param {object} request - inbound request.
   * @param {object|null} result - success result.
   * @param {BridgeError|null} error - failure.
   * @returns {object} reply message without `id`/`reply_to`.
   */
  _buildReply(request, result, error) {
    const base = { k: MessageKind.REP, m: request.m, ts: new Date(this.now()).toISOString() };
    if (error === null) return { ...base, ok: true, result };
    return { ...base, ok: false, error: error.toWire() };
  }

  /**
   * Queue one reply through the sink.
   * @param {object} message - reply message.
   * @returns {Promise<void>} resolution after enqueue.
   */
  async _sendReply(message, result, error) {
    await this._replySink({
      ...(this._buildReply(message, result, error)),
      id: randomUUID(),
      reply_to: message.id,
    });
  }

  /**
   * Drop expired reply-cache entries.
   * @returns {number} number of entries removed.
   */
  pruneReplies() {
    const cutoff = this.now() - this.replyTtlMs;
    let removed = 0;
    for (const [id, entry] of this._replies) {
      if (entry.at <= cutoff) {
        this._replies.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  /** Number of cached replies (diagnostics/tests). */
  get cachedReplies() {
    return this._replies.size;
  }
}

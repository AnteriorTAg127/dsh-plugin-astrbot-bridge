/**
 * Carrier selection, fallback, reconnection and diagnostics (protocol §6.3,
 * §7.5, §7.6).
 *
 * The manager owns one connection's carrier lifecycle for as long as the plugin
 * is installed: it tries the preferred carrier, falls back in the configured
 * order, reconnects with exponential backoff after a loss, and periodically
 * tries to return to the preferred carrier. Every switch is recorded, because
 * an operator debugging a one-way network needs to see *which* carrier is
 * active and *why* it changed.
 *
 * The loop is deliberately abortable and never runs after `stop()`: a plugin
 * reload must not leave a background reconnection behind. All waiting is done
 * with `unref`'d timers that the loop clears itself, so an idle bridge never
 * keeps the host process alive.
 * @module dsh-plugin-astrbot-bridge/transport/manager
 */

import { randomInt } from 'node:crypto';

import { BridgeError } from '../errors.js';
import { defaultLogger } from '../log.js';
import { LongPollTransport } from './longpoll.js';
import { WebhookTransport } from './webhook.js';
import { WsTransport } from './ws.js';

/** How long a fallback carrier is kept before retrying the preferred one (§7.5 rule 3). */
const RETRY_PREFERRED_MS = 5 * 60 * 1000;

/** First reconnect delay (§6.3: 1 s, ×2, capped by `reconnectMaxBackoff`). */
const BACKOFF_BASE_MS = 1000;

/** Backoff multiplier (§6.3). */
const BACKOFF_FACTOR = 2;

/** Jitter applied to every delay (§6.3: ±20%). */
const BACKOFF_JITTER = 0.2;

/** Failures that are still announced at WARN before quiet polling (§6.3). */
const WARN_ATTEMPT_LIMIT = 10;

/** Carrier factory registry, keyed by transport name. */
const CARRIERS = Object.freeze({
  ws: (options) => new WsTransport(options),
  webhook: (options) => new WebhookTransport(options),
  longpoll: (options) => new LongPollTransport(options),
});

/**
 * Create one carrier instance by name.
 * @param {string} name - `ws`, `webhook` or `longpoll`.
 * @param {object} [options] - carrier options.
 * @returns {import('./base.js').Transport} carrier instance.
 * @throws {BridgeError} `config_invalid` for an unknown carrier name.
 */
export function createCarrier(name, options = {}) {
  const factory = CARRIERS[name];
  if (factory === undefined) throw new BridgeError('config_invalid', { details: { field: 'transport' } });
  return factory(options);
}

/**
 * Wait for a delay, resolving early (as `false`) when the signal aborts.
 *
 * The timer is always cleared and the listener always removed, and the timer is
 * `unref`'d where the platform supports it so waiting never keeps the host
 * process alive.
 * @param {number} ms - delay in milliseconds.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<boolean>} true when the delay elapsed, false when aborted.
 */
function sleepUntilAborted(ms, signal) {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const finish = (value) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(true), ms);
    if (typeof timer.unref === 'function') timer.unref();
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Carrier manager for one connection. */
export class TransportManager {
  /**
   * @param {object} connConfig - connection configuration.
   * @param {object} hooks - session hooks forwarded to the carrier.
   * @param {object} [options] - manager options.
   * @param {Function} [options.onSwitch] - receives `{from, to, reason}`.
   * @param {Function} [options.onSession] - creates/attaches the session for a carrier.
   * @param {Function} [options.now] - injectable clock.
   * @param {import('../log.js').Logger} [options.logger] - structured logger.
   * @param {number} [options.retryPreferredMs] - how long a fallback carrier is
   *   kept before the preferred one is attempted again (tests only; production
   *   uses the protocol's five minutes).
   */
  constructor(connConfig, hooks, options = {}) {
    this.conn = connConfig;
    this.hooks = hooks;
    this.onSwitch = options.onSwitch ?? (() => {});
    this.onSession = options.onSession ?? (() => {});
    this.now = options.now ?? (() => Date.now());
    this.logger = options.logger ?? defaultLogger.child('transport:manager');
    this.retryPreferredMs = options.retryPreferredMs ?? RETRY_PREFERRED_MS;
    this._current = null;
    this._currentName = null;
    this._history = [];
    this._lastError = null;
    this._attempted = [];
    this._retryTimer = null;
    this._stopped = true;
    /** Background loop, present only while `runForever` is running. */
    this._loop = null;
    /** Abort control for the loop and every wait inside it. */
    this._abort = null;
    /** A configuration/security failure parks the loop instead of retrying. */
    this._fatal = null;
    /** Current backoff ceiling, grown on every failure. */
    this._backoffMs = BACKOFF_BASE_MS;
    /** Consecutive failure count, used only for the WARN → quiet transition. */
    this._failures = 0;
  }

  /**
   * Ordered carrier list: preferred first, then the configured fallbacks.
   * @returns {string[]} carrier names without duplicates.
   */
  order() {
    const fallback = Array.isArray(this.conn.transportFallback) ? this.conn.transportFallback : [];
    return [...new Set([this.conn.transport, ...fallback].filter((name) => typeof name === 'string'))];
  }

  /** Current carrier name, or null before the first successful start. */
  current() {
    return this._currentName;
  }

  /** Whether the supervised loop is currently running. */
  running() {
    return this._loop !== null && !this._stopped;
  }

  /**
   * The failure that parked the loop, if any.
   *
   * A configuration or security failure (§7.6) is never retried, so the
   * connection stays down until an operator changes the configuration. Callers
   * use this to report a readable reason instead of "it just stopped".
   * @returns {{code: string, details: object|null}|null} parked reason.
   */
  get parked() {
    if (this._fatal === null) return null;
    return { code: this._fatal.code, details: this._fatal.details ?? null };
  }

  /** Switch history, oldest first. */
  history() {
    return [...this._history];
  }

  /**
   * Maximum reconnect delay in milliseconds, from `reconnectMaxBackoff`.
   * @returns {number} cap in milliseconds.
   */
  maxBackoffMs() {
    const seconds = Number(this.conn.reconnectMaxBackoff ?? 60);
    const bounded = Number.isFinite(seconds) && seconds > 0 ? Math.min(3600, Math.max(1, Math.trunc(seconds))) : 60;
    return bounded * 1000;
  }

  /**
   * Diagnostics for an operator: what was tried, what failed, and why.
   * @returns {{reachable: boolean, lastErrorCode: string|null, attempted: string[],
   *   current: string|null, preferred: string, failures: number, backoffMs: number,
   *   maxBackoffMs: number, running: boolean, history: object[]}} diagnostics.
   */
  diagnostics() {
    return {
      reachable: this._current !== null,
      lastErrorCode: this._lastError,
      attempted: [...this._attempted],
      current: this._currentName,
      preferred: this.conn.transport,
      failures: this._failures,
      backoffMs: this._backoffMs,
      maxBackoffMs: this.maxBackoffMs(),
      running: this.running(),
      history: [...this._history],
    };
  }

  /**
   * Start the first carrier that works, in configured order.
   *
   * This is a single round with no reconnection: callers that need the bridge to
   * survive a peer restart use {@link TransportManager#runForever}.
   * @param {Function} [sessionFactory] - builds a session bound to a carrier.
   * @returns {Promise<{carrier: object, name: string}|null>} the started carrier.
   */
  async runOnce(sessionFactory = this.onSession) {
    this._stopped = false;
    const started = await this._round(sessionFactory, this.order(), 0);
    if (started === null) return null;
    return started;
  }

  /**
   * Run carriers until stopped: connect, watch, fall back, reconnect with
   * backoff, and retry the preferred carrier every five minutes (§6.3, §7.5).
   *
   * The loop is started in the background: the returned promise settles when the
   * loop exits, and callers that must not block (the plugin's `apply`) simply
   * keep it. A configuration or security failure parks the loop; a network
   * failure backs off; `stop()` aborts everything and is idempotent.
   * @param {Function} [sessionFactory] - builds a session bound to a carrier.
   * @param {object} [options] - loop options.
   * @param {Function} [options.watch] - resolves with `degraded`, `lost` or
   *   `stopped` when the live session stops being usable. Defaults to polling
   *   the carrier's own `alive()` flag.
   * @returns {Promise<void>} resolution when the loop has stopped.
   */
  async runForever(sessionFactory = this.onSession, options = {}) {
    if (this._loop !== null) return this._loop;
    this._stopped = false;
    this._fatal = null;
    this._backoffMs = BACKOFF_BASE_MS;
    this._failures = 0;
    this._abort = new AbortController();
    // The default watcher must still receive the loop's abort signal: calling it
    // without one would make every `signal.aborted` read throw.
    const watch = options.watch ?? ((signal) => this._watchCarrier(signal));
    this._loop = this._run(sessionFactory, watch)
      .catch((error) => {
        // The loop itself must never reject into a caller that did not await it.
        this.logger.failure('transport_loop_failed', error, { conn: this.conn.id });
      })
      .finally(() => {
        this._loop = null;
        this._abort = null;
      });
    return this._loop;
  }

  /**
   * The supervised loop body.
   * @param {Function} sessionFactory - builds a session bound to a carrier.
   * @param {Function} watch - resolves when the live session is unusable.
   * @returns {Promise<void>} resolution when the loop exits.
   */
  async _run(sessionFactory, watch) {
    const order = this.order();
    let index = 0;
    while (!this._aborted()) {
      const started = await this._round(sessionFactory, order, index);
      if (this._fatal !== null) {
        // §7.6: a configuration or security failure is never retried; the
        // connection parks with a readable reason instead of hammering the peer.
        this.logger.error('transport_parked', {
          conn: this.conn.id,
          carrier: this._currentName,
          code: this._fatal.code,
        });
        return;
      }
      if (this._aborted()) {
        // A carrier adopted while `stop()` was in flight would otherwise outlive
        // the manager, so the exit path releases whatever is current.
        await this._releaseCurrent();
        return;
      }
      if (started === null) {
        index = 0;
        const wait = this._nextBackoff();
        this._noteFailure(wait);
        // No carrier is reachable: report the diagnosis once per level, then
        // keep a quiet 60 s-style patrol instead of flooding the log (§7.5).
        this._logFailure();
        if (!(await this._sleep(wait))) return;
        continue;
      }
      this._failures = 0;

      let available = false; // whether the live session is still usable
      let waitBefore = 0;
      while (!this._aborted()) {
        const outcome = await this._watchOrTimeout(watch, this.retryPreferredMs);
        if (outcome.stopped || this._aborted()) return;
        if (outcome.reason === 'degraded') {
          // §7.3 rule 6: a degraded carrier MUST switch to the fallback order
          // now, while the peer may still be reachable over another carrier.
          index = this._nextIndexAfter(this._currentName, order);
          this.logger.warn('transport_degraded_fallback', {
            conn: this.conn.id,
            from: this._currentName,
            to: order[index],
          });
          await this._releaseCurrent();
          available = true;
          break;
        }
        if (outcome.reason === 'lost') {
          index = 0;
          available = true;
          await this._releaseCurrent();
          waitBefore = this._nextBackoff();
          this._noteFailure(waitBefore);
          this._logFailure();
          break;
        }
        // Five minutes elapsed on a fallback carrier: try to return to the
        // preferred one, keeping the fallback reachable if that attempt fails.
        if (this._currentName === order[0]) continue;
        index = 0;
        available = true;
        waitBefore = 0;
        this.logger.info('transport_retry_preferred', { conn: this.conn.id, carrier: order[0] });
        break;
      }
      if (waitBefore > 0 && !(await this._sleep(waitBefore))) return;
      if (!available) return;
    }
  }

  /**
   * Try every carrier once, starting at one index in the configured order.
   * @param {Function} sessionFactory - builds a session bound to a carrier.
   * @param {string[]} order - ordered carrier names.
   * @param {number} startIndex - first candidate.
   * @returns {Promise<{carrier: object, name: string}|null>} the started carrier.
   */
  async _round(sessionFactory, order, startIndex) {
    for (let step = 0; step < order.length; step += 1) {
      if (this._aborted()) return null;
      const name = order[(startIndex + step) % order.length];
      const started = await this._attempt(sessionFactory, name);
      if (started !== null) return started;
      if (this._fatal !== null) return null;
    }
    return null;
  }

  /**
   * Attempt one carrier and hand it to the session factory.
   * @param {Function} sessionFactory - builds a session bound to a carrier.
   * @param {string} name - carrier name.
   * @returns {Promise<{carrier: object, name: string}|null>} the adopted carrier.
   */
  async _attempt(sessionFactory, name) {
    this._attempted.push(name);
    let carrier = null;
    try {
      carrier = createCarrier(name, { logger: this.logger.child(name) });
      await sessionFactory(carrier, name)();
      this._lastError = null;
      this._adopt(carrier, name);
      return { carrier, name };
    } catch (error) {
      const bridgeError = error instanceof BridgeError ? error : new BridgeError('internal_error');
      this._lastError = bridgeError.code;
      this.logger.warn('transport_attempt_failed', {
        conn: this.conn.id,
        carrier: name,
        code: bridgeError.code,
      });
      // A carrier that never became a session must release its socket, or every
      // failed attempt would leak a listener.
      if (carrier !== null) {
        try {
          await carrier.stop();
        } catch {
          // Nothing left to release.
        }
      }
      // A configuration or security failure must not be papered over by
      // trying another carrier: the operator has to fix the cause (§7.6).
      if (bridgeError.isConfigError || bridgeError.fatal) {
        this._fatal = bridgeError;
        return null;
      }
      return null;
    }
  }

  /**
   * Adopt a carrier as current and record the switch.
   * @param {object} carrier - carrier instance.
   * @param {string} name - carrier name.
   * @returns {void}
   */
  _adopt(carrier, name) {
    const from = this._currentName;
    this._current = carrier;
    this._currentName = name;
    if (from !== null && from !== name) {
      const record = { from, to: name, reason: this._lastError ?? 'unavailable', at: this.now() };
      this._history.push(record);
      this.onSwitch(record);
      this.logger.warn('transport_switched', {
        conn: this.conn.id,
        from,
        to: name,
        reason: record.reason,
      });
    }
  }

  /**
   * Release the current carrier so the next attempt can bind the same address.
   *
   * A session close normally stops its own carrier, but the manager must not
   * assume it: a carrier that failed before a session existed, or a fallback
   * switch, would otherwise leave a listening socket behind.
   * @returns {Promise<void>} resolution after release.
   */
  async _releaseCurrent() {
    const carrier = this._current;
    this._current = null;
    if (carrier === null) return;
    try {
      await carrier.stop();
    } catch (error) {
      this.logger.failure('transport_release_failed', error, { conn: this.conn.id });
    }
  }

  /**
   * Index of the carrier after `name` in the configured order.
   * @param {string|null} name - current carrier.
   * @param {string[]} order - ordered carrier names.
   * @returns {number} next index, wrapping to 0.
   */
  _nextIndexAfter(name, order) {
    const index = name === null ? -1 : order.indexOf(name);
    return index < 0 ? 0 : (index + 1) % order.length;
  }

  /**
   * Compute the next backoff delay and grow the ceiling.
   * @returns {number} delay with ±20% jitter, never above the configured cap.
   */
  _nextBackoff() {
    const cap = this.maxBackoffMs();
    const base = Math.min(cap, this._backoffMs);
    const factor = 1 - BACKOFF_JITTER + (randomInt(0, 401) / 1000);
    this._backoffMs = Math.min(cap, this._backoffMs * BACKOFF_FACTOR);
    return Math.round(Math.min(cap, base * factor));
  }

  /**
   * Record one failure for diagnostics.
   * @param {number} wait - delay before the next attempt.
   * @returns {void}
   */
  _noteFailure(wait) {
    this._failures += 1;
    this._backoffMs = Math.min(this.maxBackoffMs(), this._backoffMs);
    this.logger.debug('transport_backoff', { conn: this.conn.id, wait_ms: wait, failures: this._failures });
  }

  /**
   * Report an unreachable peer at WARN for the first attempts, then quietly.
   * @returns {void}
   */
  _logFailure() {
    const fields = {
      conn: this.conn.id,
      attempted: this.order().join(','),
      failures: this._failures,
      code: this._lastError ?? 'unavailable',
    };
    if (this._failures <= WARN_ATTEMPT_LIMIT) this.logger.warn('transport_unreachable', fields);
    else this.logger.debug('transport_unreachable', fields);
  }

  /**
   * Default watcher: poll the carrier's own health flag.
   * @param {AbortSignal} signal - aborted when the manager stops watching.
   * @returns {Promise<string>} `lost` once the carrier reports it is down.
   */
  async _watchCarrier(signal) {
    while (!signal.aborted) {
      const carrier = this._current;
      if (carrier !== null && typeof carrier.alive === 'function' && !carrier.alive()) return 'lost';
      if (!(await sleepUntilAborted(5000, signal))) break;
    }
    return 'stopped';
  }

  /**
   * Wait for the session watcher, bounded by the preferred-carrier retry period.
   *
   * The watcher receives its own abort signal, so a timeout ends it instead of
   * leaving a polling loop behind; the timer is cleared on every exit path.
   * @param {Function} watch - session watcher, called with an abort signal.
   * @param {number} ms - maximum wait.
   * @returns {Promise<{reason?: string, retry?: boolean, stopped?: boolean}>} outcome.
   */
  _watchOrTimeout(watch, ms) {
    return new Promise((resolve) => {
      const controller = new AbortController();
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        controller.abort();
        if (signal !== undefined) signal.removeEventListener('abort', onAbort);
        resolve(value);
      };
      const onAbort = () => finish({ stopped: true });
      const signal = this._abort?.signal;
      const timer = setTimeout(() => finish({ retry: true }), ms);
      if (typeof timer.unref === 'function') timer.unref();
      if (signal !== undefined) {
        if (signal.aborted) {
          finish({ stopped: true });
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      Promise.resolve()
        .then(() => watch(controller.signal))
        .then(
          // `stopped` is normalized to its own flag so the loop cannot mistake a
          // finished watcher for "no news yet" and re-watch it forever.
          (reason) => finish(reason === 'stopped' ? { stopped: true } : { reason }),
          () => finish({ reason: 'lost' }),
        );
    });
  }

  /**
   * Sleep until the delay elapses or the loop is stopped.
   * @param {number} ms - delay in milliseconds.
   * @returns {Promise<boolean>} false when the loop was stopped instead.
   */
  async _sleep(ms) {
    const signal = this._abort?.signal;
    if (signal === undefined) return !this._aborted();
    const elapsed = await sleepUntilAborted(ms, signal);
    return elapsed && !this._aborted();
  }

  /** @returns {boolean} whether the loop has been aborted. */
  _aborted() {
    return this._stopped || this._abort?.signal.aborted === true;
  }

  /**
   * Stop the manager, abort the supervised loop and release the carrier.
   * @returns {Promise<void>} resolution after teardown.
   */
  async stop() {
    this._stopped = true;
    if (this._abort !== null) this._abort.abort();
    if (this._retryTimer !== null) {
      clearInterval(this._retryTimer);
      this._retryTimer = null;
    }
    const loop = this._loop;
    const carrier = this._current;
    this._current = null;
    // The carrier is gone, so `diagnostics()` must not keep advertising it:
    // a stopped manager that still reports `current: 'ws'` reads as reachable.
    this._currentName = null;
    if (carrier !== null) await carrier.stop();
    if (loop !== null) await loop;
  }
}

/**
 * HTTP long-poll carrier (protocol §7.4).
 *
 * Uplink is identical to webhook (`POST /frames`); downlink is `GET /poll`
 * with a MAC-authenticated query, answered by the listening side's frame queue.
 * This carrier is the fallback that keeps *reverse* delivery working when the
 * peer cannot POST back, which is why the queue retains frames until acked.
 * @module dsh-plugin-astrbot-bridge/transport/longpoll
 */

import { randomBytes, randomUUID } from 'node:crypto';

import { BridgeError } from '../errors.js';
import { defaultLogger } from '../log.js';
import { Limits } from '../constants.js';
import {
  Endpoints,
  PlainResponder,
  PollQueue,
  Transport,
  assertAcceptableRequest,
  closeServer,
  createServerFor,
  errorOfStatus,
  getJson,
  listenOn,
  parseJson,
  pathMatches,
  peerBaseUrl,
  postJson,
  queryOf,
  readBody,
  sendError,
  sendJson,
} from './base.js';

/**
 * Session-layer refusals whose own code and status must survive poll
 * authentication (§7.4, §15).
 *
 * A `poll_auth_failed` answer tells the peer "your MAC is wrong" and is not
 * retried, so folding `replay_detected` (409), `sid_mismatch` (409) or
 * `not_ready` (425) into a 401 makes both sides believe the keys are broken
 * and stops the re-handshake that would actually repair the session.
 */
const POLL_AUTH_PASS_THROUGH_CODES = Object.freeze(
  new Set(['poll_auth_failed', 'replay_detected', 'sid_mismatch', 'stale_session', 'not_ready']),
);

/** Long-poll carrier. */
export class LongPollTransport extends Transport {
  /**
   * @param {object} [options] - carrier options.
   * @param {(macObject: object) => string} [options.signPoll] - builds the poll MAC from the canonical §7.4 object.
   * @param {(macObject: object) => string} [options.signPollAck] - builds the ack MAC from the canonical §7.4 object.
   * @param {(macObject: object) => void} [options.verifyPoll] - validates the inbound poll MAC object.
   * @param {(macObject: object) => void} [options.verifyPollAck] - validates the inbound ack MAC object.
   * @param {import('../log.js').Logger} [options.logger] - structured logger.
   * @param {number} [options.pollWaitS] - long-poll wait in seconds; an integer in
   *   `[0, POLL_WAIT_MAX_S]`, defaulting to the maximum window.
   * @throws {BridgeError} `config_invalid` when `pollWaitS` is not an exact
   *   integer inside the §7.4 window.
   */
  constructor(options = {}) {
    super();
    // §7.4 bounds `wait` to integers in [0, 25]: 0 means "answer immediately".
    // This constructor is the only place the outbound value is chosen, so an
    // illegal one must never reach `_buildPollQuery()`: the peer would refuse
    // every poll as `bad_params`, and a non-integer (including a numeric
    // string) would sign a different MAC object than the wire carries. The
    // default is the full window, matching production.
    const rawPollWaitS = options.pollWaitS;
    const pollWaitS = rawPollWaitS === undefined ? Limits.POLL_WAIT_MAX_S : rawPollWaitS;
    if (!Number.isInteger(pollWaitS) || pollWaitS < 0 || pollWaitS > Limits.POLL_WAIT_MAX_S) {
      // Fail closed without silent coercion: `Number('60')` or `Math.trunc(1.5)`
      // would hide the configuration mistake and change the signed message.
      throw new BridgeError('config_invalid', { details: { field: 'pollWaitS' } });
    }
    this.logger = options.logger ?? defaultLogger.child('transport:longpoll');
    this.pollWaitS = pollWaitS;
    this.signPoll = options.signPoll;
    this.signPollAck = options.signPollAck;
    this.verifyPoll = options.verifyPoll;
    this.verifyPollAck = options.verifyPollAck;
    this._server = null;
    this._sockets = new Set();
    this._hooks = null;
    this._cfg = null;
    this._responder = new PlainResponder();
    this._inline = null;
    this._inflight = 0;
    this._queue = new PollQueue();
    this._waiters = new Set();
    this._pollTimer = null;
    this._stopped = true;
    this._polling = false;
    this._consecutiveTimeouts = 0;
  }

  /** @returns {'longpoll'} */
  get name() {
    return 'longpoll';
  }

  /** Whether the last poll round succeeded. */
  alive() {
    return !this._stopped;
  }

  /** Retained, unacked frame count (diagnostics/tests). */
  get retained() {
    return this._queue.size;
  }

  /**
   * Start the carrier.
   * @param {object} cfg - connection configuration.
   * @param {object} hooks - session hooks.
   * @returns {Promise<void>} resolution when ready.
   */
  async start(cfg, hooks) {
    this._hooks = hooks;
    this._cfg = cfg;
    this._stopped = false;
    this._queue = new PollQueue({
      retentionFrames: cfg.retentionFrames ?? Limits.RETENTION_FRAMES,
      onOverflow: () => {
        this.logger.warn('queue_overflow', { conn: cfg.id, carrier: 'longpoll' });
      },
      onExpired: (envelope) => {
        this.logger.warn('frame_unacked', {
          conn: cfg.id,
          carrier: 'longpoll',
          type: envelope.type,
          seq: envelope.seq,
        });
      },
    });
    // Polling does not start here: a poll is MAC-authenticated with keys that
    // only exist after the handshake, so an early poll would be refused as
    // `poll_auth_failed` and tear the handshake down. `setSessionIdentity`
    // starts the loop once the session is ready.
    if (cfg.mode === 'listen') await this._startServer(cfg);
    this._hooks.onState?.(cfg.mode === 'listen' ? 'listening' : 'connected');
  }

  /**
   * Start the listening server for `mode: listen`.
   * @param {object} cfg - connection configuration.
   * @returns {Promise<void>} resolution once listening.
   */
  async _startServer(cfg) {
    const server = createServerFor(cfg, (req, res) => void this._route(req, res), this.logger);
    server.on('connection', (socket) => {
      this._sockets.add(socket);
      socket.on('close', () => this._sockets.delete(socket));
    });
    this._server = server;
    await listenOn(server, cfg);
    this.logger.info('longpoll_listening', { conn: cfg.id, port: cfg.port });
  }

  /**
   * Route one inbound HTTP request.
   * @param {import('node:http').IncomingMessage} req - request.
   * @param {import('node:http').ServerResponse} res - response.
   * @returns {Promise<void>} resolution after the response is sent.
   */
  async _route(req, res) {
    const cfg = this._cfg;
    try {
      assertAcceptableRequest(req);
      if (pathMatches(req, cfg.path, Endpoints.HEALTH)) {
        sendJson(res, 200, { v: 1, ok: true });
        return;
      }
      if (req.method === 'POST' && pathMatches(req, cfg.path, Endpoints.HELLO)) {
        await this._onHello(req, res);
        return;
      }
      if (req.method === 'POST' && pathMatches(req, cfg.path, Endpoints.FRAMES)) {
        await this._onFrames(req, res);
        return;
      }
      if (req.method === 'GET' && pathMatches(req, cfg.path, Endpoints.POLL)) {
        await this._onPoll(req, res);
        return;
      }
      if (req.method === 'POST' && pathMatches(req, cfg.path, Endpoints.POLL_ACK)) {
        await this._onPollAck(req, res);
        return;
      }
      if (req.method === 'POST' && pathMatches(req, cfg.path, Endpoints.PROBE)) {
        await this._onProbe(req, res);
        return;
      }
      sendError(res, new BridgeError('unknown_conn', { http: 404 }));
    } catch (error) {
      sendError(res, error instanceof BridgeError ? error : new BridgeError('internal_error'));
    }
  }

  /**
   * Handle `POST {base}/hello`.
   * @param {import('node:http').IncomingMessage} req - request.
   * @param {import('node:http').ServerResponse} res - response.
   * @returns {Promise<void>} resolution after the response.
   */
  async _onHello(req, res) {
    this._inflight += 1;
    try {
      await this._handleHello(req, res);
    } finally {
      this._inflight -= 1;
    }
  }

  /**
   * Handle one `/hello` request.
   * @param {import('node:http').IncomingMessage} req - request.
   * @param {import('node:http').ServerResponse} res - response.
   * @returns {Promise<void>} resolution after the response.
   */
  async _handleHello(req, res) {
    const hello = parseJson(await readBody(req, Limits.MAX_FRAME_BYTES));
    const reply = this._responder.open();
    await this._hooks.onPlain(hello);
    const outcome = await reply;
    if (outcome.object !== undefined) {
      sendJson(res, 200, outcome.object);
      return;
    }
    sendError(res, outcome.error ?? new BridgeError('psk_mismatch'));
  }

  /**
   * Handle an inbound frame batch. Envelopes are queued for the local session
   * and, when they are responses to our own pull, dispatched directly.
   * @param {import('node:http').IncomingMessage} req - request.
   * @param {import('node:http').ServerResponse} res - response.
   * @returns {Promise<void>} resolution after the response.
   */
  async _onFrames(req, res) {
    this._inflight += 1;
    try {
      await this._handleFrames(req, res);
    } finally {
      this._inflight -= 1;
    }
  }

  /**
   * Handle one `/frames` batch.
   * @param {import('node:http').IncomingMessage} req - request.
   * @param {import('node:http').ServerResponse} res - response.
   * @returns {Promise<void>} resolution after the response.
   */
  async _handleFrames(req, res) {
    const raw = parseJson(await readBody(req));
    if (raw === null || typeof raw !== 'object' || !Array.isArray(/** @type {{frames?: unknown}} */ (raw).frames)) {
      sendError(res, new BridgeError('bad_batch'));
      return;
    }
    const batch = /** @type {import('./base.js').FrameBatch} */ (raw);
    if (batch.frames.length < 1 || batch.frames.length > Limits.MAX_BATCH_FRAMES) {
      sendError(res, new BridgeError('bad_batch'));
      return;
    }
    let previousSeq = -1;
    for (const frame of batch.frames) {
      if (!Number.isInteger(frame?.seq) || frame.seq <= previousSeq) {
        sendError(res, new BridgeError('bad_batch'));
        return;
      }
      previousSeq = frame.seq;
    }
    const accepted = [];
    const rejected = [];
    // Frames produced while handling this batch (notably `auth_ack`) must ride
    // this response, exactly as in the webhook carrier.
    const inline = [];
    this._inline = inline;
    try {
      for (const frame of batch.frames) {
        const ref = `${frame.type}#${frame.seq}`;
        try {
          await this._hooks.onEnvelope(frame);
          accepted.push(ref);
        } catch (error) {
          const bridgeError = error instanceof BridgeError ? error : new BridgeError('internal_error');
          rejected.push({ ref, code: bridgeError.code });
          if (bridgeError.fatal) break;
        }
      }
      // Let the session queue whatever this batch produced before answering.
      await this._hooks.onFlush?.();
    } finally {
      this._inline = null;
    }
    if (inline.length > 0) {
      sendJson(res, 200, {
        v: 1,
        conn: this._cfg.id,
        sid: batch.sid ?? null,
        batch_id: batch.batch_id ?? randomUUID(),
        frames: inline,
      });
      return;
    }
    if (accepted.length === 0 && rejected.length > 0) {
      sendError(res, new BridgeError(rejected[0].code));
      return;
    }
    sendJson(res, 202, { v: 1, accepted, rejected });
  }

  /**
   * Handle `GET {base}/poll`: verify the MAC, then answer with queued frames or
   * an empty 204 after the wait window (§7.4).
   * @param {import('node:http').IncomingMessage} req - request.
   * @param {import('node:http').ServerResponse} res - response.
   * @returns {Promise<void>} resolution after the response.
   */
  async _onPoll(req, res) {
    // §7.4 defines the poll MAC over a projection, not over the raw query: the
    // wire field `target` is named `mac_target` and `max`/`ts`/`wait` are
    // integers. Verifying anything else would disagree with both our own
    // `_buildPollQuery()` and the peer's signer, so the projection is the only
    // accepted shape — there is deliberately no raw-query fallback.
    let poll;
    try {
      poll = parsePollQuery(queryOf(req));
      // Fail closed: a carrier with no verifier installed must never serve
      // frames, because an unauthenticated pull is an unauthenticated read.
      if (typeof this.verifyPoll !== 'function') throw new BridgeError('poll_auth_failed');
      this.verifyPoll({ ...poll.macObject, mac: poll.mac });
    } catch (error) {
      // Only the explicit session codes keep their own §15 face; everything
      // else (unparseable query, bad params, unknown throwable) stays 401.
      if (error instanceof BridgeError && POLL_AUTH_PASS_THROUGH_CODES.has(error.code)) {
        sendError(res, error);
        return;
      }
      sendError(res, new BridgeError('poll_auth_failed'));
      return;
    }
    const { wait, max, sid } = poll;

    const deliver = () => {
      const frames = this._queue.take(max);
      if (frames.length === 0) {
        sendJson(res, 204);
        return;
      }
      sendJson(res, 200, {
        v: 1,
        conn: this._cfg.id,
        sid,
        frames,
        redelivery: false,
      });
    };

    if (this._queue.size > 0 || wait === 0) {
      deliver();
      return;
    }
    await /** @type {Promise<void>} */ (new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._waiters.delete(waiter);
        resolve();
      }, wait * 1000);
      if (typeof timer.unref === 'function') timer.unref();
      const waiter = () => {
        clearTimeout(timer);
        this._waiters.delete(waiter);
        resolve();
      };
      this._waiters.add(waiter);
    }));
    if (res.writableEnded) return;
    deliver();
  }

  /**
   * Handle `POST {base}/poll/ack`: remove acknowledged frames.
   * @param {import('node:http').IncomingMessage} req - request.
   * @param {import('node:http').ServerResponse} res - response.
   * @returns {Promise<void>} resolution after the response.
   */
  async _onPollAck(req, res) {
    const raw = parseJson(await readBody(req, Limits.MAX_FRAME_BYTES));
    // §7.4 authenticates the ack with the same projection the sender MACs:
    // `mac_target` instead of `target`, integers as integers, and none of the
    // envelope-only fields (`v`, `target`) inside the MAC input. Extra members
    // stay ignored (§17), but the MAC input is never widened by them.
    let ack;
    try {
      if (typeof this.verifyPollAck !== 'function') throw new BridgeError('poll_auth_failed');
      ack = parsePollAckBody(raw);
      this.verifyPollAck({ ...ack.macObject, mac: ack.mac });
    } catch (error) {
      // Same allowlist as `_onPoll()`: a structural `bad_params` (or anything
      // that is not a BridgeError) must not leak as a session signal.
      if (error instanceof BridgeError && POLL_AUTH_PASS_THROUGH_CODES.has(error.code)) {
        sendError(res, error);
        return;
      }
      sendError(res, new BridgeError('poll_auth_failed'));
      return;
    }
    this._queue.ack(ack.acks);
    sendJson(res, 204);
  }

  /**
   * Handle inbound probes on the long-poll port as well.
   * @param {import('node:http').IncomingMessage} req - request.
   * @param {import('node:http').ServerResponse} res - response.
   * @returns {Promise<void>} resolution after the response.
   */
  async _onProbe(req, res) {
    const probe = parseJson(await readBody(req, Limits.MAX_FRAME_BYTES));
    const answer = this._hooks.onProbe?.(probe);
    if (answer === undefined) {
      sendError(res, new BridgeError('bad_frame'));
      return;
    }
    sendJson(res, 200, answer);
  }

  /** Start the outbound pull loop for `mode: connect`. */
  _startPolling() {
    this._stopPolling();
    this._polling = true;
    void this._pollLoop();
  }

  /** Stop the outbound pull loop. */
  _stopPolling() {
    this._polling = false;
    if (this._pollTimer !== null) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
  }

  /**
   * Pull frames until the carrier stops.
   * @returns {Promise<void>} resolution when the loop ends.
   */
  async _pollLoop() {
    while (this._polling && !this._stopped) {
      let delayMs = 0;
      try {
        await this._pollOnce();
        this._consecutiveTimeouts = 0;
      } catch (error) {
        const bridgeError = error instanceof BridgeError ? error : new BridgeError('internal_error');
        if (bridgeError.code === 'timeout') {
          this._consecutiveTimeouts += 1;
        } else if (bridgeError.fatal || ['poll_auth_failed', 'sid_mismatch', 'stale_session', 'not_ready'].includes(bridgeError.code)) {
          // These mean the local session state is stale: report so the session
          // layer re-handshakes instead of polling with a dead sid (§7.4).
          this._hooks.onState?.('stale');
          this._polling = false;
          return;
        }
        delayMs = 1000;
        this.logger.debug('poll_retry', { conn: this._cfg.id, code: bridgeError.code });
      }
      if (!this._polling || this._stopped) return;
      await new Promise((resolve) => {
        this._pollTimer = setTimeout(resolve, delayMs);
        if (typeof this._pollTimer.unref === 'function') this._pollTimer.unref();
      });
    }
  }

  /**
   * Perform one poll round and dispatch every returned frame.
   * @returns {Promise<void>} resolution after dispatch and ack.
   */
  async _pollOnce() {
    const query = this._buildPollQuery();
    // The query carries numbers for the MAC projection (JCS distinguishes 5
    // from "5"), so the URL encoding stringifies each pair explicitly instead
    // of letting `URLSearchParams` do it implicitly.
    const encoded = new URLSearchParams(
      Object.entries(query).map(([key, value]) => [key, String(value)]),
    ).toString();
    const url = `${peerBaseUrl(this._cfg)}${Endpoints.POLL}?${encoded}`;
    const { status, body } = await getJson(url, {
      timeoutMs: (this.pollWaitS + 10) * 1000,
    });
    if (status === 204) return;
    if (status !== 200) throw errorOfStatus(status, body);
    // A malformed `frames` value is peer input; the cast only names the shape,
    // the `?? []` fallback keeps exactly the previous runtime behaviour.
    const polled = /** @type {{frames?: object[]}|null|undefined} */ (body);
    const frames = polled?.frames ?? [];
    const refs = [];
    for (const frame of frames) {
      try {
        await this._hooks.onEnvelope(frame);
        refs.push(`${frame.type}#${frame.seq}`);
      } catch (error) {
        // A fatal frame error must end the session; a per-frame rejection just
        // leaves the frame unacked so it can be re-driven by business logic.
        if (error instanceof BridgeError && error.fatal) throw error;
        this.logger.warn('poll_frame_rejected', { conn: this._cfg.id, code: 'bad_frame' });
      }
    }
    if (refs.length > 0) await this._sendAck(refs);
  }

  /**
   * Build the authenticated poll query (§7.4).
   * @returns {Record<string, string|number>} query parameters.
   */
  _buildPollQuery() {
    const query = {
      conn: this._cfg.id,
      sid: this._sid ?? '',
      side: this._side ?? 'B',
      wait: this.pollWaitS,
      max: Limits.POLL_MAX_FRAMES,
      ts: Date.now(),
      nonce: randomBytes(16).toString('base64url'),
      target: 'poll',
    };
    // Signed through the same builder the listener verifies with, so the two
    // sides cannot drift on the field set or the integer projection.
    const macObject = pollMacObject(query);
    return { ...query, mac: this.signPoll === undefined ? '' : this.signPoll(macObject) };
  }

  /**
   * Acknowledge delivered frames (§7.4).
   * @param {string[]} refs - `type#seq` references.
   * @returns {Promise<void>} resolution after the ack was accepted.
   */
  async _sendAck(refs) {
    const body = {
      v: 1,
      conn: this._cfg.id,
      sid: this._sid ?? '',
      side: this._side ?? 'B',
      ts: Date.now(),
      target: 'poll_ack',
      nonce: randomBytes(16).toString('base64url'),
      acks: refs,
    };
    // Sign through the same projection the listener verifies with. `body` is
    // still unsigned here, so it must not go through `parsePollAckBody()`: that
    // is the inbound validator and it rightly rejects a missing `mac`.
    const macObject = ackMacObject(body);
    const mac = this.signPollAck === undefined ? '' : this.signPollAck(macObject);
    await postJson(`${peerBaseUrl(this._cfg)}${Endpoints.POLL_ACK}`, { ...body, mac });
  }

  /**
   * Update the sid/side used in poll authentication after a handshake.
   * @param {string} sid - current session id.
   * @param {'A'|'B'} side - this endpoint's side.
   * @returns {void}
   */
  setSessionIdentity(sid, side) {
    this._sid = sid;
    this._side = side;
    if (this._server === null && !this._stopped && !this._polling) this._startPolling();
  }

  /**
   * Deliver one envelope: push it into the local queue when listening, or POST
   * it upstream when connecting.
   * @param {object} envelope - sealed frame.
   * @returns {Promise<void>} resolution after delivery.
   */
  async sendEnvelope(envelope) {
    if (this._stopped) throw new BridgeError('not_ready');
    if (this._inline !== null && this._inline !== undefined) {
      this._inline.push(envelope);
      return;
    }
    if (this._server !== null) {
      this._queue.push(envelope);
      for (const waiter of [...this._waiters]) waiter();
      return;
    }
    const url = `${peerBaseUrl(this._cfg)}${Endpoints.FRAMES}`;
    const { status, body } = await postJson(url, {
      v: 1,
      conn: this._cfg.id,
      sid: this._sid ?? null,
      batch_id: randomUUID(),
      frames: [envelope],
    });
    if (status === 200 && body !== null && typeof body === 'object'
      && Array.isArray(/** @type {{frames?: unknown}} */ (body).frames)) {
      const peerBatch = /** @type {import('./base.js').FrameBatch} */ (body);
      for (const frame of peerBatch.frames) await this._hooks.onEnvelope(frame);
      return;
    }
    if (status === 202) {
      const rejected = (body === null || typeof body !== 'object'
        ? []
        : /** @type {{rejected?: import('./base.js').RejectedFrame[]}} */ (body).rejected) ?? [];
      if (rejected.length > 0) throw new BridgeError(rejected[0].code);
      return;
    }
    throw errorOfStatus(status, body);
  }

  /**
   * Send `hello` and await `hello_ack` inline.
   * @param {object} hello - hello object.
   * @returns {Promise<object|undefined>} hello_ack.
   */
  async sendPlain(hello) {
    const { status, body } = await postJson(`${peerBaseUrl(this._cfg)}${Endpoints.HELLO}`, hello);
    if (status !== 200) throw errorOfStatus(status, body);
    return body;
  }

  /**
   * Answer an inbound hello through the open HTTP response.
   * @param {object} object - hello_ack.
   * @returns {void}
   */
  respondPlain(object) {
    this._responder.settle(object);
  }

  /**
   * Answer a refused handshake with the protocol error body (§8.2).
   * @param {BridgeError} error - failure to report.
   * @returns {void}
   */
  respondError(error) {
    this._responder.fail(error);
  }

  /**
   * Stop the carrier.
   * @returns {Promise<void>} resolution after teardown.
   */
  async stop() {
    if (this._stopped) return;
    this._stopped = true;
    this._stopPolling();
    for (let attempt = 0; attempt < 100 && this._inflight > 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    this._responder.cancel();
    for (const waiter of [...this._waiters]) waiter();
    this._waiters.clear();
    this._queue.clear();
    await closeServer(this._server, [...this._sockets]);
    this._server = null;
    this._sockets.clear();
  }
}

/**
 * Parse one query value as a decimal integer, strictly (§2.3, §7.4).
 *
 * `Number.parseInt('32abc')` is 32 and `Number('1.5')` is not an integer, so
 * neither may be used for protocol integers: a value that is not exactly its
 * own shortest decimal form is a different MAC input, not a forgiving one.
 * @param {string|null} raw - raw query value, `null` when absent.
 * @param {number} min - inclusive lower bound.
 * @param {number} max - inclusive upper bound.
 * @returns {number} the parsed integer.
 * @throws {BridgeError} `bad_params` when absent, malformed, or out of range.
 */
function strictInt(raw, min, max) {
  if (raw === null || !/^(?:0|-?[1-9][0-9]*)$/.test(raw)) {
    throw new BridgeError('bad_params');
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new BridgeError('bad_params');
  }
  return value;
}

/**
 * Read one query parameter, rejecting repeats (§7.4).
 *
 * A repeated parameter has no single canonical value, and picking one (first or
 * last) would let a sender authenticate one value while the `mac` came from the
 * other. Duplicates are therefore refused instead of resolved.
 * @param {URLSearchParams} query - request query.
 * @param {string} name - parameter name.
 * @returns {string|null} the value, or `null` when absent.
 * @throws {BridgeError} `bad_params` when the parameter appears more than once.
 */
function singleParam(query, name) {
  const values = query.getAll(name);
  if (values.length === 0) return null;
  if (values.length > 1) throw new BridgeError('bad_params');
  return values[0];
}

/**
 * Build the poll MAC object of §7.4 from digits-only wire fields.
 *
 * This is the single projection used by both directions: the connect side signs
 * its own `GET /poll` through it and the listen side verifies inbound polls
 * through it, so signing and verification cannot drift on the field set or on
 * the integer/`mac_target` renaming.
 * @param {{conn: string, max: number, nonce: string, side: string, sid: string, ts: number, wait: number}} fields - projected fields.
 * @returns {Record<string, string|number>} MAC object.
 */
function pollMacObject(fields) {
  return {
    conn: fields.conn,
    mac_target: 'poll',
    max: fields.max,
    nonce: fields.nonce,
    side: fields.side,
    sid: fields.sid,
    ts: fields.ts,
    wait: fields.wait,
  };
}

/**
 * Project an inbound `GET /poll` query onto the exact MAC object of §7.4.
 *
 * The wire carries `target` while the MAC input names the same field
 * `mac_target`, and `max`/`ts`/`wait` are integers on both sides. This is the
 * *only* accepted shape: a raw-query fallback would mean signing and verifying
 * two different messages for one request.
 * @param {URLSearchParams} query - request query.
 * @returns {{macObject: Record<string, string|number>, mac: string, wait: number, max: number, sid: string}} projection.
 * @throws {BridgeError} `bad_params` when a member is missing, repeated, or malformed.
 */
function parsePollQuery(query) {
  const conn = singleParam(query, 'conn');
  const sid = singleParam(query, 'sid');
  const side = singleParam(query, 'side');
  const nonce = singleParam(query, 'nonce');
  const target = singleParam(query, 'target');
  const mac = singleParam(query, 'mac');
  if (conn === null || sid === null || side === null || nonce === null || nonce.length === 0) {
    throw new BridgeError('bad_params');
  }
  if (mac === null || mac.length === 0) throw new BridgeError('bad_params');
  // §7.4 requires `target=poll`; it is not an optional alias of `mac_target`.
  if (target !== 'poll') throw new BridgeError('bad_params');
  const wait = strictInt(singleParam(query, 'wait'), 0, Limits.POLL_WAIT_MAX_S);
  const max = strictInt(singleParam(query, 'max'), 1, Limits.POLL_MAX_FRAMES);
  const ts = strictInt(singleParam(query, 'ts'), 0, Number.MAX_SAFE_INTEGER);
  return { macObject: pollMacObject({ conn, max, nonce, side, sid, ts, wait }), mac, wait, max, sid };
}

/**
 * Build the poll-ack MAC object of §7.4 from validated wire fields.
 *
 * This is the single projection for both directions: the connect side signs
 * its own ack through it and the listen side verifies inbound acks through it,
 * so the two cannot drift on the `mac_target` renaming or the `acks` shape.
 * @param {{acks: string[], conn: string, nonce: string, side: string, sid: string, ts: number}} fields - projected fields.
 * @returns {{acks: string[], conn: string, mac_target: string, nonce: string, side: string, sid: string, ts: number}} MAC object.
 */
function ackMacObject(fields) {
  return {
    acks: fields.acks,
    conn: fields.conn,
    mac_target: 'poll_ack',
    nonce: fields.nonce,
    side: fields.side,
    sid: fields.sid,
    ts: fields.ts,
  };
}

/**
 * Project an inbound `POST /poll/ack` body onto the exact MAC object of §7.4.
 *
 * The ack MAC input is the body minus `mac`, with `mac_target` naming what the
 * wire calls `target`; `v` never participates. `acks` is signed as sent, so its
 * order is preserved, and unknown members are not folded in (§17).
 * @param {unknown} body - wire body.
 * @returns {{macObject: Record<string, string|number|string[]>, mac: string, acks: string[]}} projection.
 * @throws {BridgeError} `bad_params` when a required member is missing or mistyped.
 */
function parsePollAckBody(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new BridgeError('bad_params');
  }
  const wire = /** @type {Record<string, unknown>} */ (body);
  const { conn, sid, side, nonce, target, acks, ts, mac } = wire;
  if (typeof conn !== 'string' || typeof sid !== 'string' || typeof side !== 'string') {
    throw new BridgeError('bad_params');
  }
  if (typeof nonce !== 'string' || nonce.length === 0) throw new BridgeError('bad_params');
  if (target !== 'poll_ack') throw new BridgeError('bad_params');
  if (!Array.isArray(acks) || acks.some((ref) => typeof ref !== 'string' || ref.length === 0)) {
    throw new BridgeError('bad_params');
  }
  if (!Number.isSafeInteger(ts) || /** @type {number} */ (ts) < 0) throw new BridgeError('bad_params');
  if (typeof mac !== 'string' || mac.length === 0) throw new BridgeError('bad_params');
  const refs = /** @type {string[]} */ (acks);
  return {
    macObject: ackMacObject({ acks: refs, conn, nonce, side, sid, ts: /** @type {number} */ (ts) }),
    mac,
    acks: refs,
  };
}

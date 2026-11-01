/**
 * HTTP webhook carrier (protocol §7.3).
 *
 * Webhook requires **bidirectional reachability**: the initiator POSTs
 * `/hello` then `/frames`, and the responder must be able to POST back. So
 * *both* modes own an inbound server, and the address each side POSTs to is the
 * configured peer address — never `host`/`port` read as "whatever this process
 * bound", which would make the carrier POST to itself. That assumption is not
 * assumed either — it is probed, and a responder that cannot be reached is
 * reported as `transport_degraded` so the manager can fall back to long
 * polling instead of silently dropping reverse events.
 * @module dsh-plugin-astrbot-bridge/transport/webhook
 */

import { randomBytes, randomUUID } from 'node:crypto';

import { BridgeError } from '../errors.js';
import { defaultLogger } from '../log.js';
import { Limits } from '../constants.js';
import {
  Endpoints,
  PlainResponder,
  Transport,
  assertAcceptableRequest,
  bindTarget,
  closeServer,
  createServerFor,
  errorOfStatus,
  listenOn,
  parseJson,
  pathMatches,
  peerBaseUrl,
  peerTarget,
  postJson,
  readBody,
  sameEndpoint,
  sendError,
  sendJson,
} from './base.js';

/** Consecutive probe failures before the carrier reports degradation (§7.3 rule 6). */
export const WEBHOOK_PROBE_FAIL = 3;

/** Webhook carrier. */
export class WebhookTransport extends Transport {
  /**
   * @param {object} [options] - carrier options.
   * @param {(envelope: object) => object} [options.sealProbe] - builds a signed probe object.
   * @param {import('../log.js').Logger} [options.logger] - structured logger.
   * @param {number} [options.probeIntervalMs] - probe period.
   */
  constructor(options = {}) {
    super();
    this.logger = options.logger ?? defaultLogger.child('transport:webhook');
    this.probeIntervalMs = options.probeIntervalMs ?? 30_000;
    this._server = null;
    this._sockets = new Set();
    this._hooks = null;
    this._cfg = null;
    /** Fixed, configuration-derived peer address (`{host, port}`), or null. */
    this._peer = null;
    this._responder = new PlainResponder();
    this._inline = null;
    this._inflight = 0;
    this._probeFailures = 0;
    this._degraded = false;
    this._probeTimer = null;
    this._stopped = true;
  }

  /** @returns {'webhook'} */
  get name() {
    return 'webhook';
  }

  /** Whether outbound delivery is currently believed to work (both directions). */
  alive() {
    return !this._stopped && !this._degraded;
  }

  /** Consecutive probe failures observed so far (diagnostics/tests). */
  get probeFailures() {
    return this._probeFailures;
  }

  /** Whether the carrier has reported bidirectional degradation. */
  get degraded() {
    return this._degraded;
  }

  /**
   * Start the carrier.
   *
   * Both modes listen: the responder is POSTed to, and the initiator must still
   * own an inbound `/frames` endpoint for reverse events (§7.3 rule 2). The
   * address that receives those POSTs is the configured peer address, kept
   * separate from the local bind address, so a listen endpoint never targets
   * its own socket.
   * @param {object} cfg - connection configuration.
   * @param {object} hooks - session hooks.
   * @returns {Promise<void>} resolution when ready to carry frames.
   * @throws {BridgeError} `config_invalid` for a half-configured or self peer.
   */
  async start(cfg, hooks) {
    this._hooks = hooks;
    this._cfg = cfg;
    const peer = peerTarget(cfg);
    const bind = bindTarget(cfg);
    if (peer !== null && sameEndpoint(peer, bind)) {
      // Refuse at start rather than after the first frame: a peer that is this
      // process is a configuration mistake, and POSTing to it would feed this
      // endpoint's own reverse traffic straight back into itself.
      throw new BridgeError('config_invalid', { details: { field: 'peerHost' } });
    }
    this._peer = peer;
    this._stopped = false;
    if (peer === null) {
      this.logger.warn('webhook_peer_not_configured', { conn: cfg.id, carrier: 'webhook' });
    }
    this._ensureReachable(cfg);
    await this._startServer(cfg);
    this._startProbing();
    this._hooks.onState?.(cfg.mode === 'listen' ? 'listening' : 'connected');
  }

  /**
   * Reject a peer address that is neither loopback nor explicitly allowed.
   *
   * Posting frames to an arbitrary address is an outbound request on behalf of
   * the operator, so the private-range rule is enforced before the first send.
   * The checked host is the *peer* host, never the local bind host: on loopback
   * deployments those differ, and checking the wrong one would either allow a
   * private peer or block a public bind.
   * @param {object} cfg - connection configuration.
   * @returns {void}
   * @throws {BridgeError} `config_invalid` when a private non-loopback peer is disallowed.
   */
  _ensureReachable(cfg) {
    if (this._peer === null) return;
    const host = this._peer.host;
    const isLoopback = host === '127.0.0.1' || host === '::1' || host === 'localhost';
    if (isLoopback || cfg.allowPrivateAddr === true) return;
    const isPrivate =
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      /^f[cd]/.test(host.toLowerCase());
    if (isPrivate) throw new BridgeError('config_invalid', { details: { field: 'allowPrivateAddr' } });
  }

  /**
   * Start the inbound server for both modes.
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
    const port = await listenOn(server, cfg);
    this.logger.info('webhook_listening', { conn: cfg.id, port });
  }

  /**
   * Port this carrier actually bound (diagnostics/tests; 0 before start).
   * @returns {number} bound port.
   */
  get boundPort() {
    const address = this._server?.address();
    return typeof address === 'object' && address !== null ? address.port : 0;
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
      if (req.method === 'POST' && pathMatches(req, cfg.path, Endpoints.PROBE)) {
        await this._onProbe(req, res);
        return;
      }
      if (pathMatches(req, cfg.path, Endpoints.HELLO) || pathMatches(req, cfg.path, Endpoints.FRAMES)) {
        sendError(res, new BridgeError('bad_frame', { http: 405 }));
        return;
      }
      sendError(res, new BridgeError('unknown_conn', { http: 404 }));
    } catch (error) {
      sendError(res, error instanceof BridgeError ? error : new BridgeError('internal_error'));
    }
  }

  /**
   * Handle `POST {base}/hello` (§7.3 rule 1).
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
   * Handle `POST {base}/frames` — a batch of envelopes (§7.3 rule 3).
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
        // §7.3.3: a batch must be strictly ascending; anything else is malformed.
        sendError(res, new BridgeError('bad_batch'));
        return;
      }
      previousSeq = frame.seq;
    }

    const accepted = [];
    const rejected = [];
    // Frames the session produces while handling this batch belong in this
    // response: the initiator is not listening, so `auth_ack` can only travel
    // back on the POST that carried `auth` (§7.3 rule 2).
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
   * Handle inbound probe frames (§7.3 rule 5).
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

  /**
   * Deliver one envelope to the peer with `POST /frames`.
   * @param {object} envelope - sealed frame.
   * @returns {Promise<void>} resolution after the peer accepted it.
   * @throws {BridgeError} `config_invalid` when no peer address is configured.
   */
  async sendEnvelope(envelope) {
    if (this._stopped) throw new BridgeError('not_ready');
    if (this._inline !== null && this._inline !== undefined) {
      this._inline.push(envelope);
      return;
    }
    const url = `${peerBaseUrl(this._cfg)}${Endpoints.FRAMES}`;
    const batch = {
      v: 1,
      conn: this._cfg.id,
      sid: envelope.sid ?? null,
      batch_id: randomUUID(),
      frames: [envelope],
    };
    const { status, body } = await postJson(url, batch);
    if (status === 200 && body !== null && typeof body === 'object'
      && Array.isArray(/** @type {{frames?: unknown}} */ (body).frames)) {
      // During the handshake the responder answers with the `auth_ack` batch.
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
   * Send `hello` and await `hello_ack` inline (§7.3 rule 1).
   * @param {object} hello - hello object.
   * @returns {Promise<object|undefined>} hello_ack.
   */
  async sendPlain(hello) {
    const url = `${peerBaseUrl(this._cfg)}${Endpoints.HELLO}`;
    const { status, body } = await postJson(url, hello);
    if (status !== 200) throw errorOfStatus(status, body);
    return body;
  }

  /**
   * Webhook cannot answer an inbound hello out of band; it returns the ack
   * through the open HTTP response instead.
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
   * Start the outbound probe loop that detects one-way reachability.
   *
   * Both modes probe, because both must POST reverse events: a `listen`
   * endpoint whose peer is unreachable is exactly as one-way as a `connect`
   * endpoint whose peer is unreachable. Probing is skipped when no peer is
   * configured — there is nothing to probe, and counting that as a failure
   * would report a configuration choice as a network fault.
   */
  _startProbing() {
    this._stopProbing();
    if (this._peer === null) return;
    this._probeTimer = setInterval(() => {
      void this.probeOnce();
    }, this.probeIntervalMs);
    if (typeof this._probeTimer.unref === 'function') this._probeTimer.unref();
  }

  /** Stop the probe loop. */
  _stopProbing() {
    if (this._probeTimer !== null) {
      clearInterval(this._probeTimer);
      this._probeTimer = null;
    }
  }

  /**
   * Probe the peer once and update the degradation state (§7.3 rule 6).
   * @returns {Promise<boolean>} whether the peer answered.
   */
  async probeOnce() {
    if (this._stopped) return false;
    // No configured peer means no reverse path to test: report "not reachable"
    // without manufacturing three failures against a configuration choice.
    if (this._peer === null) return false;
    const unsigned = {
      v: 1,
      type: 'probe',
      conn: this._cfg.id,
      nonce: randomBytes(16).toString('base64url'),
      ts: Date.now(),
    };
    // The MAC is produced by the layer that owns the PSK; the carrier only
    // transports the resulting object.
    const object = this._signProbe === undefined ? unsigned : this._signProbe(unsigned);
    try {
      const { status, body } = await postJson(`${peerBaseUrl(this._cfg)}${Endpoints.PROBE}`, object, {
        timeoutMs: 10_000,
      });
      const isProbeAck = body !== null && typeof body === 'object'
        && /** @type {{type?: unknown}} */ (body).type === 'probe_ack';
      if (status !== 200 || !isProbeAck) throw new BridgeError('timeout');
      this._probeFailures = 0;
      if (this._degraded) {
        this._degraded = false;
        this._hooks.onState?.('ready');
      }
      return true;
    } catch {
      this._probeFailures += 1;
      if (this._probeFailures >= WEBHOOK_PROBE_FAIL && !this._degraded) {
        this._degraded = true;
        this.logger.warn('transport_degraded', {
          conn: this._cfg.id,
          carrier: 'webhook',
          failures: this._probeFailures,
        });
        this._hooks.onState?.('degraded');
      }
      return false;
    }
  }

  /**
   * Install the probe signer supplied by the session layer.
   * @param {(probe: object) => object} signer - adds the `mac` field.
   * @returns {void}
   */
  setProbeSigner(signer) {
    this._signProbe = signer;
  }

  /**
   * Stop the carrier.
   * @returns {Promise<void>} resolution after teardown.
   */
  async stop() {
    if (this._stopped) return;
    this._stopped = true;
    this._stopProbing();
    // Let an in-flight handshake refusal finish writing its response before
    // the sockets are destroyed; a truncated 401 would read as a network fault.
    for (let attempt = 0; attempt < 100 && this._inflight > 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    this._responder.cancel();
    await closeServer(this._server, [...this._sockets]);
    this._server = null;
    this._sockets.clear();
  }
}

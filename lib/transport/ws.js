/**
 * WebSocket / WSS carrier (protocol §7.2).
 *
 * `listen` mode owns its own `node:http(s)` server and upgrades requests with
 * subprotocol `dsh-bridge.v1`; `connect` mode dials `ws(s)://…`. The host
 * webserver is deliberately not reused: it carries no TLS, authentication or
 * origin policy of its own, which is exactly what this channel must supply.
 * @module dsh-plugin-astrbot-bridge/transport/ws
 */

import { WebSocket, WebSocketServer } from 'ws';

import { BridgeError, asBridgeError } from '../errors.js';
import { defaultLogger } from '../log.js';
import {
  Endpoints,
  Transport,
  assertAcceptableRequest,
  closeServer,
  createServerFor,
  listenOn,
  pathMatches,
  sendError,
  sendJson,
} from './base.js';

/** Subprotocol both peers must negotiate (§7.2 rule 1). */
export const BRIDGE_SUBPROTOCOL = 'dsh-bridge.v1';

/** WebSocket close codes used by the bridge (§6.2). */
const WS_CLOSE = Object.freeze({ NORMAL: 1000, PROTOCOL: 1002, POLICY: 1008, TOO_LARGE: 1009 });

/** WebSocket carrier. */
export class WsTransport extends Transport {
  /**
   * @param {object} [options] - carrier options.
   * @param {import('../log.js').Logger} [options.logger] - structured logger.
   * @param {number} [options.maxFrameBytes] - inbound frame limit.
   */
  constructor(options = {}) {
    super();
    this.logger = options.logger ?? defaultLogger.child('transport:ws');
    this.maxFrameBytes = options.maxFrameBytes;
    this._server = null;
    this._wss = null;
    this._socket = null;
    this._hooks = null;
    this._sockets = new Set();
    this._plainReply = null;
    this._stopped = true;
  }

  /** @returns {'ws'} */
  get name() {
    return 'ws';
  }

  /** Whether a live socket is open. */
  alive() {
    return this._socket !== null && this._socket.readyState === WebSocket.OPEN;
  }

  /**
   * Open the carrier according to `mode`.
   * @param {object} cfg - connection configuration.
   * @param {object} hooks - session hooks.
   * @returns {Promise<void>} resolution when the socket is open.
   */
  async start(cfg, hooks) {
    this._hooks = hooks;
    this._cfg = cfg;
    this._stopped = false;
    if (cfg.mode === 'listen') await this._startServer(cfg);
    else await this._connect(cfg);
  }

  /**
   * Start the listening server and wait for the peer's upgrade.
   * @param {object} cfg - connection configuration.
   * @returns {Promise<void>} resolution once listening.
   */
  async _startServer(cfg) {
    const server = createServerFor(cfg, (req, res) => this._onHttpRequest(req, res), this.logger);
    server.on('connection', (socket) => {
      this._sockets.add(socket);
      socket.on('close', () => this._sockets.delete(socket));
    });
    this._server = server;
    this._wss = new WebSocketServer({
      noServer: true,
      maxPayload: this.maxFrameBytes ?? 2_097_152,
      handleProtocols: (protocols) => (protocols.has(BRIDGE_SUBPROTOCOL) ? BRIDGE_SUBPROTOCOL : false),
    });
    server.on('upgrade', (req, socket, head) => {
      // Never let a WS upgrade through unnamed: an unnegotiated subprotocol
      // means the peer is not speaking this protocol at all.
      if (!pathMatches(req, cfg.path, '') && new URL(req.url ?? '/', 'http://x').pathname !== cfg.path) {
        socket.destroy();
        return;
      }
      try {
        assertAcceptableRequest(req);
      } catch {
        socket.destroy();
        return;
      }
      this._wss.handleUpgrade(req, socket, head, (ws) => {
        this._wss.emit('connection', ws, req);
      });
    });
    this._wss.on('connection', (ws, req) => this._attachSocket(ws, req));
    await listenOn(server, cfg);
    this.logger.info('ws_listening', { conn: cfg.id, port: cfg.port });
    hooksState(this, 'listening');
  }

  /**
   * Dial the peer as a WebSocket client.
   * @param {object} cfg - connection configuration.
   * @returns {Promise<void>} resolution when the socket is open.
   */
  async _connect(cfg) {
    const scheme = cfg.tlsEnabled === true ? 'wss' : 'ws';
    const host = cfg.host.includes(':') && !cfg.host.startsWith('[') ? `[${cfg.host}]` : cfg.host;
    const url = `${scheme}://${host}:${cfg.port}${cfg.path}`;
    const ws = new WebSocket(url, BRIDGE_SUBPROTOCOL, {
      maxPayload: this.maxFrameBytes ?? 2_097_152,
      handshakeTimeout: 10_000,
      rejectUnauthorized: cfg.tlsFingerprint ? true : cfg.tlsEnabled === true,
    });
    await /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new BridgeError('timeout'));
      }, 10_000);
      ws.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.once('error', () => {
        clearTimeout(timer);
        reject(new BridgeError('internal_error', { details: { reason: 'network' } }));
      });
    }));
    if (ws.protocol !== BRIDGE_SUBPROTOCOL) {
      ws.close(WS_CLOSE.PROTOCOL);
      throw new BridgeError('subprotocol_mismatch');
    }
    this._attachSocket(ws, null);
    this.logger.info('ws_connected', { conn: cfg.id });
    hooksState(this, 'connected');
  }

  /**
   * Wire one socket into the session hooks.
   * @param {WebSocket} ws - socket.
   * @param {import('node:http').IncomingMessage|null} req - upgrade request, if any.
   * @returns {void}
   */
  _attachSocket(ws, req) {
    void req;
    this._socket = ws;
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        // §7.2 rule 3: frames are text; a binary frame is a protocol error.
        ws.close(WS_CLOSE.PROTOCOL);
        return;
      }
      void this._onSocketMessage(data.toString('utf8'));
    });
    ws.on('close', () => {
      if (this._socket === ws) this._socket = null;
      hooksState(this, 'closed');
    });
    ws.on('error', () => {
      if (this._socket === ws) this._socket = null;
    });
  }

  /**
   * Dispatch one text frame: envelopes go to the session, so does a plain
   * `hello`/`hello_ack`; a client-side `hello_ack` also answers `sendPlain`.
   * @param {string} text - frame text.
   * @returns {Promise<void>} resolution after dispatch.
   */
  async _onSocketMessage(text) {
    if (text.length > (this.maxFrameBytes ?? 2_097_152)) {
      this._socket?.close(WS_CLOSE.TOO_LARGE);
      hooksState(this, 'closed');
      return;
    }
    let object;
    try {
      object = JSON.parse(text);
    } catch {
      this._socket?.close(WS_CLOSE.PROTOCOL);
      return;
    }
    if (object !== null && typeof object === 'object' && typeof object.type === 'string' && object.ct === undefined) {
      if (object.type === 'hello' || object.type === 'hello_ack') {
        const waiter = this._plainReply;
        this._plainReply = null;
        if (waiter !== null) waiter(object);
        else await this._hooks?.onPlain?.(object);
        return;
      }
      if (object.type === 'probe' || object.type === 'probe_ack') {
        const answer = this._hooks?.onProbe?.(object);
        if (answer !== undefined) await this.sendPlain(answer);
        return;
      }
      await this._hooks?.onPlain?.(object);
      return;
    }
    await this._hooks?.onEnvelope?.(object);
  }

  /**
   * Send one plain object and wait for its reply on the same socket.
   * @param {object} object - object to send.
   * @returns {Promise<object|undefined>} reply object, or undefined if the socket closed.
   */
  async sendPlain(object) {
    if (!this.alive()) throw new BridgeError('not_ready');
    const response = new Promise((resolve) => {
      this._plainReply = resolve;
    });
    this._socket.send(JSON.stringify(object));
    return response;
  }

  /**
   * Send one plain object without expecting a reply in return.
   * @param {object} object - object to send.
   * @returns {void}
   */
  respondPlain(object) {
    if (!this.alive()) return;
    this._socket.send(JSON.stringify(object));
  }

  /**
   * Answer a refused handshake with the error object, then close.
   *
   * A WebSocket has no HTTP status left to use once upgraded, so the refusal
   * travels as a `hello`-shaped error object before the socket closes (§8.2).
   * @param {BridgeError} error - failure to report.
   * @returns {void}
   */
  respondError(error) {
    if (!this.alive()) return;
    // `toHttpBody()` already carries the pinned `v`; taking it out first lets the
    // frame keep its `v, type, error` key order without a duplicate `v` literal.
    const { v, ...body } = error.toHttpBody();
    this._socket.send(JSON.stringify({ v, type: 'error', ...body }));
    this._socket.close(WS_CLOSE.POLICY);
  }

  /**
   * Send one sealed envelope as a text frame.
   * @param {object} envelope - §5.1 envelope.
   * @returns {Promise<void>} resolution after enqueue.
   */
  async sendEnvelope(envelope) {
    if (!this.alive()) throw new BridgeError('not_ready');
    await /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
      this._socket.send(JSON.stringify(envelope), (error) => {
        if (error) reject(new BridgeError('internal_error', { details: { reason: 'socket' } }));
        else resolve();
      });
    }));
  }

  /**
   * Answer HTTP requests on the same port during `listen` mode.
   *
   * Only `GET {base}/health` is served here: WS is the data path, so any other
   * HTTP request on this port is a configuration error rather than a feature.
   * @param {import('node:http').IncomingMessage} req - inbound request.
   * @param {import('node:http').ServerResponse} res - response.
   * @returns {void}
   */
  _onHttpRequest(req, res) {
    if (this._cfg && pathMatches(req, this._cfg.path, Endpoints.HEALTH)) {
      sendJson(res, 200, { v: 1, ok: true });
      return;
    }
    try {
      assertAcceptableRequest(req);
    } catch (error) {
      // The guard throws `BridgeError`s; `asBridgeError` keeps a foreign throw
      // from reaching `sendError` (which would leak it as a 500 without a body).
      sendError(res, asBridgeError(error));
      return;
    }
    sendError(res, new BridgeError('bad_frame', { http: 404 }));
  }

  /**
   * Stop the carrier and release every socket.
   * @returns {Promise<void>} resolution after teardown.
   */
  async stop() {
    if (this._stopped) return;
    this._stopped = true;
    this._plainReply = null;
    if (this._socket !== null) {
      try {
        this._socket.close(WS_CLOSE.NORMAL);
      } catch {
        // Socket already gone.
      }
      this._socket = null;
    }
    if (this._wss !== null) {
      this._wss.close();
      this._wss = null;
    }
    await closeServer(this._server, [...this._sockets]);
    this._server = null;
    this._sockets.clear();
  }
}

/**
 * Report a carrier state change without letting a throwing observer break the
 * carrier itself.
 * @param {WsTransport} transport - carrier.
 * @param {string} state - state label.
 * @returns {void}
 */
function hooksState(transport, state) {
  try {
    transport._hooks?.onState?.(state);
  } catch {
    // An observer failure must never take the carrier down.
  }
}

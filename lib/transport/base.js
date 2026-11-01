/**
 * Transport interface and the shared HTTP machinery used by the webhook and
 * long-poll carriers (protocol §7.0, §7.3, §7.4).
 *
 * Transports only move bytes: they see envelopes and the four plain handshake
 * objects and know nothing about message names, tasks or approvals (§1.1).
 * @module dsh-plugin-astrbot-bridge/transport/base
 */

import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';

import { BridgeError } from '../errors.js';
import { defaultLogger } from '../log.js';
import { Limits } from '../constants.js';

/** Header value every request must present (§7.0). */
export const BRIDGE_VERSION_HEADER = 'x-dsh-bridge-version';

/** Headers that must never appear: they imply a bearer-token security model (§7.0). */
const FORBIDDEN_HEADERS = ['authorization', 'cookie', 'proxy-authorization'];

/** Endpoints served by every listening carrier (§7.0). */
export const Endpoints = Object.freeze({
  HELLO: '/hello',
  FRAMES: '/frames',
  POLL: '/poll',
  POLL_ACK: '/poll/ack',
  PROBE: '/probe',
  HEALTH: '/health',
});

/**
 * Abstract carrier for one connection.
 *
 * Subclasses implement `start`, `stop`, `sendEnvelope`, `sendPlain`,
 * `respondPlain` and `alive`. The session layer drives everything through this
 * surface, so it stays carrier-agnostic.
 */
export class Transport {
  /**
   * Carrier name: `ws`, `webhook` or `longpoll`.
   * @returns {string} carrier name; every concrete carrier overrides it.
   */
  get name() {
    throw new Error('not implemented');
  }

  /**
   * Open the carrier.
   * @param {object} cfg - connection configuration.
   * @param {object} hooks - callbacks.
   * @param {Function} hooks.onPlain - receives handshake-phase objects.
   * @param {Function} hooks.onEnvelope - receives sealed envelopes.
   * @param {Function} hooks.onProbe - receives a probe and may return a probe_ack.
   * @param {Function} hooks.onState - receives carrier state changes.
   * @param {Function} [hooks.onUndelivered] - receives envelopes that expired unacked.
   * @returns {Promise<void>} resolution when the carrier can move frames.
   */
  async start(cfg, hooks) {
    void cfg;
    void hooks;
    throw new Error('not implemented');
  }

  /** Stop the carrier and release every socket. @returns {Promise<void>} */
  async stop() {
    throw new Error('not implemented');
  }

  /**
   * Queue one sealed envelope for delivery.
   * @param {object} envelope - §5.1 envelope.
   * @returns {Promise<void>} resolution after the carrier accepted it.
   */
  async sendEnvelope(envelope) {
    void envelope;
    throw new Error('not implemented');
  }

  /**
   * Send one plain handshake object and return the peer's reply.
   * @param {object} object - `hello` (initiator) .
   * @returns {Promise<object|undefined>} `hello_ack`, or undefined when the carrier cannot answer inline.
   */
  async sendPlain(object) {
    void object;
    return undefined;
  }

  /**
   * Answer a plain object received from the peer (responder side).
   * @param {object} object - `hello_ack` (responder).
   * @returns {void}
   */
  respondPlain(object) {
    void object;
  }

  /**
   * Answer a handshake the session refused, when the carrier has a live
   * response channel open. Carriers without one inherit the no-op.
   * @param {BridgeError} error - failure to report.
   * @returns {void}
   */
  respondError(error) {
    void error;
  }

  /** Whether the carrier currently has a live path to the peer. */
  alive() {
    return false;
  }
}

/**
 * Read a request body with a hard byte limit.
 * @param {import('node:http').IncomingMessage} req - inbound request.
 * @param {number} [limit] - maximum accepted byte count.
 * @returns {Promise<Buffer>} body bytes.
 * @throws {BridgeError} `frame_too_large` when the limit is exceeded.
 */
export async function readBody(req, limit = Limits.MAX_BATCH_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new BridgeError('frame_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * One `POST /frames` batch as both HTTP carriers read and write it (§7.3).
 *
 * Declared here because it is the *shared* wire shape, not a per-carrier one:
 * `webhook` and `longpoll` must accept and emit byte-identical batches, and a
 * second local copy is how the two drift apart. Every field is the protocol's
 * own spelling (`sid`, `batch_id`), so nothing is renamed in transit.
 * @typedef {object} FrameBatch
 * @property {number} v - envelope version, always 1.
 * @property {string} [conn] - connection id.
 * @property {string|null} [sid] - session id once a handshake completed.
 * @property {string} [batch_id] - batch identity for dedup/diagnostics.
 * @property {object[]} frames - sealed envelopes, strictly ascending by `seq`.
 */

/**
 * One rejected frame inside a `POST /frames` response (§7.3.3).
 * @typedef {object} RejectedFrame
 * @property {string} ref - `type#seq` of the refused frame.
 * @property {string} code - protocol error code (§15).
 */

/**
 * Parse a JSON body.
 * @param {Buffer} body - raw bytes.
 * @returns {unknown} parsed JSON value.
 * @throws {BridgeError} `bad_json` when the body is not valid JSON.
 */
export function parseJson(body) {
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw new BridgeError('bad_json');
  }
}

/**
 * Send one JSON response.
 * @param {import('node:http').ServerResponse} res - response to write.
 * @param {number} status - HTTP status code.
 * @param {unknown} [body] - JSON body, omitted for 204.
 * @returns {void}
 */
export function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Cache-Control', 'no-store');
  if (status === 204 || body === undefined) {
    res.end();
    return;
  }
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', String(payload.length));
  res.end(payload);
}

/**
 * Send one protocol error using the §8.2 envelope.
 * @param {import('node:http').ServerResponse} res - response to write.
 * @param {BridgeError} error - failure to report.
 * @returns {void}
 */
export function sendError(res, error) {
  sendJson(res, error.http ?? 500, error.toHttpBody());
}

/**
 * Reject requests that use a credential-bearing security model (§7.0).
 *
 * The bridge authenticates with MACs and AEAD, so any `Authorization`/`Cookie`
 * header is either a misconfiguration or an attempt to smuggle a bearer token.
 * @param {import('node:http').IncomingMessage} req - inbound request.
 * @returns {void}
 * @throws {BridgeError} `auth_header_forbidden` or `unsupported_content_type`.
 */
export function assertAcceptableRequest(req) {
  for (const header of FORBIDDEN_HEADERS) {
    if (req.headers[header] !== undefined) throw new BridgeError('auth_header_forbidden');
  }
  if (req.headers['content-encoding'] !== undefined) {
    throw new BridgeError('unsupported_content_type');
  }
  const contentType = req.headers['content-type'];
  if (req.method === 'POST' && contentType !== undefined) {
    if (!contentType.toLowerCase().startsWith('application/json')) {
      throw new BridgeError('unsupported_content_type');
    }
  }
  if (req.headers[BRIDGE_VERSION_HEADER] !== undefined && req.headers[BRIDGE_VERSION_HEADER] !== '1') {
    throw new BridgeError('bad_version');
  }
}

/**
 * Require one request path to match an endpoint exactly.
 * @param {import('node:http').IncomingMessage} req - inbound request.
 * @param {string} base - configured path prefix.
 * @param {string} endpoint - endpoint suffix from {@link Endpoints}.
 * @returns {boolean} whether the path matches.
 */
export function pathMatches(req, base, endpoint) {
  const url = new URL(req.url ?? '/', 'http://placeholder');
  return url.pathname === `${base}${endpoint}`;
}

/**
 * Parse the request query of one poll/ack call.
 * @param {import('node:http').IncomingMessage} req - inbound request.
 * @returns {URLSearchParams} query parameters.
 */
export function queryOf(req) {
  return new URL(req.url ?? '/', 'http://placeholder').searchParams;
}

/**
 * Bounded FIFO of frames awaiting a peer pull (§7.4).
 *
 * Retention is bounded so a peer that stops polling cannot exhaust memory; the
 * dropped frames are reported so the app layer can fall back to
 * `task.status`/`task.list_open` for the authoritative state (§7.4).
 */
export class PollQueue {
  /**
   * @param {object} [options] - queue options.
   * @param {number} [options.retentionFrames] - maximum retained frames.
   * @param {number} [options.redeliverAfterS] - seconds before an unacked frame expires.
   * @param {Function} [options.onExpired] - receives expired envelopes.
   * @param {Function} [options.onOverflow] - receives overflow-dropped envelopes.
   * @param {Function} [options.now] - injectable clock.
   */
  constructor(options = {}) {
    this.retentionFrames = options.retentionFrames ?? Limits.RETENTION_FRAMES;
    this.redeliverAfterS = options.redeliverAfterS ?? Limits.REDELIVER_AFTER_S;
    this.onExpired = options.onExpired ?? (() => {});
    this.onOverflow = options.onOverflow ?? (() => {});
    this.now = options.now ?? (() => Date.now());
    /** @type {Map<string, {envelope: object, at: number}>} */
    this._frames = new Map();
  }

  /** Number of retained, unacked frames. */
  get size() {
    return this._frames.size;
  }

  /**
   * Identifier of one envelope inside a batch (`type#seq`, §7.3.4).
   * @param {object} envelope - sealed frame.
   * @returns {string} frame reference.
   */
  static refOf(envelope) {
    return `${envelope.type}#${envelope.seq}`;
  }

  /**
   * Append one envelope.
   * @param {object} envelope - sealed frame.
   * @returns {void}
   */
  push(envelope) {
    if (this._frames.size >= this.retentionFrames) {
      const oldest = this._frames.keys().next();
      if (!oldest.done) {
        const dropped = this._frames.get(oldest.value);
        this._frames.delete(oldest.value);
        // `done: false` guarantees a fresh key, so the lookup cannot miss;
        // the guard only keeps a hostile `Map` subclass from throwing.
        if (dropped !== undefined) this.onOverflow(dropped.envelope);
      }
    }
    this._frames.set(PollQueue.refOf(envelope), { envelope, at: this.now() });
  }

  /**
   * Take up to `max` frames without removing them (removal happens on ack).
   * @param {number} max - maximum frames to return.
   * @returns {object[]} envelopes in arrival order.
   */
  take(max) {
    return [...this._frames.values()].slice(0, max).map((entry) => entry.envelope);
  }

  /**
   * Acknowledge frames by reference.
   * @param {string[]} refs - `type#seq` references.
   * @returns {number} number of frames actually removed.
   */
  ack(refs) {
    let removed = 0;
    for (const ref of refs) {
      if (this._frames.delete(ref)) removed += 1;
    }
    return removed;
  }

  /**
   * Expire frames the peer never acknowledged.
   *
   * A frame that expires is NOT re-sent as the same ciphertext: its `seq` is
   * already consumed and a repeat would trip the peer's replay window (§5.4).
   * The app layer resends the *business message* with a fresh seal (§11.3).
   * @returns {object[]} expired envelopes.
   */
  expire() {
    const cutoff = this.now() - this.redeliverAfterS * 1000;
    const expired = [];
    for (const [ref, entry] of this._frames) {
      if (entry.at <= cutoff) {
        this._frames.delete(ref);
        expired.push(entry.envelope);
        this.onExpired(entry.envelope);
      }
    }
    return expired;
  }

  /** Drop every retained frame. */
  clear() {
    this._frames.clear();
  }
}

/**
 * Serve one response for a pending responder-side plain object.
 *
 * The HTTP carriers answer `/hello` inline, so the response must be correlated
 * with the exact request that produced it.
 */
export class PlainResponder {
  constructor() {
    /** @type {{resolve: Function}|null} */
    this._pending = null;
  }

  /**
   * Open a slot for the response to the current inbound plain object.
   * @returns {Promise<{object?: object, error?: BridgeError}>} the settled outcome.
   */
  open() {
    return new Promise((resolve) => {
      this._pending = { resolve };
    });
  }

  /**
   * Deliver the session's success response into the open slot.
   * @param {object} object - response object.
   * @returns {boolean} whether a slot consumed it.
   */
  settle(object) {
    return this._settle({ object });
  }

  /**
   * Deliver a rejection for the current inbound plain object.
   *
   * A refused handshake must still be answered with the §8.2 error body: a
   * silent close would leave the peer guessing whether the failure was
   * authentication, configuration or a network fault.
   * @param {BridgeError} error - failure to report.
   * @returns {boolean} whether a slot consumed it.
   */
  fail(error) {
    return this._settle({ error });
  }

  /**
   * Resolve the open slot with one outcome.
   * @param {{object?: object, error?: BridgeError}} outcome - settled outcome.
   * @returns {boolean} whether a slot consumed it.
   */
  _settle(outcome) {
    const pending = this._pending;
    if (pending === null) return false;
    this._pending = null;
    pending.resolve(outcome);
    return true;
  }

  /** Drop any open slot. */
  cancel() {
    if (this._pending !== null) {
      const pending = this._pending;
      this._pending = null;
      pending.resolve({});
    }
  }
}

/**
 * Create an HTTP or HTTPS server from connection configuration.
 * @param {object} cfg - connection configuration.
 * @param {import('node:http').RequestListener} handler - request handler.
 * @param {import('../log.js').Logger} [logger] - structured logger.
 * @returns {import('node:http').Server} server instance (not yet listening).
 * @throws {BridgeError} `config_invalid` when TLS is enabled without files.
 */
export function createServerFor(cfg, handler, logger = defaultLogger) {
  if (cfg.tlsEnabled === true) {
    if (!cfg.tlsCertPath || !cfg.tlsKeyPath) throw new BridgeError('config_invalid');
    return createHttpsServer(
      {
        cert: readFileSync(cfg.tlsCertPath),
        key: readFileSync(cfg.tlsKeyPath),
      },
      handler,
    );
  }
  void logger;
  return createHttpServer(handler);
}

/**
 * Resolve the address this carrier binds.
 *
 * `bindHost`/`bindPort` are the *local* listen address and are deliberately
 * separate from the peer address: a deployment may bind a private interface
 * while the peer only ever reaches it through a public one. When they are
 * absent the historical `host`/`port` pair keeps its old meaning in `listen`
 * mode (it *is* the bind address); in `connect` mode that pair names the peer,
 * so the local server binds an ephemeral port unless `bindPort` says otherwise.
 * Binding the peer's port would either collide with the peer or make the
 * carrier POST to itself.
 * @param {object} cfg - connection configuration.
 * @returns {{host: string, port: number}} bind address (`port: 0` = ephemeral).
 */
export function bindTarget(cfg) {
  const fallbackHost = cfg.mode === 'connect' ? '127.0.0.1' : cfg.host;
  const host = typeof cfg.bindHost === 'string' && cfg.bindHost.length > 0 ? cfg.bindHost : fallbackHost;
  const explicit = Number.isInteger(cfg.bindPort) && cfg.bindPort > 0 ? cfg.bindPort : null;
  return { host, port: explicit ?? (cfg.mode === 'connect' ? 0 : cfg.port) };
}

/**
 * Resolve the fixed peer address frames are POSTed to.
 *
 * The peer address is configuration-only: no inbound request, header or
 * handshake field may set it, otherwise any peer could redirect this
 * endpoint's outbound requests (§7.0). `peerHost`/`peerPort` name the peer
 * explicitly for both modes. For backward compatibility, a `connect`
 * connection that sets neither keeps using `host`/`port` as the peer (its
 * historical meaning); a `listen` connection has no such fallback, because
 * treating its own bind address as the peer is exactly the self-post defect.
 * @param {object} cfg - connection configuration.
 * @returns {{host: string, port: number}|null} peer address, or null when this
 *   endpoint has no configured peer (listen mode without `peerHost`/`peerPort`).
 * @throws {BridgeError} `config_invalid` when only half of the pair is set.
 */
export function peerTarget(cfg) {
  const host = typeof cfg.peerHost === 'string' && cfg.peerHost.length > 0 ? cfg.peerHost : null;
  const port = Number.isInteger(cfg.peerPort) && cfg.peerPort > 0 ? cfg.peerPort : null;
  if (host !== null && port !== null) {
    assertPlainHost(host, 'peerHost');
    return { host, port };
  }
  // Half a peer address is a configuration mistake, never a fallback trigger:
  // guessing the other half is how a peer silently becomes the local endpoint.
  if (host !== null || port !== null) {
    throw new BridgeError('config_invalid', { details: { field: host === null ? 'peerHost' : 'peerPort' } });
  }
  if (cfg.mode === 'connect') {
    assertPlainHost(cfg.host, 'host');
    return { host: cfg.host, port: cfg.port };
  }
  return null;
}

/**
 * Reject a host that is not a bare host name or IP literal.
 *
 * The peer URL is built by interpolation, so a value carrying a scheme, path,
 * userinfo or whitespace would let configuration smuggle in a different origin
 * (and, with `@` or a path, a different port). Only configuration may name the
 * peer, and it may only name a host.
 *
 * An IP literal is accepted as-is (including the unbracketed IPv6 form operators
 * write in configs); every other value must be a bare host name, so a `:` there
 * is a smuggled port and is refused rather than percent-escaped into the
 * authority.
 * @param {unknown} host - configured host.
 * @param {string} field - configuration field name for the error detail.
 * @returns {void}
 * @throws {BridgeError} `config_invalid` when the host is not a plain host.
 */
function assertPlainHost(host, field) {
  const text = typeof host === 'string' ? host.trim().replace(/^\[/, '').replace(/\]$/, '') : '';
  if (text.length === 0 || /[\s/?#@\\]/.test(text) || text.includes('://')) {
    throw new BridgeError('config_invalid', { details: { field } });
  }
  if (isIP(text) !== 0) return;
  // A bare host name cannot contain `:`: that is either a port smuggled into the
  // host field or an IPv6 literal that failed the check above.
  if (text.includes(':')) throw new BridgeError('config_invalid', { details: { field } });
}

/**
 * Whether two host/port pairs name the same local endpoint.
 *
 * Used to refuse a peer that is this endpoint itself. A wildcard bind address
 * (`0.0.0.0`, `::`) covers every local interface — so it collides with a peer
 * only when that peer *is* this host; a remote host on the same port is a
 * legitimate configuration and must not be refused. `localhost` and `::1` are
 * folded into `127.0.0.1`.
 * @param {{host: string, port: number}|null} a - first endpoint.
 * @param {{host: string, port: number}|null} b - second endpoint.
 * @returns {boolean} whether both name the same endpoint.
 */
export function sameEndpoint(a, b) {
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (a.port !== b.port) return false;
  const left = endpointHost(a.host);
  const right = endpointHost(b.host);
  if (left === right) return true;
  const leftWildcard = left === '0.0.0.0' || left === '::';
  const rightWildcard = right === '0.0.0.0' || right === '::';
  if (leftWildcard && rightWildcard) return true;
  if (leftWildcard) return isLocalAddress(right);
  if (rightWildcard) return isLocalAddress(left);
  return false;
}

/**
 * Whether one host names this machine.
 *
 * Loopback names always are local; anything else is compared against the
 * addresses the host actually has, so a wildcard bind is only ever refused
 * against itself. No DNS lookup happens here: resolving a configured peer at
 * start would turn a name-resolution delay into a startup stall.
 * @param {string} host - normalized host.
 * @returns {boolean} whether the host is local.
 */
function isLocalAddress(host) {
  if (host === '::1' || host === '127.0.0.1' || host === 'localhost') return true;
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (endpointHost(address.address) === host) return true;
    }
  }
  return false;
}

/**
 * Normalize one host for endpoint comparison.
 * @param {string} host - configured host.
 * @returns {string} lowercase host without IPv6 brackets.
 */
function endpointHost(host) {
  const bare = String(host ?? '').trim().replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  return bare === 'localhost' || bare === '::1' ? '127.0.0.1' : bare;
}

/**
 * Listen on the configured bind address and resolve once bound.
 * @param {import('node:http').Server} server - server to start.
 * @param {object} cfg - connection configuration.
 * @returns {Promise<number>} the bound port (resolved, useful with port 0).
 * @throws {BridgeError} `config_invalid` when binding fails.
 */
export async function listenOn(server, cfg) {
  const bind = bindTarget(cfg);
  await /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(new BridgeError('config_invalid', { details: { field: 'port' } }));
      void error;
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(bind.port, bind.host);
  }));
  const address = server.address();
  return typeof address === 'object' && address !== null ? address.port : bind.port;
}

/**
 * Close a server and resolve once every socket is gone.
 * @param {import('node:http').Server|null} server - server to close; `null` is a no-op.
 * @param {Array<{destroy: Function}>} [sockets] - tracked live sockets.
 * @returns {Promise<void>} resolution after close.
 */
export async function closeServer(server, sockets = []) {
  if (server === null) return;
  for (const socket of sockets) {
    try {
      socket.destroy();
    } catch {
      // Already closed by the peer; nothing to release.
    }
  }
  await /** @type {Promise<void>} */ (new Promise((resolve) => server.close(() => resolve())));
}

/**
 * Build an absolute base URL for the fixed, configured peer.
 *
 * The URL is derived from configuration only — never from an inbound request,
 * header or handshake object — so neither peer can redirect the other's
 * outbound traffic (§7.0).
 * @param {object} cfg - connection configuration.
 * @returns {string} `protocol://host:port/path` of the peer.
 * @throws {BridgeError} `config_invalid` when this endpoint has no peer.
 */
export function peerBaseUrl(cfg) {
  const target = peerTarget(cfg);
  if (target === null) throw new BridgeError('config_invalid', { details: { field: 'peerHost' } });
  const scheme = cfg.tlsEnabled === true ? 'https' : 'http';
  const host = target.host.includes(':') && !target.host.startsWith('[') ? `[${target.host}]` : target.host;
  return `${scheme}://${host}:${target.port}${cfg.path}`;
}

/**
 * POST one JSON object to an absolute URL with a bounded timeout.
 * @param {string} url - absolute URL.
 * @param {unknown} body - JSON body.
 * @param {object} [options] - request options.
 * @param {number} [options.timeoutMs] - request timeout.
 * @param {object} [options.tls] - TLS verification options.
 * @returns {Promise<{status: number, body: unknown}>} response.
 * @throws {BridgeError} `timeout` on expiry, `internal_error` on transport failure.
 */
export async function postJson(url, body, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Dsh-Bridge-Version': '1' },
      body: JSON.stringify(body),
      signal: controller.signal,
      // Never follow a redirect: a carrier move must be an explicit config change.
      redirect: 'error',
    });
    const text = await response.text();
    let parsed;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      throw new BridgeError('bad_json');
    }
    return { status: response.status, body: parsed };
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    // Abort is reported by name: `fetch` rejects with a `DOMException` whose
    // name is stable across Node versions, and no other failure is a timeout.
    if (typeof error === 'object' && error !== null && 'name' in error
      && /** @type {{name?: unknown}} */ (error).name === 'AbortError') {
      throw new BridgeError('timeout');
    }
    throw new BridgeError('internal_error', { details: { reason: 'network' } });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * GET one absolute URL with a bounded timeout.
 * @param {string} url - absolute URL.
 * @param {object} [options] - request options.
 * @param {number} [options.timeoutMs] - request timeout.
 * @returns {Promise<{status: number, body: unknown}>} response.
 * @throws {BridgeError} `timeout` on expiry, `internal_error` on transport failure.
 */
export async function getJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 40_000);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'X-Dsh-Bridge-Version': '1' },
      signal: controller.signal,
      redirect: 'error',
    });
    const text = await response.text();
    let parsed;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      throw new BridgeError('bad_json');
    }
    return { status: response.status, body: parsed };
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    // Abort is reported by name: `fetch` rejects with a `DOMException` whose
    // name is stable across Node versions, and no other failure is a timeout.
    if (typeof error === 'object' && error !== null && 'name' in error
      && /** @type {{name?: unknown}} */ (error).name === 'AbortError') {
      throw new BridgeError('timeout');
    }
    throw new BridgeError('internal_error', { details: { reason: 'network' } });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Map an HTTP status to the protocol error code it carries (§8.1).
 * @param {number} status - HTTP status.
 * @param {object} [body] - parsed error body.
 * @returns {BridgeError} mapped failure.
 */
export function errorOfStatus(status, body) {
  const code = body?.error?.code;
  if (typeof code === 'string') return new BridgeError(code, { http: status });
  if (status === 401) return new BridgeError('poll_auth_failed');
  if (status === 409) return new BridgeError('sid_mismatch');
  if (status === 425) return new BridgeError('not_ready');
  if (status === 429) return new BridgeError('rate_limited');
  if (status === 413) return new BridgeError('frame_too_large');
  if (status === 415) return new BridgeError('unsupported_content_type');
  if (status === 400) return new BridgeError('bad_frame');
  if (status === 404) return new BridgeError('unknown_conn');
  if (status === 503) return new BridgeError('server_busy');
  return new BridgeError('internal_error');
}

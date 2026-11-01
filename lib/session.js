/**
 * Session layer: handshake, frame sealing, request/reply correlation and
 * heartbeat (protocol §4, §5, §6).
 *
 * This module knows frames and envelopes only. It never imports `app/*` or
 * `host/*`, never inspects a message name's meaning, and never touches a socket
 * directly — the transport is injected as an object with four methods (§1.1).
 * @module dsh-plugin-astrbot-bridge/session
 */

import { randomUUID } from 'node:crypto';

import {
  ApprovalsFeatures,
  CapsFeature,
  FrameType,
  HandshakeRole,
  Limits,
  PlainType,
  SessionState,
  Side,
} from './constants.js';
import {
  assertHandshakeValue,
  b64u,
  b64uDec,
  constantTimeEqual,
  handshakeKey,
  handshakeTranscript,
  jcsAscii,
  macObject,
  openFrame,
  pskMaster,
  sealFrame,
  sessionKeys,
  verifyMac,
} from './crypto.js';
import { BridgeError } from './errors.js';
import { defaultLogger } from './log.js';
import { ReplayWindow } from './replay.js';

/** Sentinels that let a phase be raced against its timeout without leaking a rejection. */
const HANDSHAKE_TIMED_OUT = Symbol('handshake-timeout');
const HANDSHAKE_FINISHED = Symbol('handshake-finished');

/** Unique sentinels used to race a phase against its timeout without leaking a rejection. */
const TIMEOUT_SENTINEL = Symbol('handshake-timeout');
const OPERATION_DONE = Symbol('handshake-done');

/**
 * A single bridge session over one transport connection.
 *
 * One instance owns exactly one `sid`, one pair of nonces, and two independent
 * send counters. Every send path funnels through {@link Session#_sendChain} so
 * "allocate seq → seal → enqueue" is one indivisible step (§5.6); that is what
 * prevents a nonce reuse, which would be catastrophic for a stream cipher.
 */
export class Session {
  /**
   * @param {object} options - session configuration.
   * @param {object} options.conn - connection configuration (`id`, `pskId`, `pskSecret`, …).
   * @param {'A'|'B'} options.side - this endpoint's side.
   * @param {'initiator'|'responder'} options.role - handshake role.
   * @param {'ws'|'webhook'|'longpoll'} options.transportName - active carrier name.
   * @param {object} options.caps - capability declaration for this endpoint (§4.5).
   * @param {number} [options.heartbeatS] - heartbeat period in seconds.
   * @param {number} [options.handshakeTimeoutMs] - handshake phase deadline in milliseconds.
   * @param {number} [options.reqTimeoutS] - default request timeout in seconds.
   * @param {() => number} [options.now] - injectable clock in milliseconds (tests only).
   * @param {import('./log.js').LoggerLike} [options.logger] - structured logger.
   */
  constructor(options, transport, hooks = {}) {
    this.conn = options.conn;
    this.connId = options.conn.id;
    this.side = options.side;
    this.role = options.role;
    this.transportName = options.transportName;
    this.transport = transport;
    this.caps = options.caps;
    this.heartbeatS = options.heartbeatS ?? Limits.HEARTBEAT_S;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? Limits.HANDSHAKE_TIMEOUT_MS;
    /** Settles when the handshake phase is over, successfully or not. */
    this._handshakeWork = Promise.resolve();
    this.reqTimeoutS = options.reqTimeoutS ?? Limits.REQ_TIMEOUT_S;
    /** @type {() => number} */
    this.now = options.now ?? (() => Date.now());
    this.logger = options.logger ?? defaultLogger.child('session');

    this._onMessage = hooks.onMessage ?? (() => {});
    this._onSecurityEvent = hooks.onSecurityEvent ?? (() => {});
    this._onState = hooks.onState ?? (() => {});

    /**
     * Current state; always one of `Object.values(SessionState)` (§16.5).
     * Typed `string` rather than a literal union on purpose: the sink signature
     * this class publishes (`onState(state: string)`) is the contract the
     * supervisor consumes, so widening here keeps writer and reader identical.
     * @type {string}
     */
    this._state = SessionState.DISCONNECTED;
    /** @type {string|null} */
    this._sid = null;
    /** @type {string|null} */
    this._peerSide = null;
    /** @type {object|null} */
    this._peerCaps = null;
    /** @type {object|null} */
    this._negotiated = null;
    /** @type {import('./crypto.js').SessionKeys|null} */
    this._keys = null;

    /** @type {string|null} */
    this._helloId = null;
    /** @type {Buffer|null} */
    this._nonceC = null;
    /** @type {Buffer|null} */
    this._nonceS = null;
    this._th = null;
    this._hello = null;
    this._helloAck = null;

    this._nextSeq = 0;
    this._sendChain = Promise.resolve();
    this._recvWindow = new ReplayWindow(0);
    this._pending = new Map();
    this._pingCounter = 0;
    this._lastInboundAt = this.now();
    this._heartbeatTimer = null;
    this._handshakeTimer = null;
    this._handshakeWaiters = [];
    this._handshakeQueue = [];
    /**
     * Resolved once on close so a pending handshake cannot outlive the session.
     * @type {Promise<void>}
     */
    this._closedSignal = new Promise((resolve) => {
      this._resolveClosed = resolve;
    });
    this._closed = false;

    /** Replay cache for inbound hello_id/nonce_c on the responder side (§4.6). */
    this._helloReplay = new Map();
    /** Replay cache for HTTP poll nonces keyed by `sid|side|nonce` (§7.4). */
    this._httpNonces = new Map();
  }

  /** Current connection state (§16.5). */
  get state() {
    return this._state;
  }

  /** Session identifier assigned by the responder, or null before handshake. */
  get sid() {
    return this._sid;
  }

  /** Peer capability declaration, or null before handshake completes. */
  get peerCaps() {
    return this._peerCaps;
  }

  /** Response-window position of the receive direction (diagnostics/tests). */
  get receiveExpected() {
    return this._recvWindow.expected;
  }

  /**
   * Move to a new state and notify the observer.
   * @param {string} state - target state.
   * @returns {void}
   */
  _setState(state) {
    if (this._state === state) return;
    this._state = state;
    this._onState(state);
  }

  /**
   * React to a carrier state change.
   *
   * The carrier only reports facts (degraded, stale, closed); deciding what
   * they mean is the session's job, so a carrier that loses its path surfaces
   * as `degraded`, and a carrier whose session identity went stale surfaces as
   * a request to re-handshake.
   * @param {string} state - carrier state label.
   * @returns {void}
   */
  _onTransportState(state) {
    if (state === 'degraded') {
      if (this._state === SessionState.READY) this._setState(SessionState.DEGRADED);
      return;
    }
    if (state === 'stale') {
      this._onTransportStale();
      return;
    }
    if (state === 'ready' && this._state === SessionState.DEGRADED) {
      this._setState(SessionState.READY);
    }
  }

  /**
   * Handle a carrier that lost its session identity (poll 401/409/425).
   *
   * The carrier cannot re-handshake by itself because it holds no keys; it
   * reports the condition and the supervisor restarts the session so a fresh
   * nonce, sid and key set are used (protocol §7.4).
   * @returns {void}
   */
  _onTransportStale() {
    if (this._closed) return;
    this.logger.warn('session_stale', { conn: this.connId, sid: this._sid });
    void this.close('stale_session', 'carrier session stale', { notifyPeer: false });
  }

  /**
   * Report a fatal security failure and tear the session down.
   * @param {BridgeError} error - failure to report.
   * @param {object} [context] - id fields for the audit line.
   * @returns {Promise<void>} resolution after teardown.
   */
  async _fail(error, context = {}) {
    this._onSecurityEvent({
      code: error.code,
      fatal: error.fatal,
      conn: this.connId,
      sid: this._sid,
      ...context,
    });
    this.logger.warn('security_event', {
      conn: this.connId,
      sid: this._sid,
      code: error.code,
    });
    await this.close(error.code, 'security failure', { notifyPeer: false });
  }

  /**
   * Start the session: drive the handshake to `ready`.
   * @returns {Promise<void>} resolution when ready, or on a non-retryable failure.
   * @throws {BridgeError} `config_invalid`, `psk_not_configured` or a fatal handshake error.
   */
  async start() {
    if (this._state !== SessionState.DISCONNECTED) return;
    this._assertCredentials();
    this._setState(SessionState.CONNECTING);
    try {
      await this.transport.start(this.conn, {
        onPlain: (object) => this._onPlain(object),
        onEnvelope: (envelope) => this._onEnvelope(envelope),
        onProbe: (object) => this._onProbe(object),
        onState: (state) => this._onTransportState(state),
        // HTTP carriers use this to let queued frames (e.g. `auth_ack`) land
        // before they answer the POST that triggered them.
        onFlush: () => this.waitQuiescent(),
      });
    } catch (error) {
      this._setState(SessionState.DISCONNECTED);
      throw error;
    }
    this._installCarrierHelpers();
    this._setState(SessionState.HANDSHAKING);
    const handshake = this.role === HandshakeRole.INITIATOR
      ? this._handshakeAsInitiator()
      : this._handshakeAsResponder();
    this._handshakeWork = handshake.then(() => {}).catch(() => {});
    try {
      await handshake;
    } catch (error) {
      const failure = error instanceof BridgeError ? error : new BridgeError('timeout');
      // Tell the peer why, when the carrier still has a response channel open.
      try {
        this.transport.respondError?.(failure);
      } catch {
        // A carrier that cannot report the refusal must not mask it locally.
      }
      if (failure.fatal) {
        // A fatal handshake failure is a security event in its own right: it
        // is reported even when it happened before any frame was dispatched.
        this._onSecurityEvent({
          code: failure.code,
          fatal: true,
          conn: this.connId,
          sid: this._sid,
        });
        this.logger.warn('security_event', {
          conn: this.connId,
          sid: this._sid,
          code: failure.code,
        });
      }
      await this.close('handshake_failed', 'handshake failure', { notifyPeer: false });
      throw failure;
    }
  }

  /**
   * Reject a session without credentials: an unauthenticated bridge is never
   * an acceptable degraded mode (§3.2).
   * @returns {void}
   * @throws {BridgeError} `psk_not_configured` or `config_invalid`.
   */
  _assertCredentials() {
    if (typeof this.conn.pskSecret !== 'string' || this.conn.pskSecret.length === 0) {
      this._setState(SessionState.CONFIG_ERROR);
      throw new BridgeError('psk_not_configured');
    }
    if (this.role !== HandshakeRole.INITIATOR && this.role !== HandshakeRole.RESPONDER) {
      this._setState(SessionState.CONFIG_ERROR);
      throw new BridgeError('config_invalid', { details: { field: 'role' } });
    }
    // A timeout the timer would silently clamp (0, negative, NaN, Infinity) is a
    // configuration mistake, not a fast handshake: fail loudly instead of
    // handing it to `setTimeout`, which turns every one of them into 1 ms.
    if (!Number.isFinite(this.handshakeTimeoutMs) || this.handshakeTimeoutMs <= 0) {
      this._setState(SessionState.CONFIG_ERROR);
      throw new BridgeError('config_invalid', { details: { field: 'handshakeTimeoutMs' } });
    }
  }

  /**
   * Build the PSK master key for this connection.
   * @returns {Buffer} 32-byte master key.
   */
  _psk() {
    return pskMaster(this.conn.pskId ?? '', this.conn.pskSecret);
  }

  /**
   * Run the initiator half of the four-step handshake (§4.1).
   * @returns {Promise<void>} resolution when `ready`.
   */
  async _handshakeAsInitiator() {
    this._helloId = randomUUID();
    this._nonceC = Buffer.from(randomBytes32());
    this._hello = this._buildHello();
    await this._withHandshakeTimeout(async () => {
      // `sendPlain` returns the ack inline on every HTTP carrier and over WS.
      // Only when it cannot do that does the queued delivery apply, so no
      // waiter is left dangling to swallow the following `auth_ack`.
      const reply = await this.transport.sendPlain(this._hello);
      const ackObject = reply === undefined ? await this._waitForHandshake() : reply;
      if (ackObject === undefined) throw new BridgeError('timeout');
      this._acceptHelloAck(ackObject);
      this._deriveSessionKeys();
      const authAckWait = this._waitForHandshake();
      // The auth frame is the first sealed frame and always uses seq 0.
      await this._sendFrame(FrameType.AUTH, this._authPayload(HandshakeRole.INITIATOR));
      const authAck = await authAckWait;
      if (authAck === undefined) throw new BridgeError('timeout');
      this._verifyAuthAck(authAck);
    });
    this._becomeReady();
  }

  /**
   * Run the responder half of the handshake (§4.1).
   * @returns {Promise<void>} resolution when `ready`.
   */
  async _handshakeAsResponder() {
    await this._withHandshakeTimeout(async () => {
      const hello = await this._waitForHandshake();
      if (hello === undefined) throw new BridgeError('timeout');
      this._acceptHello(hello);
      const ack = this._buildHelloAck();
      this.transport.respondPlain(ack);
      this._deriveSessionKeys();
      // The initiator's `auth` may already be queued, which `_waitForHandshake`
      // handles, so no arm/await ordering hazard exists here.
      const auth = await this._waitForHandshake();
      if (auth === undefined) throw new BridgeError('timeout');
      this._verifyAuth(auth);
      await this._sendFrame(FrameType.AUTH_ACK, this._authPayload(HandshakeRole.RESPONDER));
    });
    this._becomeReady();
  }

  /**
   * Race one handshake phase against the handshake timeout (§4.1).
   * @param {() => Promise<void>} operation - phase body.
   * @returns {Promise<void>} resolution when the phase completes.
   */
  async _withHandshakeTimeout(operation) {
    let timer;
    const timeout = new Promise((resolve) => {
      // Deliberately not unref'd: a handshake timeout must fire even when the
      // carrier is silent, otherwise a dead peer would hang the process.
      timer = setTimeout(() => resolve(HANDSHAKE_TIMED_OUT), this.handshakeTimeoutMs);
    });
    try {
      // A bare `race` against a rejecting promise leaves the losing branch
      // running and can produce an unhandled rejection later. Racing sentinels
      // lets every branch settle.
      const outcome = await Promise.race([
        operation().then(() => HANDSHAKE_FINISHED),
        timeout,
        this._closedSignal.then(() => HANDSHAKE_TIMED_OUT),
      ]);
      if (outcome === HANDSHAKE_TIMED_OUT) throw new BridgeError('timeout');
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Resolve with the next handshake-phase object.
   *
   * A queue is used rather than a single slot because a carrier can deliver the
   * object before the peer awaits it; dropping such an object would hang the
   * handshake.
   * @returns {Promise<object|undefined>} the next delivered object, or
   *   undefined when the session closed first.
   */
  _waitForHandshake() {
    if (this._handshakeQueue.length > 0) return Promise.resolve(this._handshakeQueue.shift());
    return new Promise((resolve) => {
      this._handshakeWaiters.push(resolve);
    });
  }

  /**
   * Deliver a handshake-phase object to the next waiting phase.
   * @param {object} object - delivered object.
   * @returns {boolean} whether a waiter consumed it immediately.
   */
  _deliverHandshake(object) {
    const waiter = this._handshakeWaiters.shift();
    if (waiter === undefined) {
      this._handshakeQueue.push(object);
      return false;
    }
    waiter(object);
    return true;
  }

  /**
   * Build this endpoint's `hello` object (§4.2).
   * @returns {object} hello with MAC.
   */
  _buildHello() {
    if (this._nonceC === null) throw new BridgeError('internal_error');
    assertHandshakeValue(this.caps);
    const body = {
      v: 1,
      type: PlainType.HELLO,
      conn: this.connId,
      hello_id: this._helloId,
      pv: 1,
      side: this.side,
      tp: this.transportName,
      nonce: b64u(this._nonceC),
      ts: this.now(),
      caps: this.caps,
    };
    assertHandshakeValue(body);
    return { ...body, mac: macObject(handshakeKey(this._psk(), 'hello'), body) };
  }

  /**
   * Validate an inbound `hello` and prepare the responder state (§4.2, §4.6).
   * @param {object} hello - received hello.
   * @returns {void}
   * @throws {BridgeError} on any rejected field.
   */
  _acceptHello(hello) {
    if (hello === null || typeof hello !== 'object') throw new BridgeError('bad_frame');
    if (hello.v !== 1) throw new BridgeError('bad_frame');
    if (hello.type !== PlainType.HELLO) throw new BridgeError('bad_frame');
    if (hello.conn !== this.connId) throw new BridgeError('unknown_conn');
    if (hello.pv !== 1) throw new BridgeError('bad_version');
    if (this._peerSide !== null && hello.side !== this._peerSide) throw new BridgeError('bad_side');
    this._assertPeerSide(hello.side);
    if (this._isHelloReplay(hello)) throw new BridgeError('hello_replay');
    if (!this._isFreshTs(hello.ts)) throw new BridgeError('hello_expired');
    this._assertCaps(hello.caps);

    const body = stripMac(hello);
    assertHandshakeValue(body);
    if (!verifyMac(handshakeKey(this._psk(), 'hello'), body, hello.mac)) {
      throw new BridgeError('psk_mismatch');
    }

    this._hello = hello;
    this._helloId = hello.hello_id;
    this._nonceC = decodeNonce(hello.nonce);
    this._rememberHello(hello);
  }

  /**
   * Build the responder's `hello_ack` (§4.3).
   * @returns {object} hello_ack with MAC.
   */
  _buildHelloAck() {
    this._nonceS = Buffer.from(randomBytes32());
    this._sid = randomUUID();
    const body = {
      v: 1,
      type: PlainType.HELLO_ACK,
      conn: this.connId,
      hello_id: this._helloId,
      sid: this._sid,
      pv: 1,
      side: this.side,
      tp: this.transportName,
      nonce: b64u(this._nonceS),
      ts: this.now(),
      caps: this.caps,
    };
    assertHandshakeValue(body);
    this._helloAck = body;
    return { ...body, mac: macObject(handshakeKey(this._psk(), 'hello_ack'), body) };
  }

  /**
   * Validate an inbound `hello_ack` on the initiator side (§4.3).
   * @param {object} ack - received hello_ack.
   * @returns {void}
   * @throws {BridgeError} on any rejected field.
   */
  _acceptHelloAck(ack) {
    if (ack === null || typeof ack !== 'object') throw new BridgeError('bad_frame');
    if (ack.v !== 1 || ack.type !== PlainType.HELLO_ACK) throw new BridgeError('bad_frame');
    if (ack.conn !== this.connId) throw new BridgeError('unknown_conn');
    if (ack.pv !== 1) throw new BridgeError('bad_version');
    if (ack.hello_id !== this._helloId) throw new BridgeError('bad_frame');
    this._assertPeerSide(ack.side);
    if (!this._isFreshTs(ack.ts)) throw new BridgeError('hello_expired');
    this._assertCaps(ack.caps);

    const body = stripMac(ack);
    assertHandshakeValue(body);
    if (!verifyMac(handshakeKey(this._psk(), 'hello_ack'), body, ack.mac)) {
      throw new BridgeError('psk_mismatch');
    }
    if (this._nonceS !== null && constantTimeEqual(this._nonceS, decodeNonce(ack.nonce))) {
      // A responder that reuses a nonce is doing key/nonce continuation, which
      // this protocol forbids outright (§3.4).
      throw new BridgeError('handshake_reuse');
    }
    this._nonceS = decodeNonce(ack.nonce);
    this._sid = ack.sid;
    this._helloAck = stripMac(ack);
  }

  /**
   * Derive the session keys once both nonces are known (§3.4).
   * @returns {void}
   */
  _deriveSessionKeys() {
    // Both nonces are set by the handshake half that calls this, so a missing
    // one is an internal wiring bug, not peer input.
    if (this._nonceC === null || this._nonceS === null) throw new BridgeError('internal_error');
    this._th = handshakeTranscript(stripMac(this._hello), stripMac(this._helloAck));
    this._keys = sessionKeys(this._psk(), this._nonceC, this._nonceS);
    this._nextSeq = 0;
    this._recvWindow = new ReplayWindow(0);
  }

  /**
   * Build an `auth`/`auth_ack` payload (§4.4).
   * @param {'initiator'|'responder'} role - role of the sender.
   * @returns {object} payload.
   */
  _authPayload(role) {
    if (this._th === null) throw new BridgeError('internal_error');
    return {
      side: this.side,
      role,
      sid: this._sid,
      hello_id: this._helloId,
      th: b64u(this._th),
    };
  }

  /**
   * Compare a received `th` with the local transcript (§4.4).
   * @param {object} payload - auth or auth_ack payload.
   * @param {string} expectedRole - role the peer must claim.
   * @returns {void}
   * @throws {BridgeError} `th_mismatch` when the transcripts differ.
   */
  _verifyTranscript(payload, expectedRole) {
    if (payload === null || typeof payload !== 'object') throw new BridgeError('bad_frame');
    if (payload.role !== expectedRole) throw new BridgeError('bad_frame');
    if (payload.sid !== this._sid) throw new BridgeError('stale_session');
    if (payload.hello_id !== this._helloId) throw new BridgeError('bad_frame');
    if (this._th === null) throw new BridgeError('internal_error');
    const received = b64uDec(String(payload.th));
    if (!constantTimeEqual(received, this._th)) throw new BridgeError('th_mismatch');
  }

  /**
   * Verify the initiator's `auth` frame on the responder side.
   * @param {object} payload - auth payload.
   * @returns {void}
   */
  _verifyAuth(payload) {
    this._assertPeerSide(payload.side);
    this._verifyTranscript(payload, HandshakeRole.INITIATOR);
  }

  /**
   * Verify the responder's `auth_ack` frame on the initiator side.
   * @param {object} payload - auth_ack payload.
   * @returns {void}
   */
  _verifyAuthAck(payload) {
    this._assertPeerSide(payload.side);
    this._verifyTranscript(payload, HandshakeRole.RESPONDER);
  }

  /**
   * Reject a peer whose side is not the opposite of this endpoint's (§4.2).
   * @param {string} peerSide - claimed peer side.
   * @returns {void}
   * @throws {BridgeError} `bad_side`.
   */
  _assertPeerSide(peerSide) {
    if (peerSide !== Side.A && peerSide !== Side.B) throw new BridgeError('bad_side');
    if (peerSide === this.side) throw new BridgeError('bad_side');
    this._peerSide = peerSide;
  }

  /**
   * Validate a peer `caps` object (§4.5).
   * @param {object} caps - claimed capabilities.
   * @returns {void}
   * @throws {BridgeError} `bad_caps`.
   */
  _assertCaps(caps) {
    const fail = () => {
      throw new BridgeError('bad_caps');
    };
    if (caps === null || typeof caps !== 'object') fail();
    if (caps.side !== Side.A && caps.side !== Side.B) fail();
    if (caps.host !== 'astrbot' && caps.host !== 'dsh') fail();
    if (typeof caps.version !== 'string' || /[^\x00-\x7f]/.test(caps.version)) fail();
    if (!Array.isArray(caps.pv) || !caps.pv.includes(1)) fail();
    if (!Array.isArray(caps.transports) || caps.transports.length === 0) fail();
    for (const transport of caps.transports) {
      if (!['ws', 'webhook', 'longpoll'].includes(transport)) fail();
    }
    if (typeof caps.tls !== 'boolean') fail();
    const roles = caps.roles;
    if (!roles || typeof roles.initiate_task !== 'boolean' || typeof roles.execute_task !== 'boolean') {
      fail();
    }
    const approvals = caps.approvals;
    if (
      !approvals ||
      typeof approvals.native_tool !== 'boolean' ||
      typeof approvals.business_decision !== 'boolean' ||
      typeof approvals.cross_end_submit !== 'boolean'
    ) {
      fail();
    }
    const attachments = caps.attachments;
    if (!attachments || attachments.reference !== false) fail();
    if (!Array.isArray(attachments.mime) || attachments.mime.length === 0) fail();
    for (const mime of attachments.mime) {
      if (!ApprovalsFeatures.IMAGE_MIME.includes(mime)) fail();
    }
    for (const key of ['max_bytes', 'max_count', 'max_total_bytes', 'max_pixels', 'max_dimension']) {
      if (!Number.isInteger(attachments[key]) || attachments[key] <= 0) fail();
    }
    const limits = caps.limits;
    if (!limits) fail();
    for (const key of ['max_frame_bytes', 'max_chunk_bytes', 'max_batch_frames', 'retention_frames']) {
      if (!Number.isInteger(limits[key]) || limits[key] <= 0) fail();
    }
    if (!Array.isArray(caps.features)) fail();
    for (const feature of caps.features) {
      if (typeof feature !== 'string') fail();
    }
    this._peerCaps = caps;
    this._negotiated = negotiate(this.caps, caps);
  }

  /**
   * Reject a hello whose timestamp is too far from local time (§2.2).
   * @param {number} ts - claimed Unix milliseconds.
   * @returns {boolean} whether the timestamp is fresh.
   */
  _isFreshTs(ts) {
    if (!Number.isInteger(ts)) return false;
    return Math.abs(this.now() - ts) <= Limits.HELLO_SKEW_S * 1000;
  }

  /**
   * Detect a replayed handshake within the replay TTL (§4.6).
   * @param {object} hello - inbound hello.
   * @returns {boolean} whether this hello_id or nonce_c was already seen.
   */
  _isHelloReplay(hello) {
    const now = this.now();
    for (const [key, at] of this._helloReplay) {
      if (now - at > Limits.HELLO_REPLAY_TTL_S * 1000) this._helloReplay.delete(key);
    }
    const nonce = String(hello.nonce ?? '');
    return this._helloReplay.has(hello.hello_id) || this._helloReplay.has(nonce);
  }

  /**
   * Remember a consumed handshake identity for the replay TTL (§4.6).
   * @param {object} hello - accepted hello.
   * @returns {void}
   */
  _rememberHello(hello) {
    this._helloReplay.set(hello.hello_id, this.now());
    this._helloReplay.set(String(hello.nonce), this.now());
  }

  /**
   * Finish the handshake and enable `data` traffic.
   * @returns {void}
   */
  _becomeReady() {
    this._lastInboundAt = this.now();
    this.transport.setSessionIdentity?.(this._sid, this.side);
    this._setState(SessionState.READY);
    this._startHeartbeat();
    this.logger.info('session_ready', {
      conn: this.connId,
      sid: this._sid,
      transport: this.transportName,
      role: this.role,
    });
  }

  /** Start the application-level heartbeat timer (§6.1). */
  _startHeartbeat() {
    this._stopHeartbeat();
    const period = this.heartbeatS * 1000;
    this._heartbeatTimer = setInterval(() => {
      void this._heartbeatTick();
    }, period);
    if (typeof this._heartbeatTimer.unref === 'function') this._heartbeatTimer.unref();
  }

  /** Stop the heartbeat timer. */
  _stopHeartbeat() {
    if (this._heartbeatTimer !== null) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  /**
   * One heartbeat tick: send `ping` when quiet, disconnect when silent too long.
   * @returns {Promise<void>} resolution after the tick.
   */
  async _heartbeatTick() {
    if (this._state !== SessionState.READY) return;
    const silentFor = this.now() - this._lastInboundAt;
    if (silentFor > this.heartbeatS * 1000 * Limits.HEARTBEAT_MISS) {
      await this._fail(new BridgeError('timeout'), { reason: 'heartbeat_missed' });
      return;
    }
    if (silentFor < this.heartbeatS * 1000) return;
    try {
      this._pingCounter += 1;
      await this.send(FrameType.PING, { n: this._pingCounter });
    } catch (error) {
      this.logger.failure('heartbeat_send_failed', error, { conn: this.connId, sid: this._sid });
    }
  }

  /**
   * Handle one inbound plain object from the transport.
   *
   * During the handshake these are the handshake frames; afterwards a plain
   * object is a protocol violation because everything must be sealed.
   * @param {object} object - plain JSON object.
   * @returns {void}
   */
  _onPlain(object) {
    this._lastInboundAt = this.now();
    const type = object?.type;
    if (this._state === SessionState.HANDSHAKING) {
      if (this.role === HandshakeRole.RESPONDER && type === PlainType.HELLO) {
        this._deliverHandshake(object);
        return;
      }
      if (this.role === HandshakeRole.INITIATOR && type === PlainType.HELLO_ACK) {
        this._deliverHandshake(object);
        return;
      }
      if (type === PlainType.PROBE || type === PlainType.PROBE_ACK) return;
      void this._fail(new BridgeError('auth_required'), { reason: 'unexpected_plain_during_handshake' });
      return;
    }
    if (type === PlainType.PROBE || type === PlainType.PROBE_ACK) return;
    if (this._state === SessionState.READY || this._state === SessionState.DRAINING) {
      if (type === PlainType.HELLO) {
        // A peer that re-handshakes while this session is live is a second
        // writer on the same connection identity (§7.7): the new session wins,
        // this one is retired with an explicit reason.
        void this.close('superseded', 'peer re-handshake', { notifyPeer: false });
        return;
      }
      void this._fail(new BridgeError('auth_required'), { reason: 'plain_frame_after_ready' });
      return;
    }
    // Plain traffic while disconnected/closed is ignored: nothing to attribute.
  }

  /**
   * Give the carrier the key-dependent helpers it cannot own itself.
   *
   * Carriers move bytes and must never hold the PSK, so MAC creation and
   * verification stay here and are injected as closures (§1.1).
   * @returns {void}
   */
  _installCarrierHelpers() {
    const transport = this.transport;
    if (typeof transport.verifyPoll === 'undefined' || transport.verifyPoll === null) {
      transport.verifyPoll = (object) => this.verifyHttpMac(object);
    }
    if (typeof transport.verifyPollAck === 'undefined' || transport.verifyPollAck === null) {
      transport.verifyPollAck = (object) => this.verifyHttpMac(object);
    }
    if (typeof transport.signPoll === 'undefined' || transport.signPoll === null) {
      transport.signPoll = (object) => this.httpMac(object);
    }
    if (typeof transport.signPollAck === 'undefined' || transport.signPollAck === null) {
      transport.signPollAck = (object) => this.httpMac(object);
    }
    transport.setProbeSigner?.((probe) => this._signProbeObject(probe));
  }

  /**
   * Wait until this session has nothing left to enqueue.
   *
   * HTTP carriers need this before they answer a batch: the `auth_ack` such a
   * batch produces is queued asynchronously by the handshake coroutine, so the
   * response must not be written until that frame exists. Without it the ack
   * would be POSTed back to a peer that is not listening (§7.3 rule 2).
   * @returns {Promise<void>} resolution once no work is in flight.
   */
  async waitQuiescent() {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await this._handshakeWork;
      await this._sendChain;
      if (this._state !== SessionState.HANDSHAKING) break;
    }
  }

  /**
   * Select the HTTP MAC key for one direction (§7.4).
   *
   * The key follows the *requesting* side's direction, which is why a poll
   * from A and its acknowledgment are both authenticated with A→B.
   * @param {'A'|'B'} requestingSide - side that issued the request.
   * @returns {Buffer} 32-byte HTTP MAC key.
   */
  _httpKeyFor(requestingSide) {
    if (this._keys === null) throw new BridgeError('not_ready');
    return requestingSide === 'A' ? this._keys.kHttpA2b : this._keys.kHttpB2a;
  }

  /**
   * MAC one HTTP query/body object (§7.4).
   * @param {object} objectWithoutMac - MAC object without `mac`.
   * @returns {string} base64url MAC.
   */
  httpMac(objectWithoutMac) {
    return macObject(this._httpKeyFor(objectWithoutMac.side), objectWithoutMac);
  }

  /**
   * Verify one inbound HTTP MAC object and its freshness (§7.4).
   * @param {object} objectWithMac - received object including `mac`.
   * @returns {void}
   * @throws {BridgeError} `poll_auth_failed` on any mismatch, `replay_detected` on a reused nonce.
   */
  verifyHttpMac(objectWithMac) {
    const body = { ...objectWithMac };
    delete body.mac;
    if (body.side !== Side.A && body.side !== Side.B) throw new BridgeError('poll_auth_failed');
    if (body.side === this.side) throw new BridgeError('poll_auth_failed');
    if (!this._isFreshTs(Number(body.ts))) throw new BridgeError('poll_auth_failed');
    if (this._sid !== null && body.sid !== this._sid) throw new BridgeError('sid_mismatch');
    const expected = this.httpMac(body);
    if (!constantTimeEqual(b64uDec(expected), b64uDec(String(objectWithMac.mac ?? '')))) {
      throw new BridgeError('poll_auth_failed');
    }
    // A reused (sid, side, nonce) triple is a replay, not a slow retry.
    const key = `${String(body.sid)}|${String(body.side)}|${String(body.nonce)}`;
    const now = this.now();
    for (const [seen, at] of this._httpNonces) {
      if (now - at > Limits.HELLO_REPLAY_TTL_S * 1000) this._httpNonces.delete(seen);
    }
    if (this._httpNonces.has(key)) throw new BridgeError('replay_detected');
    this._httpNonces.set(key, now);
  }

  /**
   * Sign an outbound probe with `K_probe` (§7.3 rule 5).
   *
   * The carrier cannot sign anything: only this layer holds the PSK, so the MAC
   * is produced here and the carrier merely transports the object.
   * @param {{v: number, type: string, conn: string, nonce: string, ts: number}} probe - unsigned probe.
   * @returns {object} probe with its `mac`.
   */
  _signProbeObject(probe) {
    return { ...probe, mac: macObject(handshakeKey(this._psk(), 'probe'), probe) };
  }

  /**
   * Handle one inbound probe object (§7.3).
   * @param {object} probe - probe request.
   * @returns {object|undefined} probe_ack to return, or undefined.
   */
  _onProbe(probe) {
    this._lastInboundAt = this.now();
    if (probe?.type === PlainType.PROBE) {
      const body = {
        v: 1,
        type: PlainType.PROBE_ACK,
        conn: this.connId,
        nonce: probe.nonce,
        ts: this.now(),
      };
      return { ...body, mac: macObject(handshakeKey(this._psk(), 'probe_ack'), body) };
    }
    return undefined;
  }

  /**
   * Handle one inbound envelope: verify, decrypt, then dispatch.
   * @param {object} envelope - sealed frame.
   * @returns {Promise<void>} resolution after dispatch.
   */
  async _onEnvelope(envelope) {
    this._lastInboundAt = this.now();
    if (this._state === SessionState.HANDSHAKING) {
      const expected = this.role === HandshakeRole.RESPONDER ? FrameType.AUTH : FrameType.AUTH_ACK;
      if (envelope?.type !== expected) {
        await this._fail(new BridgeError('auth_required'), { reason: 'unexpected_frame_during_handshake' });
        return;
      }
      let payload;
      try {
        // `auth`/`auth_ack` occupy seq 0 of each direction, so they must feed
        // the same receive window as every later frame: skipping it would let
        // a replayed handshake frame pass unnoticed.
        this._recvWindow.accept(envelope.seq);
        payload = openFrame(this._sealingKeys(), this._peerSealingSide(), envelope);
      } catch (error) {
        await this._fail(asSecurity(error));
        return;
      }
      this._deliverHandshake(payload);
      return;
    }

    if (this._state !== SessionState.READY && this._state !== SessionState.DRAINING) return;
    if (envelope?.conn !== this.connId) {
      await this._fail(new BridgeError('unknown_conn'));
      return;
    }

    // `openFrame` returns decoded JSON, so the value is only known to be
    // `unknown` here; each branch below applies the narrowest useful filter and
    // keeps its own malformed-payload behaviour unchanged.
    let payload;
    try {
      this._recvWindow.accept(envelope.seq);
      payload = openFrame(this._sealingKeys(), this._peerSealingSide(), envelope);
    } catch (error) {
      await this._fail(asSecurity(error));
      return;
    }

    switch (envelope.type) {
      case FrameType.DATA:
        await this._onData(payload);
        return;
      case FrameType.PING: {
        // A `ping` carries an advisory counter; `_onData`-style rejection would
        // be wrong here, because a malformed counter still owes the peer a
        // `pong` (echoing back is what keeps a silent-but-alive peer alive).
        const ping = /** @type {{n?: unknown}|null|undefined} */ (payload);
        await this.send(FrameType.PONG, { n: ping?.n ?? 0, echo: this.now() });
        return;
      }
      case FrameType.PONG:
        return;
      case FrameType.CLOSE:
        this._onPeerClose(payload);
        return;
      default:
        await this._fail(new BridgeError('bad_frame'));
    }
  }

  /**
   * Dispatch one decrypted `data` payload into the router sink.
   *
   * The parameter is `unknown` because it is decoded JSON: this method is where
   * "the frame opened" becomes "the payload is a message object", and a
   * non-object is a `bad_frame` rather than something to coerce.
   * @param {unknown} payload - application message.
   * @returns {Promise<void>} resolution after the handler ran.
   */
  async _onData(payload) {
    if (payload === null || typeof payload !== 'object') {
      await this._fail(new BridgeError('bad_frame'));
      return;
    }
    // Shape-wise the payload is now an object; the two fields this method reads
    // are still unverified, so each is checked where it is used below.
    const message = /** @type {{k?: unknown, reply_to?: unknown}} */ (payload);
    if (message.k === 'rep') {
      const pending = this._pending.get(message.reply_to);
      if (pending === undefined) {
        // An unmatched reply is dropped with a log line, never fatal (§9.1).
        this.logger.debug('orphan_reply', { conn: this.connId, sid: this._sid });
        return;
      }
      this._pending.delete(message.reply_to);
      pending.settle(/** @type {object} */ (payload));
      return;
    }
    await this._onMessage(/** @type {object} */ (payload));
  }

  /**
   * Handle a peer-initiated close frame (§6.2).
   *
   * Like `_onData`, the payload is decoded JSON: only a string `code` is ever
   * read, and anything else is reported as "no code" instead of being rejected
   * (the session is closing either way).
   * @param {unknown} payload - close payload.
   * @returns {void}
   */
  _onPeerClose(payload) {
    const close = /** @type {{code?: unknown}} */ (payload);
    this.logger.info('peer_close', {
      conn: this.connId,
      sid: this._sid,
      code: typeof close?.code === 'string' ? close.code : null,
    });
    void this.close('peer_closed', 'peer closed the session', { notifyPeer: false });
  }

  /**
   * This session's sealing keys, or a fail-closed `not_ready`.
   *
   * `_keys` is non-null exactly between `_deriveSessionKeys()` and `close()`;
   * every caller below runs inside that window. The accessor states the
   * invariant once, so a violation surfaces as a protocol-level `not_ready`
   * instead of a `TypeError` from inside the AEAD helpers.
   * @returns {import('./crypto.js').SessionKeys} session keys.
   * @throws {BridgeError} `not_ready` when no handshake has completed.
   */
  _sealingKeys() {
    if (this._keys === null) throw new BridgeError('not_ready');
    return this._keys;
  }

  /**
   * The peer side this session seals and opens against.
   *
   * Set by `_acceptHello()` / `_acceptHelloAck()` from the peer's authenticated
   * `side`; no key is ever derived before that happens, so the same
   * handshake-complete window that makes {@link Session#_sealingKeys} total also
   * makes this one total.
   * @returns {'A'|'B'} authenticated peer side.
   * @throws {BridgeError} `bad_side` when no peer side was authenticated.
   */
  _peerSealingSide() {
    if (this._peerSide !== Side.A && this._peerSide !== Side.B) throw new BridgeError('bad_side');
    return this._peerSide;
  }

  /**
   * Serialize one sealed send: allocate seq, seal, enqueue — all under the lock.
   * @param {string} frameType - frame type.
   * @param {unknown} payload - JSON payload.
   * @returns {Promise<void>} resolution after the transport accepted the frame.
   */
  async _sendFrame(frameType, payload) {
    const operation = this._sendChain.then(async () => {
      if (this._closed) throw new BridgeError('draining');
      if (this._nextSeq > Number.MAX_SAFE_INTEGER) throw new BridgeError('draining');
      const seq = this._nextSeq;
      this._nextSeq += 1;
      const envelope = sealFrame(this._sealingKeys(), this.side, frameType, this.connId, seq, payload);
      await this.transport.sendEnvelope(envelope);
    });
    // Keep the chain alive even when this send fails, so one broken frame does
    // not deadlock every later send.
    this._sendChain = operation.catch(() => {});
    return operation;
  }

  /**
   * Send one sealed frame.
   * @param {string} frameType - frame type from `FrameType`.
   * @param {unknown} payload - JSON payload.
   * @returns {Promise<void>} resolution after enqueue.
   */
  async send(frameType, payload) {
    if (this._state !== SessionState.READY && this._state !== SessionState.HANDSHAKING) {
      throw new BridgeError('not_ready');
    }
    if (this._state === SessionState.HANDSHAKING && frameType !== FrameType.AUTH && frameType !== FrameType.AUTH_ACK) {
      throw new BridgeError('auth_required');
    }
    return this._sendFrame(frameType, payload);
  }

  /**
   * Send one application message inside a `data` frame.
   * @param {object} message - §9.1 message object.
   * @returns {Promise<void>} resolution after enqueue.
   */
  async sendMessage(message) {
    return this.send(FrameType.DATA, message);
  }

  /**
   * Send a request and await its reply.
   *
   * The pending entry is registered before the frame is queued, so a fast peer
   * reply can never arrive unmatched.
   * @param {string} m - message name.
   * @param {object} params - request parameters.
   * @param {number} [timeoutS] - override the default timeout.
   * @returns {Promise<object>} `result` of a successful reply.
   * @throws {BridgeError} the peer's error, or `timeout`.
   */
  async call(m, params, timeoutS = this.reqTimeoutS) {
    if (this._state !== SessionState.READY) throw new BridgeError('not_ready');
    const id = randomUUID();
    const message = {
      k: 'req',
      m,
      id,
      ts: new Date(this.now()).toISOString(),
      params: params ?? {},
    };
    return new Promise((resolve, reject) => {
      // Not unref'd: an unanswered request must always settle with `timeout`.
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new BridgeError('timeout'));
      }, timeoutS * 1000);

      this._pending.set(id, {
        settle: (reply) => {
          clearTimeout(timer);
          if (reply.ok === true) resolve(reply.result ?? {});
          else {
            const error = reply.error ?? {};
            reject(
              new BridgeError(error.code ?? 'internal_error', {
                details: error.details ?? null,
              }),
            );
          }
        },
      });

      this.sendMessage(message).catch((error) => {
        clearTimeout(timer);
        this._pending.delete(id);
        reject(error instanceof BridgeError ? error : new BridgeError('not_ready'));
      });
    });
  }

  /**
   * Answer one inbound request with a `rep` frame.
   * @param {object} request - inbound `k:"req"` message.
   * @param {object|null} result - success result, or null when failing.
   * @param {BridgeError|null} [error] - failure to report.
   * @returns {Promise<void>} resolution after enqueue.
   */
  async reply(request, result, error = null) {
    const message =
      error === null
        ? {
            k: 'rep',
            m: request.m,
            id: randomUUID(),
            reply_to: request.id,
            ts: new Date(this.now()).toISOString(),
            ok: true,
            result: result ?? {},
          }
        : {
            k: 'rep',
            m: request.m,
            id: randomUUID(),
            reply_to: request.id,
            ts: new Date(this.now()).toISOString(),
            ok: false,
            error: error.toWire(),
          };
    return this.sendMessage(message);
  }

  /**
   * Emit one `evt` message.
   * @param {string} m - message name.
   * @param {object} params - event parameters.
   * @returns {Promise<void>} resolution after enqueue.
   */
  async emit(m, params) {
    return this.sendMessage({
      k: 'evt',
      m,
      id: randomUUID(),
      ts: new Date(this.now()).toISOString(),
      params: params ?? {},
    });
  }

  /**
   * Whether the negotiated capability set includes one feature (§4.5).
   * @param {string} feature - feature name.
   * @returns {boolean} whether both sides declared it.
   */
  peerSupports(feature) {
    return this._peerCaps?.features?.includes(feature) === true;
  }

  /**
   * Negotiated intersection of both capability declarations (§4.5).
   * @returns {object|null} negotiated capabilities, or null before handshake.
   */
  negotiated() {
    return this._negotiated;
  }

  /**
   * Close the session.
   * @param {string} code - protocol close code.
   * @param {string} reason - short reason (≤120 ASCII, no secrets).
   * @param {object} [options] - close behaviour.
   * @param {boolean} [options.notifyPeer] - whether to send a `close` frame first.
   * @returns {Promise<void>} resolution after teardown.
   */
  async close(code, reason, options = {}) {
    if (this._closed) return;
    this._closed = true;
    this._resolveClosed();
    this._stopHeartbeat();
    this._setState(SessionState.DRAINING);
    if (options.notifyPeer !== false && this._state !== SessionState.CONFIG_ERROR && this._keys !== null) {
      try {
        await this._sendFrame(FrameType.CLOSE, {
          code,
          reason: String(reason).slice(0, Limits.MAX_CLOSE_REASON),
        });
      } catch {
        // A broken carrier must not block teardown.
      }
    }
    for (const [, pending] of this._pending) {
      pending.settle({ ok: false, error: { code: 'timeout' } });
    }
    this._pending.clear();
    for (const waiter of this._handshakeWaiters) {
      waiter(undefined);
    }
    this._handshakeWaiters.length = 0;
    try {
      await this.transport.stop();
    } catch (error) {
      this.logger.failure('transport_stop_failed', error, { conn: this.connId, sid: this._sid });
    }
    this._keys = null;
    this._setState(SessionState.CLOSED);
  }

  /**
   * Drain the session for shutdown: stop accepting new work, then close.
   * @returns {Promise<void>} resolution after close.
   */
  async drain() {
    if (this._state === SessionState.READY) this._setState(SessionState.DRAINING);
    await this.close('draining', 'shutdown');
  }
}

/**
 * Return 32 cryptographically random bytes.
 * @returns {Buffer} random bytes.
 */
function randomBytes32() {
  // `randomUUID()` is the only CSPRNG this module already imports; using it
  // twice keeps a single import surface and is still CSPRNG-grade entropy.
  const a = Buffer.from(randomUUID().replaceAll('-', ''), 'hex');
  const b = Buffer.from(randomUUID().replaceAll('-', ''), 'hex');
  return Buffer.concat([a, b]).subarray(0, 32);
}

/**
 * Copy an object without its `mac` member (the MAC input, §4.2).
 * @param {object} object - object carrying `mac`.
 * @returns {object} object without `mac`.
 */
export function stripMac(object) {
  const { mac: _mac, ...rest } = object ?? {};
  return rest;
}

/**
 * Decode a base64url nonce and require 32 bytes.
 * @param {string} text - encoded nonce.
 * @returns {Buffer} 32-byte nonce.
 * @throws {BridgeError} `bad_frame` when the nonce is not 32 bytes.
 */
function decodeNonce(text) {
  const bytes = b64uDec(String(text ?? ''));
  if (bytes.length !== 32) throw new BridgeError('bad_frame');
  return bytes;
}

/**
 * Normalize a caught error into a fatal security failure.
 * @param {unknown} error - caught value.
 * @returns {BridgeError} fatal error.
 */
function asSecurity(error) {
  return error instanceof BridgeError ? error : new BridgeError('aead_failed');
}

/**
 * Compute the negotiated capabilities from both declarations (§4.5).
 * @param {object} mine - local caps.
 * @param {object} theirs - peer caps.
 * @returns {object} negotiated view used by the app layer.
 */
export function negotiate(mine, theirs) {
  const mime = (mine.attachments.mime ?? []).filter((value) => theirs.attachments.mime.includes(value));
  const num = (key) => Math.min(mine.attachments[key], theirs.attachments[key]);
  const limit = (key) => Math.min(mine.limits[key], theirs.limits[key]);
  return {
    mime,
    limits: {
      maxBytes: num('max_bytes'),
      maxCount: num('max_count'),
      maxTotalBytes: num('max_total_bytes'),
      maxPixels: num('max_pixels'),
      maxDimension: num('max_dimension'),
      maxFrameBytes: limit('max_frame_bytes'),
      maxChunkBytes: limit('max_chunk_bytes'),
      maxBatchFrames: limit('max_batch_frames'),
      retentionFrames: limit('retention_frames'),
    },
    roles: {
      initiateTask: mine.roles.initiate_task && theirs.roles.initiate_task,
      executeTask: mine.roles.execute_task && theirs.roles.execute_task,
    },
    approvals: {
      nativeTool: mine.approvals.native_tool && theirs.approvals.native_tool,
      businessDecision: mine.approvals.business_decision && theirs.approvals.business_decision,
      crossEndSubmit: mine.approvals.cross_end_submit && theirs.approvals.cross_end_submit,
    },
    features: (mine.features ?? []).filter((value) => theirs.features.includes(value)),
  };
}

/**
 * Build the local `caps` object for this endpoint (§4.5).
 * @param {object} input - capability inputs.
 * @param {'A'|'B'} input.side - this endpoint's side.
 * @param {string} input.host - `astrbot` or `dsh`.
 * @param {string} input.version - plugin version string.
 * @param {string[]} input.transports - configured carriers.
 * @param {boolean} input.tls - whether TLS is enabled.
 * @param {boolean} input.rolesInitiate - whether this endpoint can initiate tasks.
 * @param {boolean} input.rolesExecute - whether this endpoint can execute tasks.
 * @param {object} input.approvals - approval capability flags.
 * @param {object} input.attachments - image limits and MIME list.
 * @returns {object} normalized caps object.
 */
export function buildCaps(input) {
  return {
    side: input.side,
    host: input.host,
    version: input.version,
    pv: [1],
    transports: [...new Set(input.transports)].sort(),
    tls: input.tls === true,
    roles: { initiate_task: input.rolesInitiate, execute_task: input.rolesExecute },
    approvals: {
      business_decision: input.approvals.business_decision === true,
      cross_end_submit: input.approvals.cross_end_submit === true,
      native_tool: input.approvals.native_tool === true,
    },
    attachments: {
      image: true,
      blob: true,
      reference: false,
      mime: [...input.attachments.mime].sort(),
      max_bytes: input.attachments.max_bytes,
      max_count: input.attachments.max_count,
      max_total_bytes: input.attachments.max_total_bytes,
      max_pixels: input.attachments.max_pixels,
      max_dimension: input.attachments.max_dimension,
    },
    limits: {
      max_frame_bytes: Limits.MAX_FRAME_BYTES,
      max_chunk_bytes: Limits.MAX_CHUNK_BYTES,
      max_batch_frames: Limits.MAX_BATCH_FRAMES,
      retention_frames: Limits.RETENTION_FRAMES,
    },
    features: [...CapsFeature].sort(),
  };
}

void jcsAscii;

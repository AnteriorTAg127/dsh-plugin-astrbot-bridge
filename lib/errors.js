/**
 * Bridge error type shared by every layer.
 *
 * The `code` vocabulary is closed by protocol §15; this module never invents a
 * code. `fatal` marks security failures that MUST tear the current session
 * down (protocol §15.1), and `http` carries the status an HTTP carrier must
 * answer with when the failure happens before a frame is dispatched (§8.1).
 * @module dsh-plugin-astrbot-bridge/errors
 */

/**
 * Error codes that MUST terminate the session that produced them (protocol §15.1).
 * A fatal failure never degrades, never retries with the same nonce, and never
 * falls back to an unencrypted carrier.
 */
export const FATAL_CODES = Object.freeze(
  new Set([
    'psk_mismatch',
    'th_mismatch',
    'aead_failed',
    'replay_detected',
    'replay_out_of_window',
    'hello_replay',
    'handshake_reuse',
    'stale_session',
    'dual_writer',
    'auth_required',
    'subprotocol_mismatch',
    'bad_handshake_encoding',
  ]),
);

/** Configuration-class codes: never retried, connection parks in `config_error` (§7.6). */
export const CONFIG_CODES = Object.freeze(
  new Set(['psk_not_configured', 'config_invalid', 'unknown_conn']),
);

/** HTTP status per error code (§15). Codes without an HTTP face return undefined. */
const HTTP_STATUS = Object.freeze({
  psk_not_configured: 500,
  psk_mismatch: 401,
  th_mismatch: 401,
  replay_detected: 409,
  replay_out_of_window: 409,
  hello_replay: 409,
  handshake_reuse: 409,
  stale_session: 409,
  dual_writer: 409,
  sid_mismatch: 409,
  auth_required: 401,
  poll_auth_failed: 401,
  auth_header_forbidden: 401,
  bad_version: 426,
  bad_handshake_encoding: 400,
  bad_caps: 400,
  bad_side: 400,
  unknown_conn: 404,
  rate_limited: 429,
  hello_expired: 401,
  bad_json: 400,
  bad_frame: 400,
  bad_batch: 400,
  frame_too_large: 413,
  unsupported_content_type: 415,
  not_ready: 425,
  draining: 503,
  server_busy: 503,
  internal_error: 500,
});

/** Fixed English messages (§8.2 forbids echoing peer input). */
const MESSAGES = Object.freeze({
  psk_not_configured: 'authentication is not configured',
  psk_mismatch: 'authentication failed',
  th_mismatch: 'handshake transcript mismatch',
  aead_failed: 'frame authentication failed',
  replay_detected: 'frame replay rejected',
  replay_out_of_window: 'frame sequence out of window',
  hello_replay: 'handshake replay rejected',
  handshake_reuse: 'handshake nonce reuse rejected',
  stale_session: 'session is no longer current',
  dual_writer: 'concurrent writer rejected',
  sid_mismatch: 'session identity mismatch',
  auth_required: 'handshake required',
  poll_auth_failed: 'poll authentication failed',
  auth_header_forbidden: 'credential header rejected',
  bad_version: 'protocol version unsupported',
  subprotocol_mismatch: 'websocket subprotocol mismatch',
  bad_handshake_encoding: 'handshake encoding rejected',
  bad_caps: 'capabilities rejected',
  bad_side: 'peer side rejected',
  unknown_conn: 'connection unknown',
  rate_limited: 'too many attempts',
  hello_expired: 'handshake timestamp expired',
  bad_json: 'malformed request body',
  bad_frame: 'malformed frame',
  bad_batch: 'malformed frame batch',
  frame_too_large: 'frame too large',
  unsupported_content_type: 'unsupported content type',
  unknown_message: 'unknown message name',
  unknown_message_kind: 'unknown message kind',
  bad_params: 'invalid parameters',
  orphan_reply: 'unmatched reply',
  timeout: 'request timed out',
  not_ready: 'session not ready',
  draining: 'server draining',
  server_busy: 'server busy',
  internal_error: 'internal error',
  config_invalid: 'configuration invalid',
  capability_unavailable: 'capability unavailable',
  task_not_found: 'task not found',
  task_exists: 'task exists with different parameters',
  task_timeout: 'task timed out',
  task_cancel_unsupported: 'task cannot be cancelled',
  session_not_authorized: 'session not authorized',
  session_quota_exceeded: 'session quota exceeded',
  session_create_denied: 'session creation denied',
  session_not_found: 'session not found',
  session_archived: 'session archived',
  agent_cannot_approve: 'agent cannot approve',
  agent_cannot_decide: 'agent cannot decide',
  approval_expired: 'approval expired',
  approval_mismatch: 'approval digest mismatch',
  approval_digest_mismatch: 'submit digest mismatch',
  approval_already_decided: 'approval already decided',
  approval_evidence_missing: 'approval evidence missing',
  approval_lookup_failed: 'approval lookup failed',
  decision_timeout: 'decision timed out',
  attachment_type_denied: 'attachment type denied',
  attachment_too_large: 'attachment too large',
  attachment_count_exceeded: 'attachment count exceeded',
  attachment_pixels_exceeded: 'attachment pixels exceeded',
  attachment_bytes_mismatch: 'attachment bytes do not match declaration',
  attachment_invalid: 'attachment invalid',
  attachment_not_found: 'attachment not found',
  attachment_meta_mismatch: 'attachment metadata mismatch',
  attachment_source_denied: 'attachment source denied',
  model_without_vision: 'model has no vision capability',
  blob_incomplete: 'blob incomplete',
  blob_not_found: 'blob not found',
  event_not_found: 'event not found',
  wake_chain_exceeded: 'wake chain limit exceeded',
  wake_rate_limited: 'wake rate limited',
  needs_human: 'human attention required',
});

/**
 * One protocol failure.
 *
 * The class carries no dynamic text: `message` is the fixed English sentence
 * for `code`, so a failure can never leak peer input, paths, or key material
 * into a response body or log line (§8.2, §11.4).
 */
export class BridgeError extends Error {
  /**
   * @param {string} code - one of the protocol §15 codes.
   * @param {object} [options] - failure classification.
   * @param {string} [options.message] - fixed English sentence override.
   * @param {boolean} [options.fatal] - overrides the fatal classification.
   * @param {number} [options.http] - overrides the HTTP status.
   * @param {object|null} [options.details] - non-sensitive `rep.error.details`.
   * @param {boolean} [options.retryable] - whether a caller may retry.
   */
  constructor(code, options = {}) {
    super(options.message ?? MESSAGES[code] ?? 'request failed');
    this.name = 'BridgeError';
    this.code = code;
    this.fatal = options.fatal ?? FATAL_CODES.has(code);
    this.http = options.http ?? HTTP_STATUS[code];
    this.details = options.details ?? null;
    this.retryable = options.retryable ?? code === 'timeout';
  }

  /** Whether this failure must park the connection instead of retrying. */
  get isConfigError() {
    return CONFIG_CODES.has(this.code);
  }

  /**
   * Serialize as a `rep.ok:false` error object (§9.1).
   * @returns {{code: string, message: string, details: object|null}} wire error.
   */
  toWire() {
    return { code: this.code, message: this.message, details: this.details };
  }

  /**
   * Serialize as the HTTP error envelope of §8.2.
   * @returns {{v: number, error: {code: string, message: string, retryable: boolean}}} body.
   */
  toHttpBody() {
    return {
      v: 1,
      error: { code: this.code, message: this.message, retryable: this.retryable },
    };
  }
}

/**
 * Normalize an arbitrary thrown value into a {@link BridgeError}.
 * Unknown failures become `internal_error` so no stack or message escapes.
 * @param {unknown} error - value caught from user code.
 * @returns {BridgeError} a protocol-safe error.
 */
export function asBridgeError(error) {
  if (error instanceof BridgeError) return error;
  return new BridgeError('internal_error');
}

/**
 * Build a `bad_params` failure with a non-sensitive field name.
 * @param {string} field - offending field path (never contains user data).
 * @returns {BridgeError} the failure.
 */
export function badParams(field) {
  return new BridgeError('bad_params', { details: { field } });
}

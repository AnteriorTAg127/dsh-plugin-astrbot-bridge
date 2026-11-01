/**
 * Protocol v1 constants shared by every layer.
 *
 * Every value here is normative: it comes from the frozen protocol
 * `开发/v0.1/protocol.md` and the golden fixture `开发/v0.1/vectors.json`
 * (both pinned by `开发/v0.1/protocol-freeze.json`). Where prose and fixture
 * could disagree, the fixture wins (§18.2); today they agree on every value
 * used here, and `tests/vectors.test.mjs` re-derives all of them from the
 * fixture on every run.
 * @module dsh-plugin-astrbot-bridge/constants
 */

/** Protocol label mixed into key derivation and frame AAD. */
export const LABEL = 'dsh-bridge/v1';

/** Envelope version (`v`) — always 1. */
export const ENVELOPE_VERSION = 1;

/** Protocol version (`pv`) supported by this implementation. */
export const PROTOCOL_VERSIONS = Object.freeze([1]);

/** Handshake MAC keys derived once per connection (§3.3). */
export const HANDSHAKE_KEY_NAMES = Object.freeze([
  'hello',
  'hello_ack',
  'probe',
  'probe_ack',
]);

/** Session key derivation infos (§3.4), in derivation order. */
export const SESSION_KEY_INFOS = Object.freeze([
  ['kA2b', ' a2b'],
  ['kB2a', ' b2a'],
  ['kHttpA2b', ' http-a2b'],
  ['kHttpB2a', ' http-b2a'],
]);

/** Frame types (§5.1) — the closed vocabulary of `envelope.type`. */
export const FrameType = Object.freeze({
  AUTH: 'auth',
  AUTH_ACK: 'auth_ack',
  DATA: 'data',
  PING: 'ping',
  PONG: 'pong',
  CLOSE: 'close',
});

/** Plain (unsealed) handshake object types. */
export const PlainType = Object.freeze({
  HELLO: 'hello',
  HELLO_ACK: 'hello_ack',
  PROBE: 'probe',
  PROBE_ACK: 'probe_ack',
});

/** Sides of the bridge. */
export const Side = Object.freeze({ A: 'A', B: 'B' });

/** Transport carriers. */
export const Transport = Object.freeze({
  WS: 'ws',
  WEBHOOK: 'webhook',
  LONGPOLl: 'longpoll',
});

/** Connection modes: who opens the carrier connection. */
export const Mode = Object.freeze({ LISTEN: 'listen', CONNECT: 'connect' });

/** Message kinds (§9.1). */
export const MessageKind = Object.freeze({
  REQ: 'req',
  REP: 'rep',
  EVT: 'evt',
});

/** Closed message-name vocabulary (§9.2). */
export const MessageName = Object.freeze({
  TASK_SUBMIT: 'task.submit',
  TASK_STATUS: 'task.status',
  TASK_LIST_OPEN: 'task.list_open',
  TASK_CANCEL: 'task.cancel',
  TASK_EVENT: 'task.event',
  DECISION_REQUEST: 'decision.request',
  DECISION_ANSWER: 'decision.answer',
  APPROVAL_REQUEST: 'approval.request',
  APPROVAL_DECISION: 'approval.decision',
  APPROVAL_LOOKUP: 'approval.lookup',
  SESSION_LIST: 'session.list',
  SESSION_CREATE: 'session.create',
  SESSION_SELECT: 'session.select',
  SESSION_MANAGE: 'session.manage',
  SESSION_AUTHZ: 'session.authz',
  BLOB_BEGIN: 'blob.begin',
  BLOB_CHUNK: 'blob.chunk',
  BLOB_COMMIT: 'blob.commit',
  BLOB_ABORT: 'blob.abort',
  EVENT_ACK: 'event.ack',
});

/** Every legal `m` value, used to reject unknown requests (§9.2, §17). */
export const MESSAGE_NAMES = /** @type {readonly string[]} */ (Object.freeze(Object.values(MessageName)));

/** Session/connection states (§16.5). */
export const SessionState = Object.freeze({
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  HANDSHAKING: 'handshaking',
  READY: 'ready',
  DRAINING: 'draining',
  CLOSED: 'closed',
  DEGRADED: 'degraded',
  CONFIG_ERROR: 'config_error',
});

/** Task statuses (§16.1). */
export const TaskStatus = Object.freeze({
  PENDING_APPROVAL: 'pending_approval',
  ACCEPTED: 'accepted',
  QUEUED: 'queued',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELED: 'canceled',
  NEEDS_DECISION: 'needs_decision',
  NEEDS_APPROVAL: 'needs_approval',
  NEEDS_HUMAN: 'needs_human',
  REJECTED: 'rejected',
});

/** Legal status transitions (§16.1). Every other transition is dropped as illegal. */
export const TASK_TRANSITIONS = Object.freeze({
  pending_approval: ['accepted', 'queued', 'rejected', 'canceled', 'needs_human'],
  accepted: ['queued', 'pending_approval', 'rejected', 'canceled', 'needs_human'],
  queued: ['running', 'canceled', 'needs_human'],
  running: [
    'succeeded',
    'failed',
    'canceled',
    'needs_decision',
    'needs_approval',
    'needs_human',
  ],
  needs_decision: ['running', 'failed', 'canceled', 'needs_human'],
  needs_approval: ['running', 'rejected', 'failed', 'canceled', 'needs_human'],
  needs_human: ['running', 'canceled'],
  succeeded: [],
  failed: [],
  canceled: [],
  rejected: [],
});

/** Terminal task statuses (no further transitions). */
export const TERMINAL_STATUSES = Object.freeze(['succeeded', 'failed', 'canceled', 'rejected']);

/** Task event vocabulary carried by `task.event` (§11.2). */
export const TaskEvent = Object.freeze({
  ACCEPTED: 'accepted',
  QUEUED: 'queued',
  RUNNING: 'running',
  PROGRESS: 'progress',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELED: 'canceled',
  NEEDS_DECISION: 'needs_decision',
  NEEDS_APPROVAL: 'needs_approval',
  NEEDS_HUMAN: 'needs_human',
});

/** Events that wake the originating session (§16.6). `progress` never wakes. */
export const WAKE_EVENTS = Object.freeze([
  TaskEvent.COMPLETED,
  TaskEvent.FAILED,
  TaskEvent.NEEDS_DECISION,
  TaskEvent.NEEDS_APPROVAL,
]);

/** Approval outcome vocabulary, aligned with DSH (§12.3). Never extended. */
export const ApprovalOutcome = Object.freeze({
  ALLOWED_ONCE: 'allowed-once',
  REJECTED: 'rejected',
  CANCELLED: 'cancelled',
  UNAVAILABLE: 'unavailable',
});

/** Approval kinds (§12.1). */
export const ApprovalType = Object.freeze({
  NATIVE_TOOL: 'native_tool',
  BUSINESS_DECISION: 'business_decision',
  CROSS_END_SUBMIT: 'cross_end_submit',
});

/** Image media types accepted by v1 (§13.1), ascending ASCII. */
export const IMAGE_MEDIA_TYPES = Object.freeze([
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

/** Magic byte prefixes per media type (§13.2). WebP additionally checks offset 8. */
export const IMAGE_MAGIC = Object.freeze({
  'image/png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  'image/jpeg': Buffer.from([0xff, 0xd8, 0xff]),
  'image/gif': Buffer.from([0x47, 0x49, 0x46, 0x38]),
  'image/webp': Buffer.from([0x52, 0x49, 0x46, 0x46]),
});

/** Protocol timing/size constants (§4, §6, §7, §13). */
export const Limits = Object.freeze({
  HELLO_SKEW_S: 300,
  HELLO_REPLAY_TTL_S: 120,
  HANDSHAKE_MAX_FAIL: 10,
  HANDSHAKE_FAIL_WINDOW_S: 60,
  HANDSHAKE_TIMEOUT_MS: 10_000,
  HEARTBEAT_S: 30,
  HEARTBEAT_MISS: 2,
  REQ_TIMEOUT_S: 60,
  TASK_SUBMIT_TIMEOUT_S: 15,
  NOTIFY_MAX_ATTEMPTS: 5,
  NOTIFY_BACKOFF_S: Object.freeze([1, 5, 30, 120, 600]),
  POLL_WAIT_MAX_S: 25,
  POLL_MAX_FRAMES: 32,
  MAX_BATCH_FRAMES: 32,
  MAX_BATCH_BYTES: 8_388_608,
  MAX_FRAME_BYTES: 2_097_152,
  MAX_CHUNK_BYTES: 786_432,
  RETENTION_FRAMES: 4096,
  REDELIVER_AFTER_S: 30,
  BLOB_TTL_S: 300,
  MAX_IMAGE_PIXELS: 64_000_000,
  MAX_IMAGE_DIMENSION: 8192,
  MAX_IMAGE_BYTES: 10_485_760,
  MAX_IMAGE_COUNT: 4,
  MAX_TOTAL_IMAGE_BYTES: 20_971_520,
  MAX_CLOSE_REASON: 120,
  MAX_INPUT_PARTS: 32,
  MAX_TEXT_CHARS: 65_536,
  RESULT_SUMMARY_CHARS: 1024,
  RESULT_TEXT_CHARS: 4096,
});

/** Default fallback order applied when the preferred carrier fails (§7.5). */
export const DEFAULT_TRANSPORT_FALLBACK = Object.freeze([Transport.LONGPOLl]);

/**
 * Directory name of the bridge data domain under `DSH_HOME` (PRD §5).
 * Data is never written inside the plugin repository itself.
 */
export const DATA_DOMAIN_DIRS = Object.freeze(['bridge', 'astrbot']);

/** Handshake roles (§4.1). */
export const HandshakeRole = Object.freeze({
  INITIATOR: 'initiator',
  RESPONDER: 'responder',
});

/** The seven v1 feature names both `caps.features` lists must use (§4.5). */
export const CapsFeature = Object.freeze([
  'approval.lookup',
  'blob.chunked',
  'decision.options',
  'event.ack',
  'session.authz',
  'task.cancel',
  'task.list_open',
]);

/** Attachment feature names accepted in `caps.features`. */
export const ApprovalsFeatures = Object.freeze({
  IMAGE_MIME: IMAGE_MEDIA_TYPES,
});

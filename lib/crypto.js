/**
 * Cryptographic suite for dsh-bridge/v1 (protocol §3, §5.2).
 *
 * Only standard primitives from `node:crypto` are used: SHA-256, HMAC-SHA256,
 * HKDF-SHA256 and ChaCha20-Poly1305. Nothing here is self-invented.
 *
 * The HKDF implementation is deliberately hand-written. `crypto.hkdfSync()`
 * always runs extract **and** expand, while this protocol needs expand-only
 * over a PRK this module extracted itself (§3.3, §3.4). Using `hkdfSync()` as
 * a stand-in produces wrong session keys and a permanent `psk_mismatch`.
 * @module dsh-plugin-astrbot-bridge/crypto
 */

import { createCipheriv, createDecipheriv, createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { LABEL, SESSION_KEY_INFOS } from './constants.js';
import { BridgeError } from './errors.js';

const TAG_BYTES = 16;
const NONCE_BYTES = 12;
const MAC_BYTES = 32;
const DIRECTION_TAG_A2B = 10;
const DIRECTION_TAG_B2A = 11;

/** Base64url alphabet without padding (RFC 4648 §5). */
const B64U_RE = /^[A-Za-z0-9_-]*$/;

/**
 * Encode bytes as unpadded base64url.
 * @param {Uint8Array|Buffer} bytes - input bytes.
 * @returns {string} unpadded base64url text.
 */
export function b64u(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

/**
 * Decode unpadded base64url text.
 *
 * A length of `4n+1` is not decodable base64 (RFC 4648 §3.2), and Node's
 * decoder silently truncates it, so it is rejected explicitly instead of
 * yielding shorter bytes than the sender encrypted.
 * @param {string} text - base64url without padding.
 * @returns {Buffer} decoded bytes.
 * @throws {BridgeError} `bad_frame` when the text is not valid base64url.
 */
export function b64uDec(text) {
  if (typeof text !== 'string' || !B64U_RE.test(text) || text.length % 4 === 1) {
    throw new BridgeError('bad_frame');
  }
  return Buffer.from(text, 'base64url');
}

/**
 * SHA-256 digest.
 * @param {Uint8Array|Buffer|string} bytes - input, strings are UTF-8 encoded.
 * @returns {Buffer} 32-byte digest.
 */
export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest();
}

/**
 * HMAC-SHA256.
 * @param {Uint8Array|Buffer} key - MAC key.
 * @param {Uint8Array|Buffer|string} bytes - message input.
 * @returns {Buffer} 32-byte MAC.
 */
export function hmacSha256(key, bytes) {
  return createHmac('sha256', key).update(bytes).digest();
}

/**
 * HKDF-Extract (RFC 5869 §2.2): `HMAC-SHA256(salt, ikm)`.
 * @param {Uint8Array|Buffer} salt - extract salt.
 * @param {Uint8Array|Buffer} ikm - input key material.
 * @returns {Buffer} 32-byte pseudorandom key.
 */
export function hkdfExtract(salt, ikm) {
  return hmacSha256(salt, ikm);
}

/**
 * HKDF-Expand (RFC 5869 §2.3) over an externally supplied PRK.
 *
 * This is expand-only on purpose: {@link hkdfExtract} already produced the PRK,
 * and `crypto.hkdfSync()` cannot express that (it would extract again).
 * @param {Uint8Array|Buffer} prk - pseudorandom key from {@link hkdfExtract}.
 * @param {Uint8Array|Buffer} info - context/application specific info.
 * @param {number} length - requested output length in bytes, at most 255*32.
 * @returns {Buffer} `length` bytes of output key material.
 * @throws {Error} when `length` is outside the RFC range.
 */
export function hkdfExpand(prk, info, length) {
  if (!Number.isInteger(length) || length < 0 || length > 255 * MAC_BYTES) {
    throw new Error('hkdf expand length out of range');
  }
  /** @type {Buffer[]} */
  const blocks = [];
  /** @type {Buffer} */
  let previous = Buffer.alloc(0);
  let produced = 0;
  for (let counter = 1; produced < length; counter += 1) {
    previous = hmacSha256(prk, Buffer.concat([previous, Buffer.from(info), Buffer.from([counter])]));
    blocks.push(previous);
    produced += previous.length;
  }
  return Buffer.concat(blocks).subarray(0, length);
}

/**
 * Build one HKDF info buffer: `LABEL + name` where name already carries its
 * leading space (e.g. `' hello'`).
 * @param {string} name - suffix appended verbatim.
 * @returns {Buffer} UTF-8 info bytes.
 */
function labelInfo(name) {
  return Buffer.from(`${LABEL}${name}`, 'utf8');
}

/**
 * Derive `psk_master` from connection credentials (§3.2).
 *
 * The secret is concatenated, hashed, and then immediately dropped: it never
 * leaves this function, never reaches a log, and never appears on the wire.
 * @param {string} pskId - non-secret connection key identifier.
 * @param {string} pskSecret - pre-shared secret (UTF-8 bytes are used as-is).
 * @returns {Buffer} 32-byte master key.
 */
export function pskMaster(pskId, pskSecret) {
  return sha256(
    Buffer.concat([
      Buffer.from(LABEL, 'utf8'),
      Buffer.from([0]),
      Buffer.from(pskId ?? '', 'utf8'),
      Buffer.from([0]),
      Buffer.from(pskSecret ?? '', 'utf8'),
    ]),
  );
}

/**
 * Derive a handshake MAC key from the PSK (§3.3).
 *
 * These four keys only ever produce HMACs proving PSK possession; they are
 * never used to encrypt frames.
 * @param {Buffer} psk - `psk_master`.
 * @param {'hello'|'hello_ack'|'probe'|'probe_ack'} name - key purpose.
 * @returns {Buffer} 32-byte HMAC key.
 */
export function handshakeKey(psk, name) {
  const kPre = hkdfExtract(Buffer.alloc(32), psk);
  return hkdfExpand(kPre, labelInfo(` ${name}`), 32);
}

/**
 * @typedef {object} SessionKeys
 * @property {Buffer} prk - HKDF pseudorandom key of this handshake.
 * @property {Buffer} kA2b - A→B sealed-frame key.
 * @property {Buffer} kB2a - B→A sealed-frame key.
 * @property {Buffer} kHttpA2b - A→B HTTP MAC key.
 * @property {Buffer} kHttpB2a - B→A HTTP MAC key.
 */

/**
 * Derive every session key of one handshake (§3.4).
 * @param {Buffer} psk - `psk_master`.
 * @param {Uint8Array|Buffer} nonceC - initiator nonce, 32 raw bytes.
 * @param {Uint8Array|Buffer} nonceS - responder nonce, 32 raw bytes.
 * @returns {SessionKeys} keys.
 * @throws {Error} when either nonce is not exactly 32 bytes.
 */
export function sessionKeys(psk, nonceC, nonceS) {
  if (nonceC.length !== 32 || nonceS.length !== 32) {
    throw new Error('session nonces must be 32 bytes');
  }
  const prk = hkdfExtract(Buffer.concat([Buffer.from(nonceC), Buffer.from(nonceS)]), psk);
  /** @type {SessionKeys} */
  const keys = /** @type {SessionKeys} */ ({ prk });
  for (const [field, info] of SESSION_KEY_INFOS) {
    keys[field] = hkdfExpand(prk, labelInfo(info), 32);
  }
  return keys;
}

/**
 * Pick the sender-side AEAD key and nonce direction tag.
 * @param {{kA2b: Buffer, kB2a: Buffer}} keys - derived session keys.
 * @param {'A'|'B'} side - sending side.
 * @returns {{key: Buffer, tag: number}} key and 4-byte direction tag value.
 */
function directionOf(keys, side) {
  return side === 'A' ? { key: keys.kA2b, tag: DIRECTION_TAG_A2B } : { key: keys.kB2a, tag: DIRECTION_TAG_B2A };
}

/**
 * Build the 12-byte AEAD nonce of §5.2: `direction_tag(4B BE) || seq(8B BE)`.
 * @param {'A'|'B'} senderSide - side that sends this frame.
 * @param {number} seq - frame sequence number.
 * @returns {Buffer} 12-byte nonce.
 */
export function frameNonce(senderSide, seq) {
  const nonce = Buffer.alloc(NONCE_BYTES);
  nonce.writeUInt32BE(senderSide === 'A' ? DIRECTION_TAG_A2B : DIRECTION_TAG_B2A, 0);
  nonce.writeBigUInt64BE(BigInt(seq), 4);
  return nonce;
}

/**
 * Build the AAD of §5.2: `LABEL|type|conn|seq`.
 * @param {string} frameType - frame type string.
 * @param {string} conn - connection id.
 * @param {number} seq - frame sequence number.
 * @returns {Buffer} UTF-8 AAD.
 */
export function frameAad(frameType, conn, seq) {
  return Buffer.from(`${LABEL}|${frameType}|${conn}|${seq}`, 'utf8');
}

/**
 * Serialize a payload for sealing.
 *
 * On the wire any legal JSON serialization is acceptable (§2.3); this module
 * uses `jcsFrame` so locally produced bytes match the golden vectors exactly.
 * @param {unknown} payload - JSON payload.
 * @returns {Buffer} UTF-8 plaintext bytes.
 */
export function framePlaintext(payload) {
  return Buffer.from(jcsFrame(payload), 'utf8');
}

/**
 * Seal one frame into an envelope (§5.2).
 * @param {{kA2b: Buffer, kB2a: Buffer}} keys - derived session keys.
 * @param {'A'|'B'} side - sending side.
 * @param {string} frameType - frame type from {@link FrameType}.
 * @param {string} conn - connection id.
 * @param {number} seq - sequence number for this direction.
 * @param {unknown} payload - JSON payload.
 * @returns {{v: number, type: string, conn: string, seq: number, ct: string}} envelope.
 */
export function sealFrame(keys, side, frameType, conn, seq, payload) {
  const { key } = directionOf(keys, side);
  const nonce = frameNonce(side, seq);
  const aad = frameAad(frameType, conn, seq);
  const cipher = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad);
  const body = Buffer.concat([
    cipher.update(framePlaintext(payload)),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return { v: 1, type: frameType, conn, seq, ct: b64u(body) };
}

/**
 * Open one envelope (§5.2). The layout is `ciphertext || tag(16)`.
 * @param {{kA2b: Buffer, kB2a: Buffer}} keys - derived session keys.
 * @param {'A'|'B'} senderSide - side that sent this frame.
 * @param {{v: number, type: string, conn: string, seq: number, ct: string}} envelope - frame.
 * @returns {unknown} decoded JSON payload.
 * @throws {BridgeError} `bad_frame` on shape problems, `aead_failed` on tag failure.
 */
export function openFrame(keys, senderSide, envelope) {
  if (
    envelope === null ||
    typeof envelope !== 'object' ||
    envelope.v !== 1 ||
    typeof envelope.type !== 'string' ||
    typeof envelope.conn !== 'string' ||
    !Number.isInteger(envelope.seq) ||
    envelope.seq < 0 ||
    typeof envelope.ct !== 'string'
  ) {
    throw new BridgeError('bad_frame');
  }
  const body = b64uDec(envelope.ct);
  if (body.length < TAG_BYTES) throw new BridgeError('bad_frame');

  const { key } = directionOf(keys, senderSide);
  const nonce = frameNonce(senderSide, envelope.seq);
  const aad = frameAad(envelope.type, envelope.conn, envelope.seq);
  const ciphertext = body.subarray(0, body.length - TAG_BYTES);
  const tag = body.subarray(body.length - TAG_BYTES);

  let plaintext;
  try {
    const decipher = createDecipheriv('chacha20-poly1305', key, nonce, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new BridgeError('aead_failed');
  }
  try {
    return JSON.parse(plaintext.toString('utf8'));
  } catch {
    throw new BridgeError('bad_frame');
  }
}

/**
 * MAC an object under JCS-ASCII and return base64url (§4.2, §4.3, §7.4).
 * @param {Uint8Array|Buffer} key - handshake or HTTP MAC key.
 * @param {object} objectWithoutMac - object with every `mac` field removed.
 * @returns {string} base64url MAC.
 */
export function macObject(key, objectWithoutMac) {
  return b64u(hmacSha256(key, Buffer.from(jcsAscii(objectWithoutMac), 'utf8')));
}

/**
 * Verify a base64url MAC in constant time.
 * @param {Uint8Array|Buffer} key - expected MAC key.
 * @param {object} objectWithoutMac - object with `mac` removed.
 * @param {string} expected - received base64url MAC.
 * @returns {boolean} whether the MAC matches.
 */
export function verifyMac(key, objectWithoutMac, expected) {
  if (typeof expected !== 'string') return false;
  let received;
  try {
    received = b64uDec(expected);
  } catch {
    return false;
  }
  const actual = hmacSha256(key, Buffer.from(jcsAscii(objectWithoutMac), 'utf8'));
  if (received.length !== actual.length) return false;
  return timingSafeEqual(received, actual);
}

/**
 * Constant-time comparison for digests and transcripts.
 * @param {Uint8Array|Buffer} left - first operand.
 * @param {Uint8Array|Buffer} right - second operand.
 * @returns {boolean} whether both are equal.
 */
export function constantTimeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Length-prefix helper `LP(x) = uint32_be(len(x)) || x` (§2.4).
 * @param {Uint8Array|Buffer} bytes - payload.
 * @returns {Buffer} prefixed bytes.
 */
export function lengthPrefixed(bytes) {
  const body = Buffer.from(bytes);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

/**
 * Build the handshake transcript digest `th` (§4.4).
 * @param {object} helloWithoutMac - initiator hello with `mac` removed.
 * @param {object} helloAckWithoutMac - responder ack with `mac` removed.
 * @returns {Buffer} 32-byte `th`.
 */
export function handshakeTranscript(helloWithoutMac, helloAckWithoutMac) {
  return sha256(
    Buffer.concat([
      lengthPrefixed(Buffer.from(`${LABEL} handshake`, 'utf8')),
      lengthPrefixed(Buffer.from(jcsAscii(helloWithoutMac), 'utf8')),
      lengthPrefixed(Buffer.from(jcsAscii(helloAckWithoutMac), 'utf8')),
    ]),
  );
}

/**
 * Compute `input_parts_digest` over ordered text parts (§12.5).
 * @param {ReadonlyArray<{type: string, text?: string}>} parts - input parts.
 * @returns {string} base64url digest.
 */
export function inputPartsDigest(parts) {
  return b64u(
    sha256(
      Buffer.concat(
        parts.map((part) => lengthPrefixed(Buffer.from(String(part?.text ?? ''), 'utf8'))),
      ),
    ),
  );
}

/**
 * Identity fields the §12.2 projection can be built from.
 *
 * Both spellings are accepted on purpose: the app layer holds host-shaped
 * records (`toolName`, `callId`) while an inbound `approval.request` carries the
 * wire-shaped keys (`tool`, `call_id`). The digest itself always projects the
 * five canonical snake_case fields, so the two spellings cannot diverge.
 * @typedef {object} ApprovalDigestInput
 * @property {string} [toolName] - host-shaped tool name.
 * @property {string} [tool] - wire-shaped tool name.
 * @property {string|null} [reason] - free-form reason.
 * @property {string|null} [callId] - host-shaped tool call id.
 * @property {string|null} [call_id] - wire-shaped tool call id.
 * @property {string|null} [sessionId] - host-shaped session id.
 * @property {string|null} [session_id] - wire-shaped session id.
 * @property {string|null} [taskId] - host-shaped task id.
 * @property {string|null} [task_id] - wire-shaped task id.
 */

/**
 * Compute `request_digest` for one approval request (§12.2).
 *
 * The projection always carries all five fields, with `null` for absent
 * optional ids. `jcs_ascii` cannot express that (it rejects `null` and
 * non-ASCII values), and the asker's `reason` is free-form text that is
 * frequently Chinese, so the frame canonicaliser is used — the same choice
 * the A side makes in `bridge/crypto.py: request_digest()`. Both peers must
 * hash identical bytes or every decision fails with `approval_mismatch`.
 * @param {ApprovalDigestInput} input - request identity fields.
 * @returns {string} base64url digest.
 */
export function approvalRequestDigest(input) {
  return b64u(
    sha256(
      Buffer.from(
        jcsFrame({
          call_id: input.callId ?? input.call_id ?? null,
          reason: input.reason ?? null,
          session_id: input.sessionId ?? input.session_id ?? null,
          task_id: input.taskId ?? input.task_id ?? null,
          tool: input.tool ?? input.toolName ?? null,
        }),
        'utf8',
      ),
    ),
  );
}

/**
 * Compute `submit_digest` over the §12.5 projection object.
 * @param {object} projection - projection object exactly as specified in §12.5.
 * @returns {string} base64url digest.
 */
export function submitDigest(projection) {
  return b64u(sha256(Buffer.from(jcsAscii(projection), 'utf8')));
}

/**
 * Serialize a value with the JCS-ASCII profile of §2.4.
 *
 * Handshake objects must be byte-identical on both implementations, so floats
 * and non-ASCII values/keys are rejected instead of silently normalized. `null`
 * is legal in this profile — §2.5 lists it as identical between `jcs_ascii` and
 * `jcs_frame`, and only the *value* ASCII rule differs. The "handshake and MAC
 * objects carry no `null`" rule is an object-shape rule, enforced by
 * {@link assertHandshakeValue}, not a serializer rule.
 * @param {unknown} value - value to serialize.
 * @returns {string} canonical JSON text.
 * @throws {BridgeError} `bad_handshake_encoding` when the value is outside the profile.
 */
export function jcsAscii(value) {
  return jcs(value, true, true);
}

/**
 * Serialize a payload with the `jcs_frame` profile of §2.5.
 *
 * Identical to {@link jcsAscii} except string values may hold non-ASCII UTF-8
 * (task text is Chinese in practice).
 * @param {unknown} value - value to serialize.
 * @returns {string} canonical JSON text.
 * @throws {BridgeError} `bad_frame` when the value is not serializable JSON.
 */
export function jcsFrame(value) {
  return jcs(value, false, false);
}

/**
 * Assert that a value is legal inside a handshake or MAC object (§2.4 rule 1).
 *
 * Such objects must omit optional fields rather than send `null`, and must not
 * carry non-ASCII values, because both implementations must agree byte for
 * byte on the MAC input.
 * @param {unknown} value - candidate object or value.
 * @param {string} [field] - field path used only in the internal walk.
 * @returns {void}
 * @throws {BridgeError} `bad_handshake_encoding` on `null`, non-ASCII, or a non-JSON value.
 */
export function assertHandshakeValue(value, field = '$') {
  if (value === null) throw new BridgeError('bad_handshake_encoding', { details: { field } });
  if (typeof value === 'string') {
    if (/[^\x00-\x7f]/.test(value)) {
      throw new BridgeError('bad_handshake_encoding', { details: { field } });
    }
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new BridgeError('bad_handshake_encoding', { details: { field } });
    return;
  }
  if (typeof value === 'boolean') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertHandshakeValue(item, `${field}[${index}]`));
    return;
  }
  if (typeof value !== 'object') {
    throw new BridgeError('bad_handshake_encoding', { details: { field } });
  }
  for (const [key, item] of Object.entries(value)) {
    if (/[^\x00-\x7f]/.test(key)) {
      throw new BridgeError('bad_handshake_encoding', { details: { field } });
    }
    assertHandshakeValue(item, `${field}.${key}`);
  }
}

/**
 * Shared canonical serializer.
 * @param {unknown} value - value to serialize.
 * @param {boolean} asciiValues - reject non-ASCII string values and keys.
 * @param {boolean} handshakeErrors - raise `bad_handshake_encoding` instead of `bad_frame`.
 * @returns {string} canonical JSON text.
 */
function jcs(value, asciiValues, handshakeErrors) {
  const fail = () => {
    throw new BridgeError(handshakeErrors ? 'bad_handshake_encoding' : 'bad_frame');
  };
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isInteger(value)) fail();
      return String(value);
    case 'string':
      if (asciiValues && /[^\x00-\x7f]/.test(value)) fail();
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      return fail();
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => jcs(item, asciiValues, handshakeErrors)).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  const members = [];
  for (const key of keys) {
    if (asciiValues && /[^\x00-\x7f]/.test(key)) fail();
    if (value[key] === undefined) continue;
    members.push(`${JSON.stringify(key)}:${jcs(value[key], asciiValues, handshakeErrors)}`);
  }
  return `{${members.join(',')}}`;
}

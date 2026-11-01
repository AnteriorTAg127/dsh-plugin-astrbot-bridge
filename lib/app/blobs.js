/**
 * Blob and image handling (protocol §13).
 *
 * Images travel as `blob.*` chunks over the sealed channel; nothing is fetched
 * from a URL and no reference mode exists in v1. Validation happens as early as
 * possible — at `blob.begin` — so an oversized transfer is refused before a
 * single byte is written.
 * @module dsh-plugin-astrbot-bridge/app/blobs
 */

import { randomUUID } from 'node:crypto';

import { BridgeError } from '../errors.js';
import { IMAGE_MAGIC, IMAGE_MEDIA_TYPES, Limits, MessageName } from '../constants.js';
import { b64u, b64uDec, sha256 } from '../crypto.js';

/** Image service. */
export class BlobService {
  /**
   * @param {object} options - service dependencies.
   * @param {object} options.store - bridge store.
   * @param {object} options.session - session bound to the peer (for outbound sends).
   * @param {object} options.config - bridge configuration.
   * @param {object} [options.attachments] - attachment host adapter.
   * @param {import('../log.js').Logger} [options.logger] - structured logger.
   * @param {Function} [options.now] - injectable clock.
   */
  constructor(options) {
    this.store = options.store;
    this.session = options.session;
    this.config = options.config;
    this.attachments = options.attachments ?? null;
    this.logger = options.logger ?? { info() {}, warn() {}, failure() {}, debug() {}, error() {} };
    this.now = options.now ?? (() => Date.now());
    /** @type {Map<string, object>} in-flight transfers keyed by blob_id. */
    this._transfers = new Map();
  }

  /** Effective limits, honouring configuration and host caps (§13.2). */
  get limits() {
    const host = this.attachments?.limits?.() ?? null;
    return {
      maxBytes: Math.min(this.config.imageMaxBytes, host?.maxImageBytes ?? Limits.MAX_IMAGE_BYTES),
      maxCount: Math.min(this.config.imageMaxCount, host?.maxImagesPerMessage ?? Limits.MAX_IMAGE_COUNT),
      maxTotalBytes: Math.min(
        this.config.imageTotalMaxBytes,
        host?.maxMessageImageBytes ?? Limits.MAX_TOTAL_IMAGE_BYTES,
      ),
      maxPixels: Math.min(Limits.MAX_IMAGE_PIXELS, host?.maxImagePixels ?? Limits.MAX_IMAGE_PIXELS),
      maxDimension: Math.min(Limits.MAX_IMAGE_DIMENSION, host?.maxImageDimension ?? Limits.MAX_IMAGE_DIMENSION),
      mime: this.config.imageAllowedMime ?? IMAGE_MEDIA_TYPES,
      maxChunkBytes: Limits.MAX_CHUNK_BYTES,
    };
  }

  /**
   * Validate declared image metadata without touching bytes (§13.2).
   * @param {object} input - `{media_type, bytes, width, height}`.
   * @returns {void}
   * @throws {BridgeError} on any violation.
   */
  validateMetadata(input) {
    const limits = this.limits;
    if (!limits.mime.includes(input.media_type)) throw new BridgeError('attachment_type_denied');
    if (!Number.isInteger(input.bytes) || input.bytes <= 0) throw new BridgeError('attachment_invalid');
    if (input.bytes > limits.maxBytes) throw new BridgeError('attachment_too_large');
    const width = Number(input.width ?? 0);
    const height = Number(input.height ?? 0);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      throw new BridgeError('attachment_invalid');
    }
    if (width > limits.maxDimension || height > limits.maxDimension) {
      throw new BridgeError('attachment_pixels_exceeded');
    }
    if (width * height > limits.maxPixels) throw new BridgeError('attachment_pixels_exceeded');
  }

  /**
   * Verify the magic bytes of one image (§13.2).
   * @param {string} mediaType - declared media type.
   * @param {Uint8Array} bytes - decoded image bytes.
   * @returns {void}
   * @throws {BridgeError} `attachment_bytes_mismatch` when the bytes are not that format.
   */
  assertMagic(mediaType, bytes) {
    const expected = IMAGE_MAGIC[mediaType];
    if (expected === undefined) throw new BridgeError('attachment_type_denied');
    const buffer = Buffer.from(bytes);
    if (buffer.length < expected.length) throw new BridgeError('attachment_invalid');
    for (let index = 0; index < expected.length; index += 1) {
      if (buffer[index] !== expected[index]) throw new BridgeError('attachment_bytes_mismatch');
    }
    if (mediaType === 'image/webp') {
      // WebP is `RIFF....WEBP`: the second tag at offset 8 is what identifies it.
      const tag = buffer.subarray(8, 12).toString('latin1');
      if (tag !== 'WEBP') throw new BridgeError('attachment_bytes_mismatch');
    }
  }

  /**
   * Validate a task's declared attachments atomically (§13.2, §13.4).
   * @param {object[]} attachments - declared attachments.
   * @returns {void}
   * @throws {BridgeError} on any violation; nothing is partially accepted.
   */
  validateTaskAttachments(attachments) {
    const limits = this.limits;
    if (!Array.isArray(attachments)) throw new BridgeError('bad_params', { details: { field: 'attachments' } });
    if (attachments.length === 0) return;
    if (attachments.length > limits.maxCount) throw new BridgeError('attachment_count_exceeded');
    let total = 0;
    for (const attachment of attachments) {
      if (attachment.kind !== 'blob') {
        // §13.1/§13.3: reference mode is reserved and MUST stay unsupported.
        throw new BridgeError('attachment_source_denied');
      }
      if (typeof attachment.blob_id !== 'string' || attachment.blob_id.length === 0) {
        throw new BridgeError('bad_params', { details: { field: 'attachments.blob_id' } });
      }
      this.validateMetadata(attachment);
      total += attachment.bytes;
    }
    if (total > limits.maxTotalBytes) throw new BridgeError('attachment_too_large');
  }

  /**
   * Begin one inbound transfer (§13.3).
   * @param {object} params - `blob.begin` parameters.
   * @returns {Promise<{blob_id: string, accepted: true}>} result.
   * @throws {BridgeError} on validation failure; nothing is stored.
   */
  async begin(params) {
    this.validateMetadata({
      media_type: params.media_type,
      bytes: params.bytes,
      width: params.width,
      height: params.height,
    });
    const chunks = Number(params.chunks ?? 0);
    const expected = Math.ceil(params.bytes / this.limits.maxChunkBytes);
    if (!Number.isInteger(chunks) || chunks !== expected) {
      throw new BridgeError('bad_params', { details: { field: 'chunks' } });
    }
    const blobId = String(params.blob_id ?? '');
    if (blobId.length === 0) throw new BridgeError('bad_params', { details: { field: 'blob_id' } });
    if (this._transfers.has(blobId)) return { blob_id: blobId, accepted: true };
    this._transfers.set(blobId, {
      blob_id: blobId,
      media_type: params.media_type,
      bytes: params.bytes,
      width: params.width,
      height: params.height,
      sha256: params.sha256,
      chunks,
      received: new Map(),
      started_at: this.now(),
    });
    return { blob_id: blobId, accepted: true };
  }

  /**
   * Accept one chunk of an inbound transfer (§13.3).
   * @param {object} params - `blob.chunk` parameters.
   * @returns {Promise<{blob_id: string, index: number, accepted: true}>} result.
   * @throws {BridgeError} `blob_not_found`, `bad_params`, `attachment_bytes_mismatch`.
   */
  async chunk(params) {
    const blobId = String(params.blob_id ?? '');
    const transfer = this._transfers.get(blobId);
    if (transfer === undefined) throw new BridgeError('blob_not_found');
    const index = Number(params.index ?? -1);
    if (!Number.isInteger(index) || index < 0 || index >= transfer.chunks) {
      throw new BridgeError('bad_params', { details: { field: 'index' } });
    }
    const data = b64uDec(String(params.data ?? ''));
    if (data.length > this.limits.maxChunkBytes) throw new BridgeError('attachment_too_large');
    const digest = b64u(sha256(data));
    if (digest !== params.sha256) throw new BridgeError('attachment_bytes_mismatch');
    // A repeated chunk is idempotent as long as it is byte-identical.
    const existing = transfer.received.get(index);
    if (existing !== undefined) {
      if (!existing.equals(data)) throw new BridgeError('attachment_bytes_mismatch');
      return { blob_id: blobId, index, accepted: true };
    }
    transfer.received.set(index, data);
    return { blob_id: blobId, index, accepted: true };
  }

  /**
   * Finish one inbound transfer and verify the whole-image digest (§13.3).
   * @param {object} params - `blob.commit` parameters.
   * @returns {Promise<{blob_id: string, committed: true}>} result.
   * @throws {BridgeError} `blob_not_found`, `blob_incomplete`, `attachment_bytes_mismatch`.
   */
  async commit(params) {
    const blobId = String(params.blob_id ?? '');
    const transfer = this._transfers.get(blobId);
    if (transfer === undefined) throw new BridgeError('blob_not_found');
    if (transfer.received.size !== transfer.chunks) throw new BridgeError('blob_incomplete');
    const parts = [];
    for (let index = 0; index < transfer.chunks; index += 1) {
      const chunk = transfer.received.get(index);
      if (chunk === undefined) throw new BridgeError('blob_incomplete');
      parts.push(chunk);
    }
    const image = Buffer.concat(parts);
    if (image.length !== transfer.bytes) throw new BridgeError('attachment_bytes_mismatch');
    if (b64u(sha256(image)) !== transfer.sha256) throw new BridgeError('attachment_bytes_mismatch');
    this.assertMagic(transfer.media_type, image);
    transfer.image = image;
    return { blob_id: blobId, committed: true };
  }

  /**
   * Drop one inbound transfer (§13.3 failure path).
   * @param {object} params - `blob.abort` parameters.
   * @returns {Promise<{blob_id: string, aborted: true}>} result.
   */
  async abort(params) {
    const blobId = String(params.blob_id ?? '');
    this._transfers.delete(blobId);
    return { blob_id: blobId, aborted: true };
  }

  /**
   * Read the committed bytes of one inbound transfer.
   * @param {string} blobId - blob identity.
   * @returns {Promise<Buffer>} image bytes.
   * @throws {BridgeError} `blob_not_found`.
   */
  async bytesOf(blobId) {
    const transfer = this._transfers.get(String(blobId));
    if (transfer === undefined || transfer.image === undefined) throw new BridgeError('blob_not_found');
    return transfer.image;
  }

  /**
   * Send one image to the peer as a chunked blob (§13.3).
   * @param {object} input - image input.
   * @param {Uint8Array} input.data - image bytes.
   * @param {string} input.mediaType - declared media type.
   * @param {number} input.width - pixel width.
   * @param {number} input.height - pixel height.
   * @param {string|null} [input.taskId] - owning task.
   * @returns {Promise<object>} attachment descriptor for `task.submit`.
   * @throws {BridgeError} on validation failure.
   */
  async send(input) {
    const bytes = Buffer.from(input.data);
    this.validateMetadata({
      media_type: input.mediaType,
      bytes: bytes.length,
      width: input.width,
      height: input.height,
    });
    this.assertMagic(input.mediaType, bytes);

    const blobId = randomUUID();
    const chunkSize = this.limits.maxChunkBytes;
    const chunks = Math.max(1, Math.ceil(bytes.length / chunkSize));
    const digest = b64u(sha256(bytes));
    await this.session.emit(MessageName.BLOB_BEGIN, {
      blob_id: blobId,
      media_type: input.mediaType,
      bytes: bytes.length,
      sha256: digest,
      width: input.width,
      height: input.height,
      chunks,
      task_id: input.taskId ?? null,
      name: null,
    });
    for (let index = 0; index < chunks; index += 1) {
      const slice = bytes.subarray(index * chunkSize, (index + 1) * chunkSize);
      await this.session.emit(MessageName.BLOB_CHUNK, {
        blob_id: blobId,
        index,
        data: b64u(slice),
        sha256: b64u(sha256(slice)),
      });
    }
    await this.session.emit(MessageName.BLOB_COMMIT, {
      blob_id: blobId,
      bytes: bytes.length,
      sha256: digest,
    });
    return {
      kind: 'blob',
      blob_id: blobId,
      media_type: input.mediaType,
      bytes: bytes.length,
      sha256: digest,
      width: input.width,
      height: input.height,
    };
  }

  /**
   * Delete transfers that were never committed (§13.3 rule 4).
   * @returns {number} number of transfers dropped.
   */
  cleanup() {
    const cutoff = this.now() - Limits.BLOB_TTL_S * 1000;
    let removed = 0;
    for (const [blobId, transfer] of this._transfers) {
      if (transfer.image !== undefined) continue;
      if (transfer.started_at > cutoff) continue;
      this._transfers.delete(blobId);
      removed += 1;
    }
    return removed;
  }
}

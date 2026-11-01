/**
 * Host attachment adapter: turn bridged image bytes into durable references and
 * back (protocol §13.1, §13.3).
 *
 * The host owns normalization, MIME verification and content addressing, so the
 * bridge never invents a reference: it saves bytes with
 * `saveImages`/`saveImage` and reads them back with `readImage`, which also
 * re-verifies the digest. External URLs are never fetched.
 * @module dsh-plugin-astrbot-bridge/host/attachments
 */

import { BridgeError } from '../errors.js';

/** Attachment adapter over `ctx.attachments`. */
export class AttachmentHost {
  /**
   * @param {object} options - adapter options.
   * @param {object|null} [options.ctx] - Cordis context carrying `attachments`.
   */
  constructor(options = {}) {
    this.ctx = options.ctx ?? null;
  }

  /**
   * The host attachment service, if mounted.
   * @returns {object|null} service.
   */
  get service() {
    return this.ctx?.attachments ?? null;
  }

  /**
   * Whether image attachments can be stored and read at all.
   * @returns {boolean} capability flag.
   */
  available() {
    const service = this.service;
    return service !== null && typeof service.saveImage === 'function' && typeof service.readImage === 'function';
  }

  /**
   * Persist one image and return its durable reference.
   * @param {object} input - image input.
   * @param {Uint8Array} input.data - encoded bytes (already validated by the bridge).
   * @param {string} input.mediaType - declared media type.
   * @param {string} [input.name] - display name.
   * @returns {Promise<object>} `ImageAttachmentRef`.
   * @throws {BridgeError} `capability_unavailable` when the host cannot store images.
   */
  async saveImage(input) {
    const service = this.service;
    if (service === null || typeof service.saveImage !== 'function') {
      throw new BridgeError('capability_unavailable', { details: { capability: 'attachments' } });
    }
    return service.saveImage({
      data: input.data,
      mediaType: input.mediaType,
      name: input.name,
    });
  }

  /**
   * Read an image back and verify its digest.
   * @param {object} ref - `ImageAttachmentRef`.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<{ref: object, data: Uint8Array}>} verified bytes.
   * @throws {BridgeError} `capability_unavailable` or `attachment_invalid`.
   */
  async readImage(ref, signal) {
    const service = this.service;
    if (service === null || typeof service.readImage !== 'function') {
      throw new BridgeError('capability_unavailable', { details: { capability: 'attachments' } });
    }
    try {
      return await service.readImage(ref, signal);
    } catch {
      // A digest mismatch, a missing object and a decode failure are all
      // "these bytes cannot be trusted", which the protocol reports as invalid.
      throw new BridgeError('attachment_invalid');
    }
  }

  /**
   * Deployment image limits published by the host, when available.
   * @returns {object|null} limits object.
   */
  limits() {
    return this.service?.imageLimits ?? null;
  }
}

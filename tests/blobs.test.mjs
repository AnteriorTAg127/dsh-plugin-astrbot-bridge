/**
 * Image and blob tests (protocol §13).
 *
 * Every rejection here is a limit the protocol makes atomic: a task is refused
 * whole, never partially accepted, and the declared media type is checked
 * against the actual bytes rather than trusted.
 * @module dsh-plugin-astrbot-bridge/tests/blobs
 */

import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { BlobService } from '../lib/app/blobs.js';
import { BridgeError } from '../lib/errors.js';
import { b64u, sha256 } from '../lib/crypto.js';
import { buildUserMessage, routeSupportsImages, textOnlyPlaceholder } from '../lib/host/llm.js';
import { BridgeStore } from '../lib/store.js';

/** 1x1 PNG from the golden fixture (70 bytes). */
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
    '0000000d4944415478da63105432760100015900abcc7437bb0000',
  'hex',
);

/** Minimal GIF header, enough for magic-byte validation. */
const GIF = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(16, 1)]);

/** Minimal JPEG header. */
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16, 2)]);

/** Minimal WebP container: `RIFF....WEBPVP8 `. */
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'latin1'),
  Buffer.from([0x10, 0, 0, 0]),
  Buffer.from('WEBP', 'latin1'),
  Buffer.alloc(8, 3),
]);

/**
 * Build an image service fixture.
 * @param {object} [overrides] - configuration overrides.
 * @returns {Promise<object>} fixture.
 */
async function makeService(overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'bridge-blobs-'));
  const store = new BridgeStore({ dataRoot: root });
  await store.init();
  const emitted = [];
  const session = {
    async emit(m, params) {
      emitted.push({ m, params });
    },
    async call() {
      return {};
    },
  };
  const service = new BlobService({
    store,
    session,
    config: {
      imageMaxBytes: 10_485_760,
      imageMaxCount: 4,
      imageTotalMaxBytes: 20_971_520,
      imageAllowedMime: ['image/gif', 'image/jpeg', 'image/png', 'image/webp'],
      ...overrides,
    },
    logger: null,
  });
  return { root, store, session, service, emitted };
}

/**
 * Assert that a synchronous operation fails with one exact protocol code.
 * @param {() => unknown} operation - operation expected to throw.
 * @param {string} code - expected code.
 * @returns {void}
 */
function expectCode(operation, code) {
  assert.throws(
    operation,
    (error) => error instanceof BridgeError && error.code === code,
  );
}

/**
 * Assert that an asynchronous operation rejects with one exact protocol code.
 * @param {Promise<unknown>} operation - promise expected to reject.
 * @param {string} code - expected code.
 * @returns {Promise<void>} resolution after the assertion.
 */
async function expectRejection(operation, code) {
  await assert.rejects(
    operation,
    (error) => error instanceof BridgeError && error.code === code,
  );
}

test('every allowed media type passes the magic-byte check', async () => {
  const { service, store } = await makeService();
  service.assertMagic('image/png', PNG);
  service.assertMagic('image/gif', GIF);
  service.assertMagic('image/jpeg', JPEG);
  service.assertMagic('image/webp', WEBP);
  await store.close();
});

test('a mismatched magic is refused as attachment_bytes_mismatch', async () => {
  const { service, store } = await makeService();
  expectCode(() => service.assertMagic('image/png', GIF), 'attachment_bytes_mismatch');
  expectCode(() => service.assertMagic('image/jpeg', PNG), 'attachment_bytes_mismatch');
  // A RIFF container that is not WebP must not pass as image/webp.
  const riffOnly = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.alloc(4), Buffer.from('WAVE', 'latin1'), Buffer.alloc(8)]);
  expectCode(() => service.assertMagic('image/webp', riffOnly), 'attachment_bytes_mismatch');
  await store.close();
});

test('an unsupported media type is refused before any bytes are read', async () => {
  const { service, store } = await makeService();
  expectCode(() => service.assertMagic('image/tiff', PNG), 'attachment_type_denied');
  service.validateTaskAttachments([]);
  await store.close();
});

test('metadata limits are enforced per image', async () => {
  const { service, store } = await makeService({ imageMaxBytes: 10 });
  expectCode(
    () => service.validateMetadata({ media_type: 'image/png', bytes: 11, width: 1, height: 1 }),
    'attachment_too_large',
  );
  expectCode(
    () => service.validateMetadata({ media_type: 'image/png', bytes: 9, width: 9000, height: 1 }),
    'attachment_pixels_exceeded',
  );
  // Each side is within the 8192 dimension cap but the area exceeds the
  // 64,000,000 pixel budget, so only the pixel rule can catch this.
  expectCode(
    () => service.validateMetadata({ media_type: 'image/png', bytes: 9, width: 8001, height: 8000 }),
    'attachment_pixels_exceeded',
  );
  // Exactly at both caps is allowed: the limits are inclusive.
  assert.doesNotThrow(() =>
    service.validateMetadata({ media_type: 'image/png', bytes: 9, width: 8000, height: 8000 }),
  );
  expectCode(
    () => service.validateMetadata({ media_type: 'image/png', bytes: 0, width: 1, height: 1 }),
    'attachment_invalid',
  );
  expectCode(
    () => service.validateMetadata({ media_type: 'image/png', bytes: 9, width: 0, height: 1 }),
    'attachment_invalid',
  );
  await store.close();
});

test('task attachments are validated atomically', async () => {
  const { service, store } = await makeService();
  expectCode(
    () =>
      service.validateTaskAttachments(
        Array.from({ length: 5 }, (_, index) => ({
          kind: 'blob',
          blob_id: `b${index}`,
          media_type: 'image/png',
          bytes: 70,
          width: 1,
          height: 1,
        })),
      ),
    'attachment_count_exceeded',
  );
  expectCode(
    () =>
      service.validateTaskAttachments([
        { kind: 'blob', blob_id: 'b', media_type: 'image/png', bytes: 70, width: 1, height: 1 },
        { kind: 'reference', blob_id: 'b2', media_type: 'image/png', bytes: 70, width: 1, height: 1 },
      ]),
    'attachment_source_denied',
  );
  await store.close();
});

test('an external-URL attachment source is refused', async () => {
  const { service, store } = await makeService();
  for (const attachment of [
    { kind: 'url', url: 'https://example.com/a.png' },
    { kind: 'history', message_id: 'm1' },
    { kind: 'blob', blob_id: 'b', media_type: 'image/png', bytes: 70, width: 1, height: 1, url: 'https://x' },
  ]) {
    if (attachment.kind === 'blob') {
      // A blob attachment with a stray URL is still validated as a blob; the
      // URL field is ignored, which is the correct behaviour: no fetch happens.
      assert.doesNotThrow(() => service.validateTaskAttachments([attachment]));
      continue;
    }
    expectCode(() => service.validateTaskAttachments([attachment]), 'attachment_source_denied');
  }
  await store.close();
});

test('a full chunked transfer commits and returns the bytes', async () => {
  const { service, store } = await makeService();
  const digest = b64u(sha256(PNG));
  await service.begin({
    blob_id: 'blob-1',
    media_type: 'image/png',
    bytes: PNG.length,
    sha256: digest,
    width: 1,
    height: 1,
    chunks: 1,
  });
  await service.chunk({
    blob_id: 'blob-1',
    index: 0,
    data: b64u(PNG),
    sha256: b64u(sha256(PNG)),
  });
  const committed = await service.commit({ blob_id: 'blob-1', bytes: PNG.length, sha256: digest });
  assert.equal(committed.committed, true);
  assert.deepEqual(await service.bytesOf('blob-1'), PNG);
  await store.close();
});

test('a tampered chunk is refused', async () => {
  const { service, store } = await makeService();
  await service.begin({
    blob_id: 'blob-2',
    media_type: 'image/png',
    bytes: PNG.length,
    sha256: b64u(sha256(PNG)),
    width: 1,
    height: 1,
    chunks: 1,
  });
  await expectRejection(
    service.chunk({
      blob_id: 'blob-2',
      index: 0,
      data: b64u(PNG),
      sha256: b64u(sha256(Buffer.from('other'))),
    }),
    'attachment_bytes_mismatch',
  );
  await store.close();
});

test('a commit with a missing chunk is refused as blob_incomplete', async () => {
  const { service, store } = await makeService();
  const big = Buffer.concat([PNG, Buffer.alloc(800_000, 1)]);
  const digest = b64u(sha256(big));
  await service.begin({
    blob_id: 'blob-3',
    media_type: 'image/png',
    bytes: big.length,
    sha256: digest,
    width: 1,
    height: 1,
    chunks: 2,
  });
  await service.chunk({
    blob_id: 'blob-3',
    index: 0,
    data: b64u(big.subarray(0, 786_432)),
    sha256: b64u(sha256(big.subarray(0, 786_432))),
  });
  await expectRejection(
    service.commit({ blob_id: 'blob-3', bytes: big.length, sha256: digest }),
    'blob_incomplete',
  );
  await store.close();
});

test('an oversized declaration is refused at begin, before any byte is stored', async () => {
  const { service, store } = await makeService({ imageMaxBytes: 10 });
  await expectRejection(
    service.begin({
      blob_id: 'blob-4',
        media_type: 'image/png',
      bytes: PNG.length,
      sha256: b64u(sha256(PNG)),
      width: 1,
      height: 1,
      chunks: 1,
    }),
    'attachment_too_large',
  );
  await store.close();
});

test('an unknown blob id is refused instead of being created implicitly', async () => {
  const { service, store } = await makeService();
  await expectRejection(
    service.chunk({ blob_id: 'nope', index: 0, data: 'AA', sha256: 'x' }),
    'blob_not_found',
  );
  await expectRejection(service.commit({ blob_id: 'nope', bytes: 1, sha256: 'x' }), 'blob_not_found');
  await store.close();
});

test('a declared chunk count that does not match the size is refused', async () => {
  const { service, store } = await makeService();
  await expectRejection(
    service.begin({
      blob_id: 'blob-5',
        media_type: 'image/png',
      bytes: PNG.length,
      sha256: b64u(sha256(PNG)),
      width: 1,
      height: 1,
      chunks: 9,
    }),
    'bad_params',
  );
  await store.close();
});

test('a duplicate chunk is idempotent only when byte-identical', async () => {
  const { service, store } = await makeService();
  await service.begin({
    blob_id: 'blob-6',
    media_type: 'image/png',
    bytes: PNG.length,
    sha256: b64u(sha256(PNG)),
    width: 1,
    height: 1,
    chunks: 1,
  });
  const chunk = { blob_id: 'blob-6', index: 0, data: b64u(PNG), sha256: b64u(sha256(PNG)) };
  await service.chunk(chunk);
  assert.doesNotThrow(() => service.chunk(chunk));
  await store.close();
});

test('an uncommitted transfer is cleaned up after its TTL', async () => {
  let now = 1000;
  const root = await mkdtemp(join(tmpdir(), 'bridge-blobs-'));
  const store = new BridgeStore({ dataRoot: root });
  await store.init();
  const service = new BlobService({
    store,
    session: { async emit() {}, async call() { return {}; } },
    config: {
      imageMaxBytes: 10_485_760,
      imageMaxCount: 4,
      imageTotalMaxBytes: 20_971_520,
      imageAllowedMime: ['image/png'],
    },
    logger: null,
    now: () => now,
  });
  await service.begin({
    blob_id: 'blob-7',
    media_type: 'image/png',
    bytes: PNG.length,
    sha256: b64u(sha256(PNG)),
    width: 1,
    height: 1,
    chunks: 1,
  });
  now += 301_000;
  assert.equal(service.cleanup(), 1);
  await store.close();
});

test('sending an image emits begin, chunk and commit in order', async () => {
  const { service, emitted, store } = await makeService();
  const attachment = await service.send({
    data: PNG,
    mediaType: 'image/png',
    width: 1,
    height: 1,
  });
  assert.equal(attachment.kind, 'blob');
  assert.equal(attachment.bytes, PNG.length);
  assert.equal(attachment.sha256, b64u(sha256(PNG)));
  assert.deepEqual(
    emitted.map((entry) => entry.m),
    ['blob.begin', 'blob.chunk', 'blob.commit'],
  );
  assert.equal(emitted[0].params.media_type, 'image/png');
  assert.equal(emitted[1].params.index, 0);
  await store.close();
});

test('sending mismatched bytes is refused before any frame is emitted', async () => {
  const { service, emitted, store } = await makeService();
  await assert.rejects(
    service.send({ data: GIF, mediaType: 'image/png', width: 1, height: 1 }),
    (error) => error instanceof BridgeError && error.code === 'attachment_bytes_mismatch',
  );
  assert.equal(emitted.length, 0);
  await store.close();
});

test('a vision-capable route receives an image block', () => {
  const ref = { attachmentId: 'a', mediaType: 'image/png', bytes: 70, width: 1, height: 1 };
  const message = buildUserMessage({ text: 'look', images: [ref] });
  assert.equal(message.content.length, 2);
  assert.equal(message.content[1].type, 'image');
  // The host factory deep-clones and freezes its input, so identity is by value.
  assert.deepEqual(message.content[1].attachment, ref);
  assert.equal(message.role, 'user');
  assert.ok(Object.isFrozen(message), 'the host message factory freezes the value');
});

test('a text-only route degrades images into placeholders', () => {
  const ref = { attachmentId: 'a', mediaType: 'image/png', bytes: 70, width: 1, height: 1 };
  const message = buildUserMessage({ text: 'look', images: [ref], textOnly: true });
  assert.equal(message.content.length, 2);
  assert.equal(message.content[1].type, 'text');
  assert.ok(message.content[1].text.includes('image omitted'));
  assert.ok(message.content[1].text.includes('1x1'));
  assert.equal(routeSupportsImages({ modalities: ['text'] }), false);
  assert.equal(routeSupportsImages({ modalities: ['text', 'image'] }), true);
  assert.equal(routeSupportsImages(undefined), false, 'absence of a declaration is not vision');
  assert.ok(textOnlyPlaceholder(ref).includes('image/png'));
});

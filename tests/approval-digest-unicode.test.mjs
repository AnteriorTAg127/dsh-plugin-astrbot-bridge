/**
 * Regression suite for `approvalRequestDigest` with non-ASCII reasons (§12.2).
 *
 * The approval `reason` is free-form asker text and is Chinese in practice. The
 * digest therefore has to be computed with the `jcs_frame` canonicaliser — the
 * same one the A side uses in `bridge/crypto.py: request_digest()` — because
 * `jcs_ascii` rejects both non-ASCII values and the `null` optional ids.
 *
 * Expected digests below are **not** invented: each was produced by the real
 * A-side module and independently reproduced from the canonical projection
 * bytes here. They are pinned so the test stays offline and deterministic:
 *
 * ```bash
 * cd data/plugins/astrbot_plugin_dsh_bridge && python3 -c "
 * import sys; sys.path.insert(0, '.')
 * from bridge.crypto import request_digest
 * print(request_digest({'tool': 'bash', 'reason': '请批准提升沙箱',
 *                       'call_id': None, 'session_id': None, 'task_id': None}))"
 * ```
 * @module dsh-plugin-astrbot-bridge/tests/approval-digest-unicode
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { approvalRequestDigest, b64u, sha256 } from '../lib/crypto.js';

/** 43-char unpadded base64url of a 32-byte SHA-256 digest. */
const DIGEST_RE = /^[A-Za-z0-9_-]{43}$/;

/**
 * Recompute the digest from the projection text without using the module's
 * canonicaliser, so the assertion pins the wire bytes as well as the hash.
 * @param {Record<string, string|null>} projection - five-field projection.
 * @returns {string} base64url digest.
 */
function digestOfProjection(projection) {
  return b64u(sha256(Buffer.from(JSON.stringify(projection), 'utf8')));
}

test('Chinese reason with null ids matches the A-side request_digest', () => {
  // Exactly the shape issued by the host approval flow: no call/session/task id.
  const digest = approvalRequestDigest({
    tool: 'bash',
    reason: '请批准提升沙箱',
    callId: null,
    sessionId: null,
    taskId: null,
  });
  assert.equal(digest, 'zpZjERL9pirsgrK4fsc2ghhz9GA9Cr9ozVMKMUrw3IU');
  assert.match(digest, DIGEST_RE);
});

test('digest covers the canonical projection bytes, nulls included', () => {
  assert.equal(
    digestOfProjection({
      call_id: null,
      reason: '请批准提升沙箱',
      session_id: null,
      task_id: null,
      tool: 'bash',
    }),
    'zpZjERL9pirsgrK4fsc2ghhz9GA9Cr9ozVMKMUrw3IU',
  );
});

test('multilingual reason and ids hash without a fatal encoding error', () => {
  const digest = approvalRequestDigest({
    tool: 'fs_write',
    reason: 'Write 单元测试 for 函数 — naïve café ✅ テスト',
    callId: 'call-中-1',
    sessionId: 'sid-中文',
    taskId: 'task-😀',
  });
  assert.equal(digest, 'gfiyfHzuTMQm7CNXTNsxKEg0tzz0EL0qiFQ8qOq2Ye8');
  assert.match(digest, DIGEST_RE);
});

test('mixed non-ASCII reasons keep one field-sensitive digest', () => {
  const input = {
    tool: 'deploy',
    reason: '需要审批 🚀 – Ünïcödé',
    callId: null,
    sessionId: 's-1',
    taskId: null,
  };
  assert.equal(approvalRequestDigest(input), 'RMFBpLCy2R49YLFYGvR4QbboAtpMDLxOHzBRPzT9q68');
  assert.notEqual(
    approvalRequestDigest({ ...input, taskId: 't-1' }),
    approvalRequestDigest(input),
  );
});

test('ASCII vectors keep their pre-existing digests', () => {
  // Same input as `vectors.test.mjs` vector 17, plus a null `call_id` variant.
  assert.equal(
    approvalRequestDigest({
      tool: 'bash',
      reason: 'run tests',
      callId: 'call-1',
      sessionId: 'sid-1',
      taskId: 'task-1',
    }),
    '0i8CQk6qvx_ypxwz6GpwV5qdS3YL9SWsa61X0wZkepY',
  );
  assert.equal(
    approvalRequestDigest({
      tool: 'bash',
      reason: 'run tests',
      callId: null,
      sessionId: 'sid-1',
      taskId: 'task-1',
    }),
    'qVknPeYlhDOY5E-PwYf3Z-XdsVaI7pdGbXs1O8nwSYg',
  );
});

test('absent and empty optional text still hash the five-field projection', () => {
  assert.equal(
    approvalRequestDigest({
      tool: 'bash',
      reason: null,
      callId: null,
      sessionId: null,
      taskId: null,
    }),
    '9PRRA2aAyroWGWD37_KCL67Lih4gFiZjpeE8dXMipas',
  );
  assert.equal(
    digestOfProjection({
      call_id: null,
      reason: '',
      session_id: null,
      task_id: null,
      tool: 'bash',
    }),
    approvalRequestDigest({
      tool: 'bash',
      reason: '',
      callId: null,
      sessionId: null,
      taskId: null,
    }),
  );
  assert.equal(
    approvalRequestDigest({
      tool: 'bash',
      reason: '',
      callId: null,
      sessionId: null,
      taskId: null,
    }),
    'v8tbCAua0QRoxsBgJEBNae7Q3-sBFF3hzrSf2i3u0qg',
  );
});

test('escaped control characters and quotes stay canonical', () => {
  const digest = approvalRequestDigest({
    tool: 'fs_write',
    reason: '第一行\n第二行 "quoted" \\ tab\t',
    callId: 'c1',
    sessionId: null,
    taskId: 't1',
  });
  assert.equal(digest, 'aONJL8lXpJZjf_bP_X8m4MVwDEVJgFmd1oZ-ajnHHVc');
  assert.notEqual(
    digest,
    approvalRequestDigest({
      tool: 'fs_write',
      reason: '第一行\n第二行 "quoted" \\ tab\t ',
      callId: 'c1',
      sessionId: null,
      taskId: 't1',
    }),
  );
});

test('snake_case aliases address the same projection as camelCase', () => {
  const camel = approvalRequestDigest({
    tool: 'bash',
    reason: '请批准提升沙箱',
    callId: null,
    sessionId: null,
    taskId: null,
  });
  assert.equal(
    approvalRequestDigest({
      toolName: 'bash',
      reason: '请批准提升沙箱',
      call_id: null,
      session_id: null,
      task_id: null,
    }),
    camel,
  );
  assert.match(camel, DIGEST_RE);
});

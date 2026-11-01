/**
 * `approval.lookup` evidence contract (§12.7/§12.8), both roles.
 *
 * The authority side is a real `ApprovalService` with its own store; the
 * receiving side is a second instance whose `session.call` is wired to the
 * authority's `lookup`, exactly as `lib/index.js` wires the live session. The
 * gate is opened through `requestOutboundApproval` (the same production path the
 * tools use), not written into the approvals table by hand.
 * @module dsh-plugin-astrbot-bridge/tests/approval-lookup
 */

import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ApprovalService } from '../lib/app/approvals.js';
import { BridgeError } from '../lib/errors.js';
import { BridgeStore } from '../lib/store.js';

const CONN = 'default';
const SID = '22222222-2222-4222-8222-222222222222';
const TASK = '44444444-4444-4444-8444-444444444444';

/**
 * Build one service with its own store and a stub session.
 * @param {string} root - data root.
 * @param {object} [options] - options.
 * @returns {Promise<object>} fixture.
 */
async function makeSide(root, options = {}) {
  const store = new BridgeStore({ dataRoot: root });
  await store.init();
  /** @type {object[]} */
  const calls = [];
  const session = {
    state: 'ready',
    sid: SID,
    connId: CONN,
    peerSide: 'B',
    // The handshake capability is what authorizes the outbound lookup; an
    // unadvertised feature is a refusal, so the fixture must declare it.
    peerCaps: { side: 'B', features: ['approval.lookup'] },
    async call(message, params) {
      calls.push({ message, params });
      return { approval_id: params?.approval_id, accepted: true };
    },
  };
  let now = Date.now();
  const service = new ApprovalService({
    store,
    session,
    host: {},
    notify: { async emit() { return ''; } },
    config: { approvalTimeoutSeconds: 1800 },
    logger: null,
    now: () => now,
  });
  service.onSessionReady(CONN, SID);
  return { store, service, session, calls, advance: (ms) => { now += ms; } };
}

/** A complete submission parameter set. */
function submitParams(overrides = {}) {
  const taskId = overrides.task_id ?? TASK;
  return {
    task_id: taskId,
    root_task_id: taskId,
    kind: 'astr_agent_run',
    origin: 'llm',
    input_parts: [{ type: 'text', text: 'review the patch' }],
    attachments: [],
    tool_hints: [],
    session_id: null,
    purpose: 'review',
    timeout_s: 300,
    meta: {},
    approval_ref: null,
    ...overrides,
  };
}

/** Build the wire reference from an authoritative row. */
function refFor(service, record, params) {
  return {
    approval_id: record.approval_id,
    submit_digest: service.submitDigestOf(params),
    actor: record.decision?.actor ?? null,
    actor_kind: 'human',
    decided_at: record.decision?.decided_at ?? null,
    expires_at: record.expires_at,
  };
}

/**
 * Create and release a real outbound gate on the authority side.
 * @param {object} authority - fixture.
 * @param {object} params - approved submission.
 * @returns {Promise<object>} the released record.
 */
async function openGate(authority, params) {
  const record = await authority.service.requestOutboundApproval({
    task: { task_id: params.task_id, root_task_id: params.root_task_id, session_id: null },
    tool: params.kind,
    reason: 'cross-end task submission',
    displayReason: { en: 'Run', zh: '执行' },
    submitDigest: authority.service.submitDigestOf(params),
  });
  const applied = await authority.service.decide(record.approval_id, {
    outcome: 'allowed-once',
    actor: 'astrbot_admin:alice',
    actor_kind: 'human',
    channel: 'web',
  });
  assert.equal(applied.applied, true);
  await authority.store.putApproval({
    ...(await authority.store.getApproval(record.approval_id)),
    released_by_task: params.task_id,
  });
  return (await authority.store.getApproval(record.approval_id));
}

/**
 * Wire a receiving side to a real authority lookup.
 * @param {object} receiver - receiver fixture.
 * @param {object} authority - authority fixture.
 * @param {Function} [beforeReturn] - hook executed before the answer is returned.
 * @returns {void}
 */
function wire(receiver, authority, beforeReturn = null) {
  receiver.session.call = async (message, params) => {
    assert.equal(message, 'approval.lookup');
    if (beforeReturn !== null) beforeReturn();
    return authority.service.lookup(params);
  };
}

test('a legal reference is proven, mirrored and consumed once', async () => {
  const authority = await makeSide(await mkdtemp(join(tmpdir(), 'bridge-lookup-a-')));
  const receiver = await makeSide(await mkdtemp(join(tmpdir(), 'bridge-lookup-b-')));
  receiver.session.peerSide = 'B';
  wire(receiver, authority);
  const params = submitParams();
  const record = await openGate(authority, params);
  params.approval_ref = refFor(authority.service, record, params);
  const evidence = await receiver.service.lookupEvidence(params);
  assert.equal(evidence.source, 'peer_lookup');
  assert.equal(evidence.approval_id, record.approval_id);
  assert.equal(evidence.submit_digest, authority.service.submitDigestOf(params));
  assert.equal(evidence.conn, `${CONN}|${SID}`);
  assert.equal(evidence.released_by_task, params.task_id);
  assert.equal(evidence.consumed_by_task, null);
  assert.equal(await receiver.store.getApproval(record.approval_id) !== null, true);
  await receiver.store.close();
  await authority.store.close();
});

test('a receiver without a live lookup hook fails closed', async () => {
  const authority = await makeSide(await mkdtemp(join(tmpdir(), 'bridge-lookup-a-')));
  const receiver = await makeSide(await mkdtemp(join(tmpdir(), 'bridge-lookup-b-')));
  receiver.session.state = 'closed';
  const params = submitParams();
  const record = await openGate(authority, params);
  params.approval_ref = refFor(authority.service, record, params);
  await assert.rejects(
    receiver.service.lookupEvidence(params),
    (error) => error instanceof BridgeError && error.code === 'approval_lookup_failed',
  );
  await receiver.store.close();
  await authority.store.close();
});

test('an old authority row without session evidence is refused', async () => {
  const authority = await makeSide(await mkdtemp(join(tmpdir(), 'bridge-lookup-a-')));
  const receiver = await makeSide(await mkdtemp(join(tmpdir(), 'bridge-lookup-b-')));
  wire(receiver, authority);
  const params = submitParams();
  const record = await openGate(authority, params);
  await authority.store.putApproval({ ...record, conn: null });
  params.approval_ref = refFor(authority.service, record, params);
  await assert.rejects(
    receiver.service.lookupEvidence(params),
    (error) => error instanceof BridgeError && error.code === 'approval_evidence_missing',
  );
  await receiver.store.close();
  await authority.store.close();
});

test('a sid change during the query discards the answer', async () => {
  const authority = await makeSide(await mkdtemp(join(tmpdir(), 'bridge-lookup-a-')));
  const receiver = await makeSide(await mkdtemp(join(tmpdir(), 'bridge-lookup-b-')));
  wire(receiver, authority, () => receiver.service.onSessionReady(CONN, '33333333-3333-4333-8333-333333333333'));
  const params = submitParams();
  const record = await openGate(authority, params);
  params.approval_ref = refFor(authority.service, record, params);
  await assert.rejects(
    receiver.service.lookupEvidence(params),
    (error) => error instanceof BridgeError && error.code === 'approval_lookup_failed',
  );
  assert.equal(await receiver.store.getApproval(record.approval_id), null);
  await receiver.store.close();
  await authority.store.close();
});

test('released for another task and wrong content are refused', async () => {
  const authority = await makeSide(await mkdtemp(join(tmpdir(), 'bridge-lookup-a-')));
  const receiver = await makeSide(await mkdtemp(join(tmpdir(), 'bridge-lookup-b-')));
  wire(receiver, authority);
  const params = submitParams();
  const record = await openGate(authority, params);

  const other = submitParams({ task_id: '99999999-9999-4999-8999-999999999999' });
  other.approval_ref = refFor(authority.service, record, other);
  await assert.rejects(
    receiver.service.lookupEvidence(other),
    (error) => error instanceof BridgeError && error.code === 'approval_lookup_failed',
  );

  const tampered = submitParams({ input_parts: [{ type: 'text', text: 'something else' }] });
  tampered.approval_ref = refFor(authority.service, record, tampered);
  await assert.rejects(
    receiver.service.lookupEvidence(tampered),
    (error) => error instanceof BridgeError && error.code === 'approval_lookup_failed',
  );
  await receiver.store.close();
  await authority.store.close();
});

test('an expired authority row is refused even if the ref claims a future', async () => {
  const authority = await makeSide(await mkdtemp(join(tmpdir(), 'bridge-lookup-a-')));
  const receiver = await makeSide(await mkdtemp(join(tmpdir(), 'bridge-lookup-b-')));
  wire(receiver, authority);
  const params = submitParams();
  const record = await openGate(authority, params);
  await authority.store.putApproval({ ...record, expires_at: new Date(Date.now() - 1000).toISOString() });
  params.approval_ref = refFor(authority.service, record, params);
  await assert.rejects(
    receiver.service.lookupEvidence(params),
    (error) => error instanceof BridgeError && error.code === 'approval_lookup_failed',
  );
  await receiver.store.close();
  await authority.store.close();
});

test('the mirror and its consumption survive a store reopen', async () => {
  const rootA = await mkdtemp(join(tmpdir(), 'bridge-lookup-a-'));
  const rootB = await mkdtemp(join(tmpdir(), 'bridge-lookup-b-'));
  const authority = await makeSide(rootA);
  let receiver = await makeSide(rootB);
  wire(receiver, authority);
  const params = submitParams();
  const record = await openGate(authority, params);
  params.approval_ref = refFor(authority.service, record, params);
  const evidence = await receiver.service.lookupEvidence(params);
  await receiver.store.putApproval({
    ...(await receiver.store.getApproval(evidence.approval_id)),
    consumed_by_task: params.task_id,
    consumed_at: new Date().toISOString(),
  });
  await receiver.store.close();
  receiver = await makeSide(rootB);
  const row = await receiver.store.getApproval(evidence.approval_id);
  assert.notEqual(row, null);
  assert.equal(row.source, 'peer_lookup');
  assert.equal(row.consumed_by_task, params.task_id);
  assert.equal(row.evidence.submit_digest, authority.service.submitDigestOf(params));
  await receiver.store.close();
  await authority.store.close();
});

test('an unadvertised lookup capability fails closed', async () => {
  const authority = await makeSide(await mkdtemp(join(tmpdir(), 'bridge-lookup-a-')));
  const receiver = await makeSide(await mkdtemp(join(tmpdir(), 'bridge-lookup-b-')));
  receiver.session.peerCaps = { side: 'B', features: [] };
  wire(receiver, authority);
  const params = submitParams();
  const record = await openGate(authority, params);
  params.approval_ref = refFor(authority.service, record, params);
  await assert.rejects(
    receiver.service.lookupEvidence(params),
    (error) => error instanceof BridgeError && error.code === 'approval_lookup_failed',
  );
  assert.equal(await receiver.store.getApproval(record.approval_id), null);
  await receiver.store.close();
  await authority.store.close();
});

test('a peer side change during the query discards the answer', async () => {
  const authority = await makeSide(await mkdtemp(join(tmpdir(), 'bridge-lookup-a-')));
  const receiver = await makeSide(await mkdtemp(join(tmpdir(), 'bridge-lookup-b-')));
  wire(receiver, authority, () => {
    receiver.session.peerCaps = { side: 'A', features: ['approval.lookup'] };
  });
  const params = submitParams();
  const record = await openGate(authority, params);
  params.approval_ref = refFor(authority.service, record, params);
  await assert.rejects(
    receiver.service.lookupEvidence(params),
    (error) => error instanceof BridgeError && error.code === 'approval_lookup_failed',
  );
  assert.equal(await receiver.store.getApproval(record.approval_id), null);
  await receiver.store.close();
  await authority.store.close();
});

test('mirror re-import preserves consumption and refuses conflicting evidence', async () => {
  const authority = await makeSide(await mkdtemp(join(tmpdir(), 'bridge-lookup-a-')));
  const receiver = await makeSide(await mkdtemp(join(tmpdir(), 'bridge-lookup-b-')));
  wire(receiver, authority);
  const params = submitParams();
  const record = await openGate(authority, params);
  params.approval_ref = refFor(authority.service, record, params);
  const evidence = await receiver.service.lookupEvidence(params);
  assert.equal(await receiver.store.claimApprovalConsumption(evidence.approval_id, params.task_id), true);
  const row = await receiver.store.getApproval(evidence.approval_id);
  const refreshed = await receiver.store.importApprovalMirror({
    ...row,
    expires_at: new Date(Date.now() + 120_000).toISOString(),
  });
  assert.notEqual(refreshed, null);
  assert.equal(refreshed.consumed_by_task, params.task_id);
  assert.equal(
    await receiver.store.importApprovalMirror({ ...row, submit_digest: 'different' }),
    null,
  );
  assert.equal(
    await receiver.store.importApprovalMirror({ ...row, decision: { ...row.decision, decided_at: 'not-a-date' } }),
    null,
  );
  await receiver.store.close();
  await authority.store.close();
});

test('a concurrent gate release is claimed exactly once', async () => {
  const authority = await makeSide(await mkdtemp(join(tmpdir(), 'bridge-lookup-a-')));
  const params = submitParams();
  const record = await authority.service.requestOutboundApproval({
    task: { task_id: params.task_id, root_task_id: params.root_task_id, session_id: null },
    tool: params.kind,
    reason: 'cross-end task submission',
    submitDigest: authority.service.submitDigestOf(params),
  });
  // The store serializes the read-check-write, so exactly one caller may write
  // `released_by_task`; the loser must not send a second submission.
  const results = await Promise.all([
    authority.store.claimApprovalRelease(record.approval_id, params.task_id),
    authority.store.claimApprovalRelease(record.approval_id, 'other-task'),
  ]);
  assert.equal(results.filter((value) => value === true).length, 1);
  const row = await authority.store.getApproval(record.approval_id);
  assert.ok([params.task_id, 'other-task'].includes(row.released_by_task));
  assert.equal(await authority.store.claimApprovalRelease(record.approval_id, params.task_id), false);
  await authority.store.close();
});

test('a gate release is claimed exactly once', async () => {
  const authority = await makeSide(await mkdtemp(join(tmpdir(), 'bridge-lookup-a-')));
  const params = submitParams();
  const record = await openGate(authority, params);
  await authority.store.claimApprovalConsumption(record.approval_id, params.task_id);
  const row = await authority.store.getApproval(record.approval_id);
  assert.equal(row.released_by_task, params.task_id);
  assert.equal(
    await authority.store.claimApprovalRelease(record.approval_id, 'other-task'),
    false,
  );
  await authority.store.close();
});

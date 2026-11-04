/**
 * Cross-end authorization fixture contract tests (protocol §9.7, v0.2 R1).
 *
 * `tests/fixtures/session_authz_v02.json` is copied byte-for-byte from A's
 * `tests/fixtures/`, so this suite drives the shape A actually emits instead of
 * a hand-built approximation. The earlier authority-instance tests constructed
 * `instance_started_at` themselves; a producer that stopped sending it would
 * still have left them green, so the upgrade path is pinned here against the
 * real snapshot.
 *
 * Every case runs a real {@link BridgeStore} and, for the cache case, a real
 * {@link ApprovalService} over a temporary data root. The only injected clock
 * places `now` just before the fixture's earliest grant deadline so a date that
 * has passed since the fixture was authored cannot turn a standing grant into
 * an expired one; no behavior under test is mocked.
 * @module dsh-plugin-astrbot-bridge/tests/session-authz-fixture
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ApprovalService } from '../lib/app/approvals.js';
import { BridgeStore } from '../lib/store.js';

const fixtureUrl = new URL('./fixtures/session_authz_v02.json', import.meta.url);

/** Top-level keys the cross-end snapshot contract must carry. */
const TOP_LEVEL_KEYS = [
  'allow_agent_create',
  'grants',
  'instance_id',
  'instance_started_at',
  'max_agent_sessions',
  'revoked',
  'version',
];

/** Keys every grant entry must carry. */
const GRANT_KEYS = [
  'created_by_task',
  'expires_at',
  'granted_by',
  'granted_by_id',
  'purpose',
  'session_id',
];

/** Silent logger satisfying the store/service logger surface. */
const silentLogger = {
  info() {},
  warn() {},
  failure() {},
  debug() {},
  error() {},
};

/**
 * Read and parse the replicated cross-end fixture.
 * @returns {Promise<Record<string, any>>} parsed snapshot.
 */
async function readFixture() {
  return JSON.parse(await readFile(fixtureUrl, 'utf8'));
}

/**
 * Open a store on a fresh temporary directory.
 * @param {object} [logger] - logger stub.
 * @returns {Promise<BridgeStore>} initialized store.
 */
async function freshStore(logger = silentLogger) {
  const root = await mkdtemp(join(tmpdir(), 'bridge-authz-fixture-'));
  const store = new BridgeStore({ dataRoot: root, logger });
  await store.init();
  return store;
}

/**
 * Build one grant entry with every contract field present.
 * @param {string} sessionId - session identity.
 * @param {Record<string, unknown>} [overrides] - fields to replace.
 * @returns {Record<string, unknown>} grant entry.
 */
function grantRecord(sessionId, overrides = {}) {
  return {
    session_id: sessionId,
    purpose: 'contract',
    granted_by: 'human',
    granted_by_id: 'dashboard',
    expires_at: null,
    created_by_task: null,
    ...overrides,
  };
}

/**
 * Grants a snapshot actually authorizes: fixture grants minus revoked ids.
 * @param {Record<string, any>} fixture - parsed fixture.
 * @returns {Record<string, unknown>[]} effective grants.
 */
function effectiveGrants(fixture) {
  const revoked = new Set(fixture.revoked.map(String));
  return fixture.grants.filter((grant) => !revoked.has(String(grant.session_id)));
}

/**
 * Build the snapshot of a strictly older authority instance.
 * @param {Record<string, any>} fixture - current authority snapshot.
 * @returns {Record<string, unknown>} older-instance snapshot.
 */
function olderSnapshot(fixture) {
  return {
    instance_id: randomUUID(),
    instance_started_at: fixture.instance_started_at - 1000,
    version: fixture.version + 99,
    grants: [grantRecord(randomUUID())],
    revoked: [],
    allow_agent_create: false,
    max_agent_sessions: 1,
  };
}

/**
 * Build an approval service over the real store with a fixed clock.
 * @param {BridgeStore} store - initialized store.
 * @param {number} nowMs - clock value returned by `now()`.
 * @returns {ApprovalService} service.
 */
function approvalService(store, nowMs) {
  return new ApprovalService({
    store,
    session: {},
    host: {},
    notify: {},
    config: { approvalTimeoutSeconds: 1800 },
    logger: silentLogger,
    now: () => nowMs,
  });
}

test('the cross-end authorization fixture keeps the v0.2 shape', async () => {
  const fixture = await readFixture();

  assert.ok(fixture !== null && typeof fixture === 'object' && !Array.isArray(fixture));
  assert.deepEqual(Object.keys(fixture).sort(), TOP_LEVEL_KEYS);
  assert.equal(typeof fixture.instance_id, 'string');
  assert.ok(fixture.instance_id.trim().length > 0, 'instance_id is a non-empty string');
  assert.ok(Number.isInteger(fixture.instance_started_at));
  assert.ok(fixture.instance_started_at >= 0, 'instance_started_at is a non-negative integer');
  assert.ok(Number.isInteger(fixture.version), 'version is an integer');

  assert.ok(Array.isArray(fixture.grants), 'grants is an array');
  for (const grant of fixture.grants) {
    assert.ok(grant !== null && typeof grant === 'object' && !Array.isArray(grant));
    for (const key of GRANT_KEYS) {
      assert.ok(Object.hasOwn(grant, key), `grant carries ${key}`);
    }
    assert.equal(typeof grant.session_id, 'string');
    assert.ok(grant.session_id.length > 0, 'grant session_id is non-empty');
    assert.equal(typeof grant.purpose, 'string');
    assert.equal(typeof grant.granted_by, 'string');
    assert.equal(typeof grant.granted_by_id, 'string');
    assert.ok(
      grant.expires_at === null ||
        (typeof grant.expires_at === 'string' && Number.isFinite(Date.parse(grant.expires_at))),
      'expires_at is null or a parseable timestamp',
    );
    assert.ok(
      grant.created_by_task === null || typeof grant.created_by_task === 'string',
      'created_by_task is null or a task id',
    );
  }

  assert.ok(Array.isArray(fixture.revoked), 'revoked is an array');
  for (const sessionId of fixture.revoked) {
    assert.equal(typeof sessionId, 'string');
    assert.ok(sessionId.length > 0, 'revoked entries are non-empty session ids');
  }

  assert.equal(typeof fixture.allow_agent_create, 'boolean');
  assert.ok(Number.isInteger(fixture.max_agent_sessions));
  assert.ok(fixture.max_agent_sessions >= 0, 'max_agent_sessions is a non-negative integer');
});

test('a v0.1 cache accepts the real fixture snapshot (upgrade path)', async () => {
  const fixture = await readFixture();
  const expected = effectiveGrants(fixture);
  const store = await freshStore();
  try {
    assert.deepEqual(
      await store.authzSnapshot(),
      {
        version: 0,
        instance_id: null,
        instance_started_at: null,
        grants: [],
        allow_agent_create: false,
        max_agent_sessions: 0,
      },
      'the store starts with no authorization record',
    );

    const result = await store.applyAuthz(fixture);
    assert.equal(result.applied, true, 'a complete identity is accepted by an empty cache');

    const snapshot = await store.authzSnapshot();
    assert.equal(snapshot.instance_id, fixture.instance_id);
    assert.equal(snapshot.instance_started_at, fixture.instance_started_at);
    assert.equal(snapshot.version, fixture.version);
    assert.equal(snapshot.allow_agent_create, fixture.allow_agent_create);
    assert.equal(snapshot.max_agent_sessions, fixture.max_agent_sessions);
    assert.deepEqual(snapshot.grants, expected);
    assert.equal(
      snapshot.grants.length,
      expected.length,
      'the fixture grants minus revoked grants reach the table',
    );
  } finally {
    await store.close();
  }
});

test('the fixture snapshot refuses an older authority instance after upgrade', async () => {
  const fixture = await readFixture();
  const store = await freshStore();
  try {
    await store.applyAuthz(fixture);
    const applied = await store.authzSnapshot();

    const replay = olderSnapshot(fixture);
    const result = await store.applyAuthz(replay);
    assert.equal(result.applied, false, 'an older instance with a higher version is refused');
    assert.deepEqual(await store.authzSnapshot(), applied, 'the fixture table is left untouched');
  } finally {
    await store.close();
  }
});

test('the fixture authority advances its version on the same instance', async () => {
  const fixture = await readFixture();
  const store = await freshStore();
  try {
    await store.applyAuthz(fixture);
    const next = grantRecord(randomUUID(), { purpose: 'contract-progress' });

    const result = await store.applyAuthz({
      instance_id: fixture.instance_id,
      instance_started_at: fixture.instance_started_at,
      version: fixture.version + 1,
      grants: [...fixture.grants, next],
      revoked: fixture.revoked,
      allow_agent_create: fixture.allow_agent_create,
      max_agent_sessions: fixture.max_agent_sessions,
    });
    assert.equal(result.applied, true, 'a strictly higher version of the same instance applies');

    const snapshot = await store.authzSnapshot();
    assert.equal(snapshot.version, fixture.version + 1);
    assert.equal(snapshot.instance_id, fixture.instance_id);
    assert.equal(snapshot.instance_started_at, fixture.instance_started_at);
    assert.deepEqual(snapshot.grants, [...effectiveGrants(fixture), next]);
    assert.equal(await store.isAuthorized(next.session_id), true);
  } finally {
    await store.close();
  }
});

test('the approval cache follows the fixture and ignores an older instance replay', async () => {
  const fixture = await readFixture();
  const grants = effectiveGrants(fixture);
  assert.ok(grants.length > 0, 'the fixture has an effective grant to cache');
  const sessionId = String(grants[0].session_id);

  // The fixture was authored with a fixed expiry; keep the clock just before
  // the earliest deadline so the standing grant is judged by its expiry field
  // rather than by the date this test happens to run.
  const deadlines = grants
    .map((grant) => (grant.expires_at === null ? null : Date.parse(String(grant.expires_at))))
    .filter((value) => Number.isFinite(value));
  const nowMs = deadlines.length === 0 ? Date.now() : Math.min(...deadlines) - 1000;

  const store = await freshStore();
  try {
    await store.applyAuthz(fixture);
    const service = approvalService(store, nowMs);
    await service.syncAuthz();

    assert.equal(service._isAuthorizedSync(sessionId), true, 'the fixture grant reaches the claim cache');
    assert.equal(service._authzVersion, fixture.version);
    assert.equal(service._authzInstanceId, fixture.instance_id);
    assert.equal(service._authzInstanceStartedAt, fixture.instance_started_at);

    const replay = olderSnapshot(fixture);
    const result = await store.applyAuthz(replay);
    assert.equal(result.applied, false, 'the older instance push is refused by the store');

    await service.syncAuthz();
    assert.equal(service._isAuthorizedSync(sessionId), true, 'the cached fixture grant is unchanged');
    assert.equal(
      service._isAuthorizedSync(String(replay.grants[0].session_id)),
      false,
      'the replayed grant never enters the cache',
    );
    assert.equal(service._authzVersion, fixture.version);
    assert.equal(service._authzInstanceId, fixture.instance_id);
    assert.equal(service._authzInstanceStartedAt, fixture.instance_started_at);
  } finally {
    await store.close();
  }
});

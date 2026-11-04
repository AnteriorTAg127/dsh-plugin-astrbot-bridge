/**
 * Authorization authority-instance tests (protocol §9.7, v0.2 R1).
 *
 * A's authorization `version` is monotonic *within one authority instance*.
 * Recreating A's database restarts the version at 0, so a corrected snapshot can
 * be lower than the stale one cached here. These tests pin the acceptance rules:
 * the instance identity plus `instance_started_at` decide whether a version drop
 * is a rebuild (apply) or an older snapshot being replayed (reject, never roll
 * the table back).
 *
 * Every test drives a real {@link BridgeStore} (and, for approval claims, the
 * real {@link ApprovalService}) over a temporary data root; no part of the
 * behavior under test is mocked. The one injected delay in the concurrency test
 * slows a store read so the lost-update interleaving is deterministic; it does
 * not replace any logic under test.
 * @module dsh-plugin-astrbot-bridge/tests/authz-instance
 */

import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ApprovalService } from '../lib/app/approvals.js';
import { BridgeStore } from '../lib/store.js';

/** Silent logger satisfying the store/service logger surface. */
const silentLogger = {
  info() {},
  warn() {},
  failure() {},
  debug() {},
  error() {},
};

/**
 * Build a logger that records every warning event name.
 * @returns {{events: string[], logger: object}} recording logger.
 */
function recordingLogger() {
  const events = [];
  const logger = {
    info() {},
    warn(event) {
      events.push(event);
    },
    failure() {},
    debug() {},
    error() {},
  };
  return { events, logger };
}

/**
 * Open a store on a fresh temporary directory.
 * @param {object} [logger] - logger stub.
 * @returns {Promise<{store: BridgeStore, root: string}>} store fixture.
 */
async function freshStore(logger = silentLogger) {
  const root = await mkdtemp(join(tmpdir(), 'bridge-authz-instance-'));
  const store = new BridgeStore({ dataRoot: root, logger });
  await store.init();
  return { store, root };
}

/**
 * Build one grant for a session.
 * @param {string} sessionId - session identity.
 * @returns {object} grant record.
 */
function grant(sessionId) {
  return { session_id: sessionId };
}

/**
 * Build an approval service over a real store; only the cache is exercised.
 * @param {BridgeStore} store - initialized store.
 * @returns {ApprovalService} service.
 */
function approvalService(store) {
  return new ApprovalService({
    store,
    session: {},
    host: {},
    notify: {},
    config: { approvalTimeoutSeconds: 1800 },
    logger: silentLogger,
    now: () => Date.now(),
  });
}

test('a store with no authorization record reports no authority instance', async () => {
  const { store } = await freshStore();
  assert.deepEqual(await store.authzSnapshot(), {
    version: 0,
    instance_id: null,
    instance_started_at: null,
    grants: [],
    allow_agent_create: false,
    max_agent_sessions: 0,
  });
  await store.close();
});

test('the same instance stays version-monotonic', async () => {
  const { store } = await freshStore();
  assert.equal(
    (
      await store.applyAuthz({
        version: 1,
        instance_id: 'inst-A',
        instance_started_at: 1000,
        grants: [grant('s1')],
      })
    ).applied,
    true,
  );
  assert.equal(
    (
      await store.applyAuthz({
        version: 1,
        instance_id: 'inst-A',
        instance_started_at: 1000,
        grants: [grant('s2')],
      })
    ).applied,
    false,
    'an equal version from the same instance does not replace the table',
  );
  assert.equal(
    (
      await store.applyAuthz({
        version: 0,
        instance_id: 'inst-A',
        instance_started_at: 1000,
        grants: [],
      })
    ).applied,
    false,
    'a lower version from the same instance never replaces the table',
  );
  const snapshot = await store.authzSnapshot();
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.instance_id, 'inst-A');
  assert.equal(snapshot.instance_started_at, 1000);
  assert.deepEqual(snapshot.grants, [grant('s1')]);

  assert.equal(
    (
      await store.applyAuthz({
        version: 2,
        instance_id: 'inst-A',
        instance_started_at: 1000,
        grants: [grant('s2')],
      })
    ).applied,
    true,
    'a strictly higher version from the same instance applies',
  );
  const updated = await store.authzSnapshot();
  assert.equal(updated.version, 2);
  assert.equal(updated.instance_id, 'inst-A');
  assert.equal(updated.instance_started_at, 1000);
  assert.deepEqual(updated.grants, [grant('s2')]);
  await store.close();
});

test('a different instance replaces the table even when its version is lower', async () => {
  const { store, root } = await freshStore();
  await store.applyAuthz({
    version: 5,
    instance_id: 'inst-A',
    instance_started_at: 1000,
    grants: [grant('old-1'), grant('old-2')],
    allow_agent_create: true,
    max_agent_sessions: 7,
  });

  const result = await store.applyAuthz({
    version: 1,
    instance_id: 'inst-B',
    instance_started_at: 2000,
    grants: [{ session_id: 'new-1', purpose: 'code-review' }],
    allow_agent_create: false,
    max_agent_sessions: 2,
  });
  assert.equal(result.applied, true, 'a rebuilt authority with a later start is accepted');

  const snapshot = await store.authzSnapshot();
  assert.deepEqual(snapshot, {
    version: 1,
    instance_id: 'inst-B',
    instance_started_at: 2000,
    grants: [{ session_id: 'new-1', purpose: 'code-review' }],
    allow_agent_create: false,
    max_agent_sessions: 2,
  });
  assert.equal(await store.isAuthorized('old-1'), false);
  assert.equal(await store.isAuthorized('old-2'), false);
  assert.equal(await store.isAuthorized('new-1'), true);
  await store.close();

  const reopened = new BridgeStore({ dataRoot: root, logger: silentLogger });
  await reopened.init();
  const persisted = await reopened.authzSnapshot();
  assert.equal(persisted.version, 1);
  assert.equal(persisted.instance_id, 'inst-B');
  assert.equal(persisted.instance_started_at, 2000);
  assert.deepEqual(persisted.grants, [{ session_id: 'new-1', purpose: 'code-review' }]);
  await reopened.close();
});

test('an older instance snapshot cannot roll the table back (T-05)', async () => {
  const { events, logger } = recordingLogger();
  const { store, root } = await freshStore(logger);
  await store.applyAuthz({
    version: 1,
    instance_id: 'inst-B',
    instance_started_at: 2000,
    grants: [grant('new')],
  });

  // A replayed frame from the previous authority: a much higher version, but an
  // earlier start. Version comparison alone would downgrade the table.
  const replay = await store.applyAuthz({
    version: 9,
    instance_id: 'inst-A',
    instance_started_at: 1000,
    grants: [grant('old')],
  });
  assert.equal(replay.applied, false, 'an older instance is refused');
  assert.deepEqual(await store.authzSnapshot(), {
    version: 1,
    instance_id: 'inst-B',
    instance_started_at: 2000,
    grants: [grant('new')],
    allow_agent_create: false,
    max_agent_sessions: 0,
  });
  assert.ok(
    events.includes('authz_instance_rollback_refused'),
    'the refusal is observable in the logs',
  );
  await store.close();

  const reopened = new BridgeStore({ dataRoot: root, logger: silentLogger });
  await reopened.init();
  const persisted = await reopened.authzSnapshot();
  assert.equal(persisted.instance_id, 'inst-B');
  assert.equal(persisted.instance_started_at, 2000);
  assert.deepEqual(persisted.grants, [grant('new')]);
  await reopened.close();
});

test('the v0.1 upgrade path accepts the first complete authority identity', async () => {
  const { store } = await freshStore();
  // A v0.1 cache row: version is the only ordering information it carries.
  await store.applyAuthz({ version: 5, grants: [grant('legacy')] });

  const result = await store.applyAuthz({
    version: 0,
    instance_id: 'inst-B',
    instance_started_at: 2000,
    grants: [grant('rebuilt')],
  });
  assert.equal(result.applied, true, 'an identity-less cache accepts the first complete identity');
  assert.deepEqual(await store.authzSnapshot(), {
    version: 0,
    instance_id: 'inst-B',
    instance_started_at: 2000,
    grants: [grant('rebuilt')],
    allow_agent_create: false,
    max_agent_sessions: 0,
  });
  await store.close();
});

test('the upgrade path does not accept a push without a usable start', async () => {
  const { store } = await freshStore();
  await store.applyAuthz({ version: 5, grants: [grant('legacy')] });

  const result = await store.applyAuthz({
    version: 0,
    instance_id: 'inst-B',
    grants: [grant('rejected')],
  });
  assert.equal(result.applied, false, 'rule 1 still requires a strictly higher version');
  assert.deepEqual(await store.authzSnapshot(), {
    version: 5,
    instance_id: null,
    instance_started_at: null,
    grants: [grant('legacy')],
    allow_agent_create: false,
    max_agent_sessions: 0,
  });
  await store.close();
});

test('an id without a usable start falls back to version monotonicity without recording it', async () => {
  const { store } = await freshStore();
  await store.applyAuthz({ version: 5, grants: [grant('legacy')] });

  const applied = await store.applyAuthz({
    version: 6,
    instance_id: 'inst-B',
    grants: [grant('version-only')],
  });
  assert.equal(applied.applied, true, 'a strictly higher version still applies');
  let snapshot = await store.authzSnapshot();
  assert.equal(snapshot.instance_id, null, 'an incomplete identity is not recorded');
  assert.equal(snapshot.instance_started_at, null);
  assert.deepEqual(snapshot.grants, [grant('version-only')]);

  // The cache is still identity-less, so rule 0 remains available for the next
  // complete snapshot even though its version is lower.
  const upgraded = await store.applyAuthz({
    version: 0,
    instance_id: 'inst-B',
    instance_started_at: 2000,
    grants: [grant('rebuilt')],
  });
  assert.equal(upgraded.applied, true);
  snapshot = await store.authzSnapshot();
  assert.equal(snapshot.version, 0);
  assert.equal(snapshot.instance_id, 'inst-B');
  assert.equal(snapshot.instance_started_at, 2000);
  assert.deepEqual(snapshot.grants, [grant('rebuilt')]);
  await store.close();
});

test('an older instance cannot roll the table back after the upgrade', async () => {
  const { events, logger } = recordingLogger();
  const { store } = await freshStore(logger);
  await store.applyAuthz({ version: 5, grants: [grant('legacy')] });
  await store.applyAuthz({
    version: 0,
    instance_id: 'inst-B',
    instance_started_at: 2000,
    grants: [grant('new')],
  });

  // Once rule 0 recorded inst-B, the normal rollback guard must apply: an older
  // instance with a much higher version is still a replay.
  const replay = await store.applyAuthz({
    version: 9,
    instance_id: 'inst-A',
    instance_started_at: 1000,
    grants: [grant('old')],
  });
  assert.equal(replay.applied, false, 'the rollback guard applies after the upgrade');
  assert.deepEqual(await store.authzSnapshot(), {
    version: 0,
    instance_id: 'inst-B',
    instance_started_at: 2000,
    grants: [grant('new')],
    allow_agent_create: false,
    max_agent_sessions: 0,
  });
  assert.ok(
    events.includes('authz_instance_rollback_refused'),
    'the refusal is observable in the logs',
  );
  await store.close();
});

const startedAtRejectionCases = [
  ['an equal start', 2000],
  ['a missing start', undefined],
  ['a string start', '2001'],
  ['a null start', null],
  ['a negative start', -1],
  ['a fractional start', 2000.5],
];

for (const [label, pushedStartedAt] of startedAtRejectionCases) {
  test(`a switch with ${label} is refused`, async () => {
    const { events, logger } = recordingLogger();
    const { store } = await freshStore(logger);
    await store.applyAuthz({
      version: 1,
      instance_id: 'inst-B',
      instance_started_at: 2000,
      grants: [grant('kept')],
    });

    const params = {
      version: 9,
      instance_id: 'inst-A',
      grants: [grant('replayed')],
    };
    if (pushedStartedAt !== undefined) params.instance_started_at = pushedStartedAt;
    const result = await store.applyAuthz(params);
    assert.equal(result.applied, false, 'the table must not move backwards');
    assert.deepEqual(await store.authzSnapshot(), {
      version: 1,
      instance_id: 'inst-B',
      instance_started_at: 2000,
      grants: [grant('kept')],
      allow_agent_create: false,
      max_agent_sessions: 0,
    });
    assert.ok(events.includes('authz_instance_rollback_refused'));
    await store.close();
  });
}

const invalidCachedStartCases = [
  ['a string', '2000'],
  ['null', null],
  ['a missing value', undefined],
  ['a negative value', -1],
];

for (const [label, cachedStartedAt] of invalidCachedStartCases) {
  test(`a switch is refused when the cached start is ${label}`, async () => {
    const { store } = await freshStore();
    // Bypass applyAuthz: this is a legacy/malformed row whose start cannot order
    // instances. It must never be treated as "safe to replace".
    const stored = {
      version: 5,
      instance_id: 'inst-A',
      grants: [grant('kept')],
      allow_agent_create: false,
      max_agent_sessions: 0,
    };
    if (cachedStartedAt !== undefined) stored.instance_started_at = cachedStartedAt;
    await store.put('authz', 'current', stored);

    const result = await store.applyAuthz({
      version: 9,
      instance_id: 'inst-B',
      instance_started_at: 3000,
      grants: [grant('replayed')],
    });
    assert.equal(result.applied, false, 'an unordered cached identity is not replaceable');
    const snapshot = await store.authzSnapshot();
    assert.equal(snapshot.instance_id, 'inst-A');
    assert.deepEqual(snapshot.grants, [grant('kept')]);
    await store.close();
  });
}

const missingInstanceCases = [
  {
    label: 'neither side carries one',
    cached: null,
    cachedStarted: null,
    pushed: null,
    pushedStarted: null,
    expected: null,
    expectedStarted: null,
  },
  {
    // Rule 0 (v0.2 R1): a cache with no identity can only predate the upgrade,
    // so the first complete pushed identity is accepted even at a lower version.
    // This is the F3 upgrade path, not v0.1 monotonicity.
    label: 'only the push carries one',
    cached: null,
    cachedStarted: null,
    pushed: 'inst-B',
    pushedStarted: 2000,
    expected: 'inst-B',
    expectedStarted: 2000,
    upgrade: true,
  },
  {
    // The pushed older-format snapshot keeps the cached identity: a missing
    // field must not erase the rollback guard.
    label: 'only the cache carries one',
    cached: 'inst-A',
    cachedStarted: 1000,
    pushed: null,
    pushedStarted: null,
    expected: 'inst-A',
    expectedStarted: 1000,
  },
  {
    label: 'both carry the same one',
    cached: 'inst-A',
    cachedStarted: 1000,
    pushed: 'inst-A',
    pushedStarted: 1000,
    expected: 'inst-A',
    expectedStarted: 1000,
  },
];

for (const testCase of missingInstanceCases) {
  test(`a missing instance_id (${testCase.label}) ${
    testCase.upgrade ? 'takes the one-time upgrade path' : 'falls back to version monotonicity'
  }`, async () => {
    const { store } = await freshStore();
    const withInstance = (params, instanceId, startedAt) => {
      const next = { ...params };
      if (instanceId !== null) next.instance_id = instanceId;
      if (startedAt !== null) next.instance_started_at = startedAt;
      return next;
    };

    await store.applyAuthz(
      withInstance(
        { version: 5, grants: [grant('kept')], allow_agent_create: true },
        testCase.cached,
        testCase.cachedStarted,
      ),
    );

    const lower = await store.applyAuthz(
      withInstance(
        { version: 1, grants: [grant('rejected')] },
        testCase.pushed,
        testCase.pushedStarted,
      ),
    );
    let snapshot = await store.authzSnapshot();
    if (testCase.upgrade) {
      // Rule 0: the identity-less cache accepts the first complete pushed
      // identity even though the version is lower, and records it.
      assert.equal(lower.applied, true, 'the v0.1 cache accepts the first complete identity');
      assert.equal(snapshot.version, 1);
      assert.equal(snapshot.instance_id, 'inst-B');
      assert.equal(snapshot.instance_started_at, 2000);
      assert.deepEqual(snapshot.grants, [grant('rejected')]);
    } else {
      assert.equal(lower.applied, false, 'a lower version without a complete identity is stale');
      assert.equal(snapshot.version, 5);
      assert.equal(snapshot.instance_id, testCase.cached);
      assert.equal(snapshot.instance_started_at, testCase.cachedStarted);
      assert.deepEqual(snapshot.grants, [grant('kept')]);
    }

    const fresh = await store.applyAuthz(
      withInstance(
        { version: 6, grants: [grant('accepted')] },
        testCase.pushed,
        testCase.pushedStarted,
      ),
    );
    assert.equal(fresh.applied, true, 'a strictly higher version still applies');
    snapshot = await store.authzSnapshot();
    assert.equal(snapshot.version, 6);
    assert.equal(snapshot.instance_id, testCase.expected);
    assert.equal(snapshot.instance_started_at, testCase.expectedStarted);
    assert.deepEqual(snapshot.grants, [grant('accepted')]);
    await store.close();
  });
}

const invalidInstanceValues = [
  ['an empty string', ''],
  ['a number', 42],
  ['an object', { id: 'inst-B' }],
];

for (const [label, value] of invalidInstanceValues) {
  test(`an invalid instance_id (${label}) is treated as absent`, async () => {
    const { store } = await freshStore();
    await store.applyAuthz({
      version: 5,
      instance_id: 'inst-A',
      instance_started_at: 1000,
      grants: [grant('s1')],
    });

    const stale = await store.applyAuthz({
      version: 4,
      instance_id: value,
      instance_started_at: 2000,
      grants: [grant('s2')],
    });
    assert.equal(stale.applied, false, 'an unusable instance id cannot make a lower version current');
    let snapshot = await store.authzSnapshot();
    assert.equal(snapshot.instance_id, 'inst-A');
    assert.equal(snapshot.instance_started_at, 1000);

    const fresh = await store.applyAuthz({
      version: 6,
      instance_id: value,
      instance_started_at: 2000,
      grants: [grant('s3')],
    });
    assert.equal(fresh.applied, true, 'the snapshot is not rejected because of the bad field');
    snapshot = await store.authzSnapshot();
    // v0.1 behaviour: no instance switch, so the cached identity is preserved.
    assert.equal(snapshot.instance_id, 'inst-A');
    assert.equal(snapshot.instance_started_at, 1000);
    assert.deepEqual(snapshot.grants, [grant('s3')]);
    await store.close();
  });
}

test('an invalid cached instance_id is treated as absent and upgraded once', async () => {
  const { store } = await freshStore();
  // Simulate a record written before the field was validated (or by hand). The
  // id is unusable, so rule 0 treats the cache as identity-less: the first
  // complete pushed identity is accepted and recorded even at a lower version.
  await store.put('authz', 'current', {
    version: 5,
    instance_id: 12,
    instance_started_at: 1000,
    grants: [grant('kept')],
    allow_agent_create: false,
    max_agent_sessions: 0,
  });

  const lower = await store.applyAuthz({
    version: 1,
    instance_id: 'inst-B',
    instance_started_at: 2000,
    grants: [grant('s2')],
  });
  assert.equal(lower.applied, true, 'a bad cached id cannot order instances, so rule 0 applies');
  let snapshot = await store.authzSnapshot();
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.instance_id, 'inst-B');
  assert.equal(snapshot.instance_started_at, 2000);
  assert.deepEqual(snapshot.grants, [grant('s2')]);

  const fresh = await store.applyAuthz({
    version: 2,
    instance_id: 'inst-B',
    instance_started_at: 2000,
    grants: [grant('s3')],
  });
  assert.equal(fresh.applied, true);
  snapshot = await store.authzSnapshot();
  assert.equal(snapshot.instance_id, 'inst-B');
  assert.equal(snapshot.instance_started_at, 2000);
  assert.deepEqual(snapshot.grants, [grant('s3')]);
  await store.close();
});

test('an invalid instance_started_at does not throw on a monotonic push', async () => {
  const { store } = await freshStore();
  await store.applyAuthz({
    version: 1,
    instance_id: 'inst-A',
    instance_started_at: 1000,
    grants: [grant('s1')],
  });
  const result = await store.applyAuthz({
    version: 2,
    instance_id: 'inst-A',
    instance_started_at: 'not-a-number',
    grants: [grant('s2')],
  });
  assert.equal(result.applied, true, 'a bad optional field is ignored, not fatal');
  const snapshot = await store.authzSnapshot();
  assert.equal(snapshot.instance_started_at, 1000, 'the cached start is kept');
  assert.deepEqual(snapshot.grants, [grant('s2')]);
  await store.close();
});

test('revocation still filters grants inside a replacement snapshot', async () => {
  const { store } = await freshStore();
  await store.applyAuthz({
    version: 5,
    instance_id: 'inst-A',
    instance_started_at: 1000,
    grants: [grant('s1'), grant('s2')],
  });

  const result = await store.applyAuthz({
    version: 1,
    instance_id: 'inst-B',
    instance_started_at: 2000,
    grants: [grant('s2'), grant('s3')],
    revoked: ['s3'],
  });
  assert.equal(result.applied, true);
  const snapshot = await store.authzSnapshot();
  assert.deepEqual(snapshot.grants, [grant('s2')], 'a revoked grant is dropped from the replacement');
  assert.equal(await store.isAuthorized('s1'), false);
  assert.equal(await store.isAuthorized('s2'), true);
  assert.equal(await store.isAuthorized('s3'), false);
  await store.close();
});

test('a non-integer version is still bad_params', async () => {
  const { store } = await freshStore();
  await assert.rejects(
    () => store.applyAuthz({ version: 'x', instance_id: 'inst-B', instance_started_at: 2000 }),
    (error) => {
      assert.equal(error.code, 'bad_params');
      return true;
    },
  );
  await assert.rejects(
    () => store.applyAuthz({ version: 1.5, instance_id: 'inst-B', instance_started_at: 2000 }),
    (error) => {
      assert.equal(error.code, 'bad_params');
      return true;
    },
  );
  await assert.rejects(
    () => store.applyAuthz({ instance_id: 'inst-B', instance_started_at: 2000 }),
    (error) => {
      assert.equal(error.code, 'bad_params');
      return true;
    },
  );
  assert.deepEqual(await store.authzSnapshot(), {
    version: 0,
    instance_id: null,
    instance_started_at: null,
    grants: [],
    allow_agent_create: false,
    max_agent_sessions: 0,
  });
  await store.close();
});

test('concurrent snapshots are serialized and lose no grant', async () => {
  const { store } = await freshStore();
  await store.applyAuthz({
    version: 5,
    instance_id: 'inst-A',
    instance_started_at: 1000,
    grants: [grant('base')],
  });

  // Slow down the *first* read after it captured the old table. Without
  // serialization the second (higher-version) push writes next, then the first
  // push resumes from its stale read and overwrites it, dropping `s2`.
  const unit = store._unit;
  const originalLoadAll = unit.loadAll.bind(unit);
  let reads = 0;
  unit.loadAll = async () => {
    const snapshot = await originalLoadAll();
    reads += 1;
    if (reads === 1) await new Promise((resolve) => setTimeout(resolve, 25));
    return snapshot;
  };
  try {
    const snapshotA = {
      version: 6,
      instance_id: 'inst-A',
      instance_started_at: 1000,
      grants: [grant('base'), grant('s1')],
    };
    const snapshotB = {
      version: 7,
      instance_id: 'inst-A',
      instance_started_at: 1000,
      grants: [grant('base'), grant('s1'), grant('s2')],
    };
    const [first, second] = await Promise.all([
      store.applyAuthz(snapshotA),
      store.applyAuthz(snapshotB),
    ]);
    assert.equal(first.applied, true);
    assert.equal(second.applied, true);

    const final = await store.authzSnapshot();
    assert.deepEqual(
      final,
      {
        version: 7,
        instance_id: 'inst-A',
        instance_started_at: 1000,
        grants: [grant('base'), grant('s1'), grant('s2')],
        allow_agent_create: false,
        max_agent_sessions: 0,
      },
      'the final table is the complete higher-version snapshot, not a mix or a loss',
    );
  } finally {
    unit.loadAll = originalLoadAll;
    await store.close();
  }
});

test('approvals rebuild their cache when a newer authority instance appears', async () => {
  const { store } = await freshStore();
  await store.applyAuthz({
    version: 5,
    instance_id: 'inst-A',
    instance_started_at: 1000,
    grants: [grant('old-session')],
  });
  const service = approvalService(store);
  await service.syncAuthz();
  assert.equal(service._isAuthorizedSync('old-session'), true);
  assert.equal(service._authzVersion, 5);
  assert.equal(service._authzInstanceId, 'inst-A');
  assert.equal(service._authzInstanceStartedAt, 1000);

  await store.applyAuthz({
    version: 1,
    instance_id: 'inst-B',
    instance_started_at: 2000,
    grants: [grant('new-session')],
  });
  await service.syncAuthz();
  assert.equal(service._isAuthorizedSync('old-session'), false, 'the old instance no longer authorizes');
  assert.equal(service._isAuthorizedSync('new-session'), true);
  assert.equal(service._authzVersion, 1);
  assert.equal(service._authzInstanceId, 'inst-B');
  assert.equal(service._authzInstanceStartedAt, 2000);
  await store.close();
});

test('approvals rebuild an empty cache from a complete authority identity', async () => {
  const { store } = await freshStore();
  // The v0.1 cache has no identity; approvals loaded it before the upgrade.
  await store.applyAuthz({ version: 5, grants: [grant('legacy')] });
  const service = approvalService(store);
  await service.syncAuthz();
  assert.equal(service._isAuthorizedSync('legacy'), true);
  assert.equal(service._authzVersion, 5);
  assert.equal(service._authzInstanceId, null);
  assert.equal(service._authzInstanceStartedAt, null);

  // The persisted table after applyAuthz rule 0: a complete identity at a lower
  // version. The synchronous claim cache must follow it, not stay on v0.1.
  await store.put('authz', 'current', {
    version: 0,
    instance_id: 'inst-B',
    instance_started_at: 2000,
    grants: [grant('rebuilt')],
    allow_agent_create: false,
    max_agent_sessions: 0,
  });
  await service.syncAuthz();
  assert.equal(service._isAuthorizedSync('legacy'), false, 'the pre-upgrade cache is replaced');
  assert.equal(service._isAuthorizedSync('rebuilt'), true);
  assert.equal(service._authzVersion, 0);
  assert.equal(service._authzInstanceId, 'inst-B');
  assert.equal(service._authzInstanceStartedAt, 2000);
  await store.close();
});

test('approvals do not record an incomplete identity from a higher version', async () => {
  const { store } = await freshStore();
  await store.applyAuthz({ version: 5, grants: [grant('legacy')] });
  const service = approvalService(store);
  await service.syncAuthz();
  assert.equal(service._isAuthorizedSync('legacy'), true);

  // Id present, start absent: v0.1 monotonicity applies, but recording the
  // partial identity would block the later complete snapshot's rule 0.
  await store.put('authz', 'current', {
    version: 6,
    instance_id: 'inst-B',
    grants: [grant('version-only')],
    allow_agent_create: false,
    max_agent_sessions: 0,
  });
  await service.syncAuthz();
  assert.equal(service._isAuthorizedSync('version-only'), true);
  assert.equal(service._isAuthorizedSync('legacy'), false);
  assert.equal(service._authzVersion, 6);
  assert.equal(service._authzInstanceId, null);
  assert.equal(service._authzInstanceStartedAt, null);

  await store.put('authz', 'current', {
    version: 0,
    instance_id: 'inst-B',
    instance_started_at: 2000,
    grants: [grant('rebuilt')],
    allow_agent_create: false,
    max_agent_sessions: 0,
  });
  await service.syncAuthz();
  assert.equal(service._isAuthorizedSync('rebuilt'), true, 'rule 0 is still available');
  assert.equal(service._isAuthorizedSync('version-only'), false);
  assert.equal(service._authzVersion, 0);
  assert.equal(service._authzInstanceId, 'inst-B');
  assert.equal(service._authzInstanceStartedAt, 2000);
  await store.close();
});

test('approvals ignore a lower version from the same instance', async () => {
  const { store } = await freshStore();
  await store.applyAuthz({
    version: 5,
    instance_id: 'inst-A',
    instance_started_at: 1000,
    grants: [grant('kept')],
  });
  const service = approvalService(store);
  await service.syncAuthz();
  assert.equal(service._isAuthorizedSync('kept'), true);

  // Bypass applyAuthz: this is the stale row the monotonic guard defends against.
  await store.put('authz', 'current', {
    version: 1,
    instance_id: 'inst-A',
    instance_started_at: 1000,
    grants: [grant('dropped')],
    allow_agent_create: false,
    max_agent_sessions: 0,
  });
  await service.syncAuthz();
  assert.equal(service._isAuthorizedSync('kept'), true, 'the same-instance cache is not replaced');
  assert.equal(service._isAuthorizedSync('dropped'), false);
  assert.equal(service._authzVersion, 5);
  assert.equal(service._authzInstanceId, 'inst-A');
  assert.equal(service._authzInstanceStartedAt, 1000);
  await store.close();
});

test('approvals ignore a replay from an older authority instance', async () => {
  const { store } = await freshStore();
  await store.applyAuthz({
    version: 3,
    instance_id: 'inst-B',
    instance_started_at: 2000,
    grants: [grant('kept')],
  });
  const service = approvalService(store);
  await service.syncAuthz();
  assert.equal(service._isAuthorizedSync('kept'), true);

  // The persisted table is forced back to the older instance, as a buggy or
  // replayed write would leave it; the claim cache must not follow.
  await store.put('authz', 'current', {
    version: 9,
    instance_id: 'inst-A',
    instance_started_at: 1000,
    grants: [grant('replayed')],
    allow_agent_create: false,
    max_agent_sessions: 0,
  });
  await service.syncAuthz();
  assert.equal(service._isAuthorizedSync('kept'), true, 'the newer instance stays cached');
  assert.equal(service._isAuthorizedSync('replayed'), false);
  assert.equal(service._authzVersion, 3);
  assert.equal(service._authzInstanceId, 'inst-B');
  assert.equal(service._authzInstanceStartedAt, 2000);
  await store.close();
});

const approvalRejectedSwitchCases = [
  ['an equal start', 2000],
  ['a missing start', undefined],
  ['a string start', '2001'],
  ['a null start', null],
  ['a negative start', -1],
];

for (const [label, startedAt] of approvalRejectedSwitchCases) {
  test(`approvals ignore a switch with ${label}`, async () => {
    const { store } = await freshStore();
    await store.applyAuthz({
      version: 3,
      instance_id: 'inst-B',
      instance_started_at: 2000,
      grants: [grant('kept')],
    });
    const service = approvalService(store);
    await service.syncAuthz();

    const stored = {
      version: 9,
      instance_id: 'inst-A',
      grants: [grant('replayed')],
      allow_agent_create: false,
      max_agent_sessions: 0,
    };
    if (startedAt !== undefined) stored.instance_started_at = startedAt;
    await store.put('authz', 'current', stored);
    await service.syncAuthz();
    assert.equal(service._isAuthorizedSync('kept'), true);
    assert.equal(service._isAuthorizedSync('replayed'), false);
    assert.equal(service._authzVersion, 3);
    assert.equal(service._authzInstanceId, 'inst-B');
    assert.equal(service._authzInstanceStartedAt, 2000);
    await store.close();
  });
}

test('approvals rebuild on a higher version when the instance field is missing', async () => {
  const { store } = await freshStore();
  await store.applyAuthz({ version: 3, grants: [grant('kept')] });
  const service = approvalService(store);
  await service.syncAuthz();

  await store.put('authz', 'current', {
    version: 4,
    grants: [grant('kept'), grant('added')],
    allow_agent_create: false,
    max_agent_sessions: 0,
  });
  await service.syncAuthz();
  assert.equal(service._isAuthorizedSync('added'), true);
  assert.equal(service._authzVersion, 4);
  assert.equal(service._authzInstanceId, null);

  await store.put('authz', 'current', {
    version: 2,
    grants: [grant('replayed')],
    allow_agent_create: false,
    max_agent_sessions: 0,
  });
  await service.syncAuthz();
  assert.equal(service._isAuthorizedSync('replayed'), false, 'v0.1 fallback stays monotonic');
  assert.equal(service._authzVersion, 4);
  await store.close();
});

test('approvals stay fail-closed when the table cannot be read', async () => {
  const { store } = await freshStore();
  await store.applyAuthz({
    version: 3,
    instance_id: 'inst-A',
    instance_started_at: 1000,
    grants: [grant('kept')],
  });
  const service = approvalService(store);
  await service.syncAuthz();
  assert.equal(service._isAuthorizedSync('kept'), true);

  // A closed store is a real read failure, not a mocked one.
  await store.close();
  const state = await service.syncAuthz();
  assert.equal(state.count, 0);
  assert.equal(service._isAuthorizedSync('kept'), false, 'unknown is not allowed');
});

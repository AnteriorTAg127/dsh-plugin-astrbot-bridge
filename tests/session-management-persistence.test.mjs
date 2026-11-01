/**
 * Durable `session.manage` dispositions (protocol §9.7, PRD §3.4).
 *
 * `session.manage` used to record `rename`/`archive` in a `Map` that lived on
 * the `SessionService` instance, while `lib/index.js` builds a *new*
 * `SessionService` on every handshake (`_buildServices`). The observable
 * failure was:
 *
 *   ```js
 *   const a = new SessionService({store, host, config});
 *   await a.manage({session_id: 's1', action: 'archive'});   // applied: true
 *   const b = new SessionService({store, host, config});     // next handshake
 *   await b.isDeliverable('s1');                             // true — archive gone
 *   ```
 *
 * The suite drives the real service against a real durable store in a
 * temporary directory, and rebuilds the service *and* reopens the store between
 * the write and the read. Nothing here is a stand-in for the store: the second
 * instance reads what the first one actually wrote to disk.
 *
 * Two invariants are asserted alongside durability, because a naive "add a
 * table" fix can break both:
 *
 *   - a disposition never grants: a locally existing (renamed) session the peer
 *     never authorized is still refused as a delivery target;
 *   - authority stays monotonic: an older `session.authz` push is ignored and
 *     cannot resurrect a session the peer revoked, nor un-archive it.
 * @module dsh-plugin-astrbot-bridge/tests/session-management-persistence
 */

import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { SessionService } from '../lib/app/sessions.js';
import { BridgeError } from '../lib/errors.js';
import { BridgeStore } from '../lib/store.js';

/** Logger stub: this suite asserts behaviour, not log text. */
const SILENT = { info() {}, warn() {}, failure() {}, debug() {}, error() {} };

/**
 * Host stub exposing the two session primitives the service uses.
 * @param {string[]} [live] - session ids the host currently has in memory.
 * @returns {object} host adapter.
 */
function makeHost(live = ['s1', 's2']) {
  return {
    listSessions: () => live.map((sessionId) => ({ session_id: sessionId, state: 'idle' })),
    async createSession(input) {
      return input.sessionId;
    },
  };
}

/**
 * Open a durable store in a fresh temporary root.
 * @param {string} root - directory that holds the store.
 * @returns {Promise<BridgeStore>} opened store.
 */
async function openStore(root) {
  const store = new BridgeStore({ dataRoot: root });
  await store.init();
  return store;
}

/**
 * Build one service over a store, as `_buildServices` does per handshake.
 * @param {BridgeStore} store - store to use.
 * @param {object} [options] - overrides.
 * @returns {SessionService} service.
 */
function makeService(store, options = {}) {
  return new SessionService({
    store,
    host: options.host ?? makeHost(),
    config: { id: 'default', allowedSessionPurposes: options.allowedSessionPurposes ?? [] },
    logger: options.logger ?? SILENT,
  });
}

/**
 * Temporary store root, removed by the caller.
 * @param {string} prefix - directory prefix.
 * @returns {Promise<string>} absolute path.
 */
async function makeRoot(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

test('an archive survives a service rebuild on the same store', async () => {
  const root = await makeRoot('bridge-session-rebuild-');
  try {
    const store = await openStore(root);
    await store.applyAuthz({
      version: 1,
      grants: [{ session_id: 's1', granted_by: 'human' }],
      allow_agent_create: false,
      max_agent_sessions: 0,
    });

    const first = makeService(store);
    assert.equal(await first.isDeliverable('s1'), true, 'a granted session starts deliverable');
    assert.deepEqual(await first.manage({ session_id: 's1', action: 'archive' }), {
      session_id: 's1',
      action: 'archive',
      applied: true,
    });
    assert.equal(await first.isDeliverable('s1'), false);

    // The next handshake rebuilds the service on the same store.
    const second = makeService(store);
    assert.equal(await second.isDeliverable('s1'), false, 'the archive did not survive the rebuild');
    await store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a title survives a service rebuild and is what list() reports', async () => {
  const root = await makeRoot('bridge-session-title-');
  try {
    const store = await openStore(root);
    await store.applyAuthz({
      version: 1,
      grants: [{ session_id: 's1', granted_by: 'human', title: 'from-peer' }],
      allow_agent_create: false,
      max_agent_sessions: 0,
    });

    const first = makeService(store);
    await first.manage({ session_id: 's1', action: 'rename', title: '本地标题' });
    assert.equal((await first.list({})).sessions[0].title, '本地标题');

    const second = makeService(store);
    assert.equal((await second.list({})).sessions[0].title, '本地标题', 'the rename did not survive the rebuild');
    await store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a closed store and a rebuilt service keep archive and title', async () => {
  const root = await makeRoot('bridge-session-reopen-');
  try {
    const firstStore = await openStore(root);
    await firstStore.applyAuthz({
      version: 1,
      grants: [{ session_id: 's1', granted_by: 'human' }],
      allow_agent_create: false,
      max_agent_sessions: 0,
    });
    const first = makeService(firstStore);
    await first.manage({ session_id: 's1', action: 'rename', title: 'persisted' });
    await first.manage({ session_id: 's1', action: 'archive' });
    await firstStore.close();

    // A real restart: new store handle on the same root, new service instance.
    const secondStore = await openStore(root);
    const second = makeService(secondStore);
    assert.equal(await second.isDeliverable('s1'), false, 'an archived session became deliverable after a restart');
    assert.equal((await second.list({})).sessions[0].title, 'persisted', 'the title was lost on restart');
    await secondStore.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a disposition is written under the existing authz table, not a new one', async () => {
  const root = await makeRoot('bridge-session-table-');
  try {
    const store = await openStore(root);
    await store.applyAuthz({
      version: 1,
      grants: [{ session_id: 's1', granted_by: 'human' }],
      allow_agent_create: false,
      max_agent_sessions: 0,
    });
    const service = makeService(store);
    await service.manage({ session_id: 's1', action: 'archive' });

    // The store's unit descriptor is fixed (`TABLES` in lib/store.js); this
    // module must not need a new one, so the disposition lives in `authz`
    // alongside — and keyed apart from — the pushed authority record.
    const tables = await readdir(root);
    assert.ok(tables.includes('authz'), 'the authority table must still exist');
    const declared = ['tasks', 'replies', 'notifies', 'approvals', 'decisions', 'authz', 'wake'];
    assert.deepEqual(
      tables.filter((name) => !declared.includes(name)),
      [],
      'the session fix must not introduce a table the store did not declare',
    );

    const authority = await store.get('authz', 'current');
    assert.equal(authority.version, 1, 'the authority record is untouched by a disposition write');
    assert.deepEqual(authority.grants.map((grant) => grant.session_id), ['s1']);

    const stored = await store.get('authz', 'local_session:s1');
    assert.equal(stored.kind, 'local_session');
    assert.equal(stored.session_id, 's1');
    assert.equal(stored.archived, true);
    assert.equal('version' in stored, false, 'a disposition must not look like an authority snapshot');
    await store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a local disposition is not authority: an unauthorized session stays undeliverable', async () => {
  const root = await makeRoot('bridge-session-authority-');
  try {
    const store = await openStore(root);
    // `s2` exists on the host but the peer never granted it. Local existence is
    // not authorization, and neither is a rename.
    const service = makeService(store, { host: makeHost(['s1', 's2']) });
    await store.applyAuthz({
      version: 1,
      grants: [{ session_id: 's1', granted_by: 'human' }],
      allow_agent_create: false,
      max_agent_sessions: 0,
    });

    await assert.rejects(
      service.manage({ session_id: 's2', action: 'rename', title: 'not-granted' }),
      (error) => error instanceof BridgeError && error.code === 'session_not_authorized',
    );
    await assert.rejects(
      service.manage({ session_id: 's2', action: 'archive' }),
      (error) => error instanceof BridgeError && error.code === 'session_not_authorized',
    );
    assert.equal(await service.isDeliverable('s2'), false);
    assert.equal((await service.list({})).sessions.some((entry) => entry.session_id === 's2'), false);
    await store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an older authz push cannot resurrect a revoked session or unarchive it', async () => {
  const root = await makeRoot('bridge-session-monotonic-');
  try {
    const store = await openStore(root);
    const service = makeService(store);
    await store.applyAuthz({
      version: 3,
      grants: [{ session_id: 's1', granted_by: 'human' }, { session_id: 's2', granted_by: 'human' }],
      allow_agent_create: false,
      max_agent_sessions: 0,
    });
    await service.manage({ session_id: 's1', action: 'archive' });

    // Revision 4 revokes `s1`; revision 2 — an old replay — still lists it.
    assert.equal(
      (await service.onAuthz({ version: 4, grants: [{ session_id: 's2' }], revoked: ['s1'] })).applied,
      true,
    );
    assert.equal(await service.isDeliverable('s1'), false);
    assert.equal(
      (await service.onAuthz({ version: 2, grants: [{ session_id: 's1' }, { session_id: 's2' }] })).applied,
      false,
      'a stale authz version must be ignored',
    );

    // The stale push changed neither the authority cache nor the archive flag.
    assert.equal(await store.isAuthorized('s1'), false);
    assert.equal(await service.isDeliverable('s1'), false);
    const rebuilt = makeService(store);
    assert.equal(await rebuilt.isDeliverable('s1'), false);

    // Re-granting at a newer version restores authorization, and the archive
    // flag still decides delivery on its own.
    assert.equal((await service.onAuthz({ version: 5, grants: [{ session_id: 's1' }] })).applied, true);
    assert.equal(await service.isDeliverable('s1'), false, 'the archive still wins over a fresh grant');
    await service.manage({ session_id: 's1', action: 'rename', title: 'kept' });
    await store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('archive is idempotent and a rename does not clear it', async () => {
  const root = await makeRoot('bridge-session-idempotent-');
  try {
    const store = await openStore(root);
    await store.applyAuthz({
      version: 1,
      grants: [{ session_id: 's1', granted_by: 'human' }],
      allow_agent_create: false,
      max_agent_sessions: 0,
    });
    const service = makeService(store);
    await service.manage({ session_id: 's1', action: 'archive' });
    assert.deepEqual(await service.manage({ session_id: 's1', action: 'archive' }), {
      session_id: 's1',
      action: 'archive',
      applied: true,
    });
    await service.manage({ session_id: 's1', action: 'rename', title: 'after-archive' });
    assert.equal(await service.isDeliverable('s1'), false);

    const rebuilt = makeService(store);
    assert.equal(await rebuilt.isDeliverable('s1'), false);
    const listed = await rebuilt.list({});
    assert.equal(listed.sessions[0].title, 'after-archive');
    // An archive never removes the grant from the list: §9.7 reports the
    // session with the disposition, and only delivery is refused.
    assert.equal(listed.sessions[0].authorized, true);
    await store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an unknown action is refused before any disposition is persisted', async () => {
  const root = await makeRoot('bridge-session-badaction-');
  try {
    const store = await openStore(root);
    await store.applyAuthz({
      version: 1,
      grants: [{ session_id: 's1', granted_by: 'human' }],
      allow_agent_create: false,
      max_agent_sessions: 0,
    });
    const service = makeService(store);
    await assert.rejects(
      service.manage({ session_id: 's1', action: 'delete' }),
      (error) => error instanceof BridgeError && error.code === 'bad_params',
    );
    assert.equal(await store.get('authz', 'local_session:s1'), null, 'a refused action must not persist anything');
    assert.equal(await service.isDeliverable('s1'), true);
    await store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a disposition write that fails is surfaced, not swallowed as applied', async () => {
  const root = await makeRoot('bridge-session-writefail-');
  try {
    const store = await openStore(root);
    await store.applyAuthz({
      version: 1,
      grants: [{ session_id: 's1', granted_by: 'human' }],
      allow_agent_create: false,
      max_agent_sessions: 0,
    });
    const service = makeService(store);
    const write = store.put.bind(store);
    store.put = async () => {
      throw new BridgeError('draining');
    };
    await assert.rejects(
      service.manage({ session_id: 's1', action: 'archive' }),
      (error) => error instanceof BridgeError && error.code === 'draining',
    );
    store.put = write;
    assert.equal(await store.get('authz', 'local_session:s1'), null);

    // A failed write must not wedge the write chain: the next manager call has
    // to reach the store again instead of silently reporting `applied:true`.
    assert.deepEqual(await service.manage({ session_id: 's1', action: 'archive' }), {
      session_id: 's1',
      action: 'archive',
      applied: true,
    });
    assert.equal((await store.get('authz', 'local_session:s1')).archived, true);
    await store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

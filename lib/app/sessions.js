/**
 * Session surface: list, create, select and manage, always inside the peer's
 * authorization table (protocol §9.7, PRD §3.4).
 *
 * Authority stays with the peer: this service only *caches* the pushed `authz`
 * table and enforces it locally. That is deliberate — a bug here must deny, not
 * grant, so every check falls through to `session_not_authorized`.
 *
 * Two different kinds of state live here and must never be confused:
 *
 *   - the **authority** (`authz/current`), pushed by the peer and versioned;
 *   - the **disposition** (display title, archive flag), owned by this side and
 *     persisted per session. A disposition is never an authorization: an
 *     archived-but-granted session is undeliverable, while a renamed session the
 *     peer never granted stays unauthorized. Local existence is not authority.
 *
 * Dispositions are durable because a new `SessionService` is built on every
 * handshake (`lib/index.js: _buildServices`). Keeping them only in a `Map`
 * meant that `applied:true` was a lie the next handshake silently reverted:
 * an archived session became a delivery target again.
 * @module dsh-plugin-astrbot-bridge/app/sessions
 */

import { randomUUID } from 'node:crypto';

import { BridgeError } from '../errors.js';
import { MessageName } from '../constants.js';

/** Management actions allowed in v1 (§9.7). */
const ACTIONS = Object.freeze(['rename', 'archive']);

/**
 * Table that carries bridge-local session dispositions.
 *
 * The store exposes no session table and no disposition API, so the records
 * ride in the existing `authz` table under a namespaced key. They are *only*
 * ever B-side metadata (a display title and an archive flag); the authority
 * itself stays in the `current` record that the peer pushes, and the two never
 * share a key. Adding a dedicated table would mean changing the store's unit
 * descriptor, which is outside this module's write scope.
 */
const DISPOSITION_TABLE = 'authz';

/** Namespace that keeps dispositions apart from the pushed authority snapshot. */
const DISPOSITION_PREFIX = 'local_session:';

/** Marker that lets a full-table read ignore the authority record. */
const DISPOSITION_KIND = 'local_session';

/** Session service. */
export class SessionService {
  /**
   * @param {object} options - service dependencies.
   * @param {object} options.store - bridge store.
   * @param {object} options.host - agent host adapter.
   * @param {object} options.config - bridge configuration.
   * @param {import('../log.js').Logger} [options.logger] - structured logger.
   */
  constructor(options) {
    this.store = options.store;
    this.host = options.host;
    this.config = options.config;
    this.logger = options.logger ?? { info() {}, warn() {}, failure() {}, debug() {}, error() {} };
    /** Cached titles/archive flags managed by the bridge (host has no rename). */
    this._local = new Map();
    /** Serializes read-modify-write of the disposition records. */
    this._writes = Promise.resolve();
  }

  /**
   * Read every disposition record of this bridge.
   *
   * Dispositions are durable, so a service rebuilt on the next handshake (or a
   * process restarted on the same root) sees the same archive flags and titles
   * instead of silently un-archiving a session.
   * @returns {Promise<void>} resolution once the cache matches the store.
   */
  async _load() {
    const records = await this.store.list(DISPOSITION_TABLE);
    this._local.clear();
    for (const record of records) {
      if (record?.kind !== DISPOSITION_KIND) continue;
      this._local.set(String(record.session_id), {
        title: record.title ?? null,
        archived: record.archived === true,
      });
    }
  }

  /**
   * Read-modify-write one disposition durably.
   *
   * The whole cycle runs inside one chain and re-reads the store rather than
   * merging onto the in-process cache, so a later writer — the service rebuilt
   * after a handshake, or a process taking over the same root — builds on what
   * was persisted instead of on a snapshot it captured earlier. (Two writers
   * truly in flight at the same instant are still last-write-wins; there is no
   * cross-instance transaction in the store contract.) The authority record is
   * a different key, so a `session.authz` push neither sees nor clobbers a
   * disposition.
   * @param {string} sessionId - session identity.
   * @param {(current: {title: string|null, archived: boolean}) =>
   *   {title: string|null, archived: boolean}} change - disposition update.
   * @returns {Promise<{title: string|null, archived: boolean}>} new disposition.
   */
  async _update(sessionId, change) {
    const run = this._writes.then(async () => {
      await this._load();
      const next = change(this._local.get(sessionId) ?? { title: null, archived: false });
      await this.store.put(DISPOSITION_TABLE, `${DISPOSITION_PREFIX}${sessionId}`, {
        kind: DISPOSITION_KIND,
        session_id: sessionId,
        title: next.title ?? null,
        archived: next.archived === true,
      });
      this._local.set(sessionId, next);
      return next;
    });
    // One failed write must not wedge every later one; the caller still sees it.
    this._writes = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  /**
   * Wait for pending disposition writes and refresh the cache.
   * @returns {Promise<void>} resolution once the cache is current.
   */
  async _refresh() {
    await this._writes;
    await this._load();
  }

  /**
   * Whether one purpose is allowed by local configuration (§4).
   * @param {string|null} purpose - purpose label.
   * @returns {boolean} whether the purpose passes the local allow-list.
   */
  _purposeAllowed(purpose) {
    const allowed = this.config.allowedSessionPurposes ?? [];
    if (allowed.length === 0) return true;
    if (purpose === null || purpose === undefined) return false;
    return allowed.includes(String(purpose));
  }

  /**
   * List sessions the peer authorized (§9.7).
   *
   * Unauthorized sessions are *absent* rather than refused, so the response
   * cannot be used to enumerate what exists (§9.7).
   * @param {object} params - `{purpose, state, limit, cursor}`.
   * @returns {Promise<object>} list result with `authz_version`.
   */
  async list(params = {}) {
    const snapshot = await this.store.authzSnapshot();
    await this._refresh();
    const live = new Map(this.host.listSessions().map((entry) => [entry.session_id, entry.state]));
    const limit = Math.min(200, Math.max(1, Number(params.limit ?? 50)));
    const now = Date.now();

    const sessions = snapshot.grants
      .filter((grant) => {
        if (grant.expires_at !== null && grant.expires_at !== undefined) {
          if (Date.parse(String(grant.expires_at)) <= now) return false;
        }
        if (params.purpose !== null && params.purpose !== undefined && grant.purpose !== params.purpose) {
          return false;
        }
        if (params.state !== undefined && params.state !== 'any') {
          const state = live.get(String(grant.session_id)) ?? 'cold';
          if (state !== params.state) return false;
        }
        return true;
      })
      .slice(0, limit)
      .map((grant) => {
        const local = this._local.get(String(grant.session_id)) ?? {};
        return {
          session_id: String(grant.session_id),
          purpose: grant.purpose ?? null,
          state: live.get(String(grant.session_id)) ?? 'cold',
          authorized: true,
          granted_by: grant.granted_by ?? 'human',
          granted_by_id: grant.granted_by_id ?? null,
          expires_at: grant.expires_at ?? null,
          created_by_task: grant.created_by_task ?? null,
          title: local.title ?? grant.title ?? null,
        };
      });
    return { sessions, next_cursor: null, authz_version: snapshot.version };
  }

  /**
   * Create one session, auto-authorized inside the granted quota (§9.7).
   *
   * `request_id` is the idempotency key: repeating it returns the first result
   * instead of creating a second session.
   * @param {object} params - `{request_id, purpose, title}`.
   * @returns {Promise<object>} creation result.
   * @throws {BridgeError} `session_create_denied`, `session_quota_exceeded`,
   *   `session_not_authorized`, or `session_quota_exceeded` for an exhausted quota.
   */
  async create(params) {
    const requestId = String(params?.request_id ?? '');
    if (requestId.length === 0) throw new BridgeError('bad_params', { details: { field: 'request_id' } });
    const cached = await this.store.get('replies', `session.create:${requestId}`);
    if (cached !== null) {
      return { ...cached.reply, dedup: true };
    }

    const snapshot = await this.store.authzSnapshot();
    if (snapshot.allow_agent_create !== true) throw new BridgeError('session_create_denied');
    if (!this._purposeAllowed(params.purpose ?? null)) {
      throw new BridgeError('session_not_authorized', { details: { field: 'purpose' } });
    }
    const used = await this.store.countAgentSessions();
    if (used >= snapshot.max_agent_sessions) throw new BridgeError('session_quota_exceeded');

    const sessionId = await this.host.createSession({
      sessionId: randomUUID(),
      purpose: params.purpose ?? null,
    });
    const grant = {
      session_id: sessionId,
      purpose: params.purpose ?? null,
      granted_by: 'agent_auto',
      granted_by_id: `conn:${this.config.id ?? 'default'}#request:${requestId}`,
      expires_at: null,
      created_by_task: params.task_id ?? null,
    };
    await this.store.applyAuthz({
      version: snapshot.version + 1,
      grants: [...snapshot.grants, grant],
      allow_agent_create: snapshot.allow_agent_create,
      max_agent_sessions: snapshot.max_agent_sessions,
    });
    // The id is a fresh UUID, so this only records the create-time title; an
    // archive flag already on record is kept rather than reset.
    await this._update(sessionId, (current) => ({
      title: params.title ?? null,
      archived: current.archived === true,
    }));

    const result = {
      session_id: sessionId,
      authorized: true,
      granted_by: 'agent_auto',
      authz_version: snapshot.version + 1,
    };
    await this.store.put('replies', `session.create:${requestId}`, {
      reply: result,
      expires_at: Date.now() + 24 * 60 * 60 * 1000,
    });
    this.logger.info('session_created', { session: sessionId, via: 'agent_auto' });
    return result;
  }

  /**
   * Authorize a task to target one session (§9.7 `session.select`).
   * @param {object} params - `{task_id, session_id}`.
   * @returns {Promise<{ok: true}>} result.
   * @throws {BridgeError} `session_not_authorized`.
   */
  async select(params) {
    const sessionId = String(params?.session_id ?? '');
    const authorized = await this.store.isAuthorized(sessionId);
    if (!authorized) throw new BridgeError('session_not_authorized');
    const task = await this.store.getTask(String(params?.task_id ?? ''));
    if (task !== null) {
      await this.store.putTask({
        ...task,
        session_id: sessionId,
        updated_at: new Date(Date.now()).toISOString(),
      });
    }
    await this.store.put('replies', `session.select:${String(params?.task_id ?? '')}:${sessionId}`, {
      reply: { ok: true },
      expires_at: Date.now() + 24 * 60 * 60 * 1000,
    });
    return { ok: true };
  }

  /**
   * Rename or archive one session (§9.7).
   *
   * The host has no rename primitive, so the disposition is tracked locally and
   * an archived session is refused as a delivery target. The disposition is
   * written through the store *before* the call returns: `applied:true` must
   * mean durable, or the next handshake would quietly make an archived session
   * a delivery target again.
   *
   * Renaming a session never authorizes it — the authorization check below is
   * the only gate, and it reads the peer-pushed table, not local existence.
   * @param {object} params - `{session_id, action, title}`.
   * @returns {Promise<object>} result.
   * @throws {BridgeError} `bad_params`, `session_not_authorized`.
   */
  async manage(params) {
    const action = String(params?.action ?? '');
    if (!ACTIONS.includes(action)) throw new BridgeError('bad_params', { details: { field: 'action' } });
    const sessionId = String(params?.session_id ?? '');
    if (!(await this.store.isAuthorized(sessionId))) throw new BridgeError('session_not_authorized');
    // Merge onto the stored disposition, not a possibly stale in-process cache:
    // two managers (a reconnect, a restarted process) must not drop each
    // other's field.
    await this._update(sessionId, (current) => ({
      title: action === 'rename' ? String(params.title ?? '') : (current.title ?? null),
      archived: action === 'archive' ? true : current.archived === true,
    }));
    return { session_id: sessionId, action, applied: true };
  }

  /**
   * Whether one session may receive deliveries.
   * @param {string} sessionId - session identity.
   * @returns {Promise<boolean>} whether it is authorized and not archived.
   */
  async isDeliverable(sessionId) {
    await this._refresh();
    if (this._local.get(String(sessionId))?.archived === true) return false;
    return this.store.isAuthorized(sessionId);
  }

  /**
   * Handle a pushed `session.authz` snapshot (§9.7).
   * @param {object} params - pushed snapshot.
   * @returns {Promise<{applied: boolean, version: number}>} outcome.
   */
  async onAuthz(params) {
    const result = await this.store.applyAuthz(params ?? {});
    if (result.applied) this.logger.info('authz_applied', { version: result.version });
    return result;
  }

  /**
   * Ask the peer to list its own sessions (used when this side initiates).
   * @param {object} session - session bound to the peer.
   * @param {object} [params] - query parameters.
   * @returns {Promise<object>} peer response.
   */
  async remoteList(session, params = {}) {
    return session.call(MessageName.SESSION_LIST, {
      purpose: params.purpose ?? null,
      state: params.state ?? 'any',
      limit: params.limit ?? 50,
      cursor: params.cursor ?? null,
    });
  }
}

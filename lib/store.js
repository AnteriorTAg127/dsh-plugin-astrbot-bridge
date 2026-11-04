/**
 * Durable bridge storage (protocol §10.1, PRD §5).
 *
 * The bridge persists through the host storage service when the composition
 * root hands one over (`storage.backend.get('json').kv.open(...)`, per-record
 * layout under the harness data root). The service is passed in explicitly
 * rather than read off `ctx`: Cordis resolves context properties through a
 * proxy that **throws** for any name the plugin did not declare in `inject`,
 * so reaching for `ctx.storage` here would turn a missing declaration into a
 * load failure far away from the declaration itself.
 *
 * Two backends, one contract:
 *
 *   - `host-json` — the storage hub's `json` backend, when available.
 *   - `file-json` — the same per-record layout written directly by this
 *     module, rooted at the resolved data root. It is a *durable* store, never
 *     an in-memory stand-in, and the reason for the choice is logged.
 *
 * Whichever is used, every mutation is one atomic, durable write, so a crash
 * can never leave a half-written task row that would later be re-executed. Data
 * is never written inside the plugin repository (PRD §5).
 * @module dsh-plugin-astrbot-bridge/store
 */

import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { Limits, TERMINAL_STATUSES, TASK_TRANSITIONS } from './constants.js';
import { BridgeError } from './errors.js';
import { defaultLogger } from './log.js';

/** Tables in the bridge data domain (§10.1). */
export const TABLES = Object.freeze([
  'tasks',
  'replies',
  'notifies',
  'approvals',
  'decisions',
  'authz',
  'wake',
]);

/**
 * Unit name of the bridge domain.
 *
 * The storage hub restricts unit and table names to `/^[a-z][a-z0-9_]*$/`
 * (`UNIT_NAME_RE`) because the name is also a directory name and a SQL
 * identifier segment; a hyphen makes every `open` reject with
 * `malformed-medium`.
 */
export const UNIT_NAME = 'astrbot_bridge';

/** Unit format version. */
export const UNIT_VERSION = 1;

/** Record keys must be filesystem- and SQL-safe (§10.1, storage backend contract). */
const SAFE_KEY = /^[A-Za-z0-9_-]+$/;

/**
 * Encode an arbitrary identity into a safe record key.
 *
 * Keys legitimately contain `:` and `.` (task ids, `${conn}:${m}`, AAD-style
 * composites), which the per-record layout rejects, so they are percent-encoded
 * into the safe alphabet instead of being rejected.
 * @param {string} key - logical key.
 * @returns {string} safe record key.
 */
export function safeKey(key) {
  const text = String(key);
  if (SAFE_KEY.test(text)) return text;
  return `x${Buffer.from(text, 'utf8').toString('base64url')}`;
}

/**
 * Decode a record key produced by {@link safeKey}.
 *
 * A key that is already inside the safe alphabet is returned unchanged, so an
 * identity that merely *starts* with `x` (but was never encoded) is not
 * mis-decoded: the decoded form is only accepted when re-encoding reproduces
 * the stored key exactly.
 * @param {string} key - stored record key.
 * @returns {string} logical key.
 */
export function unsafeKey(key) {
  const text = String(key);
  if (text.length < 2 || !text.startsWith('x')) return text;
  const decoded = Buffer.from(text.slice(1), 'base64url').toString('utf8');
  return decoded.length > 0 && safeKey(decoded) === text ? decoded : text;
}

/**
 * Record shapes written by this store (§10.1).
 *
 * The unit stores opaque JSON, so a record read back through
 * {@link BridgeStore.get} is `unknown`: the table name alone does not tell
 * TypeScript what a document contains. These typedefs state the shape each
 * table *does* write, so retention and quota code can read a field instead of
 * narrowing the whole domain to `any`. Fields that a partial or legacy record
 * may lack are optional, and every branch keeps its original "absent means
 * absent" behaviour instead of inventing a default.
 */

/**
 * @typedef {object} TaskRecord
 * @property {string} [task_id] - task identity (also the record key).
 * @property {string} [status] - §16.1 task status.
 * @property {boolean} [needs_human] - parked for a human decision.
 * @property {string} [updated_at] - ISO timestamp stamped by the store clock.
 */

/**
 * @typedef {object} ReplyRecord
 * @property {number} expires_at - absolute expiry in epoch milliseconds.
 * @property {object} reply - cached `task.status` reply body.
 */

/**
 * @typedef {object} NotifyRecord
 * @property {string} [notify_id] - notification identity (also the record key).
 * @property {{task_id?: string}} [payload] - business payload; `task_id` is the
 *   task the notification belongs to, when it reports on one.
 * @property {number} [attempts] - failed delivery attempts so far.
 * @property {boolean} [delivered] - whether the peer acknowledged it.
 * @property {number} [next_at] - earliest next attempt, epoch milliseconds.
 */

/**
 * @typedef {object} ApprovalRecord
 * @property {string} [approval_id] - approval identity (also the record key).
 * @property {string} [task_id] - task the approval belongs to.
 * @property {boolean} [decided] - whether a human already answered it.
 */

/**
 * @typedef {object} DecisionRecord
 * @property {string} [decision_id] - decision identity (also the record key).
 * @property {string} [task_id] - task the decision belongs to.
 * @property {boolean} [answered] - whether a human already answered it.
 */

/**
 * @typedef {object} AuthzRecord
 * @property {number} version - monotonically increasing snapshot version.
 * @property {string|null} instance_id - authority instance that produced the
 *   snapshot (v0.2 R1); `null` when the peer did not supply one.
 * @property {number|null} instance_started_at - Unix seconds when that instance
 *   first created its database (v0.2 R1); `null` when absent. It orders
 *   instances, so a rebuilt authority can replace a lower-version snapshot
 *   while an older replayed one cannot.
 * @property {Record<string, unknown>[]} grants - granted session entries.
 * @property {boolean} allow_agent_create - whether agents may open sessions.
 * @property {number} max_agent_sessions - agent-auto-created session quota.
 */

/**
 * @typedef {object} WakeRecord
 * @property {string} root_task_id - root task the counters belong to.
 * @property {number} count - automatic wakes issued for this root task. Only
 *   {@link BridgeStore.bumpWake} writes this table, so a stored record always
 *   carries the counter it incremented.
 * @property {Record<string, number[]>} [window] - per-session wake timestamps
 *   inside the current sliding minute; absent when never yet counted.
 */

/** KV unit backed by the host storage service. */
class HostUnit {
  /**
   * @param {object} unit - opened host `KvUnit`.
   */
  constructor(unit) {
    this._unit = unit;
  }

  /** @returns {Promise<{tables: Record<string, Record<string, unknown>>, global: unknown}>} snapshot */
  async loadAll() {
    const snapshot = await this._unit.loadAll();
    /** @type {Record<string, Record<string, unknown>>} decoded tables */
    const tables = {};
    for (const [table, records] of Object.entries(snapshot.tables ?? {})) {
      // Writes encode the key into the safe alphabet, so reads must decode it
      // back to the logical key: otherwise `get()` misses every record whose
      // identity contains `:` or `.` after a restart.
      tables[table] = {};
      for (const [key, value] of Object.entries(records ?? {})) tables[table][unsafeKey(key)] = value;
    }
    return { tables, global: snapshot.global ?? null };
  }

  /**
   * @param {string} table - table name.
   * @param {string} key - record key.
   * @param {unknown} value - record value.
   * @returns {Promise<void>} resolution after durability.
   */
  async putRecord(table, key, value) {
    return this._unit.putRecord(table, safeKey(key), value);
  }

  /**
   * @param {string} table - table name.
   * @param {string} key - record key.
   * @returns {Promise<void>} resolution after deletion.
   */
  async deleteRecord(table, key) {
    return this._unit.deleteRecord(table, safeKey(key));
  }

  /**
   * @param {unknown} value - global singleton value.
   * @returns {Promise<void>} resolution after durability.
   */
  async setGlobal(value) {
    return this._unit.setGlobal(value);
  }

  /** @returns {Promise<void>} resolution after close. */
  async close() {
    return this._unit.close();
  }

  /**
   * Report the layout so callers can tell whether keys are already encoded.
   * @returns {boolean} always true: the host unit encodes keys itself.
   */
  get encodesKeys() {
    return true;
  }
}

/** KV unit backed by a directory of atomic JSON documents. */
class FileUnit {
  /**
   * @param {string} root - unit directory.
   */
  constructor(root) {
    this.root = root;
  }

  /**
   * Path of one record document.
   * @param {string} table - table name.
   * @param {string} key - record key.
   * @returns {string} absolute path.
   */
  _path(table, key) {
    return join(this.root, table, `${safeKey(key)}.json`);
  }

  /** @returns {Promise<{tables: Record<string, Record<string, unknown>>, global: unknown}>} snapshot */
  async loadAll() {
    /** @type {Record<string, Record<string, unknown>>} tables of this unit */
    const tables = {};
    for (const table of TABLES) tables[table] = await this._readTable(table);
    let global = null;
    try {
      global = JSON.parse(await readFile(join(this.root, 'global.json'), 'utf8')).value ?? null;
    } catch {
      global = null;
    }
    return { tables, global };
  }

  /**
   * Read one table directory.
   * @param {string} table - table name.
   * @returns {Promise<Record<string, unknown>>} records keyed by logical key.
   */
  async _readTable(table) {
    /** @type {Record<string, unknown>} records keyed by logical key */
    const records = {};
    let names;
    try {
      names = await readdir(join(this.root, table));
    } catch {
      return records;
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        const document = JSON.parse(await readFile(join(this.root, table, name), 'utf8'));
        records[unsafeKey(name.slice(0, -'.json'.length))] = document.record;
      } catch {
        // An unreadable document reads as absent, matching the per-record
        // contract: one bad file must not reject the whole unit.
      }
    }
    return records;
  }

  /**
   * Write one record atomically.
   * @param {string} table - table name.
   * @param {string} key - record key.
   * @param {unknown} value - record value.
   * @returns {Promise<void>} resolution after the rename.
   */
  async putRecord(table, key, value) {
    const path = this._path(table, key);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: UNIT_VERSION, record: value }), {
      mode: 0o600,
    });
    // Atomic replacement: a reader sees either the old or the new document.
    await rename(temporary, path);
  }

  /**
   * Delete one record.
   * @param {string} table - table name.
   * @param {string} key - record key.
   * @returns {Promise<void>} resolution after deletion.
   */
  async deleteRecord(table, key) {
    await rm(this._path(table, key), { force: true });
  }

  /**
   * Write the global singleton.
   * @param {unknown} value - value.
   * @returns {Promise<void>} resolution after the rename.
   */
  async setGlobal(value) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const path = join(this.root, 'global.json');
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: UNIT_VERSION, value }), { mode: 0o600 });
    await rename(temporary, path);
  }

  /** @returns {Promise<void>} always resolves; the file store keeps no handle. */
  async close() {
    // Nothing to release: every write opened and closed its own file.
  }

  /**
   * @returns {boolean} always true: this unit owns key encoding.
   */
  get encodesKeys() {
    return true;
  }
}

/**
 * Bridge data domain: tasks, idempotent replies, notification outbox,
 * approvals, decisions, session authorization cache and wake accounting.
 *
 * Every mutation is a single-record durable write; callers persist a state
 * change *before* announcing it, which is what makes "no work is silently lost
 * on restart" true (§10.2).
 */
export class BridgeStore {
  /**
   * @param {object} options - store options.
   * @param {object} [options.storage] - host storage hub (`ctx.storage`), passed
   *   in by the composition root that declared it in `inject`. Never resolved
   *   from a context here: Cordis throws on an undeclared context property.
   * @param {string} [options.dataRoot] - absolute durable root for the file
   *   backend; required whenever `storage` is not supplied.
   * @param {Function} [options.now] - injectable clock.
   * @param {import('./log.js').Logger} [options.logger] - structured logger.
   */
  constructor(options) {
    this.storage = options.storage ?? null;
    this.dataRoot = options.dataRoot;
    this.now = options.now ?? (() => Date.now());
    this.logger = options.logger ?? defaultLogger.child('store');
    this._unit = null;
    this._closed = false;
    /** Write chain: the host unit does not serialize writes for callers. */
    this._writeChain = Promise.resolve();
  }

  /**
   * Open the unit.
   *
   * Precedence is fixed and never silent: a supplied storage hub is used or the
   * open fails, because silently writing to another location would split the
   * task history across two roots. Only when no hub is supplied — a CLI tool,
   * an isolated unit test, a profile that mounts no storage — is the durable
   * file backend used, and the reason is logged with the resolved root.
   * @returns {Promise<void>} resolution when open.
   * @throws {BridgeError} `internal_error` when a supplied hub cannot serve the
   *   unit, or when no usable durable root exists.
   */
  async init() {
    if (this._unit !== null) return;
    if (this.storage !== null) {
      this._unit = await this._openHostUnit();
      this.logger.info('store_open', { backend: 'host-json', tables: TABLES.length });
      return;
    }
    if (typeof this.dataRoot !== 'string' || this.dataRoot.trim().length === 0) {
      throw new BridgeError('internal_error', { details: { reason: 'storage_unavailable' } });
    }
    // Materialize the root now, exactly as the hub's json backend does on
    // `open`: an install whose data directory cannot be created must fail at
    // startup, not on the first task that arrives minutes later.
    try {
      await mkdir(this.dataRoot, { recursive: true, mode: 0o700 });
    } catch (error) {
      this.logger.failure('store_root_unwritable', error, {});
      throw new BridgeError('internal_error', { details: { reason: 'storage_root_unwritable' } });
    }
    this._unit = new FileUnit(this.dataRoot);
    this.logger.info('store_open', {
      backend: 'file-json',
      tables: TABLES.length,
      reason: 'no_storage_service',
    });
  }

  /**
   * Open the host storage unit, failing closed.
   *
   * A hub that is present but cannot serve this unit is a configuration error
   * the caller must see: continuing with a different backend would make
   * "persisted" mean two different things depending on the profile. The
   * registry itself throws `backend-not-found` for an unregistered name, so the
   * lookup is inside the same guarded region as the open.
   * @returns {Promise<HostUnit>} the opened unit.
   * @throws {BridgeError} `internal_error` when the backend is missing or refuses the unit.
   */
  async _openHostUnit() {
    try {
      const backend = this.storage.backend.get('json');
      if (backend?.kv === undefined) {
        throw new BridgeError('internal_error', { details: { reason: 'kv_backend_unavailable' } });
      }
      const unit = await backend.kv.open({
        name: UNIT_NAME,
        version: UNIT_VERSION,
        tables: TABLES,
        hasGlobal: true,
        layout: 'per-record',
      });
      return new HostUnit(unit);
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      // The host error carries the unit name and layout; neither is sensitive.
      this.logger.failure('store_host_unavailable', error, { unit: UNIT_NAME });
      throw new BridgeError('internal_error', { details: { reason: 'storage_open_failed' } });
    }
  }

  /**
   * Run one write after the previous one settled.
   * @param {() => Promise<T>} operation - write body.
   * @returns {Promise<T>} its result.
   * @template T
   */
  _serialized(operation) {
    const run = this._writeChain.then(operation);
    this._writeChain = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  /**
   * Read the whole snapshot once.
   * @returns {Promise<{tables: Record<string, Record<string, unknown>>, global: unknown}>} snapshot.
   */
  async snapshot() {
    if (this._unit === null) throw new BridgeError('not_ready');
    return this._unit.loadAll();
  }

  /**
   * Read every record of one table.
   * @param {string} table - table name.
   * @returns {Promise<object[]>} records.
   */
  async list(table) {
    const snapshot = await this.snapshot();
    const records = snapshot.tables[table] ?? {};
    return Object.values(records);
  }

  /**
   * Read one record.
   * @param {string} table - table name.
   * @param {string} key - logical key.
   * @returns {Promise<unknown|null>} record, or null when absent.
   */
  async get(table, key) {
    const snapshot = await this.snapshot();
    return snapshot.tables[table]?.[key] ?? null;
  }

  /**
   * Upsert one record durably.
   * @param {string} table - table name.
   * @param {string} key - logical key.
   * @param {unknown} value - record value.
   * @returns {Promise<void>} resolution after durability.
   */
  async put(table, key, value) {
    if (this._closed) throw new BridgeError('draining');
    if (this._unit === null) throw new BridgeError('not_ready');
    // Capture the unit the guard just validated: the queued write runs after
    // this call returns, and re-reading `this._unit` inside the closure would
    // re-open the window `close()` closes (it clears `_unit` after draining).
    const unit = this._unit;
    return this._serialized(() => unit.putRecord(table, key, value));
  }

  /**
   * Delete one record durably.
   * @param {string} table - table name.
   * @param {string} key - logical key.
   * @returns {Promise<void>} resolution after deletion.
   */
  async delete(table, key) {
    if (this._closed) throw new BridgeError('draining');
    if (this._unit === null) throw new BridgeError('not_ready');
    // Same capture as `put()`: the deletion belongs to the unit opened at call
    // time, not to whatever `_unit` holds when the queued write finally runs.
    const unit = this._unit;
    return this._serialized(() => unit.deleteRecord(table, key));
  }

  /**
   * Upsert a task record.
   *
   * `updated_at` is owned by the store, not by the caller: it is stamped with
   * the store clock on every write, which is the same clock retention is
   * measured against. Callers that pass their own `updated_at` (business code
   * does, for readability) do not get to rewind a record's age — trusting a
   * supplied timestamp would let a stale `updated_at` from a peer, a restored
   * record or a buggy caller make a live task look expired, or make an old
   * record look fresh and outlive its window forever.
   * @param {object} task - task record with `task_id`.
   * @returns {Promise<void>} resolution after durability.
   */
  async putTask(task) {
    await this.put('tasks', task.task_id, { ...task, updated_at: new Date(this.now()).toISOString() });
  }

  /**
   * Read one task.
   * @param {string} taskId - task identifier.
   * @returns {Promise<object|null>} task record.
   */
  async getTask(taskId) {
    return /** @type {Promise<object|null>} */ (this.get('tasks', taskId));
  }

  /**
   * List unfinished tasks, newest first (§9.5).
   * @param {number} [limit] - page size.
   * @param {string|null} [cursor] - `updated_at` cursor of the previous page.
   * @returns {Promise<{tasks: object[], next_cursor: string|null}>} page.
   */
  async listOpenTasks(limit = 50, cursor = null) {
    const tasks = (await this.list('tasks'))
      .filter((task) => !TERMINAL_STATUSES.includes(task.status))
      .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)));
    const start = cursor === null ? 0 : tasks.findIndex((task) => task.updated_at === cursor) + 1;
    const page = tasks.slice(start, start + limit);
    const next = start + limit < tasks.length ? page.at(-1)?.updated_at ?? null : null;
    return { tasks: page, next_cursor: next };
  }

  /**
   * Apply one task state transition.
   *
   * The transition table is checked before writing, so an illegal transition
   * from the peer is dropped instead of corrupting local state (§16.1).
   * @param {string} taskId - task identifier.
   * @param {string} toStatus - target status.
   * @param {object} [patch] - additional fields to persist.
   * @returns {Promise<object>} the updated task.
   * @throws {BridgeError} `task_not_found` for an unknown task.
   */
  async transition(taskId, toStatus, patch = {}) {
    const task = await this.getTask(taskId);
    if (task === null) throw new BridgeError('task_not_found');
    const allowed = TASK_TRANSITIONS[task.status] ?? [];
    if (task.status !== toStatus && !allowed.includes(toStatus)) {
      this.logger.warn('illegal_transition', {
        task: taskId,
        from: task.status,
        to: toStatus,
      });
      return task;
    }
    const next = {
      ...task,
      ...patch,
      status: toStatus,
      updated_at: new Date(this.now()).toISOString(),
    };
    await this.putTask(next);
    return next;
  }

  /**
   * Cache one idempotent reply under `(conn, m, id)` (§10.1).
   * @param {string} key - `${conn}:${m}:${id}`.
   * @param {object} reply - reply message.
   * @param {number} [ttlMs] - retention.
   * @returns {Promise<void>} resolution after durability.
   */
  async cacheReply(key, reply, ttlMs = 24 * 60 * 60 * 1000) {
    await this.put('replies', key, { reply, expires_at: this.now() + ttlMs });
  }

  /**
   * Read a cached reply when it is still fresh.
   * @param {string} key - reply key.
   * @returns {Promise<object|null>} cached reply.
   */
  async getCachedReply(key) {
    // `get()` returns the opaque stored value; `cacheReply()` is the only
    // writer of this table, so the ReplyRecord shape below is what a hit is.
    const record = /** @type {ReplyRecord|null} */ (await this.get('replies', key));
    if (record === null || record.expires_at <= this.now()) return null;
    return record.reply;
  }

  /**
   * Append one notification to the outbox before sending it (§10.3).
   * @param {string} notifyId - notification identity.
   * @param {object} payload - business payload.
   * @returns {Promise<void>} resolution after durability.
   */
  async enqueueNotify(notifyId, payload) {
    await this.put('notifies', notifyId, {
      notify_id: notifyId,
      payload,
      attempts: 0,
      delivered: false,
      next_at: this.now(),
      created_at: new Date(this.now()).toISOString(),
    });
  }

  /**
   * Mark a notification delivered after its ack arrives.
   * @param {string} notifyId - notification identity.
   * @returns {Promise<boolean>} whether a pending record was updated.
   */
  async markDelivered(notifyId) {
    const record = /** @type {NotifyRecord|null} */ (await this.get('notifies', notifyId));
    if (record === null) return false;
    await this.put('notifies', notifyId, { ...record, delivered: true });
    return true;
  }

  /**
   * Record one failed delivery attempt and schedule the next one (§10.3).
   * @param {string} notifyId - notification identity.
   * @returns {Promise<object|null>} updated record.
   */
  async markAttempt(notifyId) {
    const record = /** @type {NotifyRecord|null} */ (await this.get('notifies', notifyId));
    if (record === null) return null;
    const attempts = (record.attempts ?? 0) + 1;
    const backoff = Limits.NOTIFY_BACKOFF_S[Math.min(attempts - 1, Limits.NOTIFY_BACKOFF_S.length - 1)];
    const next = {
      ...record,
      attempts,
      next_at: this.now() + backoff * 1000,
      undelivered: attempts >= Limits.NOTIFY_MAX_ATTEMPTS,
    };
    await this.put('notifies', notifyId, next);
    return next;
  }

  /**
   * Pending, due notifications.
   * @param {number} [limit] - page size.
   * @returns {Promise<object[]>} records.
   */
  async pendingNotifies(limit = 32) {
    const now = this.now();
    return (await this.list('notifies'))
      .filter((record) => record.delivered !== true && record.next_at <= now)
      .sort((left, right) => left.next_at - right.next_at)
      .slice(0, limit);
  }

  /**
   * Upsert an approval request record.
   * @param {object} approval - record with `approval_id`.
   * @returns {Promise<void>} resolution after durability.
   */
  async putApproval(approval) {
    await this.put('approvals', approval.approval_id, approval);
  }

  /**
   * Read one approval record.
   * @param {string} approvalId - approval identity.
   * @returns {Promise<object|null>} record.
   */
  async getApproval(approvalId) {
    return /** @type {Promise<object|null>} */ (this.get('approvals', approvalId));
  }

  /**
   * Record the first decision for an approval and refuse every later one.
   * @param {string} approvalId - approval identity.
   * @param {object} decision - `{outcome, actor, actor_kind, channel, reason, decided_at}`.
   * @returns {Promise<{applied: boolean, reason: string|null, record: object}>} outcome.
   */
  async decideApproval(approvalId, decision) {
    if (this._closed) throw new BridgeError('draining');
    if (this._unit === null) throw new BridgeError('not_ready');
    // The read and the write must be one serialized unit: a read outside the
    // write chain lets two callers both observe `decided !== true` and both
    // apply, and the last write silently rewrites the human's answer. The write
    // is issued straight to the unit on purpose — calling `putApproval()` here
    // would enqueue behind the operation that is running and deadlock.
    const unit = this._unit;
    return this._serialized(async () => {
      const snapshot = await unit.loadAll();
      const record = /** @type {Record<string, any>|null} */ (
        snapshot.tables.approvals?.[approvalId] ?? null
      );
      if (record === null) {
        throw new BridgeError('approval_mismatch', { details: { field: 'approval_id' } });
      }
      if (record.decided === true) {
        // Report the durable winner, not this caller's attempted answer: the
        // caller uses the returned record to settle a waiter, and a loser must
        // never settle it with its own (discarded) decision.
        return { applied: false, reason: 'already_answered', record };
      }
      if (decision?.actor_kind === 'human') {
        const expires = Date.parse(String(record.expires_at ?? ''));
        if (!Number.isFinite(expires) || expires <= this.now()) {
          // A human answer may never settle a row whose deadline has passed or
          // cannot be parsed. System settlement (timeout/channel loss) is
          // deliberately exempt: it is the path that turns expiry into
          // `rejected`/`unavailable` in the first place.
          return { applied: false, reason: 'expired', record };
        }
      }
      const next = { ...record, decided: true, decision };
      await unit.putRecord('approvals', approvalId, next);
      return { applied: true, reason: null, record: next };
    });
  }

  /**
   * Persist a trusted `peer_lookup` mirror, or enrich an existing peer mirror.
   *
   * A lookup answer may only ever be attached to a row this endpoint did **not**
   * open itself (`source !== 'local'`). A local gate is this side's own
   * authority and is never rewritten from the wire. An existing peer mirror is
   * upgraded with the authoritative digest/session/decision; a mirror that
   * already carries evidence may only refresh its deadline when the evidence is
   * identical, so a repeated lookup can never reset `consumed_by_task` (the
   * one-shot latch) or replace a different human decision.
   * @param {object} approval - mirror row, including `decision`/`evidence`.
   * @returns {Promise<object|null>} the stored row, or null when it cannot be
   *   imported without overwriting local authority or conflicting evidence.
   * @throws {BridgeError} `draining` / `not_ready` when the store cannot write.
   */
  async importApprovalMirror(approval) {
    const approvalId = String(approval?.approval_id ?? '');
    const submitDigest = String(approval?.submit_digest ?? '');
    const expires = Date.parse(String(approval?.expires_at ?? ''));
    const decidedAt = Date.parse(String(approval?.decision?.decided_at ?? ''));
    if (
      approvalId.length === 0 ||
      submitDigest.length === 0 ||
      approval?.approval_type !== 'cross_end_submit' ||
      approval?.decision?.actor_kind !== 'human' ||
      typeof approval?.decision?.actor !== 'string' ||
      approval.decision.actor.length === 0 ||
      !Number.isFinite(expires) ||
      !Number.isFinite(decidedAt)
    ) {
      return null;
    }
    if (this._closed) throw new BridgeError('draining');
    if (this._unit === null) throw new BridgeError('not_ready');
    const unit = this._unit;
    return this._serialized(async () => {
      const snapshot = await unit.loadAll();
      const existing = /** @type {Record<string, any>|null} */ (
        snapshot.tables.approvals?.[approvalId] ?? null
      );
      if (existing !== null && existing.source === 'local') return null;
      if (existing !== null) {
        if (existing.approval_type !== approval.approval_type) return null;
        for (const field of ['task_id', 'root_task_id', 'session_id']) {
          const current = existing[field];
          const incoming = approval[field];
          if (current === undefined || current === null) continue;
          if (incoming === undefined || incoming === null) continue;
          if (String(current) !== String(incoming)) return null;
        }
        if (
          typeof existing.conn === 'string' &&
          existing.conn.length > 0 &&
          existing.conn !== approval.conn
        ) {
          // A row bound to another authenticated session cannot be enriched
          // into evidence for this one.
          return null;
        }
        if (
          existing.submit_digest !== undefined &&
          existing.submit_digest !== null &&
          String(existing.submit_digest) !== submitDigest
        ) {
          return null;
        }
        if (existing.evidence !== undefined && existing.evidence !== null) {
          const same =
            String(existing.submit_digest ?? '') === submitDigest &&
            existing.decision?.outcome === approval.decision?.outcome &&
            existing.decision?.actor === approval.decision?.actor &&
            existing.decision?.actor_kind === approval.decision?.actor_kind &&
            existing.conn === approval.conn &&
            String(existing.decision?.decided_at ?? '') ===
              String(approval.decision?.decided_at ?? '');
          if (!same) return null;
          // Same authoritative answer: only the authority's deadline may move.
          // `consumed_by_task`/`consumed_at` stay exactly as the receiver wrote.
          const refreshed = { ...existing, evidence: approval.evidence, expires_at: approval.expires_at };
          await unit.putRecord('approvals', approvalId, refreshed);
          return refreshed;
        }
        const enriched = {
          ...existing,
          source: 'peer_lookup',
          submit_digest: submitDigest,
          evidence: approval.evidence,
          conn: approval.conn,
          released_by_task: approval.released_by_task ?? null,
          decided: true,
          decision: approval.decision,
          expires_at: approval.expires_at,
          origin_side: approval.origin_side,
        };
        await unit.putRecord('approvals', approvalId, enriched);
        return enriched;
      }
      const inserted = {
        ...approval,
        source: 'peer_lookup',
        decided: true,
        consumed_by_task: null,
        consumed_at: null,
      };
      await unit.putRecord('approvals', approvalId, inserted);
      return inserted;
    });
  }

  /**
   * Upsert a business decision record.
   * @param {object} decision - record with `decision_id`.
   * @returns {Promise<void>} resolution after durability.
   */
  async putDecision(decision) {
    await this.put('decisions', decision.decision_id, decision);
  }

  /**
   * Record the first answer to a decision (§9.8).
   * @param {string} decisionId - decision identity.
   * @param {object} answer - `{choice, free_text, actor, actor_kind, answered_at}`.
   * @returns {Promise<{applied: boolean, reason: string|null, record: object}>} outcome.
   * @throws {BridgeError} `task_not_found` when the decision is unknown.
   */
  async answerDecision(decisionId, answer) {
    if (this._closed) throw new BridgeError('draining');
    if (this._unit === null) throw new BridgeError('not_ready');
    // Same serialized read-check-write as `decideApproval`: the first answer is
    // the durable winner, and a concurrent answer sees that winner instead of
    // overwriting it. Direct unit access avoids waiting on the running write.
    const unit = this._unit;
    return this._serialized(async () => {
      const snapshot = await unit.loadAll();
      const record = /** @type {Record<string, any>|null} */ (
        snapshot.tables.decisions?.[decisionId] ?? null
      );
      if (record === null) throw new BridgeError('task_not_found');
      if (record.answered === true) {
        return { applied: false, reason: 'already_answered', record };
      }
      if (record.expires_at !== undefined && record.expires_at !== null) {
        const expires = Date.parse(String(record.expires_at));
        if (!Number.isFinite(expires) || expires <= this.now()) {
          return { applied: false, reason: 'expired', record };
        }
      }
      const next = { ...record, answered: true, answer };
      await unit.putRecord('decisions', decisionId, next);
      return { applied: true, reason: null, record: next };
    });
  }

  /**
   * Consume one approval exactly once, for exactly one task (§12.1).
   *
   * The read-check-write is serialized with the store's write chain, so two
   * submissions cannot both observe `consumed_by_task` empty and both claim the
   * same human decision. The first claim is the durable winner; every later
   * claim reports `false` and must execute nothing.
   * @param {string} approvalId - approval identity.
   * @param {string} taskId - task claiming the decision.
   * @returns {Promise<boolean>} whether this call recorded the consumption.
   * @throws {BridgeError} `draining` / `not_ready` when the store cannot write.
   */
  async claimApprovalConsumption(approvalId, taskId) {
    if (this._closed) throw new BridgeError('draining');
    if (this._unit === null) throw new BridgeError('not_ready');
    const unit = this._unit;
    return this._serialized(async () => {
      const snapshot = await unit.loadAll();
      const record = /** @type {Record<string, any>|null} */ (
        snapshot.tables.approvals?.[approvalId] ?? null
      );
      if (record === null) return false;
      const winner = String(record.consumed_by_task ?? '');
      if (winner.length > 0) return false;
      await unit.putRecord('approvals', approvalId, {
        ...record,
        consumed_by_task: String(taskId),
        consumed_at: new Date(this.now()).toISOString(),
      });
      return true;
    });
  }

  /**
   * Claim initiator-domain release exactly once (§12.7.4).
   *
   * `released_by_task` is the initiator's own consumption domain and must never
   * be confused with the receiver's `consumed_by_task`. The conditional write is
   * serialized with every other store write, so a second sender cannot release
   * the same gate for another submission.
   * @param {string} approvalId - approval identity.
   * @param {string} taskId - submission the gate is released for.
   * @returns {Promise<boolean>} whether this call recorded the release.
   * @throws {BridgeError} `draining` / `not_ready` when the store cannot write.
   */
  async claimApprovalRelease(approvalId, taskId) {
    if (this._closed) throw new BridgeError('draining');
    if (this._unit === null) throw new BridgeError('not_ready');
    const unit = this._unit;
    return this._serialized(async () => {
      const snapshot = await unit.loadAll();
      const record = /** @type {Record<string, any>|null} */ (
        snapshot.tables.approvals?.[approvalId] ?? null
      );
      if (record === null) return false;
      const winner = String(record.released_by_task ?? '');
      if (winner.length > 0) return false;
      await unit.putRecord('approvals', approvalId, {
        ...record,
        released_by_task: String(taskId),
      });
      return true;
    });
  }

  /**
   * Read the current session authorization snapshot (§9.7).
   *
   * `instance_id` / `instance_started_at` name the authority instance that
   * produced the table and when it started (v0.2 R1). A record written before
   * the fields existed reports `null`, which makes the acceptance rule fall back
   * to version monotonicity.
   * @returns {Promise<{version: number, instance_id: string|null,
   *   instance_started_at: number|null, grants: object[],
   *   allow_agent_create: boolean, max_agent_sessions: number}>} snapshot.
   */
  async authzSnapshot() {
    const record = /** @type {AuthzRecord|null} */ (await this.get('authz', 'current'));
    if (record === null) {
      return {
        version: 0,
        instance_id: null,
        instance_started_at: null,
        grants: [],
        allow_agent_create: false,
        max_agent_sessions: 0,
      };
    }
    return {
      ...record,
      instance_id: record.instance_id ?? null,
      instance_started_at: record.instance_started_at ?? null,
    };
  }

  /**
   * Apply an authorization push (§9.7).
   *
   * The version is monotonic only *within one authority instance*. Recreating
   * the peer database restarts `version` at 0, so a snapshot from a different
   * `instance_id` may replace the table at a lower version. That is allowed
   * only when `instance_started_at` proves the pushed instance is strictly
   * newer; otherwise a replayed old snapshot could roll the table back forever
   * (the version-only rule cannot order two instances).
   *
   * A cached table written by v0.1 carries no identity. Its first complete
   * pushed identity (id plus a valid start) is accepted and recorded even at a
   * lower version (rule 0): there is no cached instance to order, and the
   * frame layer's replay window rules out a replay. From then on the rollback
   * guard applies. In that state, a push carrying an id but no usable start
   * falls back to the version-only rule and records no identity.
   *
   * This adds no trust assumption: the push still arrives over the
   * authenticated channel from the sole authorization authority, and the stored
   * grants still come one-for-one from that authority. `instance_started_at` is
   * an ordering hint, not a credential.
   *
   * The read-check-write is serialized with the store's write chain so two
   * concurrent pushes cannot both read the old table and let the lower-version
   * one overwrite the higher-version one.
   * @param {{version: number, instance_id?: string|null,
   *   instance_started_at?: number|null, grants?: object[], revoked?: string[],
   *   allow_agent_create?: boolean, max_agent_sessions?: number}} params -
   *   pushed snapshot.
   * @returns {Promise<{applied: boolean, version: number}>} outcome.
   * @throws {BridgeError} `bad_params` for a non-integer version; `draining` /
   *   `not_ready` when the store cannot write.
   */
  async applyAuthz(params) {
    if (this._closed) throw new BridgeError('draining');
    if (this._unit === null) throw new BridgeError('not_ready');
    if (!Number.isInteger(params?.version)) {
      throw new BridgeError('bad_params', { details: { field: 'version' } });
    }
    const unit = this._unit;
    return this._serialized(async () => {
      const snapshot = await unit.loadAll();
      const record = /** @type {AuthzRecord|null} */ (snapshot.tables.authz?.current ?? null);
      const current =
        record === null
          ? {
              version: 0,
              instance_id: null,
              instance_started_at: null,
              grants: [],
              allow_agent_create: false,
              max_agent_sessions: 0,
            }
          : {
              ...record,
              instance_id: record.instance_id ?? null,
              instance_started_at: record.instance_started_at ?? null,
            };

      /**
       * Normalize an instance id; anything but a non-empty string is absent.
       * @param {unknown} raw - candidate value.
       * @param {'cache'|'push'} source - which side supplied it.
       * @returns {string|null} usable id.
       */
      const readInstance = (raw, source) => {
        if (raw === undefined || raw === null) return null;
        if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim();
        this.logger.warn('authz_instance_id_invalid', { source, type: typeof raw });
        return null;
      };
      /**
       * Normalize a start timestamp; only a non-negative integer orders instances.
       * @param {unknown} value - candidate value.
       * @returns {number|null} usable timestamp.
       */
      const readStartedAt = (value) =>
        typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;

      const currentInstance = readInstance(current.instance_id, 'cache');
      const pushedInstance = readInstance(params.instance_id, 'push');
      const currentStartedAt = readStartedAt(current.instance_started_at);
      const pushedStartedAt = readStartedAt(params.instance_started_at);

      let identity;
      if (currentInstance === null) {
        // Rule 0 (v0.1 upgrade path): the cached table has no comparable
        // identity, so it can only have been written before this side learned
        // about authority instances. A complete pushed identity (id plus a
        // valid start) is accepted and recorded even when its version is lower;
        // the frame layer's seq replay window rules out a replayed frame here.
        // A push carrying an id but no usable start cannot order anything, so
        // it falls through to the version-only rule and records no identity.
        if (pushedInstance !== null && pushedStartedAt !== null) {
          identity = { instance_id: pushedInstance, instance_started_at: pushedStartedAt };
        } else {
          if (params.version <= current.version) {
            return { applied: false, version: current.version };
          }
          identity = { instance_id: null, instance_started_at: null };
        }
      } else if (pushedInstance === null) {
        // Rule 1 (v0.1 fallback): no usable pushed identity, so only a strictly
        // higher version applies. The cached identity is never switched.
        if (params.version <= current.version) {
          return { applied: false, version: current.version };
        }
        identity = { instance_id: currentInstance, instance_started_at: currentStartedAt };
      } else if (currentInstance === pushedInstance) {
        // Rule 2: same instance, strict version monotonicity.
        if (params.version <= current.version) {
          return { applied: false, version: current.version };
        }
        identity = { instance_id: currentInstance, instance_started_at: currentStartedAt };
      } else {
        // Rules 3/4: a different instance is only a rebuild when its start is
        // strictly later. Missing/equal/earlier starts cannot be ordered, so
        // the old table is kept: never degrade an authority on an unprovable
        // switch.
        if (
          currentStartedAt === null ||
          pushedStartedAt === null ||
          pushedStartedAt <= currentStartedAt
        ) {
          this.logger.warn('authz_instance_rollback_refused', {
            cached_started_at: currentStartedAt ?? -1,
            pushed_started_at: pushedStartedAt ?? -1,
            version: params.version,
          });
          return { applied: false, version: current.version };
        }
        identity = { instance_id: pushedInstance, instance_started_at: pushedStartedAt };
      }

      const revoked = new Set((params.revoked ?? []).map(String));
      const grants = (params.grants ?? []).filter((grant) => !revoked.has(String(grant.session_id)));
      const next = {
        version: params.version,
        instance_id: identity.instance_id,
        instance_started_at: identity.instance_started_at,
        grants,
        allow_agent_create: params.allow_agent_create ?? false,
        max_agent_sessions: params.max_agent_sessions ?? 0,
      };
      await unit.putRecord('authz', 'current', next);
      return { applied: true, version: params.version };
    });
  }

  /**
   * Whether one session is currently authorized (§9.7).
   * @param {string} sessionId - session identity.
   * @returns {Promise<boolean>} authorization result.
   */
  async isAuthorized(sessionId) {
    const snapshot = await this.authzSnapshot();
    const now = this.now();
    return snapshot.grants.some((grant) => {
      if (String(grant.session_id) !== String(sessionId)) return false;
      if (grant.expires_at === null || grant.expires_at === undefined) return true;
      return Date.parse(String(grant.expires_at)) > now;
    });
  }

  /**
   * Count agent-auto-created sessions, for quota enforcement (§9.7).
   * @returns {Promise<number>} current count.
   */
  async countAgentSessions() {
    const snapshot = await this.authzSnapshot();
    return snapshot.grants.filter((grant) => grant.granted_by === 'agent_auto').length;
  }

  /**
   * Count one automatic wake for a root task and enforce the chain limit (§16.6).
   * @param {string} rootTaskId - root task identity.
   * @param {string} sessionKey - target session key.
   * @param {object} [options] - limits.
   * @param {number} [options.maxChain] - chain limit.
   * @param {number} [options.ratePerMinute] - sliding-window rate limit.
   * @returns {Promise<{allowed: boolean, code: string|null, count: number}>} decision.
   */
  async bumpWake(rootTaskId, sessionKey, options = {}) {
    const maxChain = options.maxChain ?? 8;
    const ratePerMinute = options.ratePerMinute ?? 10;
    // This method is the only writer of the `wake` table, so an absent record
    // means "never woken yet" and a present one is a WakeRecord.
    const record = /** @type {WakeRecord} */ (
      (await this.get('wake', rootTaskId)) ?? {
        root_task_id: rootTaskId,
        count: 0,
        window: {},
      }
    );
    if (record.count >= maxChain) return { allowed: false, code: 'wake_chain_exceeded', count: record.count };

    const now = this.now();
    /** @type {Record<string, number[]>} recent wake stamps per session */
    const window = {};
    for (const [key, stamps] of Object.entries(record.window ?? {})) {
      const recent = stamps.filter((at) => now - at < 60_000);
      if (recent.length > 0) window[key] = recent;
    }
    const stamps = window[sessionKey] ?? [];
    if (stamps.length >= ratePerMinute) {
      return { allowed: false, code: 'wake_rate_limited', count: record.count };
    }
    stamps.push(now);
    window[sessionKey] = stamps;
    const next = { ...record, count: record.count + 1, window };
    await this.put('wake', rootTaskId, next);
    return { allowed: true, code: null, count: next.count };
  }

  /**
   * Current automatic wake count for one root task.
   * @param {string} rootTaskId - root task identity.
   * @returns {Promise<number>} count.
   */
  async wakeCount(rootTaskId) {
    const record = /** @type {WakeRecord|null} */ (await this.get('wake', rootTaskId));
    return record?.count ?? 0;
  }

  /**
   * Delete expired records (§10.1 retention).
   *
   * The age of a record is measured against the store clock (`options.now`),
   * never against a timestamp supplied by a caller: every mutation through
   * {@link putTask} / {@link transition} stamps `updated_at` with that same
   * clock, so a record is old exactly when this store last touched it long ago.
   *
   * Deletion is deliberately conservative — the PRD fixes the window but not
   * the per-record rule, so only records that nobody can still need are
   * removed:
   *
   *   - tasks: terminal status *and* not flagged `needs_human` *and* not the
   *     subject of an undelivered outbox record, an undecided approval or an
   *     unanswered decision. A pending notification is work the resend loop
   *     still owns; a pending approval or decision is a question a human has
   *     not answered yet. Deleting the task first would leave that work with
   *     nothing to report against, and the peer's later answer would then be
   *     applied to a task that no longer exists.
   *   - notifications: only after they were delivered *and* are past the
   *     cutoff, so "at least once" delivery is never traded for disk space.
   *   - replies: only idempotency entries whose TTL expired before the cutoff.
   *
   * Every record is deleted by its **storage key** from one consistent
   * snapshot; deriving the key from a field inside the record (as an earlier
   * version did for replies) silently addressed the wrong document and left the
   * expired entry in place while still counting it.
   * @param {number} [retentionDays] - retention window in days.
   * @returns {Promise<number>} number of deleted records.
   */
  async cleanupExpired(retentionDays = 7) {
    const cutoff = this.now() - retentionDays * 24 * 60 * 60 * 1000;
    const snapshot = await this.snapshot();
    // Each table is read with the shape its own writer persists (`enqueueNotify`,
    // `putApproval`, `putDecision`, `putTask`, `cacheReply`); the optional
    // properties stay optional, so a partial record still reads as "field
    // absent" rather than being coerced into a default.
    const notifies = Object.entries(
      /** @type {Record<string, NotifyRecord>} */ (snapshot.tables.notifies ?? {}),
    );
    // Terminal tasks that a still-pending notification, approval or decision
    // points at are alive work, not history. Only unanswered work counts: a
    // decided approval or an answered decision no longer needs its task.
    const pending = new Set();
    for (const [, record] of notifies) {
      if (record?.delivered !== true && record?.payload?.task_id != null) {
        pending.add(String(record.payload.task_id));
      }
    }
    for (const [, record] of Object.entries(
      /** @type {Record<string, ApprovalRecord>} */ (snapshot.tables.approvals ?? {}),
    )) {
      if (record?.decided !== true && record?.task_id != null) pending.add(String(record.task_id));
    }
    for (const [, record] of Object.entries(
      /** @type {Record<string, DecisionRecord>} */ (snapshot.tables.decisions ?? {}),
    )) {
      if (record?.answered !== true && record?.task_id != null) pending.add(String(record.task_id));
    }
    let removed = 0;
    for (const [key, task] of Object.entries(
      /** @type {Record<string, TaskRecord>} */ (snapshot.tables.tasks ?? {}),
    )) {
      // A record whose status is absent or not a string is not terminal: the
      // membership test below used to be handed `undefined` and answered false.
      const status = task?.status;
      if (typeof status !== 'string' || !TERMINAL_STATUSES.includes(status)) continue;
      if (task.needs_human === true) continue;
      if (pending.has(String(task.task_id ?? key))) continue;
      if (!(Date.parse(String(task.updated_at)) <= cutoff)) continue;
      await this.delete('tasks', key);
      removed += 1;
    }
    for (const [key, record] of notifies) {
      // Only a delivered notification is history; a record without a scheduled
      // `next_at` was never queued for a retry and is left alone.
      if (record?.delivered === true && record.next_at !== undefined && record.next_at <= cutoff) {
        await this.delete('notifies', key);
        removed += 1;
      }
    }
    for (const [key, record] of Object.entries(
      /** @type {Record<string, ReplyRecord>} */ (snapshot.tables.replies ?? {}),
    )) {
      if (record?.expires_at <= cutoff) {
        await this.delete('replies', key);
        removed += 1;
      }
    }
    return removed;
  }

  /**
   * Drain pending writes and close the unit.
   * @returns {Promise<void>} resolution after close.
   */
  async close() {
    if (this._closed) return;
    this._closed = true;
    await this._writeChain;
    if (this._unit !== null) await this._unit.close();
    this._unit = null;
  }
}

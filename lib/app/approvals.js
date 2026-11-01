/**
 * Approval and decision service (protocol §12, §9.8, and the native-approval
 * settlement rules in `开发/v0.1/native-approval-id-decision.md`).
 *
 * Three invariants dominate this module:
 *
 *   1. **Nothing is ever auto-approved.** A request is only settled by a human
 *      answer, or by a fail-closed terminal event (deadline → `rejected`,
 *      withdrawal → `cancelled`, channel loss → `unavailable`).
 *   2. **One answer per request.** The bridge-generated `approval_id` is the
 *      settlement key: the first authoritative answer wins and every later one
 *      is recorded as discarded.
 *   3. **A bridge approval handle dies with its process and its sid.** A resumed
 *      session, or a reconnect that produced a new `sid`, can never settle an
 *      old handle: those become `unavailable` and are never re-asked.
 *   4. **Only A's authorization table decides whether a session may be
 *      claimed.** The table is cached synchronously (it is consulted inside the
 *      waterfall listener, before any `await`), replaced on every applied push,
 *      and never inferred from the local agent registry.
 * @module dsh-plugin-astrbot-bridge/app/approvals
 */

import { randomUUID } from 'node:crypto';

import { asBridgeError, BridgeError } from '../errors.js';
import { ApprovalOutcome, ApprovalType, Limits, MessageName, TaskEvent, TaskStatus } from '../constants.js';
import { approvalRequestDigest, inputPartsDigest, submitDigest } from '../crypto.js';

/** Approval service. */
export class ApprovalService {
  /**
   * @param {object} options - service dependencies.
   * @param {object} options.store - bridge store.
   * @param {object} options.session - session bound to the peer.
   * @param {object} options.host - agent host adapter (used only for wake-ups).
   * @param {object} options.notify - notification service.
   * @param {object} options.config - bridge configuration.
   * @param {boolean} [options.remoteApprovalEnabled] - whether this side claims
   *   harness-native approvals and forwards them to the peer's human. Defaults
   *   to `false`: a deployment that never mounts the host approval service must
   *   not advertise the capability.
   * @param {import('../log.js').LoggerLike} [options.logger] - structured logger
   *   (a silent stub satisfying the same surface is accepted).
   * @param {Function} [options.now] - injectable clock.
   */
  constructor(options) {
    this.store = options.store;
    this.session = options.session;
    this.host = options.host;
    this.notify = options.notify;
    this.config = options.config;
    //: Local protocol side. Record and wire `origin_side` values are stamped
    //: from this, never from a payload or a hard-coded literal.
    this._side = options.config?.side === 'A' ? 'A' : 'B';
    this.logger = options.logger ?? { info() {}, warn() {}, failure() {}, debug() {}, error() {} };
    this.now = options.now ?? (() => Date.now());
    /** Bridge that owns the claimed harness requests, once attached. */
    this._bridge = null;
    this._timeoutTimer = null;
    this._disposer = null;
    /** `(conn, sid)` that currently owns this side's native approvals. */
    this._sessionKey = null;
    /** Whether this side advertises and uses remote native approval. */
    this.remoteApprovalEnabled = options.remoteApprovalEnabled === true;
    /**
     * Synchronous view of A's authorization table: `session_id → expiry` (ms,
     * or `null` for a standing grant). Empty means "nothing is authorized",
     * never "do not filter" — an empty table must deny, not allow.
     */
    this._authz = new Map();
    /** Version of the table in `_authz`; a lower push never replaces it. */
    this._authzVersion = 0;
    /**
     * Settlement handlers of `cross_end_submit` approvals this side opened for a
     * held submission, keyed by `approval_id` (§12.5 point 5).
     *
     * The handler is the task service's release/reject step. It is invoked
     * exactly once — when the first authoritative answer is applied — and never
     * for a request claimed from the harness (those settle through
     * `_bridge`).
     * @type {Map<string, (record: object, allowed: boolean) => unknown>}
     */
    this._submitWaiters = new Map();
    /**
     * Durable settlement of gates that belonged to a previous connection.
     * `onSessionReady`/`onSessionLost` are synchronous callbacks, so the store
     * work is chained here and `attach()` awaits it before any new request can
     * be claimed.
     * @type {Promise<void>}
     */
    this._pendingSettlements = Promise.resolve();
    /**
     * Serializes the read-check-write of an initiating gate release, so two
     * concurrent releases of the same approval cannot both send a submission.
     * @type {Promise<void>}
     */
    this._releaseChain = Promise.resolve();
  }

  /** `(conn, sid)` that currently owns this side's approvals. */
  get sessionKey() {
    return this._sessionKey;
  }

  /**
   * Whether one approval row was opened on the connection bound right now.
   * @param {object} record - approval row.
   * @returns {boolean} whether the row belongs to the live connection.
   */
  ownsApproval(record) {
    return this._sessionKey !== null && record?.conn === this._sessionKey;
  }

  /**
   * Refresh the synchronous authorization cache from the persisted peer table.
   *
   * `_canClaim` runs inside the waterfall listener before any `await`, so it
   * cannot call `store.isAuthorized()`; this cache is the only synchronous view
   * of A's authority. It is loaded at attach time (so a reconnect resumes from
   * the last authoritative push) and rebuilt after every applied
   * `session.authz`, which is what makes a revocation effective on the very next
   * claim. Versions only move forward: a stale frame cannot resurrect a grant.
   * @returns {Promise<{version: number, count: number}>} cached table state.
   */
  async syncAuthz() {
    let snapshot;
    try {
      snapshot = await this.store.authzSnapshot();
    } catch (error) {
      // "Unknown" is not "allowed": an unreadable table drops every grant and
      // makes the next claim delegate to the local answerer.
      this._authz = new Map();
      this.logger.failure('approvals_authz_sync_failed', error, { conn: this._sessionKey });
      return { version: this._authzVersion, count: 0 };
    }
    const version = Number.isInteger(snapshot?.version) ? snapshot.version : 0;
    if (version < this._authzVersion) {
      return { version: this._authzVersion, count: this._authz.size };
    }
    const grants = new Map();
    for (const grant of snapshot?.grants ?? []) {
      const sessionId = grant?.session_id;
      if (sessionId === undefined || sessionId === null) continue;
      const raw = grant.expires_at;
      const expires = raw === undefined || raw === null ? null : Date.parse(String(raw));
      // A malformed deadline is not a standing grant: leave the session out.
      if (expires !== null && !Number.isFinite(expires)) continue;
      grants.set(String(sessionId), expires);
    }
    this._authz = grants;
    this._authzVersion = version;
    return { version, count: grants.size };
  }

  /**
   * Whether one session is inside A's authorization table right now.
   *
   * Synchronous by contract: it is only ever consulted before the first
   * `await` of a claim decision.
   * @param {string} sessionId - session identity.
   * @returns {boolean} whether the session may be claimed at this instant.
   */
  _isAuthorizedSync(sessionId) {
    if (!this._authz.has(sessionId)) return false;
    const expiresAt = this._authz.get(sessionId);
    return expiresAt === null || expiresAt > this.now();
  }

  /**
   * Record the live `(conn, sid)` and fail every handle from a previous one.
   *
   * A new `sid` means a fresh handshake, so any request claimed under the old
   * one has no reachable answer channel. Its handle is settled `unavailable`
   * locally, which is the only honest conclusion (§5 of the settlement rules).
   * @param {string} conn - connection identity.
   * @param {string} sid - current session identity.
   * @returns {number} number of handles failed by the switch.
   */
  onSessionReady(conn, sid) {
    const nextKey = `${conn}|${sid}`;
    if (this._sessionKey === nextKey) return 0;
    const previous = this._sessionKey;
    this._sessionKey = nextKey;
    // A first bind after a process restart also finds a batch of pending rows
    // from the dead process (their `conn` names it). Reconciling on every new
    // key, including the first, is what stops them from staying answerable or
    // parking a task forever.
    this._invalidatePendingGates(previous === null ? 'restart' : 'new_sid', nextKey);
    if (previous === null || this._bridge === null) return 0;
    const failed = this._bridge.failAll('session');
    if (failed > 0) {
      this.logger.warn('approvals_failed_on_new_sid', { conn, count: failed });
    }
    return failed;
  }

  /**
   * Clear the bound `(conn, sid)` and fail every claimed handle.
   *
   * Called when the carrier leaves `ready` (disconnect, drain, close,
   * degradation) and on shutdown. The key is cleared as well, because a claim
   * made while no session is bound has no way back to its answerer.
   * @returns {number} number of handles failed.
   */
  onSessionLost() {
    this._sessionKey = null;
    this._invalidatePendingGates('channel', null);
    if (this._bridge === null) return 0;
    return this._bridge.failAll('channel');
  }

  /**
   * Fail closed every gate that belonged to a connection that is gone.
   *
   * Pending approvals become `unavailable`; an allowed gate whose release step
   * was lost to the restart is *not* replayed (never auto-execute), it is parked
   * as `needs_human` and spent so no `approval_ref` can borrow it. A held local
   * task receives a durable `task.event`; a mirrored gate only records the
   * closure locally because the peer owns that task's status.
   * @param {string} reason - `restart` / `new_sid` / `channel`.
   * @param {string|null} currentKey - the connection that may still own gates.
   * @returns {void}
   */
  _invalidatePendingGates(reason, currentKey) {
    this._pendingSettlements = this._pendingSettlements
      .then(async () => {
        const records = await this.store.list('approvals');
        for (const record of records) {
          if (record.approval_type === ApprovalType.NATIVE_TOOL) {
            if (record.decided === true) continue;
            if (currentKey !== null && record.conn === currentKey) continue;
            await this.store.decideApproval(record.approval_id, {
              outcome: ApprovalOutcome.UNAVAILABLE,
              actor: 'system',
              actor_kind: 'system',
              channel: reason,
              reason: `approval channel lost (${reason})`,
              decided_at: new Date(this.now()).toISOString(),
            });
            continue;
          }
          if (record.approval_type !== ApprovalType.CROSS_END_SUBMIT) continue;
          if (record.decided !== true) {
            if (currentKey !== null && record.conn === currentKey) continue;
            const settled = await this.store.decideApproval(record.approval_id, {
              outcome: ApprovalOutcome.UNAVAILABLE,
              actor: 'system',
              actor_kind: 'system',
              channel: reason,
              reason: `approval channel lost (${reason})`,
              decided_at: new Date(this.now()).toISOString(),
            });
            if (!settled.applied) {
              // A human answer won the race; the gate is not unavailable.
              continue;
            }
            this._submitWaiters.delete(String(record.approval_id));
            await this._parkHeldTask(record, 'approval_unavailable', `approval channel lost (${reason})`);
            continue;
          }
          if (
            record.decision?.outcome === ApprovalOutcome.ALLOWED_ONCE &&
            (record.consumed_by_task === undefined || record.consumed_by_task === null || record.consumed_by_task === '')
          ) {
            // The decision was durable but its release never happened. Replaying
            // it would execute an old cross-end task on a new session, which is
            // exactly what must not happen.
            this._submitWaiters.delete(String(record.approval_id));
            await this._parkHeldTask(record, 'approval_settlement_lost', 'approval release lost on restart');
            // Spend through the one-shot conditional write, preserving any
            // consumption a racing release may have recorded already.
            await this.store.claimApprovalConsumption(
              record.approval_id,
              String(record.task_id ?? ''),
            );
          }
        }
        // Restart recovery for held tasks that no pending gate will ever
        // release: a task left in `pending_approval` whose gate is already
        // decided (rejected/expired) or missing has no in-process settlement
        // left after the restart, so waiting would strand it forever. A task
        // whose gate is still pending on the *current* channel is left alone
        // (the normal answer path owns it).
        const liveTasks = new Set();
        for (const record of records) {
          if (
            record.decided !== true &&
            currentKey !== null &&
            record.conn === currentKey &&
            record.task_id !== null &&
            record.task_id !== undefined
          ) {
            liveTasks.add(String(record.task_id));
          }
        }
        for (const task of await this.store.list('tasks')) {
          if (task?.status !== TaskStatus.PENDING_APPROVAL) continue;
          const taskId = String(task.task_id ?? '');
          if (taskId.length === 0 || liveTasks.has(taskId)) continue;
          const gate = records.find((record) => String(record.task_id ?? '') === taskId);
          await this._parkHeldTask(
            { task_id: taskId },
            gate?.decided === true ? 'approval_settlement_lost' : 'approval_missing',
            gate?.decided === true
              ? 'approval settlement was lost with the previous channel'
              : 'no durable approval belongs to the held task',
          );
        }
      })
      .catch((error) => {
        this.logger.failure('approval_gate_invalidation_failed', error, { reason });
      });
  }

  /**
   * Park the task behind one dead gate, if it is still waiting.
   * @param {object} record - approval row.
   * @param {string} code - machine-readable reason.
   * @param {string} message - short English explanation.
   * @returns {Promise<void>} resolution after the task was parked.
   */
  async _parkHeldTask(record, code, message) {
    const taskId = String(record?.task_id ?? '');
    if (taskId.length === 0) return;
    const task = await this.store.getTask(taskId);
    if (task === null || task.status !== TaskStatus.PENDING_APPROVAL) return;
    if (task.direction !== 'inbound') {
      // The peer executes this task; only its own event may change the status.
      await this.store.putTask({
        ...task,
        needs_human: true,
        error: { code, message, details: null },
      });
      return;
    }
    const error = { code, message, details: null };
    const parked = await this.store.transition(taskId, TaskStatus.NEEDS_HUMAN, {
      needs_human: true,
      error,
    });
    if (parked.status !== TaskStatus.NEEDS_HUMAN) return;
    await this.notify.emit({
      task_id: parked.task_id,
      event: TaskEvent.NEEDS_HUMAN,
      status: TaskStatus.NEEDS_HUMAN,
      error,
    });
    this.logger.warn('submit_gate_closed', { task: taskId, code });
  }

  /**
   * Wait for the pending settlement of dead-connection gates.
   * @returns {Promise<void>} resolution after the chain drained.
   */
  async whenGatesSettled() {
    await this._pendingSettlements;
  }

  /**
   * Whether one request belongs to a bound, online, remote-approval session.
   *
   * This runs synchronously inside the waterfall listener, before any `await`,
   * because claiming late would either strand the operator's prompt or leave the
   * peer holding a request that can never be settled.
   * @param {object} request - harness approval request.
   * @returns {boolean} whether the bridge should claim it.
   */
  _canClaim(request) {
    if (this.remoteApprovalEnabled !== true) return false;
    if (this._sessionKey === null) return false;
    const sessionId = request?.agent?.session?.id;
    if (sessionId === undefined) return false;
    // A session this host happens to know about is not enough: A's authorization
    // table is the authority, and a revocation must bite on the next request.
    return this._isAuthorizedSync(String(sessionId));
  }

  /**
   * Attach the harness `approval/request` listener (§12).
   *
   * The listener claims a request only when this connection is bound, online,
   * authorized by A and configured for remote native approval; otherwise it
   * hands the request back to the deployment's own answerer. Both branches are
   * exclusive.
   *
   * Attachment is idempotent per service instance: a reconnect must not stack a
   * second listener, because two listeners would both claim and the inner one
   * would be dead weight. It does re-read the authorization cache, since a
   * reconnect may have missed pushes.
   * @param {object} ctx - Cordis context.
   * @returns {Promise<void>} resolution after attachment.
   */
  async attach(ctx) {
    const { attachApprovalBridge, createApprovalBridge } = await import('../host/approval.js');
    // Gates of a previous connection are settled before a new one can claim, so
    // a fresh request cannot race the closure of an old one.
    await this._pendingSettlements;
    await this.syncAuthz();
    if (this._bridge !== null) return;
    this._bridge = createApprovalBridge(
      {
        canClaim: (request) => this._canClaim(request),
        forward: (record) => this._publishRequest(record),
        confirmClaim: async (record) => {
          // The deadline is armed only after the peer acknowledged the request:
          // a locally expiring handle whose question never reached anyone would
          // be a silent denial the operator never saw. The deadline itself comes
          // from the persisted record, so the host timer always matches
          // `approvalTimeoutSeconds` rather than the 15 s sweep.
          if (!(await this._isPersisted(record.approval_id))) return false;
          this._bridge.armDeadline(record.approval_id, record.expires_at);
          return true;
        },
        onSettled: (record, settled) => {
          this.logger.info('approval_settled', {
            approval: record.approval_id,
            outcome: settled.outcome,
            source: settled.source,
            channel: settled.channel,
          });
          // The settlement already happened in memory; failing to write the
          // audit row must not become an unhandled rejection either.
          Promise.resolve()
            .then(() =>
              this.store.decideApproval(record.approval_id, {
                outcome: settled.outcome,
                actor: settled.source === 'remote' ? 'remote_human' : 'system',
                actor_kind: settled.source === 'remote' ? 'human' : 'system',
                channel: settled.channel,
                reason: settled.source === 'timeout' ? 'approval timed out' : null,
                decided_at: new Date(this.now()).toISOString(),
              }),
            )
            .catch((error) => this.logger.failure('approval_settle_persist_failed', error, { approval: record.approval_id }));
        },
      },
      this.logger,
      this.now,
    );
    this._disposer = attachApprovalBridge(ctx, this._bridge);
    this._timeoutTimer = setInterval(() => {
      void this.timeoutLoop();
    }, 15_000);
    if (typeof this._timeoutTimer.unref === 'function') this._timeoutTimer.unref();
  }

  /**
   * Confirm one claimed request really reached the durable table.
   *
   * `_publishRequest` writes the record before it talks to the peer, so this is
   * the postcondition that the host deadline can be armed from: without a
   * persisted `expires_at` the harness would have no deadline of its own and
   * would only be swept by the 15 s loop.
   * @param {string} approvalId - bridge approval identity.
   * @returns {Promise<boolean>} whether the record is durably pending.
   * @throws {BridgeError} when the store refuses the read.
   */
  async _isPersisted(approvalId) {
    const stored = await this.store.getApproval(approvalId);
    // The deadline must be a real date before the host timer is armed: a
    // non-finite value would compute `NaN` remaining time and expire the handle
    // immediately, denying a question the operator never got to answer.
    const expires = Date.parse(String(stored?.expires_at ?? ''));
    return (
      stored !== null &&
      stored.decided !== true &&
      Number.isFinite(expires)
    );
  }

  /**
   * Persist and publish one claimed native-tool request (§12.2).
   * @param {object} record - claimed record from the host bridge.
   * @returns {Promise<void>} resolution after the peer acknowledged it.
   * @throws {BridgeError} when the peer cannot queue the request.
   */
  async _publishRequest(record) {
    const expiresAt = new Date(this.now() + this.config.approvalTimeoutSeconds * 1000).toISOString();
    record.expires_at = expiresAt;
    record.request_digest = approvalRequestDigest({
      tool: record.tool,
      reason: record.reason,
      call_id: record.call_id,
      session_id: record.session_id,
      task_id: null,
    });
    await this.store.putApproval({
      approval_id: record.approval_id,
      approval_type: ApprovalType.NATIVE_TOOL,
      task_id: null,
      root_task_id: null,
      session_id: record.session_id,
      tool: record.tool,
      reason: record.reason,
      display_reason: record.display_reason,
      call_id: record.call_id,
      request_digest: record.request_digest,
      expires_at: expiresAt,
      origin_side: this._side,
      source: 'local',
      gate_scope: 'native_tool',
      conn: this._sessionKey,
      decided: false,
      decision: null,
      created_at: new Date(this.now()).toISOString(),
    });
    await this.session.call(
      MessageName.APPROVAL_REQUEST,
      {
        approval_id: record.approval_id,
        approval_type: ApprovalType.NATIVE_TOOL,
        task_id: null,
        root_task_id: null,
        session_id: record.session_id,
        tool: record.tool,
        reason: record.reason,
        display_reason: record.display_reason ?? { en: record.tool },
        call_id: record.call_id,
        request_digest: record.request_digest,
        expires_at: expiresAt,
        notify_id: randomUUID(),
        origin_side: this._side,
      },
      15,
    );
    this.logger.info('approval_forwarded', { approval: record.approval_id, tool: record.tool });
  }

  /**
   * Record the first answer to one approval (§12.4).
   *
   * The first call settles it; every later call is refused with
   * `already_answered` and changes nothing.
   * @param {string} approvalId - approval identity.
   * @param {object} answer - `{outcome, actor, actor_kind, channel, reason}`.
   * @returns {Promise<{applied: boolean, reason: string|null, outcome: string}>} outcome.
   * @throws {BridgeError} `agent_cannot_approve` for a non-human actor.
   */
  async decide(approvalId, answer) {
    if (answer?.actor_kind !== 'human') {
      // §12.3: an agent may never answer for a human, and neither may the bridge.
      throw new BridgeError('agent_cannot_approve');
    }
    const record = await this.store.getApproval(approvalId);
    if (record === null) throw new BridgeError('approval_mismatch', { details: { field: 'approval_id' } });
    // A handle belongs to the `(conn, sid)` that asked. A decision arriving on a
    // later connection can never *settle* it — but a late answer to an already
    // settled row is reported as `already_answered`, not as a new settlement.
    if (record.decided !== true) {
      // Strict equality: a legacy row with no `conn` is not evidence, and a
      // row from another connection may not settle this one.
      if (record.conn !== this._sessionKey) {
        throw new BridgeError('approval_mismatch', { details: { field: 'approval_id' } });
      }
      const expires = Date.parse(String(record.expires_at ?? ''));
      if (!Number.isFinite(expires) || expires <= this.now()) {
        throw new BridgeError('approval_expired');
      }
    }
    const normalised = normaliseApprovalOutcome(answer.outcome);
    const result = await this.store.decideApproval(approvalId, {
      outcome: normalised,
      actor: String(answer.actor ?? ''),
      actor_kind: 'human',
      channel: String(answer.channel ?? 'web'),
      reason: answer.reason ?? null,
      decided_at: new Date(this.now()).toISOString(),
    });
    if (result.reason === 'expired') {
      // The store checks the deadline inside the same serialized write: the
      // human answer lost to expiry, which is a refusal, never a grant.
      throw new BridgeError('approval_expired');
    }
    if (!result.applied) {
      // `result.record` is the durable winner. Reporting its outcome (rather
      // than this discarded answer) keeps a late loser from settling a waiter.
      return {
        applied: false,
        reason: result.reason,
        outcome: result.record?.decision?.outcome ?? normalised,
      };
    }

    // The durable record is the authority; the in-process handle is settled from
    // it so the harness sees exactly the answer that was persisted.
    this._bridge?.settleExternal(approvalId, result.record?.decision?.outcome ?? normalised);
    await this._settleSubmitWaiter(result.record ?? record, normalised);
    return { applied: true, reason: null, outcome: normalised };
  }

  /**
   * Open a `cross_end_submit` approval for one held submission (§12.5 point 5).
   *
   * This is the receiving end's own gate: the task stays `pending_approval`, the
   * approval is durable before anything is asked, and the question is put on the
   * wire as a §12.2 `approval.request` so a human on the other side can answer
   * it. The answer comes back as `approval.decision` and settles through
   * {@link ApprovalService#decide}; the `onDecided` handler is what releases (or
   * rejects) the held task exactly once.
   * @param {object} input - approval input.
   * @param {object} input.task - the held task record.
   * @param {string} input.tool - action label shown to the approver.
   * @param {string} input.reason - asker-supplied reason.
   * @param {object} [input.displayReason] - localized reason strings.
   * @param {string} [input.submitDigest] - digest of the complete submission that
   *   the human is approving; a later `approval_ref` must reproduce it.
   * @param {(record: object, allowed: boolean) => unknown} [input.onDecided] -
   *   invoked once when a first answer is applied.
   * @returns {Promise<object>} the persisted approval record.
   */
  async requestSubmitApproval(input) {
    const approvalId = randomUUID();
    const expiresAt = new Date(this.now() + this.config.approvalTimeoutSeconds * 1000).toISOString();
    const tool = String(input.tool ?? '');
    const reason = String(input.reason ?? 'cross-end task submission');
    const sessionId = input.task?.session_id ?? null;
    const taskId = input.task?.task_id ?? null;
    const requestDigest = approvalRequestDigest({
      tool,
      reason,
      call_id: null,
      session_id: sessionId,
      task_id: taskId,
    });
    const record = {
      approval_id: approvalId,
      approval_type: ApprovalType.CROSS_END_SUBMIT,
      task_id: taskId,
      root_task_id: input.task?.root_task_id ?? taskId,
      session_id: sessionId,
      tool,
      reason,
      display_reason: input.displayReason ?? null,
      call_id: null,
      request_digest: requestDigest,
      // The complete content a human is approving. A later `approval_ref` must
      // reproduce this value; comparing only a digest the submitter computed
      // would bind the content to itself, not to the decision.
      submit_digest: input.submitDigest ?? null,
      expires_at: expiresAt,
      origin_side: this._side,
      source: 'local',
      gate_scope: 'inbound_release',
      released_by_task: null,
      conn: this._sessionKey,
      decided: false,
      decision: null,
      created_at: new Date(this.now()).toISOString(),
    };
    // Durable before the question is asked: a crash right after this point must
    // leave an approval the peer's answer can still be matched against.
    await this.store.putApproval(record);
    if (typeof input.onDecided === 'function') this._submitWaiters.set(approvalId, input.onDecided);
    try {
      await this.session.call(
        MessageName.APPROVAL_REQUEST,
        {
          approval_id: approvalId,
          approval_type: ApprovalType.CROSS_END_SUBMIT,
          task_id: taskId,
          root_task_id: record.root_task_id,
          session_id: sessionId,
          tool,
          reason,
          display_reason: record.display_reason ?? { en: tool, zh: tool },
          call_id: null,
          request_digest: requestDigest,
          expires_at: expiresAt,
          notify_id: randomUUID(),
          origin_side: this._side,
        },
        15,
      );
    } catch (error) {
      // The question never reached a human. Nothing may run: the approval stays
      // pending and its deadline turns it into a rejection (§12.4).
      this.logger.failure('submit_approval_forward_failed', asBridgeError(error), {
        approval: approvalId,
        task: String(taskId ?? ''),
      });
      return record;
    }
    this.logger.info('submit_approval_forwarded', { approval: approvalId, task: String(taskId ?? '') });
    return record;
  }

  /**
   * Hand one applied decision to the task that opened the approval.
   *
   * Only `cross_end_submit` approvals opened by this side have a waiter, so a
   * native-tool settlement (which belongs to the harness) never reaches a task
   * lifecycle. A failing handler is logged: the decision itself is already
   * durable, and a human can still see the held task.
   * @param {object} record - the decided approval record.
   * @param {string} outcome - the applied outcome.
   * @returns {Promise<void>} resolution after the handler ran.
   */
  async _settleSubmitWaiter(record, outcome) {
    if (record?.approval_type !== ApprovalType.CROSS_END_SUBMIT) return;
    const approvalId = String(record.approval_id ?? '');
    const waiter = this._submitWaiters.get(approvalId);
    if (waiter === undefined) return;
    this._submitWaiters.delete(approvalId);
    try {
      await waiter(record, outcome === ApprovalOutcome.ALLOWED_ONCE);
    } catch (error) {
      this.logger.failure('submit_approval_settle_failed', error, { approval: approvalId });
    }
  }

  /**
   * Handle an inbound `approval.request` from the peer (§12.2).
   *
   * The request is queued and acknowledged immediately; the human answer comes
   * back asynchronously as `approval.decision`, so this never blocks on a person.
   * @param {object} params - request parameters.
   * @returns {Promise<{approval_id: string, accepted: true, dedup?: true}>} result.
   */
  async handleRequest(params) {
    const approvalId = String(params?.approval_id ?? '');
    if (approvalId.length === 0) throw new BridgeError('bad_params', { details: { field: 'approval_id' } });
    if (!Object.values(ApprovalType).includes(params.approval_type)) {
      throw new BridgeError('capability_unavailable', { details: { capability: 'approval_type' } });
    }
    const existing = await this.store.getApproval(approvalId);
    if (existing !== null) {
      if (existing.decided === true) return { approval_id: approvalId, accepted: true, dedup: true };
      return { approval_id: approvalId, accepted: true, dedup: true };
    }
    if (params.expires_at !== undefined) {
      const expires = Date.parse(String(params.expires_at));
      // An unparseable deadline is not "no deadline": accepting it would leave a
      // row the timeout loop can only treat as already expired. Refuse instead.
      if (!Number.isFinite(expires) || expires <= this.now()) {
        throw new BridgeError('approval_expired');
      }
    }
    const expected = approvalRequestDigest({
      tool: params.tool,
      reason: params.reason ?? null,
      call_id: params.call_id ?? null,
      session_id: params.session_id ?? null,
      task_id: params.task_id ?? null,
    });
    if (params.request_digest !== undefined && params.request_digest !== expected) {
      throw new BridgeError('approval_mismatch');
    }
    const record = {
      approval_id: approvalId,
      approval_type: params.approval_type,
      task_id: params.task_id ?? null,
      root_task_id: params.root_task_id ?? null,
      session_id: params.session_id ?? null,
      tool: params.tool ?? null,
      reason: params.reason ?? null,
      display_reason: params.display_reason ?? null,
      call_id: params.call_id ?? null,
      request_digest: expected,
      expires_at:
        params.expires_at ?? new Date(this.now() + this.config.approvalTimeoutSeconds * 1000).toISOString(),
      // The authenticated handshake's `caps.side` is the only trustworthy
      // source side; the payload's `origin_side` is peer-controlled text and is
      // kept only as a compatibility fallback when no handshake is bound.
      origin_side:
        this.session?.peerCaps?.side === 'A' || this.session?.peerCaps?.side === 'B'
          ? this.session.peerCaps.side
          : this.session?.peerSide === 'A' || this.session?.peerSide === 'B'
            ? this.session.peerSide
            : params.origin_side ?? (this._side === 'A' ? 'B' : 'A'),
      source: 'peer_request',
      gate_scope: 'inbound_release',
      released_by_task: null,
      // The connection that received the question is the only one that may
      // settle it. A reconnect always produces a new `sid`, so an old row can
      // never be answered by the new channel.
      conn: this._sessionKey,
      decided: false,
      decision: null,
      created_at: new Date(this.now()).toISOString(),
    };
    await this.store.putApproval(record);
    this.logger.info('approval_queued', { approval: approvalId, type: record.approval_type });
    return { approval_id: approvalId, accepted: true };
  }

  /**
   * Handle an inbound `approval.decision` event (§12.3).
   * @param {object} params - decision parameters.
   * @returns {Promise<{approval_id: string, applied: boolean, reason: string|null}>} outcome.
   * @throws {BridgeError} `agent_cannot_approve`, `approval_mismatch`, `approval_expired`.
   */
  async onDecisionEvent(params) {
    if (params?.actor_kind !== 'human') throw new BridgeError('agent_cannot_approve');
    const approvalId = String(params.approval_id ?? '');
    const record = await this.store.getApproval(approvalId);
    if (record === null) throw new BridgeError('approval_mismatch', { details: { field: 'approval_id' } });
    if (record.request_digest !== params.request_digest) throw new BridgeError('approval_mismatch');
    const result = await this.decide(approvalId, {
      outcome: params.outcome,
      actor: params.actor,
      actor_kind: params.actor_kind,
      channel: params.channel ?? 'im',
      reason: params.reason ?? null,
    });
    return { approval_id: approvalId, applied: result.applied, reason: result.reason };
  }

  /**
   * Split the bound `conn|sid` session key.
   * @returns {{conn: string, sid: string}|null} identity, or null when unbound.
   */
  _identity() {
    if (this._sessionKey === null) return null;
    const index = this._sessionKey.indexOf('|');
    if (index <= 0 || index === this._sessionKey.length - 1) return null;
    return {
      conn: this._sessionKey.slice(0, index),
      sid: this._sessionKey.slice(index + 1),
    };
  }

  /**
   * Whether the authenticated peer advertised `approval.lookup`.
   *
   * Unknown caps mean unsupported: an optimistic attempt would leak a request
   * to a peer that cannot answer and then fail open through a fallback.
   * @returns {boolean} whether remote lookup is negotiated.
   */
  _peerSupportsLookup() {
    const features = this.session?.peerCaps?.features;
    return Array.isArray(features) && features.includes('approval.lookup');
  }

  /**
   * The peer side authenticated by the handshake, or null when unknown.
   *
   * Only the signed caps/side is trusted; a payload-supplied side is not.
   * @returns {'A'|'B'|null} authenticated peer side.
   */
  _trustedPeerSide() {
    const side = this.session?.peerCaps?.side;
    if (side === 'A' || side === 'B') return side;
    const legacy = this.session?.peerSide;
    return legacy === 'A' || legacy === 'B' ? legacy : null;
  }

  /**
   * Whether one row carries the durable evidence §12.7 requires.
   * @param {object} record - approval row.
   * @returns {boolean} complete evidence or not.
   */
  _evidenceComplete(record) {
    return Boolean(
      record !== null &&
        record.approval_type === ApprovalType.CROSS_END_SUBMIT &&
        record.decided === true &&
        record.decision !== null &&
        Object.values(ApprovalOutcome).includes(record.decision?.outcome) &&
        record.decision?.actor_kind === 'human' &&
        typeof record.decision?.actor === 'string' &&
        record.decision.actor.length > 0 &&
        typeof record.submit_digest === 'string' &&
        record.submit_digest.length > 0 &&
        typeof record.conn === 'string' &&
        record.conn.length > 0 &&
        record.decision?.decided_at,
    );
  }

  /**
   * Answer `approval.lookup` as the authority (§12.7.3).
   *
   * Only a gate this endpoint opened itself (`source === 'local'`) and decided on
   * the *current* session is answered. Mirrors, old rows without session evidence
   * and a new sid are all refused; the query never writes.
   * @param {object} params - `{approval_id, task_id, root_task_id, session_id, submit_digest}`.
   * @returns {Promise<object>} the evidence object of §12.7.2.
   * @throws {BridgeError} bad_params / approval_mismatch / approval_evidence_missing /
   *   approval_expired / approval_already_decided.
   */
  async lookup(params) {
    const approvalId = String(params?.approval_id ?? '');
    if (approvalId.length === 0) throw new BridgeError('bad_params', { details: { field: 'approval_id' } });
    const taskId = String(params?.task_id ?? '');
    const rootTaskId = String(params?.root_task_id ?? '');
    if (taskId.length === 0) throw new BridgeError('bad_params', { details: { field: 'task_id' } });
    if (rootTaskId.length === 0) throw new BridgeError('bad_params', { details: { field: 'root_task_id' } });
    if (!Object.hasOwn(params ?? {}, 'session_id')) {
      throw new BridgeError('bad_params', { details: { field: 'session_id' } });
    }
    const expectedDigest = String(params?.submit_digest ?? '');
    if (expectedDigest.length === 0) throw new BridgeError('bad_params', { details: { field: 'submit_digest' } });

    const record = await this.store.getApproval(approvalId);
    if (
      record === null ||
      record.approval_type !== ApprovalType.CROSS_END_SUBMIT ||
      record.source !== 'local' ||
      record.origin_side !== this._side
    ) {
      throw new BridgeError('approval_mismatch', { details: { field: 'approval_id' } });
    }
    if (!this._evidenceComplete(record)) {
      this.logger.warn('approval_lookup_evidence_missing', { approval: approvalId });
      throw new BridgeError('approval_evidence_missing');
    }
    const identity = this._identity();
    if (identity === null || record.conn !== this._sessionKey) {
      // A decision made on an older session is not evidence for this one.
      throw new BridgeError('approval_evidence_missing');
    }
    const expires = Date.parse(String(record.expires_at ?? ''));
    if (!Number.isFinite(expires) || expires <= this.now()) throw new BridgeError('approval_expired');
    const released = String(record.released_by_task ?? '');
    if (released.length === 0) throw new BridgeError('approval_mismatch', { details: { field: 'released_by_task' } });
    if (released !== taskId) throw new BridgeError('approval_already_decided');
    if (
      String(record.task_id ?? '') !== taskId ||
      String(record.root_task_id ?? '') !== rootTaskId ||
      (record.session_id ?? null) !== (params.session_id ?? null) ||
      String(record.submit_digest ?? '') !== expectedDigest
    ) {
      throw new BridgeError('approval_mismatch', { details: { field: 'binding' } });
    }
    if (record.decision?.outcome !== ApprovalOutcome.ALLOWED_ONCE || record.decision?.actor_kind !== 'human') {
      throw new BridgeError('approval_mismatch', { details: { field: 'outcome' } });
    }
    return {
      approval_id: record.approval_id,
      approval_type: record.approval_type,
      state: 'decided',
      outcome: record.decision.outcome,
      actor: record.decision.actor ?? null,
      actor_kind: record.decision.actor_kind,
      channel: record.decision.channel ?? null,
      decided_at: record.decision.decided_at ?? null,
      expires_at: record.expires_at,
      task_id: record.task_id,
      root_task_id: record.root_task_id,
      session_id: record.session_id ?? null,
      request_digest: record.request_digest ?? null,
      submit_digest: record.submit_digest,
      conn: identity.conn,
      sid: identity.sid,
      side: this._side,
      released_by_task: released,
    };
  }

  /**
   * Whether a stored row is usable local evidence for an inbound reference.
   *
   * An `outbound_submit` gate belongs to the opposite role (this endpoint was the
   * initiator) and must never authorize an inbound submission. A local
   * receiving-side gate or a previously imported `peer_lookup` mirror may, once
   * its evidence is complete and bound to the live session; the deadline is
   * checked by `_checkEvidenceBindings`, so an overdue gate is reported as
   * `approval_expired` (never as a lookup failure or a grant).
   * @param {object} record - approval row.
   * @returns {boolean} whether it can be used without a remote query.
   */
  _localEvidenceUsable(record) {
    if (record === null) return false;
    if (record.source === 'local' && record.gate_scope === 'outbound_submit') return false;
    if (!this._evidenceComplete(record)) return false;
    // Expiry is reported by `_checkEvidenceBindings`, so the caller sees the
    // specific `approval_expired` refusal instead of a generic lookup failure.
    return this._sessionKey !== null && record.conn === this._sessionKey;
  }

  /**
   * Prove an inbound `approval_ref` and return the evidence row (§12.7.4).
   *
   * Local evidence is used only when complete and bound to this submission and
   * the live session. Otherwise the peer is queried on the captured session and
   * the answer is re-checked after the call; a session change refuses the answer.
   * The result is persisted as a `peer_lookup` mirror before execution.
   * @param {object} params - `task.submit` parameters carrying the reference.
   * @returns {Promise<object>} the local evidence row or the imported mirror.
   * @throws {BridgeError} approval_lookup_failed / approval_mismatch /
   *   approval_digest_mismatch / approval_expired / approval_evidence_missing.
   */
  async lookupEvidence(params) {
    const ref = params?.approval_ref ?? null;
    const approvalId = String(ref?.approval_id ?? '');
    if (approvalId.length === 0) throw new BridgeError('approval_mismatch', { details: { field: 'approval_id' } });
    const local = await this.store.getApproval(approvalId);
    if (this._localEvidenceUsable(local)) {
      this._checkEvidenceBindings(params, local, ref);
      return local;
    }
    if (this.session === null || this.session === undefined || this.session.state !== 'ready') {
      throw new BridgeError('approval_lookup_failed');
    }
    if (!this._peerSupportsLookup()) {
      // Unknown/unadvertised capability is a refusal, never an optimistic call.
      throw new BridgeError('approval_lookup_failed');
    }
    const identity = this._identity();
    if (identity === null) throw new BridgeError('approval_lookup_failed');
    const capturedKey = this._sessionKey;
    const capturedSid = this.session.sid;
    const capturedSide = this._trustedPeerSide();
    if (capturedSide === null) throw new BridgeError('approval_lookup_failed');
    const expected = this.submitDigestOf(params);
    const request = {
      approval_id: approvalId,
      task_id: params.task_id,
      root_task_id: params.root_task_id,
      session_id: params.session_id ?? null,
      submit_digest: expected,
    };
    let evidence;
    try {
      evidence = await this.session.call(MessageName.APPROVAL_LOOKUP, request, 15);
    } catch (error) {
      const code = error instanceof BridgeError ? error.code : 'approval_lookup_failed';
      this.logger.warn('approval_lookup_failed', { approval: approvalId, code });
      // §12.7.5: evidence_missing is the only refusal reported verbatim; every
      // other authority error is a failed lookup on this side.
      if (code === 'approval_evidence_missing') throw error;
      throw new BridgeError('approval_lookup_failed');
    }
    if (
      this._sessionKey !== capturedKey ||
      this.session === null ||
      this.session === undefined ||
      this.session.state !== 'ready' ||
      this.session.sid !== capturedSid ||
      this._trustedPeerSide() !== capturedSide
    ) {
      this.logger.warn('approval_lookup_session_raced', { approval: approvalId });
      throw new BridgeError('approval_lookup_failed');
    }
    this._verifyLookupEvidence(params, evidence, identity, capturedSide, ref);
    const mirror = {
      approval_id: approvalId,
      approval_type: ApprovalType.CROSS_END_SUBMIT,
      task_id: evidence.task_id ?? null,
      root_task_id: evidence.root_task_id ?? null,
      session_id: evidence.session_id ?? null,
      tool: null,
      reason: '',
      display_reason: null,
      call_id: null,
      request_digest: evidence.request_digest ?? '',
      submit_digest: evidence.submit_digest,
      expires_at: evidence.expires_at,
      origin_side: capturedSide,
      source: 'peer_lookup',
      gate_scope: 'inbound_release',
      conn: capturedKey,
      released_by_task: evidence.released_by_task ?? null,
      evidence,
      decided: true,
      decision: {
        outcome: evidence.outcome,
        actor: evidence.actor ?? null,
        actor_kind: 'human',
        channel: evidence.channel ?? null,
        reason: null,
        decided_at: evidence.decided_at ?? null,
      },
      consumed_by_task: null,
      consumed_at: null,
      created_at: new Date(this.now()).toISOString(),
    };
    // Controlled import: an existing mirror keeps its local consumption, and a
    // local gate or a conflicting old row is refused instead of overwritten.
    const stored = await this.store.importApprovalMirror(mirror);
    if (stored === null) throw new BridgeError('approval_evidence_missing');
    return stored;
  }

  /**
   * Compare local evidence with the actual submission and the ref.
   * @param {object} params - submit parameters.
   * @param {object} record - evidence row.
   * @param {object} ref - approval_ref.
   * @returns {void}
   * @throws {BridgeError} on any mismatch.
   */
  _checkEvidenceBindings(params, record, ref) {
    if (ref?.actor_kind !== 'human') throw new BridgeError('agent_cannot_approve');
    const expected = this.submitDigestOf(params);
    if (String(ref?.submit_digest ?? '') !== expected) throw new BridgeError('approval_digest_mismatch');
    if (String(record.submit_digest ?? '') !== expected) throw new BridgeError('approval_digest_mismatch');
    if (
      String(record.task_id ?? '') !== String(params.task_id) ||
      String(record.root_task_id ?? '') !== String(params.root_task_id) ||
      (record.session_id ?? null) !== (params.session_id ?? null)
    ) {
      throw new BridgeError('approval_mismatch', { details: { field: 'task_id' } });
    }
    if (record.decision?.outcome !== ApprovalOutcome.ALLOWED_ONCE) {
      throw new BridgeError('approval_mismatch', { details: { field: 'outcome' } });
    }
    if (record.decision?.actor_kind !== 'human') throw new BridgeError('agent_cannot_approve');
    const expires = Date.parse(String(record.expires_at ?? ''));
    if (!Number.isFinite(expires) || expires <= this.now()) throw new BridgeError('approval_expired');
  }

  /**
   * Validate one authoritative lookup answer against the real submission.
   * @param {object} params - submit parameters.
   * @param {object} evidence - decoded lookup result.
   * @param {{conn: string, sid: string}} identity - captured session identity.
   * @param {'A'|'B'} peerSide - authenticated peer side captured before the call.
   * @param {object} ref - approval_ref.
   * @returns {void}
   * @throws {BridgeError} on any mismatch.
   */
  _verifyLookupEvidence(params, evidence, identity, peerSide, ref) {
    if (evidence === null || typeof evidence !== 'object') throw new BridgeError('approval_lookup_failed');
    const expected = this.submitDigestOf(params);
    if (String(ref?.submit_digest ?? '') !== expected) throw new BridgeError('approval_digest_mismatch');
    if (String(evidence.submit_digest ?? '') !== expected) throw new BridgeError('approval_digest_mismatch');
    if (
      String(evidence.approval_id ?? '') !== String(ref?.approval_id ?? '') ||
      evidence.approval_type !== ApprovalType.CROSS_END_SUBMIT ||
      evidence.state !== 'decided' ||
      evidence.outcome !== ApprovalOutcome.ALLOWED_ONCE ||
      evidence.actor_kind !== 'human' ||
      typeof evidence.actor !== 'string' ||
      evidence.actor.length === 0 ||
      !Number.isFinite(Date.parse(String(evidence.decided_at ?? '')))
    ) {
      throw new BridgeError('approval_mismatch', { details: { field: 'evidence' } });
    }
    if (
      String(evidence.task_id ?? '') !== String(params.task_id) ||
      String(evidence.root_task_id ?? '') !== String(params.root_task_id) ||
      (evidence.session_id ?? null) !== (params.session_id ?? null) ||
      String(evidence.released_by_task ?? '') !== String(params.task_id)
    ) {
      throw new BridgeError('approval_mismatch', { details: { field: 'binding' } });
    }
    if (evidence.conn !== identity.conn || evidence.sid !== identity.sid) {
      throw new BridgeError('approval_evidence_missing');
    }
    // An unknown or changed peer side is never accepted as evidence.
    if (evidence.side !== peerSide) {
      throw new BridgeError('approval_mismatch', { details: { field: 'side' } });
    }
    const expires = Date.parse(String(evidence.expires_at ?? ''));
    if (!Number.isFinite(expires) || expires <= this.now()) {
      throw new BridgeError('approval_expired');
    }
  }

  /**
   * Compute the §12.5 `submit_digest` for one submission.
   * @param {object} params - submit parameters.
   * @returns {string} base64url digest.
   */
  submitDigestOf(params) {
    return submitDigest({
      task_id: params.task_id,
      root_task_id: params.root_task_id,
      kind: params.kind,
      origin: params.origin,
      session_id: params.session_id ?? null,
      purpose: params.purpose ?? null,
      timeout_s: params.timeout_s,
      input_parts_digest: inputPartsDigest(params.input_parts ?? []),
      attachments: (params.attachments ?? []).map((attachment) => ({
        kind: attachment.kind,
        blob_id: attachment.blob_id,
        media_type: attachment.media_type,
        bytes: attachment.bytes,
        sha256: attachment.sha256,
      })),
      tool_hints: params.tool_hints ?? [],
    });
  }

  /**
   * Build the wire `approval_ref` for a locally released initiating gate (§12.5).
   * @param {object} record - decided local approval row.
   * @returns {object} approval_ref.
   */
  buildSubmitRef(record) {
    return {
      approval_id: record.approval_id,
      submit_digest: record.submit_digest,
      actor: record.decision?.actor ?? null,
      actor_kind: 'human',
      decided_at: record.decision?.decided_at ?? new Date(this.now()).toISOString(),
      expires_at: record.expires_at,
    };
  }

  /**
   * Verify and atomically release an initiating gate for one submission (§12.7.4).
   * @param {object} record - decided local gate.
   * @param {object} params - wire submit parameters.
   * @returns {Promise<boolean>} whether this call recorded the release.
   * @throws {BridgeError} when the gate may not be released.
   */
  async releaseOutboundGate(record, params) {
    if (
      record === null ||
      record.approval_type !== ApprovalType.CROSS_END_SUBMIT ||
      record.source !== 'local' ||
      record.gate_scope !== 'outbound_submit' ||
      record.origin_side !== this._side
    ) {
      throw new BridgeError('approval_mismatch', { details: { field: 'approval_id' } });
    }
    if (
      record.decided !== true ||
      record.decision?.outcome !== ApprovalOutcome.ALLOWED_ONCE ||
      record.decision?.actor_kind !== 'human'
    ) {
      throw new BridgeError('approval_mismatch', { details: { field: 'outcome' } });
    }
    const expires = Date.parse(String(record.expires_at ?? ''));
    if (!Number.isFinite(expires) || expires <= this.now()) throw new BridgeError('approval_expired');
    if (this._sessionKey === null || record.conn !== this._sessionKey) {
      throw new BridgeError('approval_evidence_missing');
    }
    if (String(record.submit_digest ?? '') !== this.submitDigestOf(params)) {
      throw new BridgeError('approval_digest_mismatch');
    }
    // The store serializes this conditional write, so two concurrent releases
    // cannot both succeed. `false` means an earlier release won (same or other
    // task); the caller must not send a second submission.
    return this.store.claimApprovalRelease(record.approval_id, params.task_id);
  }

  /**
   * Open this side's initiating gate for one held outbound submission (§12.5).
   * @param {object} input - gate input.
   * @param {object} input.task - pending outbound task.
   * @param {string} input.tool - action label.
   * @param {string} input.reason - reason shown to the human.
   * @param {object} [input.displayReason] - localized strings.
   * @param {string} input.submitDigest - digest of the complete submission.
   * @param {(record: object, allowed: boolean) => unknown} input.onDecided - release handler.
   * @returns {Promise<object>} the persisted approval record.
   */
  async requestOutboundApproval(input) {
    const approvalId = randomUUID();
    const expiresAt = new Date(this.now() + this.config.approvalTimeoutSeconds * 1000).toISOString();
    const tool = String(input.tool ?? '');
    const reason = String(input.reason ?? 'cross-end task submission');
    const taskId = input.task?.task_id ?? null;
    const requestDigest = approvalRequestDigest({
      tool,
      reason,
      call_id: null,
      session_id: input.task?.session_id ?? null,
      task_id: taskId,
    });
    const record = {
      approval_id: approvalId,
      approval_type: ApprovalType.CROSS_END_SUBMIT,
      task_id: taskId,
      root_task_id: input.task?.root_task_id ?? taskId,
      session_id: input.task?.session_id ?? null,
      tool,
      reason,
      display_reason: input.displayReason ?? null,
      call_id: null,
      request_digest: requestDigest,
      submit_digest: input.submitDigest ?? null,
      expires_at: expiresAt,
      origin_side: this._side,
      source: 'local',
      gate_scope: 'outbound_submit',
      released_by_task: null,
      conn: this._sessionKey,
      decided: false,
      decision: null,
      created_at: new Date(this.now()).toISOString(),
    };
    await this.store.putApproval(record);
    if (typeof input.onDecided === 'function') this._submitWaiters.set(approvalId, input.onDecided);
    try {
      await this.session.call(
        MessageName.APPROVAL_REQUEST,
        {
          approval_id: approvalId,
          approval_type: ApprovalType.CROSS_END_SUBMIT,
          task_id: taskId,
          root_task_id: record.root_task_id,
          session_id: record.session_id,
          tool,
          reason,
          display_reason: record.display_reason ?? { en: tool, zh: tool },
          call_id: null,
          request_digest: requestDigest,
          expires_at: expiresAt,
          notify_id: randomUUID(),
          origin_side: this._side,
        },
        15,
      );
    } catch (error) {
      this.logger.failure('outbound_approval_forward_failed', asBridgeError(error), {
        approval: approvalId,
        task: String(taskId ?? ''),
      });
    }
    return record;
  }

  /**
   * Settle every expired approval as a rejection (§12.4).
   *
   * This is the whole "no auto-approval" guarantee in one loop: expiry produces
   * `rejected` with `channel: "timeout"`, never a grant and never a silent drop.
   * @returns {Promise<number>} number of approvals expired.
   */
  async timeoutLoop() {
    const snapshot = await this.store.list('approvals');
    const now = this.now();
    let expired = 0;
    for (const record of snapshot) {
      if (record.decided === true) continue;
      const expires = Date.parse(String(record.expires_at ?? ''));
      // A missing/unparseable deadline is fail-closed: never leave an
      // unanswerable row pending because its timestamp was not a finite date.
      if (Number.isFinite(expires) && expires > now) continue;
      const result = await this.store.decideApproval(record.approval_id, {
        outcome: ApprovalOutcome.REJECTED,
        actor: 'system',
        // A timeout is a fail-closed terminal event, not a human answer. Writing
        // `human` here would let a system expiry masquerade as consent evidence.
        actor_kind: 'system',
        channel: 'timeout',
        reason: 'approval timed out',
        decided_at: new Date(now).toISOString(),
      });
      if (!result.applied) continue;
      expired += 1;
      this._bridge?.settleExternal(record.approval_id, ApprovalOutcome.REJECTED);
      // An expired gate can never release its task: no answer will ever be
      // applied to it now (§12.4 makes expiry a rejection). The pending promise
      // is dropped so a late answer cannot fire it.
      this._submitWaiters.delete(String(record.approval_id));
      this.logger.warn('approval_expired', { approval: record.approval_id });
      // The peer is *not* sent a fabricated `approval.decision`: only a human
      // may produce one. A held task is reported through `task.event` below,
      // which is the durable, replayable status channel.
      if (record.task_id !== null && record.task_id !== undefined) {
        const task = await this.store.getTask(String(record.task_id));
        if (task !== null && task.direction === 'inbound' && task.status === TaskStatus.PENDING_APPROVAL) {
          const error = { code: 'approval_expired', message: 'approval timed out', details: null };
          const parked = await this.store.transition(String(record.task_id), TaskStatus.NEEDS_HUMAN, {
            needs_human: true,
            error,
          });
          if (parked.status === TaskStatus.NEEDS_HUMAN) {
            await this.notify.emit({
              task_id: parked.task_id,
              event: TaskEvent.NEEDS_HUMAN,
              status: TaskStatus.NEEDS_HUMAN,
              error,
            });
          }
        } else if (task !== null && task.direction !== 'inbound') {
          // Mirror of the peer's gate: this side is not the executor, so it must
          // not move the task's status, but it can record why nothing ran.
          await this.store.putTask({
            ...task,
            needs_human: true,
            error: { code: 'approval_expired', message: 'approval timed out', details: null },
          });
        }
      }
    }
    return expired;
  }

  /**
   * Handle one inbound `decision.answer` (§9.8).
   * @param {object} params - answer parameters.
   * @returns {Promise<object>} result.
   * @throws {BridgeError} `agent_cannot_decide` for a non-human actor.
   */
  async onDecisionAnswer(params) {
    if (params?.actor_kind !== 'human') throw new BridgeError('agent_cannot_decide');
    const decisionId = String(params.decision_id ?? '');
    const record = await this.store.get('decisions', decisionId);
    if (record === null) throw new BridgeError('task_not_found');
    const expires = Date.parse(String(record.expires_at ?? ''));
    if (!Number.isFinite(expires) || expires <= this.now()) {
      return { decision_id: decisionId, applied: false, reason: 'expired' };
    }
    const result = await this.store.answerDecision(decisionId, {
      choice: params.choice ?? null,
      free_text: params.free_text ?? null,
      actor: String(params.actor ?? ''),
      actor_kind: 'human',
      answered_at: params.answered_at ?? new Date(this.now()).toISOString(),
    });
    return {
      decision_id: decisionId,
      applied: result.applied,
      reason: result.applied ? null : result.reason,
    };
  }

  /**
   * Create a business decision that needs a human answer (§9.8).
   * @param {object} input - decision input.
   * @param {string|null} input.taskId - owning task.
   * @param {string} input.question - question text.
   * @param {object[]} input.options - selectable options.
   * @param {boolean} [input.allowFreeText] - whether free text is accepted.
   * @param {number} [input.timeoutS] - expiry window.
   * @returns {Promise<string>} the decision identity.
   */
  async requestDecision(input) {
    const decisionId = randomUUID();
    const record = {
      decision_id: decisionId,
      task_id: input.taskId ?? null,
      root_task_id: input.taskId ?? null,
      question: String(input.question ?? ''),
      options: input.options ?? [],
      allow_free_text: input.allowFreeText === true,
      default_option: null,
      expires_at: new Date(this.now() + (input.timeoutS ?? 1800) * 1000).toISOString(),
      answered: false,
      answer: null,
    };
    await this.store.putDecision(record);
    if (input.taskId !== null && input.taskId !== undefined) {
      const task = await this.store.getTask(input.taskId);
      if (task !== null) {
        await this.notify.emit({
          task_id: input.taskId,
          event: 'needs_decision',
          status: 'needs_decision',
          decision: {
            decision_id: decisionId,
            question: record.question,
            options: record.options,
            allow_free_text: record.allow_free_text,
            default_option: null,
            expires_at: record.expires_at,
            notify_id: randomUUID(),
          },
        });
      }
    }
    return decisionId;
  }

  /**
   * Remove the listener and stop the timeout loop.
   * @returns {void}
   */
  stop() {
    if (this._timeoutTimer !== null) {
      clearInterval(this._timeoutTimer);
      this._timeoutTimer = null;
    }
    // A handler cannot survive the service that owns the task: the held tasks
    // stay `pending_approval` (never executed) and are resumed only by a new
    // decision, which a new service would have to be told about.
    this._submitWaiters.clear();
    if (this._bridge !== null) {
      // Shutdown settles every claimed handle as unavailable: a handle cannot
      // survive its process, so nothing may stay answerable after this point.
      this._bridge.failAll('shutdown');
      this._bridge.dispose();
      this._bridge = null;
    }
    if (typeof this._disposer === 'function') this._disposer();
    this._disposer = null;
  }
}

/**
 * Normalize a candidate answer to the closed outcome vocabulary (§12.3).
 * @param {unknown} outcome - candidate.
 * @returns {string} one of the four outcomes; anything unknown fails closed.
 */
export function normaliseApprovalOutcome(outcome) {
  // The candidate is peer input, so it is `unknown`: only a string can name an
  // outcome, and a non-string is outside the vocabulary either way, so this
  // check never changes the result.
  if (typeof outcome === 'string' && /** @type {readonly string[]} */ (Object.values(ApprovalOutcome)).includes(outcome)) {
    return outcome;
  }
  return ApprovalOutcome.UNAVAILABLE;
}

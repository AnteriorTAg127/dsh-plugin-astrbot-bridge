/**
 * Task service: submit, status, list, cancel and event intake (protocol §9.3–§9.6,
 * §10, §16).
 *
 * The service is peer-symmetric: `submitInbound` accepts work from the peer and
 * `submitOutbound` initiates work at the peer. Both persist before they answer,
 * which is what makes "accepted" durable and what makes a reconnect a
 * *reconciliation* instead of a guess.
 * @module dsh-plugin-astrbot-bridge/app/tasks
 */

import { randomUUID } from 'node:crypto';

import { BridgeError } from '../errors.js';
import {
  Limits,
  MessageName,
  TaskEvent,
  TaskStatus,
  TERMINAL_STATUSES,
  WAKE_EVENTS,
} from '../constants.js';

/** Valid `kind` values per direction (§9.3). */
const KINDS = Object.freeze(['dsh_agent_run', 'astr_agent_run']);

/**
 * §15.3 refusals one submission can be remembered as (`rejected`).
 *
 * Only these codes are replayed when a refused `task_id` is submitted again;
 * a persisted code outside the vocabulary becomes `task_exists`, so the reply
 * can never carry a value the peer does not know.
 */
const REFUSAL_REPLAY_CODES = Object.freeze(
  new Set([
    'approval_digest_mismatch',
    'approval_expired',
    'approval_mismatch',
    'approval_already_decided',
    'approval_evidence_missing',
    'approval_lookup_failed',
    'agent_cannot_approve',
  ]),
);

/** Task service. */
export class TaskService {
  /**
   * @param {object} options - service dependencies.
   * @param {object} options.store - bridge store.
   * @param {object} options.session - session bound to the peer.
   * @param {object} options.host - agent host adapter.
   * @param {object} options.notify - notification service.
   * @param {object} options.config - bridge configuration.
   * @param {object} [options.attachments] - attachment host adapter.
   * @param {object} [options.blobService] - blob resolver for `blob_id`
   *   attachments; assigned by the composition root after construction.
   * @param {object} [options.approvals] - approval service (protocol §12). The
   *   composition root MUST pass the `ApprovalService` it builds for this
   *   connection: it is what opens the `cross_end_submit` gate of §12.5 point 5
   *   and what releases (or rejects) the held task once a human decided. While
   *   it is missing the gate is **fail-closed** — an inbound submission the
   *   local policy cannot gate is parked in `pending_approval` and never run —
   *   and reports `approval_gate_unwired` instead of looking like enforcement.
   * @param {object} [options.sessions] - session service; only its
   *   `isDeliverable(sessionId) => Promise<boolean>` method is used, to refuse
   *   an archived session as a delivery target (§9.7, §15.3 `session_archived`).
   *   `lib/index.js:_buildServices` MUST pass the `SessionService` it already
   *   builds; while it does not, the gate cannot see a disposition and reports
   *   `archive_gate_unwired` instead of pretending to enforce one.
   * @param {import('../log.js').Logger} [options.logger] - structured logger.
   * @param {Function} [options.now] - injectable clock.
   */
  constructor(options) {
    this.store = options.store;
    this.session = options.session;
    this.host = options.host;
    this.notify = options.notify;
    this.config = options.config;
    this.attachments = options.attachments ?? null;
    this.sessions = options.sessions ?? null;
    /**
     * Blob service used to resolve `blob_id` attachments into image bytes.
     *
     * Injected after construction by `lib/index.js:_buildServices` (the blob
     * service needs the same session and store, so it is built alongside this
     * one). Left `undefined` — not `null` — so `_resolveImages` keeps its
     * "no resolver wired" early return and never calls into an absent service.
     * @type {object|undefined}
     */
    this.blobService = options.blobService;
    this.approvals = options.approvals ?? null;
    this.logger = options.logger ?? { info() {}, warn() {}, failure() {}, debug() {}, error() {} };
    this.now = options.now ?? (() => Date.now());
    /** @type {Map<string, Promise<unknown>>} in-flight executions by task id. */
    this._executions = new Map();
    /** @type {Map<string, Promise<unknown>>} in-flight applications by notification id. */
    this._intake = new Map();
    /** Whether the missing-`sessions` warning has already been emitted. */
    this._archiveGateWarned = false;
    /** Whether the missing-`approvals` warning has already been emitted. */
    this._approvalGateWarned = false;
    /** Serializes the read-modify-write of an `approval_ref` consumption. */
    this._refChain = Promise.resolve();
    /** Whether restart reconciliation already ran for this service. */
    this._recovered = false;
    /** @type {Map<string, Promise<unknown>>} background evidence checks by task id. */
    this._refVerifications = new Map();
  }

  /**
   * Decide whether one session may receive a delivery, and why not.
   *
   * Order matters twice over:
   *
   *   - **authorization before disposition**: a session the peer never granted
   *     must not learn whether it is archived, so it is reported
   *     `session_not_authorized` rather than `session_archived` (§9.7 hides
   *     existence instead of refusing it);
   *   - **the gate is fail-closed**: only a literal `true` from
   *     `sessions.isDeliverable` opens it. A probe that throws, or one that
   *     answers something that is not a boolean, closes it, because an unknown
   *     archive state must not be treated as "not archived".
   *
   * A *missing* `sessions` dependency is a composition gap, not a denial: the
   * caller's own authorization check still stands, so delivery is not blocked,
   * but the gap is logged once (`archive_gate_unwired`) rather than silently
   * looking like enforcement. Wiring it is a `lib/index.js` change.
   * @param {string|null} sessionId - session identity, `null` when unresolved.
   * @returns {Promise<string|null>} a §15.3 code when delivery must be refused,
   *   `null` when it may proceed.
   */
  async _deliveryBlock(sessionId) {
    if (sessionId === null || sessionId === undefined) return null;
    // Authorization never depends on the disposition dependency: it is the
    // peer's table and it is checked whether or not `sessions` is wired.
    if (!(await this.store.isAuthorized(sessionId))) return 'session_not_authorized';
    return this._archiveBlock(sessionId);
  }

  /**
   * Whether one *already authorized* session is archived.
   *
   * Archive is a disposition recorded against a granted session (`manage()`
   * refuses an ungranted one), so this answers "is this session archived"
   * rather than "may anything reach it". Keeping the two questions apart
   * matters: `sessions.isDeliverable` is `authorized && !archived`, and using it
   * on a path that never required authorization would silently turn an archive
   * check into a stricter authorization check.
   *
   * Fail-closed: only a literal `true` counts as "not archived", so a probe
   * that throws, or one that answers a non-boolean, is treated as archived.
   * @param {string|null} sessionId - session identity, `null` when unresolved.
   * @returns {Promise<string|null>} `session_archived` when archived, else null.
   */
  async _archiveBlock(sessionId) {
    if (sessionId === null || sessionId === undefined) return null;
    if (this.sessions === null || typeof this.sessions.isDeliverable !== 'function') {
      if (this._archiveGateWarned === false) {
        this._archiveGateWarned = true;
        this.logger.warn('archive_gate_unwired', { service: 'tasks' });
      }
      return null;
    }
    try {
      return (await this.sessions.isDeliverable(sessionId)) === true ? null : 'session_archived';
    } catch (error) {
      // The disposition could not be read. Delivering into a session whose
      // archive state is unknown is exactly the failure this gate exists for.
      this.logger.failure('archive_gate_failed', error, { session: String(sessionId) });
      return 'session_archived';
    }
  }

  /**
   * Validate a `task.submit` request (§9.3).
   * @param {object} params - request parameters.
   * @returns {object} normalized parameters.
   * @throws {BridgeError} `bad_params` on any violation.
   */
  validateSubmit(params) {
    const fail = (field) => {
      throw new BridgeError('bad_params', { details: { field } });
    };
    if (params === null || typeof params !== 'object') fail('params');
    for (const field of ['task_id', 'root_task_id', 'kind', 'origin']) {
      if (typeof params[field] !== 'string' || params[field].length === 0) fail(field);
    }
    if (!KINDS.includes(params.kind)) fail('kind');
    if (!['llm', 'human'].includes(params.origin)) fail('origin');
    if (!Array.isArray(params.input_parts) || params.input_parts.length === 0) fail('input_parts');
    if (params.input_parts.length > Limits.MAX_INPUT_PARTS) fail('input_parts');
    for (const part of params.input_parts) {
      if (part?.type !== 'text' || typeof part.text !== 'string') fail('input_parts');
      if (part.text.length > Limits.MAX_TEXT_CHARS) fail('input_parts');
    }
    if (!Array.isArray(params.attachments)) fail('attachments');
    if (!Array.isArray(params.tool_hints)) fail('tool_hints');
    if (!(params.session_id === null || typeof params.session_id === 'string')) fail('session_id');
    if (!(params.purpose === null || typeof params.purpose === 'string')) fail('purpose');
    if (!Number.isInteger(params.timeout_s) || params.timeout_s < 1 || params.timeout_s > 86_400) fail('timeout_s');
    if (params.meta === null || typeof params.meta !== 'object' || Array.isArray(params.meta)) fail('meta');
    if (!(params.approval_ref === null || typeof params.approval_ref === 'object')) fail('approval_ref');
    return params;
  }

  /**
   * Accept a task from the peer and answer immediately (§9.3, C4).
   *
   * Execution is started in the background on a later tick: the reply must not
   * wait for the agent, and the task is durable before the reply leaves.
   * @param {object} params - validated `task.submit` parameters.
   * @returns {Promise<object>} `task.submit` result.
   * @throws {BridgeError} on validation, authorization or approval failures.
   */
  async submitInbound(params) {
    this.validateSubmit(params);
    const existing = await this.store.getTask(params.task_id);
    if (existing !== null) {
      // §10.1: the same task id is idempotent and must not run twice.
      //
      // §9.3 allows only `accepted` / `pending_approval` in this reply, so a
      // stored task that was **refused before admission** must not be
      // re-announced as `accepted`: nothing was ever dispatched for it and
      // nothing ever will be, so that answer would send the peer polling for a
      // task that cannot run. The refusal is durable (`rejected` + the wire
      // error of the first attempt), so it is replayed unchanged — the same
      // `BridgeError`, still no dispatch, and no second consumption of the
      // reference. A task that *was* admitted keeps the §10.1 replay answer
      // below unchanged, `dedup:true` being what marks it as a replay.
      if (existing.status === TaskStatus.REJECTED) {
        const storedCode = String(existing.error?.code ?? '');
        // The refusal is replayed from the durable record, never re-derived:
        // the reference is *not* verified (and therefore not consumed) a second
        // time, and nothing is dispatched.
        const refusal = new BridgeError(REFUSAL_REPLAY_CODES.has(storedCode) ? storedCode : 'task_exists');
        this.logger.warn('task_submit_refused', {
          task: existing.task_id,
          code: refusal.code,
          field: 'dedup',
        });
        throw refusal;
      }
      return {
        task_id: existing.task_id,
        status: existing.status === TaskStatus.PENDING_APPROVAL ? 'pending_approval' : 'accepted',
        root_task_id: existing.root_task_id,
        session_id: existing.session_id ?? null,
        poll_hint_ms: 2000,
        dedup: true,
      };
    }

    if (params.session_id !== null) {
      // §9.7: the peer's authorization table is the only authority, and it is
      // consulted before the local disposition so an unauthorized session is
      // refused as unauthorized instead of leaking whether it is archived.
      // §15.3: an archived session is a refused delivery target, not a silent
      // fallback to some other conversation.
      const block = await this._deliveryBlock(params.session_id);
      if (block !== null) throw new BridgeError(block);
    }

    /** @type {string} */
    let status = TaskStatus.ACCEPTED;
    /** @type {BridgeError|null} */
    let refRefusal = null;
    /** Whether the authoritative evidence still has to be checked. */
    let deferredRef = false;
    if (params.approval_ref !== null && params.approval_ref !== undefined) {
      try {
        // Cheap self-consistency only: the digest of *this* submission, a human
        // claim and a deadline. The authoritative evidence may need a peer
        // round-trip, so it is checked after this reply (§12.7.5).
        await this._checkSubmitRef(params);
        status = TaskStatus.PENDING_APPROVAL;
        deferredRef = true;
      } catch (error) {
        // §12.5 point 5 is fail-closed: a self-inconsistent reference may neither
        // be accepted nor run. The refusal is durable (`rejected`) and rethrown
        // before any execution is scheduled.
        if (!(error instanceof BridgeError)) throw error;
        refRefusal = error;
        status = TaskStatus.REJECTED;
      }
    } else if (await this._submitNeedsApproval(params)) {
      // §12.5 point 5: no approval reference and the local policy requires one.
      // The task is held — nothing may execute before a human answered — and the
      // approval is opened below, after the task itself is durable.
      status = TaskStatus.PENDING_APPROVAL;
    }

    const task = {
      task_id: params.task_id,
      root_task_id: params.root_task_id,
      kind: params.kind,
      origin: params.origin,
      direction: 'inbound',
      status,
      session_id: params.session_id,
      purpose: params.purpose,
      timeout_s: params.timeout_s,
      input_parts: params.input_parts,
      attachments: params.attachments,
      tool_hints: params.tool_hints,
      meta: params.meta,
      approval_ref: params.approval_ref ?? null,
      eseq: 0,
      attempts: 0,
      needs_human: false,
      result: null,
      error: refRefusal === null ? null : refRefusal.toWire(),
      created_at: new Date(this.now()).toISOString(),
      updated_at: new Date(this.now()).toISOString(),
    };
    // Persist before answering: a crash between here and the reply must leave a
    // task the peer can still query by id.
    await this.store.putTask(task);
    // A refused reference is durable but never accepted: no wake, no dispatch.
    // The protocol reply is the refusal itself, so the peer learns why.
    if (refRefusal !== null) {
      this.logger.warn('task_submit_refused', {
        task: task.task_id,
        code: refRefusal.code,
        field: 'approval_ref',
      });
      throw refRefusal;
    }
    this.logger.info('task_accepted', { task: task.task_id, direction: 'inbound', status });

    if (status === TaskStatus.PENDING_APPROVAL) {
      if (deferredRef) {
        // Nothing may run until the reference is proven; the reply is still
        // immediate and the peer's later `task.event` reports the outcome.
        this._scheduleRefVerification(task.task_id);
      } else {
        await this._holdForApproval(task, params);
      }
      return {
        task_id: task.task_id,
        status,
        root_task_id: task.root_task_id,
        session_id: task.session_id,
        poll_hint_ms: 2000,
        dedup: false,
      };
    }

    this._dispatchInbound(task);

    return {
      task_id: task.task_id,
      status,
      root_task_id: task.root_task_id,
      session_id: task.session_id,
      poll_hint_ms: 2000,
      dedup: false,
    };
  }

  /**
   * Whether one submission the peer did **not** approve requires a human here (§12.5 point 5).
   *
   * The decision is local, and the wire cannot make it: `origin` is a peer
   * assertion, so a payload claiming `human` is not evidence that a human acted
   * (the integration plan forbids exactly that bypass). The corroboration used
   * instead comes from the peer's *authorization table* — pushed over the
   * authenticated channel and cached locally — which records who granted the
   * target session: only a session a **human** granted can carry a human command
   * straight through. Everything else (an LLM-originated submission, an
   * agent-created session, or a task that names no session at all) is held for a
   * human.
   * @param {object} params - validated `task.submit` parameters.
   * @returns {Promise<boolean>} whether the submission must wait for a human.
   */
  async _submitNeedsApproval(params) {
    if (params.origin === 'llm') return true;
    return !(await this._humanGranted(params.session_id));
  }

  /**
   * Whether one session was granted by a human on the peer side.
   *
   * `granted_by` is the authority table's own field (`human` vs `agent_auto`);
   * it is not part of the submission and therefore cannot be forged by the
   * payload that is being judged. A malformed or expired grant does not count.
   * @param {string|null} sessionId - target session, `null` when the peer let
   *   this side pick one.
   * @returns {Promise<boolean>} whether a human granted this session.
   */
  async _humanGranted(sessionId) {
    if (sessionId === null || sessionId === undefined) return false;
    const snapshot = await this.store.authzSnapshot();
    const grant = snapshot.grants.find((entry) => String(entry.session_id) === String(sessionId));
    if (grant === undefined || grant.granted_by !== 'human') return false;
    const raw = grant.expires_at;
    if (raw === null || raw === undefined) return true;
    const expires = Date.parse(String(raw));
    return Number.isFinite(expires) && expires > this.now();
  }

  /**
   * Open the approval of one held submission through the real `ApprovalService` (§12.5).
   *
   * The task stays `pending_approval` with nothing running. When the service is
   * not wired the gate is fail-closed: the task is parked for a human and the
   * composition gap is reported (`approval_gate_unwired`), never silently
   * executed.
   * @param {object} task - the persisted, held task.
   * @param {object} params - its `task.submit` parameters.
   * @returns {Promise<void>} resolution after the approval was opened.
   */
  async _holdForApproval(task, params) {
    if (this.approvals === null || typeof this.approvals.requestSubmitApproval !== 'function') {
      if (!this._approvalGateWarned) {
        this._approvalGateWarned = true;
        this.logger.warn('approval_gate_unwired', { service: 'tasks', task: task.task_id });
      }
      await this.store.putTask({
        ...(await this.store.getTask(task.task_id)),
        needs_human: true,
        error: { code: 'needs_human', message: 'human attention required', details: null },
      });
      return;
    }
    const approval = await this.approvals.requestSubmitApproval({
      task,
      tool: String(params.kind ?? ''),
      reason: 'cross-end task submission',
      displayReason: { en: 'Run a cross-end task', zh: '执行跨端任务' },
      // Persist the exact approved content, so only an `approval_ref` that
      // reproduces it can ever spend this decision (§12.5).
      submitDigest: await this.submitDigestOf(params),
      onDecided: (record, allowed) => this._settleSubmitApproval(record, allowed),
    });
    await this.store.putTask({
      ...(await this.store.getTask(task.task_id)),
      approval_id: approval.approval_id,
    });
    this.logger.info('submit_held_for_approval', {
      task: task.task_id,
      approval: approval.approval_id,
    });
  }

  /**
   * Release or reject one held submission after its approval was decided (§12.4, §12.5).
   *
   * Only a task still sitting in `pending_approval` is acted on: the durable
   * status is the one-shot latch, so a second decision (or a decision that raced
   * a cancel) can never start a second execution.
   * @param {object} record - the decided approval record.
   * @param {boolean} allowed - whether a human allowed it (once).
   * @returns {Promise<void>} resolution after the task moved on.
   */
  async _settleSubmitApproval(record, allowed) {
    const taskId = String(record?.task_id ?? '');
    if (taskId.length === 0) return;
    const task = await this.store.getTask(taskId);
    if (task === null || task.status !== TaskStatus.PENDING_APPROVAL) return;
    if (allowed !== true) {
      const error = { code: 'rejected', message: 'rejected by a human', details: null };
      const rejected = await this.store.transition(taskId, TaskStatus.REJECTED, { error });
      if (rejected.status !== TaskStatus.REJECTED) return;
      await this._emit(taskId, TaskEvent.FAILED, TaskStatus.REJECTED, { error });
      this.logger.info('submit_approval_rejected', { task: taskId, approval: record?.approval_id });
      return;
    }
    // The receiver-domain consumption is the one-shot latch and MUST be durable
    // **before** the task becomes accepted, because acceptance is what makes
    // execution possible. A refused or failed claim (`false`/throw) parks the
    // task for a human: no `accepted` event is emitted and nothing runs. The
    // crash window after this claim but before acceptance is recovered as
    // `needs_human` by `recoverAfterRestart`, never by replaying the gate.
    const approvalId = String(record?.approval_id ?? '');
    let claimed = false;
    if (approvalId.length > 0) {
      try {
        claimed = await this.store.claimApprovalConsumption(approvalId, taskId);
      } catch (error) {
        claimed = false;
        this.logger.failure('submit_approval_consume_failed', error, {
          task: taskId,
          approval: approvalId,
        });
      }
    }
    if (!claimed) {
      const error = {
        code: 'approval_settlement_lost',
        message: 'approval consumption could not be recorded',
        details: null,
      };
      const parked = await this.store.transition(taskId, TaskStatus.NEEDS_HUMAN, {
        needs_human: true,
        error,
      });
      if (parked.status === TaskStatus.NEEDS_HUMAN) {
        await this._emit(taskId, TaskEvent.NEEDS_HUMAN, TaskStatus.NEEDS_HUMAN, { error });
      }
      this.logger.warn('submit_approval_consumption_refused', {
        task: taskId,
        approval: approvalId,
      });
      return;
    }
    const released = await this.store.transition(taskId, TaskStatus.ACCEPTED, {});
    if (released.status !== TaskStatus.ACCEPTED) {
      // The claim is already durable, but the task did not become executable
      // (a cancel raced, or the state moved). Never leave a spent approval
      // behind a non-terminal task: park it for a human instead of running.
      if (!TERMINAL_STATUSES.includes(released.status)) {
        const error = {
          code: 'approval_settlement_lost',
          message: 'approval consumption was claimed but the task did not become accepted',
          details: null,
        };
        const parked = await this.store.transition(taskId, TaskStatus.NEEDS_HUMAN, {
          needs_human: true,
          error,
        });
        if (parked.status === TaskStatus.NEEDS_HUMAN) {
          await this._emit(taskId, TaskEvent.NEEDS_HUMAN, TaskStatus.NEEDS_HUMAN, { error });
        }
      }
      return;
    }
    await this._emit(taskId, TaskEvent.ACCEPTED, TaskStatus.ACCEPTED);
    this.logger.info('submit_approval_allowed', { task: taskId, approval: approvalId });
    this._dispatchInbound(released);
  }

  /**
   * Reconcile inbound tasks after a process restart (§16.2).
   *
   * Safe resumes: `accepted`/`queued` inbound tasks whose human gate (when one
   * exists) was already consumed. Anything with an unknown execution state is
   * parked for a human and never re-run. A pending task whose gate was already
   * claimed is a crash between the one-shot claim and acceptance; the claim
   * cannot be reused, so it is parked as well.
   * @returns {Promise<{resumed: string[], needs_human: string[], kept: string[]}>} summary.
   */
  async recoverAfterRestart() {
    if (this._recovered) return { resumed: [], needs_human: [], kept: [] };
    this._recovered = true;
    const resumed = [];
    const uncertain = [];
    const kept = [];

    const park = async (task, code, message) => {
      const error = { code, message, details: null };
      const parked = await this.store.transition(task.task_id, TaskStatus.NEEDS_HUMAN, {
        needs_human: true,
        error,
      });
      if (parked.status !== TaskStatus.NEEDS_HUMAN) return;
      await this._emit(task.task_id, TaskEvent.NEEDS_HUMAN, TaskStatus.NEEDS_HUMAN, { error });
      uncertain.push(task.task_id);
    };

    const tasks = await this.store.list('tasks');
    for (const task of tasks) {
      const status = String(task?.status ?? '');
      if (status !== TaskStatus.ACCEPTED && status !== TaskStatus.QUEUED) continue;
      if (task.direction !== 'inbound') {
        kept.push(String(task.task_id));
        continue;
      }
      const approvalId = String(task.approval_id ?? task.approval_ref?.approval_id ?? '');
      if (approvalId.length > 0) {
        const record = await this.store.getApproval(approvalId);
        if (record === null || String(record.consumed_by_task ?? '') !== String(task.task_id)) {
          // Accepted before its gate was spent (crash window) or the gate row is
          // gone: resuming would execute without a proven, consumed decision.
          await park(task, 'approval_settlement_lost', 'restart found acceptance without a consumed human gate');
          continue;
        }
      }
      this._dispatchInbound(task);
      resumed.push(String(task.task_id));
    }

    for (const task of tasks) {
      if (task?.status !== TaskStatus.RUNNING) continue;
      await park(task, 'execution_unknown', 'restart while running');
    }

    for (const task of tasks) {
      if (task?.status !== TaskStatus.PENDING_APPROVAL) continue;
      const approvalId = String(task.approval_id ?? task.approval_ref?.approval_id ?? '');
      if (approvalId.length === 0) {
        kept.push(String(task.task_id));
        continue;
      }
      const record = await this.store.getApproval(approvalId);
      if (record !== null && String(record.consumed_by_task ?? '') === String(task.task_id)) {
        // The one-shot claim happened, then the process died before
        // `accepted`. It cannot be claimed again and must not run.
        await park(task, 'approval_settlement_lost', 'restart found a claimed approval on a pending task');
        continue;
      }
      kept.push(String(task.task_id));
    }

    if (uncertain.length > 0) {
      this.logger.warn('restart_recovery_parked', { count: uncertain.length });
    }
    this.logger.info('restart_recovery', {
      resumed: resumed.length,
      needs_human: uncertain.length,
      kept: kept.length,
    });
    return { resumed, needs_human: uncertain, kept };
  }

  /**
   * Start one inbound execution at most once per task.
   * @param {object} task - task record to execute.
   * @returns {void}
   */
  _dispatchInbound(task) {
    if (this._executions.has(task.task_id)) return;
    const run = this._runInbound(task)
      .catch((error) => {
        this.logger.failure('task_execution_failed', error, { task: task.task_id });
      })
      .finally(() => {
        this._executions.delete(task.task_id);
      });
    this._executions.set(task.task_id, run);
  }

  /**
   * Check the self-consistency of an `approval_ref` (no store, no network).
   * @param {object} params - `task.submit` parameters.
   * @returns {Promise<void>} resolution after the cheap checks passed.
   * @throws {BridgeError} `approval_mismatch` / `approval_digest_mismatch` /
   *   `agent_cannot_approve` / `approval_expired`.
   */
  async _checkSubmitRef(params) {
    const ref = params.approval_ref;
    if (ref === null || typeof ref !== 'object' || Array.isArray(ref)) {
      throw new BridgeError('approval_mismatch', { details: { field: 'approval_ref' } });
    }
    const approvalId = String(ref.approval_id ?? '');
    if (approvalId.length === 0) {
      throw new BridgeError('approval_mismatch', { details: { field: 'approval_id' } });
    }
    if (ref.actor_kind !== 'human') throw new BridgeError('agent_cannot_approve');
    const expires = Date.parse(String(ref.expires_at ?? ''));
    if (!Number.isFinite(expires) || expires <= this.now()) throw new BridgeError('approval_expired');
    if (String(ref.submit_digest ?? '') !== (await this.submitDigestOf(params))) {
      throw new BridgeError('approval_digest_mismatch');
    }
  }

  /**
   * Start the background evidence check for one held reference task (§12.7.5).
   * @param {string} taskId - held inbound task.
   * @returns {void}
   */
  _scheduleRefVerification(taskId) {
    if (this._refVerifications.has(taskId)) return;
    const run = this._verifyRefTask(taskId)
      .catch((error) => {
        this.logger.failure('approval_ref_verification_failed', error, { task: taskId });
      })
      .finally(() => {
        this._refVerifications.delete(taskId);
      });
    this._refVerifications.set(taskId, run);
  }

  /**
   * Prove an inbound `approval_ref` and release the task exactly once (§12.7.4).
   *
   * Failure is terminal `rejected`: no downgrade to "no reference", no retry and
   * never a run without complete evidence.
   * @param {string} taskId - held inbound task.
   * @returns {Promise<void>} resolution after the task moved on.
   */
  async _verifyRefTask(taskId) {
    const task = await this.store.getTask(taskId);
    if (task === null || task.status !== TaskStatus.PENDING_APPROVAL) return;
    const wire = {
      task_id: task.task_id,
      root_task_id: task.root_task_id,
      kind: task.kind,
      origin: task.origin,
      input_parts: task.input_parts ?? [],
      attachments: task.attachments ?? [],
      tool_hints: task.tool_hints ?? [],
      session_id: task.session_id ?? null,
      purpose: task.purpose ?? null,
      timeout_s: task.timeout_s,
      meta: task.meta ?? {},
      approval_ref: task.approval_ref ?? null,
    };
    try {
      if (this.approvals === null || typeof this.approvals.lookupEvidence !== 'function') {
        throw new BridgeError('approval_lookup_failed');
      }
      const evidence = await this.approvals.lookupEvidence(wire);
      const run = this._refChain.then(async () => {
        const current = await this.store.getTask(taskId);
        if (current === null || current.status !== TaskStatus.PENDING_APPROVAL) return false;
        const record = await this.store.getApproval(String(evidence.approval_id));
        if (record === null) throw new BridgeError('approval_mismatch', { details: { field: 'approval_id' } });
        // One-shot receiver-domain CAS: an already consumed mirror (replay or
        // another task) must execute nothing.
        const claimed = await this.store.claimApprovalConsumption(
          String(evidence.approval_id),
          String(taskId),
        );
        if (!claimed) throw new BridgeError('approval_already_decided');
        return true;
      });
      this._refChain = run.then(
        () => {},
        () => {},
      );
      if (!(await run)) return;
      const accepted = await this.store.transition(taskId, TaskStatus.ACCEPTED, {});
      if (accepted.status !== TaskStatus.ACCEPTED) {
        // The consumption is already durable but the task did not become
        // executable (a cancel raced, or the state moved). Never leave a spent
        // approval behind a pending task; park it for a human.
        if (accepted.status === TaskStatus.PENDING_APPROVAL || accepted.status === TaskStatus.QUEUED) {
          const error = {
            code: 'approval_settlement_lost',
            message: 'approval consumption was claimed but the task did not become accepted',
            details: null,
          };
          const parked = await this.store.transition(taskId, TaskStatus.NEEDS_HUMAN, {
            needs_human: true,
            error,
          });
          if (parked.status === TaskStatus.NEEDS_HUMAN) {
            await this._emit(taskId, TaskEvent.NEEDS_HUMAN, TaskStatus.NEEDS_HUMAN, { error });
          }
        }
        return;
      }
      await this._emit(taskId, TaskEvent.ACCEPTED, TaskStatus.ACCEPTED);
      this.logger.info('approval_ref_verified', {
        task: taskId,
        approval: String(evidence.approval_id),
        source: String(evidence.source ?? ''),
      });
      this._dispatchInbound(accepted);
    } catch (error) {
      const code = error instanceof BridgeError ? error.code : 'approval_lookup_failed';
      await this._rejectRefTask(taskId, code);
    }
  }

  /**
   * Fail a held reference task closed and tell the peer.
   * @param {string} taskId - task that could not prove its reference.
   * @param {string} code - refusal code reported to the peer.
   * @returns {Promise<void>} resolution after the task moved on.
   */
  async _rejectRefTask(taskId, code) {
    const task = await this.store.getTask(taskId);
    if (task === null || task.status !== TaskStatus.PENDING_APPROVAL) return;
    const error = { code, message: 'approval reference could not be verified', details: null };
    const rejected = await this.store.transition(taskId, TaskStatus.REJECTED, { error });
    if (rejected.status !== TaskStatus.REJECTED) return;
    this.logger.warn('approval_ref_refused', { task: taskId, code });
    await this.notify.emit({
      task_id: taskId,
      event: TaskEvent.FAILED,
      status: TaskStatus.REJECTED,
      error,
    });
  }

  /**
   * Compute the §12.5 `submit_digest` for one submission.
   * @param {object} params - `task.submit` parameters.
   * @returns {Promise<string>} base64url digest.
   */
  async submitDigestOf(params) {
    const { submitDigest, inputPartsDigest } = await import('../crypto.js');
    return submitDigest({
      task_id: params.task_id,
      root_task_id: params.root_task_id,
      kind: params.kind,
      origin: params.origin,
      session_id: params.session_id,
      purpose: params.purpose,
      timeout_s: params.timeout_s,
      input_parts_digest: inputPartsDigest(params.input_parts),
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
   * Execute one accepted inbound task on a host agent.
   *
   * Every state change is persisted before it is announced (§10.2), and a
   * failure to determine the outcome parks the task in `needs_human` rather
   * than re-running it (§16.2).
   * @param {object} task - task record.
   * @returns {Promise<void>} resolution when the task reached a terminal state.
   */
  async _runInbound(task) {
    let sessionId;
    try {
      sessionId = task.session_id ?? (await this._pickSession(task));
    } catch (error) {
      // No eligible session: park it for a human. `_runInbound` runs detached
      // (`void ... .catch(...)`), so a throw here would leave the task stranded
      // in `accepted` with no event and no next step.
      const failure = error instanceof BridgeError ? error : new BridgeError('internal_error');
      // Only a "no eligible target" outcome is parked here; anything else is a
      // real fault and keeps its existing handling (the caller logs it).
      if (failure.code !== 'session_not_authorized' && failure.code !== 'session_archived') throw failure;
      const wireError = failure.toWire();
      await this.store.transition(task.task_id, TaskStatus.NEEDS_HUMAN, {
        needs_human: true,
        error: wireError,
      });
      await this._emit(task.task_id, TaskEvent.NEEDS_HUMAN, TaskStatus.NEEDS_HUMAN, { error: wireError });
      return;
    }
    // Execution boundary, not submission boundary. `submitInbound` answers
    // `accepted` before anything runs, so the session named by the task may be
    // archived during that window; re-checking here is what stops a task that
    // was already accepted from still executing into an archived session
    // (§9.7, §15.3 `session_archived`). The check happens before `queued` /
    // `running` is claimed, so a refused task never pretends to have run.
    const blocked = await this._deliveryBlock(sessionId);
    if (blocked !== null) {
      // Not a task failure and not a silent drop: a human can unarchive the
      // session and retry under a new `task_id` (§16.1, §16.2).
      const error = new BridgeError(blocked).toWire();
      await this.store.transition(task.task_id, TaskStatus.NEEDS_HUMAN, {
        needs_human: true,
        error,
      });
      await this._emit(task.task_id, TaskEvent.NEEDS_HUMAN, TaskStatus.NEEDS_HUMAN, { error });
      return;
    }
    if (task.status === TaskStatus.QUEUED) {
      // Restart recovery: `queued` was durable but `running` never was, so no
      // delivery was attempted. Do not emit a duplicate queued event.
      await this.store.transition(task.task_id, TaskStatus.RUNNING, { attempts: 1 });
      await this._emit(task.task_id, TaskEvent.RUNNING, TaskStatus.RUNNING);
    } else {
      await this.store.transition(task.task_id, TaskStatus.QUEUED, { session_id: sessionId });
      await this._emit(task.task_id, TaskEvent.QUEUED, TaskStatus.QUEUED);
      await this.store.transition(task.task_id, TaskStatus.RUNNING, { attempts: 1 });
      await this._emit(task.task_id, TaskEvent.RUNNING, TaskStatus.RUNNING);
    }

    const text = task.input_parts.map((part) => part.text).join('\n');
    try {
      const delivery = await this.host.deliver({
        sessionId,
        text,
        images: await this._resolveImages(task),
        wake: true,
      });
      const idle = await this.host.waitIdle(sessionId, Math.min(task.timeout_s, 3600) * 1000);
      if (!idle) {
        await this.store.transition(task.task_id, TaskStatus.NEEDS_HUMAN, {
          needs_human: true,
          error: { code: 'task_timeout', message: 'task timed out', details: null },
        });
        await this._emit(task.task_id, TaskEvent.NEEDS_HUMAN, TaskStatus.NEEDS_HUMAN, {
          error: { code: 'task_timeout', message: 'task timed out', details: null },
        });
        return;
      }
      const result = { summary: 'completed', text: '', attachments: [], degraded: delivery.degraded };
      await this.store.transition(task.task_id, TaskStatus.SUCCEEDED, { result });
      await this._emit(task.task_id, TaskEvent.COMPLETED, TaskStatus.SUCCEEDED, { result });
    } catch (error) {
      const failure = error instanceof BridgeError ? error : new BridgeError('internal_error');
      if (failure.code === 'capability_unavailable' || failure.code === 'session_not_found') {
        // Not a task failure the peer can fix by retrying: a human must decide.
        await this.store.transition(task.task_id, TaskStatus.FAILED, {
          error: failure.toWire(),
        });
        await this._emit(task.task_id, TaskEvent.FAILED, TaskStatus.FAILED, { error: failure.toWire() });
        return;
      }
      // Unknown outcome: never re-run, never claim success (§16.2).
      await this.store.transition(task.task_id, TaskStatus.NEEDS_HUMAN, {
        needs_human: true,
        error: failure.toWire(),
      });
      await this._emit(task.task_id, TaskEvent.NEEDS_HUMAN, TaskStatus.NEEDS_HUMAN, {
        error: failure.toWire(),
      });
    }
  }

  /**
   * Choose a session for a task that named none (§9.3 `session_id: null`).
   *
   * Only sessions the peer authorized are eligible; when none is, the task is
   * parked for a human instead of landing in an arbitrary conversation. An
   * archived session is not a delivery target either, so it is skipped here
   * rather than selected and then refused at the execution boundary — picking
   * it would park a task that another eligible session could have run.
   *
   * Only the *archive* disposition is consulted: the candidates already come
   * from the authorization snapshot, and re-judging authorization here would
   * change unrelated grant semantics (expiry, for one) as a side effect.
   * @param {object} task - task record.
   * @returns {Promise<string>} chosen session id.
   * @throws {BridgeError} `session_not_authorized` or `session_archived` when
   *   nothing is eligible.
   */
  async _pickSession(task) {
    const snapshot = await this.store.authzSnapshot();
    const purpose = task.purpose;
    const candidates = snapshot.grants.filter((grant) =>
      purpose === null || purpose === undefined ? true : grant.purpose === purpose,
    );
    /** @type {string|null} first refusal, reported when nothing is eligible. */
    let refusal = null;
    const usable = [];
    for (const grant of candidates) {
      const blocked = await this._archiveBlock(String(grant.session_id));
      if (blocked === null) usable.push(grant);
      else refusal ??= blocked;
    }
    const live = new Set(this.host.listSessions().map((entry) => entry.session_id));
    const chosen = usable.find((grant) => live.has(String(grant.session_id))) ?? usable[0];
    if (chosen === undefined) throw new BridgeError(refusal ?? 'session_not_authorized');
    return String(chosen.session_id);
  }

  /**
   * Turn `blob_id` attachments into host image references.
   * @param {object} task - task record.
   * @returns {Promise<object[]>} `ImageAttachmentRef` values.
   */
  async _resolveImages(task) {
    if (this.attachments === null || (task.attachments ?? []).length === 0) return [];
    const blobService = this.blobService;
    if (blobService === undefined) return [];
    const refs = [];
    for (const attachment of task.attachments) {
      const bytes = await blobService.bytesOf(attachment.blob_id);
      refs.push(
        await this.attachments.saveImage({
          data: bytes,
          mediaType: attachment.media_type,
          name: undefined,
        }),
      );
    }
    return refs;
  }

  /**
   * Initiate a task at the peer and return immediately (C4).
   * @param {object} params - submission inputs.
   * @param {string} params.text - prompt text.
   * @param {string} [params.purpose] - purpose label.
   * @param {string[]} [params.toolHints] - tool names to hint.
   * @param {string|null} [params.sessionId] - peer session to target.
   * @param {string} [params.origin] - `llm` or `human`.
   * @param {string|null} [params.rootTaskId] - upstream root for a derived task.
   * @param {number} [params.timeoutS] - execution timeout.
   * @param {object|null} [params.approvalRef] - §12.5 approval reference presented
   *   to the peer; absent or null means the submission carries no approval.
   * @param {boolean} [params.requireApproval] - hold the submission behind this
   *   side's human gate instead of sending it immediately.
   * @returns {Promise<{task_id: string, status: string, root_task_id: string, dedup: boolean}>} result.
   * @throws {BridgeError} when the peer refuses the submission.
   */
  async submitOutbound(params) {
    if (
      params.requireApproval === true &&
      (params.approvalRef === null || params.approvalRef === undefined) &&
      this.approvals !== null
    ) {
      return this._prepareOutboundApproval(params);
    }
    const taskId = randomUUID();
    const rootTaskId = params.rootTaskId ?? taskId;
    const request = {
      task_id: taskId,
      root_task_id: rootTaskId,
      kind: 'astr_agent_run',
      origin: params.origin ?? 'llm',
      input_parts: [{ type: 'text', text: String(params.text ?? '') }],
      attachments: [],
      tool_hints: (params.toolHints ?? []).map((tool) => ({ tool, args_hint: {} })),
      session_id: params.sessionId ?? null,
      purpose: params.purpose ?? null,
      timeout_s: params.timeoutS ?? 1800,
      meta: {},
      approval_ref: params.approvalRef ?? null,
    };
    // Persist the outbound intent first: if the reply never arrives, the task
    // still exists and can be reconciled instead of vanishing (§16.2).
    await this.store.putTask({
      task_id: taskId,
      root_task_id: rootTaskId,
      kind: request.kind,
      origin: request.origin,
      direction: 'outbound',
      status: TaskStatus.ACCEPTED,
      session_id: request.session_id,
      purpose: request.purpose,
      timeout_s: request.timeout_s,
      input_parts: request.input_parts,
      attachments: [],
      tool_hints: request.tool_hints,
      meta: {},
      approval_ref: request.approval_ref,
      eseq: 0,
      attempts: 1,
      needs_human: false,
      result: null,
      error: null,
      created_at: new Date(this.now()).toISOString(),
      updated_at: new Date(this.now()).toISOString(),
    });
    try {
      const result = await this.session.call(MessageName.TASK_SUBMIT, request, Limits.TASK_SUBMIT_TIMEOUT_S);
      await this.store.putTask({
        ...(await this.store.getTask(taskId)),
        // §9.3: `pending_approval` is an answer, not an acceptance — recording it
        // as `accepted` would present a task the peer has not released as one
        // that is already running.
        status: result.status === 'pending_approval' ? TaskStatus.PENDING_APPROVAL : TaskStatus.ACCEPTED,
        session_id: result.session_id ?? request.session_id,
        updated_at: new Date(this.now()).toISOString(),
      });
      return {
        task_id: taskId,
        status: result.status ?? 'accepted',
        root_task_id: rootTaskId,
        dedup: result.dedup === true,
      };
    } catch (error) {
      // The submit outcome is unknown: do not resend, park it for a human.
      const failure = error instanceof BridgeError ? error : new BridgeError('timeout');
      await this.store.transition(taskId, TaskStatus.NEEDS_HUMAN, {
        needs_human: true,
        error: failure.toWire(),
      });
      throw failure;
    }
  }

  /**
   * Hold an agent-initiated outbound submission behind this side's human gate (§12.5).
   *
   * The production path that makes a legal `approval_ref` reachable for the B→A
   * direction: the question is sent as `approval.request` to the peer's human,
   * and nothing is submitted until that human answers. The pending submission is
   * durable and visible through `task.status`.
   * @param {object} params - submission inputs (`text`, `purpose`, `sessionId`, ...).
   * @returns {Promise<{task_id: string, root_task_id: string, status: string, approval_id: string, dedup: boolean}>} handle.
   */
  async _prepareOutboundApproval(params) {
    const taskId = randomUUID();
    const rootTaskId = params.rootTaskId ?? taskId;
    const request = {
      task_id: taskId,
      root_task_id: rootTaskId,
      kind: 'astr_agent_run',
      origin: params.origin ?? 'llm',
      input_parts: [{ type: 'text', text: String(params.text ?? '') }],
      attachments: [],
      tool_hints: (params.toolHints ?? []).map((tool) => ({ tool, args_hint: {} })),
      session_id: params.sessionId ?? null,
      purpose: params.purpose ?? null,
      timeout_s: params.timeoutS ?? 1800,
      meta: {},
      approval_ref: null,
    };
    const task = {
      task_id: taskId,
      root_task_id: rootTaskId,
      kind: request.kind,
      origin: request.origin,
      direction: 'outbound',
      status: TaskStatus.PENDING_APPROVAL,
      session_id: request.session_id,
      purpose: request.purpose,
      timeout_s: request.timeout_s,
      input_parts: request.input_parts,
      attachments: [],
      tool_hints: request.tool_hints,
      meta: {},
      approval_ref: null,
      eseq: 0,
      attempts: 0,
      needs_human: false,
      result: null,
      error: null,
      created_at: new Date(this.now()).toISOString(),
      updated_at: new Date(this.now()).toISOString(),
    };
    await this.store.putTask(task);
    const approval = await this.approvals.requestOutboundApproval({
      task,
      tool: request.kind,
      reason: 'cross-end task submission',
      displayReason: { en: 'Submit a cross-end task', zh: '提交跨端任务' },
      submitDigest: await this.submitDigestOf(request),
      onDecided: (record, allowed) => this._settleOutboundApproval(record, allowed),
    });
    this.logger.info('outbound_submit_held_for_approval', {
      task: taskId,
      approval: approval.approval_id,
    });
    return {
      task_id: taskId,
      root_task_id: rootTaskId,
      status: TaskStatus.PENDING_APPROVAL,
      approval_id: approval.approval_id,
      dedup: false,
    };
  }

  /**
   * Send a held outbound submission after its gate was released (§12.5).
   *
   * The release is durable before the frame leaves. A failed send parks the task
   * `needs_human` and is never retried (§16.2). The peer may answer
   * `pending_approval` while it verifies the reference; its later event drives
   * this outbound mirror.
   * @param {object} record - decided local gate.
   * @param {boolean} allowed - whether a human allowed it once.
   * @returns {Promise<void>} resolution after the task moved on.
   */
  async _settleOutboundApproval(record, allowed) {
    const taskId = String(record?.task_id ?? '');
    if (taskId.length === 0) return;
    const task = await this.store.getTask(taskId);
    if (task === null || task.status !== TaskStatus.PENDING_APPROVAL || task.direction !== 'outbound') return;
    if (allowed !== true) {
      await this.store.transition(taskId, TaskStatus.REJECTED, {
        error: { code: 'rejected', message: 'rejected by a human before submission', details: null },
      });
      this.logger.info('outbound_submit_rejected', { task: taskId, approval: record?.approval_id });
      return;
    }
    const fresh = await this.store.getApproval(String(record.approval_id));
    if (fresh === null) return;
    const request = {
      task_id: taskId,
      root_task_id: task.root_task_id,
      kind: task.kind,
      origin: task.origin,
      input_parts: task.input_parts ?? [],
      attachments: task.attachments ?? [],
      tool_hints: task.tool_hints ?? [],
      session_id: task.session_id ?? null,
      purpose: task.purpose ?? null,
      timeout_s: task.timeout_s,
      meta: task.meta ?? {},
      approval_ref: null,
    };
    try {
      const released = await this.approvals.releaseOutboundGate(fresh, request);
      if (!released) return;
    } catch (error) {
      this.logger.failure('outbound_gate_release_failed', error, { task: taskId, approval: record?.approval_id });
      return;
    }
    const wire = {
      ...request,
      approval_ref: this.approvals.buildSubmitRef(fresh),
    };
    try {
      const result = await this.session.call(MessageName.TASK_SUBMIT, wire, Limits.TASK_SUBMIT_TIMEOUT_S);
      await this.store.putTask({
        ...(await this.store.getTask(taskId)),
        status: result.status === 'pending_approval' ? TaskStatus.PENDING_APPROVAL : TaskStatus.ACCEPTED,
        session_id: result.session_id ?? task.session_id,
        updated_at: new Date(this.now()).toISOString(),
      });
      this.logger.info('outbound_submit_released', {
        task: taskId,
        approval: record?.approval_id,
        status: result.status ?? 'accepted',
      });
    } catch (error) {
      const failure = error instanceof BridgeError ? error : new BridgeError('timeout');
      await this.store.transition(taskId, TaskStatus.NEEDS_HUMAN, {
        needs_human: true,
        error: failure.toWire(),
      });
      this.logger.failure('outbound_submit_send_failed', failure, { task: taskId });
    }
  }

  /**
   * Report one task's state (§9.4).
   * @param {object} params - `{task_id}`.
   * @returns {Promise<object>} status result.
   * @throws {BridgeError} `task_not_found`.
   */
  async status(params) {
    const task = await this.store.getTask(String(params?.task_id ?? ''));
    if (task === null) throw new BridgeError('task_not_found');
    return {
      task_id: task.task_id,
      root_task_id: task.root_task_id,
      status: task.status,
      direction: task.direction,
      kind: task.kind,
      created_at: task.created_at,
      updated_at: task.updated_at,
      attempts: task.attempts ?? 0,
      session_id: task.session_id ?? null,
      result: task.result ?? null,
      error: task.error ?? null,
      eseq: task.eseq ?? 0,
      needs_human: task.needs_human === true,
    };
  }

  /**
   * List unfinished tasks (§9.5).
   * @param {object} params - `{limit, cursor}`.
   * @returns {Promise<{tasks: object[], next_cursor: string|null}>} page.
   */
  async listOpen(params) {
    const limit = Math.min(200, Math.max(1, Number(params?.limit ?? 50)));
    return this.store.listOpenTasks(limit, params?.cursor ?? null);
  }

  /**
   * Request cancellation of one task (§9.6).
   * @param {object} params - `{task_id, reason}`.
   * @returns {Promise<{task_id: string, status: string}>} result.
   * @throws {BridgeError} `task_not_found`.
   */
  async cancel(params) {
    const task = await this.store.getTask(String(params?.task_id ?? ''));
    if (task === null) throw new BridgeError('task_not_found');
    if (TERMINAL_STATUSES.includes(task.status)) return { task_id: task.task_id, status: task.status };
    if (task.direction === 'inbound') {
      const cancelled = this.host.cancel(task.session_id);
      if (!cancelled) return { task_id: task.task_id, status: 'cancel_unsupported' };
    }
    await this.store.transition(task.task_id, TaskStatus.CANCELED, {});
    await this._emit(task.task_id, TaskEvent.CANCELED, TaskStatus.CANCELED);
    return { task_id: task.task_id, status: TaskStatus.CANCELED };
  }

  /**
   * Handle one inbound `task.event` (§11.2).
   *
   * Three properties are structural:
   *
   *   1. **The receipt is durable before anything is acknowledged.** A
   *      notification is identified by the producer's `notify_id`, so the
   *      receipt — not an in-memory flag — is what makes a redelivery
   *      idempotent across a restart (§10.1, §10.3).
   *   2. **The ack goes back over the wire.** `event.ack` is a request from the
   *      receiving side to the *producer*; only the producer may retire its own
   *      outbox row (§11.1). A local `markDelivered` on a peer-generated
   *      `notify_id` addresses a row that does not exist here, which is why the
   *      previous implementation acknowledged nothing at all.
   *   3. **A failed ack is never a task failure and never a re-run.** The event
   *      has already been applied durably; the producer's resend is the retry,
   *      and this side answers it as a duplicate without waking anyone again.
   * @param {object} params - event parameters.
   * @returns {Promise<void>} resolution after processing and acknowledging.
   * @throws {BridgeError} `bad_params` for a malformed event; `task_not_found`
   *   when the event names a task this side does not know; `not_ready` /
   *   `timeout` (retryable) when the acknowledgement could not be sent.
   */
  async onEvent(params) {
    const notifyId = String(params?.notify_id ?? '');
    const taskId = String(params?.task_id ?? '');
    if (notifyId.length === 0 || taskId.length === 0) throw new BridgeError('bad_params', { details: { field: 'notify_id' } });

    // A redelivery can land while the first copy is still being applied (the
    // producer resends every second). Both must resolve to one application and
    // one wake, so the second waits for the first and then acknowledges as a
    // duplicate.
    const running = this._intake.get(notifyId);
    if (running !== undefined) {
      await running.catch(() => {});
      await this._ack(params, taskId, 'duplicate');
      return;
    }
    const work = this._applyEvent(params, notifyId, taskId);
    this._intake.set(notifyId, work);
    try {
      await work;
    } finally {
      this._intake.delete(notifyId);
    }
  }

  /**
   * Apply one event whose redelivery is not currently in flight.
   * @param {object} params - event parameters.
   * @param {string} notifyId - producer notification identity.
   * @param {string} taskId - owning task.
   * @returns {Promise<void>} resolution after the event was applied and acked.
   */
  async _applyEvent(params, notifyId, taskId) {
    const rootTaskId = String(params.root_task_id ?? '');
    const task = await this.store.getTask(taskId);
    if (task === null) {
      // Nothing to apply, but the producer must still learn the outcome or it
      // will redeliver until its own attempt budget is exhausted.
      await this._ack(params, taskId, 'rejected');
      throw new BridgeError('task_not_found');
    }

    const seen = await this.notify.claimInbound(notifyId, params);
    if (!seen) {
      // Already processed once: acknowledge again (the producer retries until
      // it sees an ack) but never repeat the side effects, and never re-wake.
      await this._ack(params, taskId, 'duplicate');
      return;
    }

    const eseq = Number(params.eseq ?? 0);
    if (eseq <= (task.eseq ?? 0)) {
      // Out-of-order or replayed event: drop the state change, acknowledge.
      await this._ack(params, taskId, 'duplicate');
      return;
    }
    if (eseq > (task.eseq ?? 0) + 1) {
      this.logger.warn('event_gap', { task: taskId, expected: (task.eseq ?? 0) + 1, got: eseq });
      try {
        // Ask for the authoritative state instead of inferring the gap.
        await this.session.call(MessageName.TASK_STATUS, { task_id: taskId }, 15);
      } catch {
        // A failed refresh leaves the gap recorded; the event still applies.
      }
    }

    const nextStatus = mapEventToStatus(params.event, params.status);
    if (nextStatus !== null) {
      await this.store.putTask({
        ...task,
        status: nextStatus,
        eseq,
        result: params.result ?? task.result ?? null,
        error: params.error ?? task.error ?? null,
        updated_at: new Date(this.now()).toISOString(),
      });
    } else {
      await this.store.putTask({ ...task, eseq, updated_at: new Date(this.now()).toISOString() });
    }

    if (WAKE_EVENTS.includes(params.event)) await this._wake(taskId, params);
    await this._ack(params, taskId, 'processed');
  }

  /**
   * Send `event.ack` for one received notification (§11.1).
   *
   * The parameters are exactly the §11.1 shape — `notify_id`, `task_id`,
   * `root_task_id`, `outcome` — and the ack is a request, because the producer
   * answers it and retires its outbox row from that answer.
   * @param {object} params - the received `task.event` parameters.
   * @param {string} taskId - owning task.
   * @param {'processed'|'duplicate'|'rejected'} outcome - what happened locally.
   * @returns {Promise<void>} resolution after the producer answered.
   */
  async _ack(params, taskId, outcome) {
    const rootTaskId = String(params?.root_task_id ?? '') || String(params?.task_id ?? taskId);
    await this.notify.acknowledge({
      notify_id: String(params?.notify_id ?? ''),
      task_id: taskId,
      root_task_id: rootTaskId,
      outcome,
    });
  }

  /**
   * Wake the session that initiated a task (§16.6).
   *
   * An archived session is checked *before* the wake budget is charged. Two
   * reasons: a wake that will be suppressed anyway must not consume a chain or
   * rate slot, and a suppressed wake must not be the reason a task that already
   * reached a terminal state gets rewritten to `needs_human`. `NotifyService`
   * re-checks at the actual `host.deliver` boundary, which covers a session
   * archived while the wake retries; this check exists to avoid the side
   * effects of asking for a wake that cannot happen.
   * @param {string} taskId - task identity.
   * @param {object} params - event parameters.
   * @returns {Promise<void>} resolution after the wake attempt.
   */
  async _wake(taskId, params) {
    const task = await this.store.getTask(taskId);
    if (task === null) return;
    const sessionId = task.session_id ?? null;
    // Wake targets are not re-authorized here (an outbound task wakes the
    // session that initiated it, which the peer's grant table does not
    // describe), so only the archive disposition is consulted — the same
    // question archive answers: "may this session still be woken?".
    const blocked = await this._archiveBlock(sessionId);
    if (blocked !== null) {
      // The wake would be refused at delivery; report it and leave the task's
      // status alone — a wake is a side effect, not the task's outcome.
      this.logger.warn('wake_suppressed', { task: taskId, code: blocked });
      return;
    }
    const rootTaskId = task.root_task_id ?? task.task_id;
    const decision = await this.notify.authoriseWake(rootTaskId, taskId);
    if (!decision.allowed) {
      await this.store.putTask({
        ...task,
        needs_human: true,
        error: { code: decision.code, message: 'wake suppressed', details: null },
        updated_at: new Date(this.now()).toISOString(),
      });
      return;
    }
    await this.notify.wake({
      task,
      event: params.event,
      text: describeEvent(params),
      rootTaskId,
    });
  }

  /**
   * Report one state transition to the peer, persisted first (§10.2).
   * @param {string} taskId - task identity.
   * @param {string} event - event name.
   * @param {string} status - target status.
   * @param {object} [extra] - `result`/`error`/`decision`/`approval`.
   * @returns {Promise<string>} the notification identity.
   */
  async _emit(taskId, event, status, extra = {}) {
    return this.notify.emit({ task_id: taskId, event, status, ...extra });
  }
}

/**
 * Map a `task.event` name onto the status it asserts (§11.2).
 * @param {string} event - event name.
 * @param {string} [claimedStatus] - status claimed by the peer.
 * @returns {string|null} status to persist, or null for a non-status event.
 */
export function mapEventToStatus(event, claimedStatus) {
  switch (event) {
    case TaskEvent.ACCEPTED:
      return TaskStatus.ACCEPTED;
    case TaskEvent.QUEUED:
      return TaskStatus.QUEUED;
    case TaskEvent.RUNNING:
      return TaskStatus.RUNNING;
    case TaskEvent.COMPLETED:
      return TaskStatus.SUCCEEDED;
    case TaskEvent.FAILED:
      // A refused submission is reported as `event: "failed"` with the terminal
      // status `rejected` (this endpoint emits exactly that for an unproven
      // `approval_ref`). Only that terminal pair is honoured; any other claimed
      // value is ignored so the peer cannot invent an arbitrary state.
      return claimedStatus === TaskStatus.REJECTED ? TaskStatus.REJECTED : TaskStatus.FAILED;
    case TaskEvent.CANCELED:
      return TaskStatus.CANCELED;
    case TaskEvent.NEEDS_DECISION:
      return TaskStatus.NEEDS_DECISION;
    case TaskEvent.NEEDS_APPROVAL:
      return TaskStatus.NEEDS_APPROVAL;
    case TaskEvent.NEEDS_HUMAN:
      return TaskStatus.NEEDS_HUMAN;
    case TaskEvent.PROGRESS:
      // Progress carries no state change; the claimed status is advisory only,
      // so it is never persisted (§11.2).
      return null;
    default:
      return null;
  }
}

/**
 * Build the model-facing text for one wake-up.
 *
 * Only the whitelisted fields of §11.4 are used: a summary and a short text,
 * never a prompt, a path or a stack.
 * @param {object} params - event parameters.
 * @returns {string} wake-up text.
 */
export function describeEvent(params) {
  const head = `Bridge task ${params.task_id} reported ${params.event}.`;
  if (params.event === TaskEvent.COMPLETED) {
    const summary = String(params.result?.summary ?? '').slice(0, Limits.RESULT_SUMMARY_CHARS);
    const text = String(params.result?.text ?? '').slice(0, Limits.RESULT_TEXT_CHARS);
    return `${head}\nsummary: ${summary}\ntext: ${text}`;
  }
  if (params.event === TaskEvent.FAILED) {
    return `${head}\nerror: ${String(params.error?.code ?? 'unknown')}`;
  }
  if (params.event === TaskEvent.NEEDS_DECISION) {
    return `${head}\nquestion: ${String(params.decision?.question ?? '').slice(0, Limits.RESULT_TEXT_CHARS)}`;
  }
  if (params.event === TaskEvent.NEEDS_APPROVAL) {
    return `${head}\ntool: ${String(params.approval?.tool ?? '')}`;
  }
  return head;
}

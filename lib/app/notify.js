/**
 * Notification outbox, acknowledgements and wake accounting
 * (protocol §10.3, §11, §16.6).
 *
 * Delivery is "at least once" and every notification carries a stable
 * `notify_id`, so the peer can deduplicate. A wake-up is a *side effect of a
 * notification*, and that side effect is guarded twice: by `(task_id,
 * event_type)` deduplication and by the persisted chain/rate budget, so a
 * replayed event can never wake the same session twice or storm it.
 * @module dsh-plugin-astrbot-bridge/app/notify
 */

import { randomUUID } from 'node:crypto';

import { asBridgeError, BridgeError } from '../errors.js';
import { Limits, MessageName, TaskEvent } from '../constants.js';

/**
 * How long an `event.ack` request may wait for its reply.
 *
 * An ack is a bookkeeping round-trip, not business work: waiting the full
 * `REQ_TIMEOUT_S` would hold the event handler (and everything queued behind it)
 * for a minute when the producer is slow. A timed-out ack is safe — the producer
 * has not retired the row and will resend (§11.3), and this side answers the
 * redelivery as a duplicate.
 */
const ACK_TIMEOUT_S = 15;

/**
 * Key namespace of the receipts for notifications *received* from the peer.
 *
 * Receipts and outbox rows share the `notifies` table (the store owns one table
 * per domain), so the prefix is what keeps the two apart: `onAck` looks up a
 * bare `notify_id`, which can therefore only ever match one of *our* outbox
 * entries, and a peer acknowledging its own notification id can never retire a
 * receipt.
 */
const INBOUND_PREFIX = 'inbound:';

/** Notification service. */
export class NotifyService {
  /**
   * @param {object} options - service dependencies.
   * @param {object} options.store - bridge store.
   * @param {object} options.session - session bound to the peer.
   * @param {object} options.host - agent host adapter.
   * @param {object} options.config - bridge configuration.
   * @param {object} [options.sessions] - session service; only its
   *   `isDeliverable(sessionId) => Promise<boolean>` method is used, to refuse
   *   to wake an archived session (§9.7, §15.3 `session_archived`).
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
    this.config = options.config;
    this.sessions = options.sessions ?? null;
    this.logger = options.logger ?? { info() {}, warn() {}, failure() {}, debug() {}, error() {} };
    this.now = options.now ?? (() => Date.now());
    this._resendTimer = null;
    this._stopped = true;
    /** Whether the missing-`sessions` warning has already been emitted. */
    this._archiveGateWarned = false;
  }

  /**
   * Whether one session may still be woken.
   *
   * Only the archive disposition is consulted, not authorization: a wake goes
   * back to the session that initiated a task, and `sessions.isDeliverable`
   * answers `authorized && !archived`. Using that here would turn an archive
   * check into a stricter authorization check on a path that never required
   * one, quietly suppressing wakes that used to work.
   *
   * Fail-closed: only a literal `true` opens the gate, so a probe that throws
   * or answers a non-boolean counts as archived. A *missing* `sessions`
   * dependency is a composition gap rather than a denial — the §16.6 wake
   * accounting still applies — so it is logged once (`archive_gate_unwired`)
   * instead of looking like enforcement. Wiring it is a `lib/index.js` change.
   * @param {string} sessionId - session identity.
   * @returns {Promise<string|null>} `session_archived` when archived, else null.
   */
  async _wakeBlock(sessionId) {
    if (this.sessions === null || typeof this.sessions.isDeliverable !== 'function') {
      if (this._archiveGateWarned === false) {
        this._archiveGateWarned = true;
        this.logger.warn('archive_gate_unwired', { service: 'notify' });
      }
      return null;
    }
    try {
      return (await this.sessions.isDeliverable(sessionId)) === true ? null : 'session_archived';
    } catch (error) {
      // Unknown archive state: refuse the wake instead of waking a session that
      // may have been archived precisely to stop automatic traffic.
      this.logger.failure('archive_gate_failed', error, { session: String(sessionId) });
      return 'session_archived';
    }
  }

  /**
   * Persist an event and send it as `task.event` (§11.2).
   *
   * Persistence comes first: if the process dies after writing but before
   * sending, the resend loop finds the record and delivers it later.
   * @param {object} input - event input.
   * @param {string} input.task_id - task identity.
   * @param {string} input.event - event name.
   * @param {string} input.status - asserted status.
   * @param {object} [input.result] - success payload.
   * @param {object} [input.error] - failure payload.
   * @param {object} [input.decision] - business decision payload.
   * @param {object} [input.approval] - approval payload.
   * @returns {Promise<string>} the notification identity.
   */
  async emit(input) {
    const task = await this.store.getTask(input.task_id);
    if (task === null) throw new BridgeError('task_not_found');
    const notifyId = randomUUID();
    const eseq = (task.eseq ?? 0) + 1;
    const params = {
      task_id: input.task_id,
      root_task_id: task.root_task_id,
      eseq,
      event: input.event,
      status: input.status,
      notify_id: notifyId,
      result: input.event === TaskEvent.COMPLETED ? trimResult(input.result) : null,
      error: input.event === TaskEvent.FAILED ? input.error ?? null : null,
      decision: input.event === TaskEvent.NEEDS_DECISION ? input.decision ?? null : null,
      approval: input.event === TaskEvent.NEEDS_APPROVAL ? input.approval ?? null : null,
    };
    await this.store.enqueueNotify(notifyId, params);
    await this.store.putTask({
      ...task,
      eseq,
      updated_at: new Date(this.now()).toISOString(),
    });
    try {
      await this.session.emit(MessageName.TASK_EVENT, params);
    } catch (error) {
      // Undelivered for now: the record stays pending and the loop retries with
      // a *fresh* seal and the same `notify_id` (§11.3).
      this.logger.failure('notify_send_failed', error, { task: input.task_id, notify: notifyId });
    }
    return notifyId;
  }

  /**
   * Confirm one received notification to its producer (§11.1).
   *
   * `event.ack` is a **request** (peer-symmetric: the receiver of a
   * notification acknowledges it back to the producer), so this is the only
   * place where "the peer's notification was handled" leaves this side. The
   * producer retires its own outbox row when the ack arrives; nothing here
   * touches a local outbox row, because a peer-generated `notify_id` is not one
   * of ours.
   *
   * Failure classes are deliberately split:
   *
   *   - `event_not_found`: the producer no longer knows the id (it pruned the
   *     row). §11.1 says the sender ignores that answer, and there is nothing to
   *     retry, so it is logged and treated as "nothing owed".
   *   - `not_ready`/`draining`: the ack could not be put on the wire. It is
   *     re-thrown as **retryable** so the caller never records the notification
   *     as acknowledged; the producer's own resend then delivers the same
   *     `notify_id` again and this side answers it a second time.
   * @param {object} params - ack parameters.
   * @param {string} params.notify_id - acknowledged notification.
   * @param {string} params.task_id - owning task.
   * @param {string} params.root_task_id - root task.
   * @param {string} params.outcome - `processed`, `duplicate` or `rejected`.
   * @returns {Promise<object>} the producer's reply result.
   * @throws {BridgeError} `not_ready`/`draining` (retryable) when the ack could
   *   not be sent, or the producer's own failure for any other code.
   */
  async acknowledge(params) {
    const notifyId = String(params?.notify_id ?? '');
    if (notifyId.length === 0) throw new BridgeError('bad_params', { details: { field: 'notify_id' } });
    const outcome = ['processed', 'duplicate', 'rejected'].includes(String(params?.outcome))
      ? String(params?.outcome)
      : 'processed';
    const wire = {
      notify_id: notifyId,
      task_id: String(params?.task_id ?? ''),
      root_task_id: String(params?.root_task_id ?? ''),
      outcome,
    };
    try {
      return await this.session.call(MessageName.EVENT_ACK, wire, ACK_TIMEOUT_S);
    } catch (error) {
      const failure = asBridgeError(error);
      if (failure.code === 'event_not_found') {
        // The producer retired the row already: the ack is moot, not a failure.
        this.logger.info('event_ack_unknown', { notify: notifyId, outcome });
        return { notify_id: notifyId, delivered: false };
      }
      if (failure.code === 'not_ready' || failure.code === 'draining') {
        // The notification keeps its "not acknowledged" status; the producer's
        // resend is what retries it, so the failure must be marked retryable.
        this.logger.warn('event_ack_unsent', { notify: notifyId, code: failure.code });
        throw new BridgeError(failure.code, { retryable: true, details: { field: 'event.ack' } });
      }
      throw failure;
    }
  }

  /**
   * Durable receipt of one notification received from the peer (§10.1, §10.3).
   *
   * The idempotency key is `(conn, notify_id)` and it must survive a restart.
   * The receipt lives in the `notifies` table — the same per-notification table
   * the outbox uses — under a namespaced key, so it can never be mistaken for
   * an outbox row: it is written as `delivered: true` (nothing is owed *to* the
   * peer for a received notification), and `resendOnce()` therefore never
   * re-emits it. It is retained for the normal notification retention window.
   * @param {string} notifyId - the peer's notification identity.
   * @param {object} params - the received `task.event` parameters.
   * @returns {Promise<boolean>} whether this call recorded a new receipt.
   */
  async claimInbound(notifyId, params) {
    const key = `${INBOUND_PREFIX}${notifyId}`;
    const existing = await this.store.get('notifies', key);
    if (existing !== null) return false;
    const at = this.now();
    await this.store.put('notifies', key, {
      notify_id: notifyId,
      inbound: true,
      // A received notification is not an outbox obligation: marking it
      // "delivered" is what keeps the resend loop from echoing it back.
      delivered: true,
      attempts: 0,
      next_at: at,
      created_at: new Date(at).toISOString(),
      payload: {
        task_id: String(params?.task_id ?? ''),
        root_task_id: String(params?.root_task_id ?? ''),
        event: String(params?.event ?? ''),
        eseq: Number(params?.eseq ?? 0),
      },
    });
    return true;
  }

  /**
   * Handle one `event.ack` for one of *this* side's own notifications (§11.1).
   * @param {object} params - ack parameters.
   * @param {string} params.notify_id - acknowledged notification.
   * @param {string} [params.task_id] - task identity.
   * @param {string} [params.outcome] - `processed`, `duplicate` or `rejected`.
   * @returns {Promise<{notify_id: string, delivered: boolean}>} ack result.
   */
  async onAck(params) {
    const notifyId = String(params?.notify_id ?? '');
    const record = await this.store.get('notifies', notifyId);
    if (record === null) {
      // Unknown notification: the peer may acknowledge something we pruned.
      throw new BridgeError('event_not_found');
    }
    await this.store.markDelivered(notifyId);
    return { notify_id: notifyId, delivered: true };
  }

  /**
   * Authorize one automatic wake against the persisted budget (§16.6).
   * @param {string} rootTaskId - root task identity.
   * @param {string} sessionKey - target session key.
   * @returns {Promise<{allowed: boolean, code: string|null}>} decision.
   */
  async authoriseWake(rootTaskId, sessionKey) {
    const decision = await this.store.bumpWake(rootTaskId, String(sessionKey), {
      maxChain: this.config.wakeMaxChain,
      ratePerMinute: this.config.wakeRatePerMinute,
    });
    return decision;
  }

  /**
   * Deliver one wake-up to the session that initiated the task (§16.6).
   *
   * The wake text is derived from the whitelisted event fields only; a failure
   * is retried at most three times and then parked for a human, never retried
   * forever.
   * @param {object} input - wake input.
   * @param {object} input.task - task record.
   * @param {string} input.event - event name.
   * @param {string} input.text - wake text.
   * @param {string} input.rootTaskId - root task identity.
   * @returns {Promise<void>} resolution after the attempt.
   */
  async wake(input) {
    const sessionId = input.task.session_id;
    if (sessionId === null || sessionId === undefined) {
      this.logger.warn('wake_without_session', { task: input.task.task_id });
      return;
    }
    // The wake is the side effect that archive exists to stop, so the gate sits
    // here, at the point of delivery, rather than only where a wake is queued:
    // a session can be archived between the event and the attempt. Refusing
    // here is not a failure to retry — the wake is suppressed on purpose, so no
    // backoff is consumed and no human is paged for it.
    const blocked = await this._wakeBlock(String(sessionId));
    if (blocked !== null) {
      this.logger.warn('wake_suppressed', {
        task: input.task.task_id,
        code: blocked,
        session: String(sessionId),
      });
      return;
    }
    // §16.6: three attempts with 1 s / 5 s / 30 s backoff, then a human.
    const backoff = [1000, 5000, 30_000];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.host.deliver({ sessionId: String(sessionId), text: input.text, wake: true });
        return;
      } catch (error) {
        this.logger.failure('wake_delivery_failed', error, {
          task: input.task.task_id,
          attempt: attempt + 1,
        });
        if (attempt === 2) {
          await this.store.putTask({
            ...input.task,
            needs_human: true,
            updated_at: new Date(this.now()).toISOString(),
          });
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, backoff[attempt]));
      }
    }
  }

  /**
   * Start the resend loop (§10.3).
   * @param {number} [intervalMs] - tick period.
   * @returns {void}
   */
  startResendLoop(intervalMs = 1000) {
    if (!this._stopped) return;
    this._stopped = false;
    this._resendTimer = setInterval(() => {
      void this.resendOnce();
    }, intervalMs);
    if (typeof this._resendTimer.unref === 'function') this._resendTimer.unref();
  }

  /**
   * Deliver every due, unacknowledged notification.
   *
   * A redelivery reseals the same business message, so the peer sees the same
   * `notify_id` under a new `seq` (§11.3) rather than a replayed ciphertext,
   * which its replay window would reject.
   * @returns {Promise<number>} number of notifications attempted.
   */
  async resendOnce() {
    if (this._stopped) return 0;
    const pending = await this.store.pendingNotifies(32);
    let attempted = 0;
    for (const record of pending) {
      try {
        await this.session.emit(MessageName.TASK_EVENT, record.payload);
        await this.store.markAttempt(record.notify_id);
        attempted += 1;
      } catch (error) {
        const updated = await this.store.markAttempt(record.notify_id);
        if (updated?.undelivered === true) {
          // The peer never accepted it: stop retrying and let a human decide.
          await this.store.putTask({
            ...(await this.store.getTask(record.payload?.task_id)),
            needs_human: true,
            updated_at: new Date(this.now()).toISOString(),
          });
        }
        this.logger.failure('notify_resend_failed', error, { notify: record.notify_id });
      }
    }
    return attempted;
  }

  /**
   * Stop the resend loop.
   * @returns {void}
   */
  stop() {
    this._stopped = true;
    if (this._resendTimer !== null) {
      clearInterval(this._resendTimer);
      this._resendTimer = null;
    }
  }
}

/**
 * Trim a `result` to the whitelist and length limits of §11.4.
 * @param {object|undefined} result - candidate result.
 * @returns {object} trimmed result.
 */
export function trimResult(result) {
  const summary = String(result?.summary ?? '').slice(0, Limits.RESULT_SUMMARY_CHARS);
  const text = String(result?.text ?? '').slice(0, Limits.RESULT_TEXT_CHARS);
  const attachments = Array.isArray(result?.attachments)
    ? result.attachments.slice(0, 16).map((attachment) => ({
        kind: 'blob',
        blob_id: String(attachment.blob_id ?? ''),
        media_type: String(attachment.media_type ?? ''),
        bytes: Number(attachment.bytes ?? 0),
        sha256: String(attachment.sha256 ?? ''),
        width: Number(attachment.width ?? 0),
        height: Number(attachment.height ?? 0),
      }))
    : [];
  const toolAudit = Array.isArray(result?.tool_audit)
    ? result.tool_audit.slice(0, 32).map((entry) => ({
        tool: String(entry.tool ?? '').slice(0, 64),
        outcome: entry.outcome === 'error' ? 'error' : 'ok',
        code: String(entry.code ?? '').slice(0, 64),
      }))
    : [];
  const degraded = Array.isArray(result?.degraded) ? result.degraded.map(String) : [];
  return { summary, text, attachments, tool_audit: toolAudit, degraded };
}

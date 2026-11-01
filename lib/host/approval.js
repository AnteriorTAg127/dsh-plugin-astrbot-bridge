/**
 * Host approval bridge (protocol §12, plus the native-approval settlement rules
 * recorded in `开发/v0.1/native-approval-id-decision.md` §3.0).
 *
 * The harness dispatches `approval/request` as a **sequential waterfall**
 * (`@deepseek-ai/cordis` `lib/index.js:317-325`), not a parallel race: a
 * listener either calls `next()` — handing the remaining answer authority to the
 * listeners behind it — or returns its own outcome, which claims the request and
 * short-circuits the chain. `@deepseek-ai/dsh-user-approval`
 * (`lib/index.js:176-188`) only ever sees that one returned value and normalises
 * it into `approval/decided`. Both consequences are structural here, not
 * configurable:
 *
 *   1. **Claim or delegate — never both.** The decision is made synchronously,
 *      before any `await`, so a request is never forwarded and then abandoned.
 *      Claiming returns a promise that only a human answer or a fail-closed
 *      terminal event can settle, and never calls `next()`. Delegating calls
 *      `next()` and creates no pending entry, so a later remote answer has no
 *      host-side effect whatsoever.
 *   2. **No fallback after claiming.** Once this listener claims a request the
 *      chain behind it is gone: a second `next()` would consume the *next*
 *      listener (or run the built-in answerer twice) rather than re-asking the
 *      UI. So a claim whose channel turns out to be unusable settles
 *      `unavailable` immediately — fail closed, never a fallback and never a
 *      grant.
 *   3. **No outcome is ever invented.** The settlements are: a human answer
 *      arrived, the deadline expired → `rejected`, the request was withdrawn →
 *      `cancelled`, or the channel became unusable → `unavailable`. Every
 *      terminal value except `allowed-once` denies.
 *
 * The `approval_id` is a bridge-local UUID minted only when a real request is
 * claimed. It is **not** the harness `ApprovalRequestId` (never exposed to a
 * waterfall listener), it is never derived from request content, and it is never
 * recovered by scanning `approval/asked` / `approval/decided` audit events.
 * @module dsh-plugin-astrbot-bridge/host/approval
 */

import { randomUUID } from 'node:crypto';

import { ApprovalOutcome } from '../constants.js';
import { BridgeError } from '../errors.js';

/** How many already-settled ids stay available for late-answer auditing. */
const SETTLED_AUDIT_LIMIT = 512;

/**
 * One claimed harness request held by the bridge.
 *
 * The mutable lifecycle fields start `null` and are narrowed by their guards:
 * `resolve`/`onAbort` are filled while the listener is still synchronous, and
 * `timer` is only read through {@link clearTimer}.
 * @typedef {object} PendingApproval
 * @property {string} approval_id - bridge-local UUID.
 * @property {string|null} session_id - harness session, when known.
 * @property {string|null} call_id - harness tool-call id, when known.
 * @property {string} tool - tool name (`unknown` when the host omitted it).
 * @property {string|null} reason - truncated asker reason.
 * @property {string|null} display_reason - short human-facing label.
 * @property {string|null} expires_at - ISO 8601 deadline once armed.
 * @property {boolean} settled - whether settlement already happened.
 * @property {string|null} outcome - settled protocol outcome.
 * @property {string|null} settled_at - ISO 8601 settlement time.
 * @property {string|null} settled_source - `remote`/`timeout`/`cancelled`/`channel`/`session`/`shutdown`.
 * @property {{aborted?: boolean, addEventListener?: Function, removeEventListener?: Function}|undefined} signal - host abort signal.
 * @property {ReturnType<typeof setTimeout>|null} timer - local deadline timer.
 * @property {((outcome: string) => void)|null} resolve - settles the harness answer.
 * @property {(() => void)|null} onAbort - host abort listener, once armed.
 */

/**
 * Build the `approval/request` listener and its pending table.
 * @param {object} options - bridge behaviour.
 * @param {(request: object) => boolean} options.canClaim - synchronous predicate
 *   answering "does this request belong to a bound, online,
 *   remote-approval-enabled session?". It must not await and must not send
 *   anything: the claim decision has to be final before the first `await`.
 * @param {(record: object) => Promise<void>} options.forward - publish one
 *   `approval.request` to the peer. Rejecting means the answer channel is
 *   unusable, which settles the claimed request `unavailable`.
 * @param {(record: object) => Promise<boolean>} options.confirmClaim - final
 *   confirmation that the peer queued the request. Resolving false means the
 *   peer will never answer, which also settles `unavailable`: the claim is not
 *   reversible once the request has been forwarded.
 * @param {(record: object, settled: object) => void} [options.onSettled] -
 *   audit hook invoked exactly once per settlement.
 * @param {import('../log.js').LoggerLike} logger - structured logger.
 * @param {Function} [now] - injectable clock.
 * @returns {{listener: Function, pending: Map<string, object>,
 *   settleExternal: (id: string, outcome: string) => boolean,
 *   failAll: (source?: string) => number, armDeadline: (id: string, at: string) => boolean,
 *   dispose: () => void}} bridge surface.
 */
export function createApprovalBridge(options, logger, now = () => Date.now()) {
  /** @type {Map<string, object>} claimed requests, keyed by bridge approval id. */
  const pending = new Map();
  /** Bounded ring of settled ids, so a late answer is audited, not silent. */
  const settledIds = new Set();

  /**
   * Settle one pending entry exactly once.
   *
   * This is the single arbiter for every settlement source: remote answer,
   * deadline, host abort, channel loss and shutdown all funnel through here, so
   * the first one wins and the rest are reported as discarded (§3.1 rule 1-2).
   * @param {string} approvalId - bridge approval identity.
   * @param {string} outcome - protocol outcome.
   * @param {string} source - `remote`, `timeout`, `cancelled`, `channel`,
   *   `session` or `shutdown`.
   * @returns {boolean} whether this call settled it.
   */
  const settle = (approvalId, outcome, source) => {
    const record = pending.get(approvalId);
    if (record === undefined) {
      if (settledIds.has(approvalId)) {
        // §3.1 rule 2: the answer arrived after the request was already
        // settled. It must not change the recorded result, and it must not be
        // silently dropped either.
        logger.info('approval_late_answer_discarded', {
          approval: approvalId,
          source,
          outcome: normaliseOutcome(outcome),
        });
      }
      return false;
    }
    if (record.settled) {
      logger.info('approval_late_answer_discarded', {
        approval: approvalId,
        source,
        outcome: normaliseOutcome(outcome),
      });
      return false;
    }
    record.settled = true;
    record.outcome = normaliseOutcome(outcome);
    record.settled_at = new Date(now()).toISOString();
    record.settled_source = source;
    clearTimer(record);
    record.signal?.removeEventListener?.('abort', record.onAbort);
    record.onAbort = null;
    pending.delete(approvalId);
    settledIds.add(approvalId);
    if (settledIds.size > SETTLED_AUDIT_LIMIT) {
      const oldest = settledIds.values().next().value;
      settledIds.delete(oldest);
    }
    try {
      options.onSettled?.(record, {
        outcome: record.outcome,
        source,
        channel: channelOf(source),
      });
    } catch (error) {
      // An audit hook failure must not leave the harness waiting.
      logger.failure('approval_settled_hook_failed', error, { approval: approvalId });
    }
    record.resolve(record.outcome);
    return true;
  };

  /**
   * Arm (or re-arm) the local deadline of one claimed record.
   * @param {object} record - pending record.
   * @param {string} expiresAt - ISO 8601 deadline.
   * @returns {void}
   */
  const armDeadlineOn = (record, expiresAt) => {
    record.expires_at = expiresAt;
    clearTimer(record);
    const remaining = Date.parse(String(expiresAt)) - now();
    // §3.1 rule 4: an unanswered request expires into `rejected`, never into a
    // grant, and the timer must not keep the host process alive by itself.
    record.timer = setTimeout(
      () => settle(record.approval_id, ApprovalOutcome.REJECTED, 'timeout'),
      Math.max(0, remaining),
    );
    if (typeof record.timer.unref === 'function') record.timer.unref();
  };

  /**
   * Fail one claim closed because the answer channel turned out to be unusable.
   *
   * The request was already forwarded, so the claim cannot be handed back:
   * a second `next()` would consume the *next* listener, not re-ask the local UI
   * (§3.0 fact table, last row). `unavailable` is the honest outcome, and it
   * denies. The record never enters the pending table under a live id.
   * @param {object} record - claimed record.
   * @returns {void}
   */
  const failClosed = (record) => {
    clearTimer(record);
    record.signal?.removeEventListener?.('abort', record.onAbort);
    record.onAbort = null;
    record.settled = true;
    record.outcome = ApprovalOutcome.UNAVAILABLE;
    record.settled_source = 'channel';
    record.settled_at = new Date(now()).toISOString();
    pending.delete(record.approval_id);
    try {
      options.onSettled?.(record, {
        outcome: record.outcome,
        source: 'channel',
        channel: channelOf('channel'),
      });
    } catch (error) {
      // An audit hook failure must not leave the harness waiting.
      logger.failure('approval_settled_hook_failed', error, { approval: record.approval_id });
    }
    record.resolve(record.outcome);
  };

  /**
   * The `approval/request` waterfall listener.
   *
   * The claim decision happens before the first `await`; after it, this
   * function never touches `next` again, so a claim can only end in a settled
   * outcome (§3.0 "禁止先 next() 再声称远端生效").
   * @param {object} request - harness approval request.
   * @param {() => Promise<string>} next - delegate to the next listener.
   * @returns {Promise<string>} the settled outcome.
   */
  const listener = (request, next) => {
    // Claim-versus-delegate is decided synchronously: `canClaim` must not await,
    // and no `approval.request` may be sent before that decision, otherwise the
    // peer could be left holding a request this side never settles.
    let claim;
    try {
      claim = options.canClaim(request) === true;
    } catch (error) {
      logger.failure('approval_claim_check_failed', error, { tool: typeof request?.toolName === 'string' ? request.toolName : 'unknown' });
      claim = false;
    }
    if (!claim) {
      // §3.0 hand-over path: the local answerer owns this request completely.
      // No pending entry and no `approval.request` frame is created.
      return next?.();
    }

    // §3.0 position: the host withdrew this request before we could forward it.
    // Nothing may be sent, and no bridge id is minted for a dead request.
    if (request?.signal?.aborted === true) {
      logger.info('approval_withdrawn_before_claim', {
        tool: typeof request?.toolName === 'string' ? request.toolName : 'unknown',
      });
      return Promise.resolve(ApprovalOutcome.CANCELLED);
    }

    const approvalId = randomUUID();
    /** @type {PendingApproval} */
    const record = {
      approval_id: approvalId,
      session_id: request?.agent?.session?.id === undefined ? null : String(request.agent.session.id),
      call_id: request?.callId === undefined ? null : String(request.callId),
      tool: String(request?.toolName ?? 'unknown'),
      reason: typeof request?.reason === 'string' ? request.reason.slice(0, 512) : null,
      display_reason: request?.displayReason ?? null,
      expires_at: null,
      settled: false,
      outcome: null,
      settled_at: null,
      settled_source: null,
      signal: request?.signal,
      timer: null,
      resolve: null,
      onAbort: null,
    };
    const settledPromise = new Promise((resolve) => {
      record.resolve = resolve;
    });

    if (typeof record.signal?.addEventListener === 'function') {
      // §3.1 rule 3: a withdrawn request settles `cancelled` immediately; a
      // later answer is discarded instead of reviving it.
      record.onAbort = () => settle(approvalId, ApprovalOutcome.CANCELLED, 'cancelled');
      record.signal.addEventListener('abort', record.onAbort, { once: true });
    }

    pending.set(approvalId, record);

    Promise.resolve()
      .then(() => {
        // The host may withdraw the request while this microtask is queued.
        // Once settled there is nobody to answer, so nothing is published and
        // the peer is never handed a question this side cannot settle.
        if (record.settled) return undefined;
        return Promise.resolve(options.forward(record)).then(() => options.confirmClaim(record));
      })
      .then(
        (accepted) => {
          if (record.settled || accepted === undefined) return undefined;
          if (accepted === false) {
            // The peer will never answer, so this claim fails closed. Calling
            // `next()` here would replay the request into the chain that has
            // already been short-circuited, which §3.0 rules out.
            logger.info('approval_claim_unconfirmed', { approval: approvalId });
            failClosed(record);
          }
          // The caller arms the deadline from `confirmClaim` (via the returned
          // `armDeadline`) once the peer acknowledged the question: a locally
          // expiring handle whose question never reached anyone would be a
          // silent denial the operator never saw.
          return undefined;
        },
        (error) => {
          // §3.1 rule 5: the answer channel is gone, so this request is
          // `unavailable` — fail closed, never a fallback and never a grant.
          logger.failure('approval_forward_failed', error, { approval: approvalId });
          if (!record.settled) failClosed(record);
          return undefined;
        },
      );

    return settledPromise;
  };

  return {
    listener,
    pending,
    /**
     * Resolve a claimed request from the peer's decision.
     * @param {string} approvalId - bridge approval identity.
     * @param {string} outcome - protocol outcome.
     * @returns {boolean} whether this call settled it.
     */
    settleExternal: (approvalId, outcome) => settle(approvalId, outcome, 'remote'),
    /**
     * Settle every still-pending request as `unavailable` on channel loss, sid
     * change or shutdown. A handle from a previous process or sid can never
     * settle, so waiting is pointless and hiding the refusal would be worse.
     * @param {string} [source] - audit source label.
     * @returns {number} number of entries settled.
     */
    failAll: (source = 'channel') => {
      let count = 0;
      for (const approvalId of [...pending.keys()]) {
        if (settle(approvalId, ApprovalOutcome.UNAVAILABLE, source)) count += 1;
      }
      return count;
    },
    /**
     * Set the deadline of one claimed record so it expires locally.
     * @param {string} approvalId - bridge approval identity.
     * @param {string} expiresAt - ISO 8601 deadline.
     * @returns {boolean} whether the record was still pending.
     */
    armDeadline: (approvalId, expiresAt) => {
      const record = pending.get(approvalId);
      if (record === undefined || record.settled) return false;
      armDeadlineOn(record, expiresAt);
      return true;
    },
    /**
     * Tear the bridge down: every claimed request is settled `unavailable`
     * (its resolver cannot survive this process), then all timers and abort
     * listeners are cleared.
     * @returns {void}
     */
    dispose: () => {
      for (const approvalId of [...pending.keys()]) {
        settle(approvalId, ApprovalOutcome.UNAVAILABLE, 'shutdown');
      }
    },
  };
}

/**
 * Map a settlement source onto the audit channel vocabulary (§12.3).
 * @param {string} source - settlement source.
 * @returns {string} audit channel.
 */
function channelOf(source) {
  if (source === 'timeout') return 'timeout';
  if (source === 'remote') return 'im';
  if (source === 'shutdown' || source === 'session' || source === 'channel') return 'dsh_local';
  return 'dsh_local';
}

/**
 * Clear one record's deadline timer.
 * @param {object} record - pending record.
 * @returns {void}
 */
function clearTimer(record) {
  if (record.timer !== null && record.timer !== undefined) {
    clearTimeout(record.timer);
    record.timer = null;
  }
}

/**
 * Attach the bridge listener to a Cordis context.
 *
 * The listener is registered with `prepend` so it sits *outside* the
 * deployment's own remote/UI forwarder (`@deepseek-ai/dsh-api-remotes`
 * `lib/index.js:165-175`). Without that ordering the UI listener would run
 * first and the bridge could only ever answer after the UI delegated, making
 * remote approval a degraded fallback instead of a first-class answerer.
 * @param {object} ctx - Cordis context with event dispatch.
 * @param {object} bridge - value returned by {@link createApprovalBridge}.
 * @returns {() => void} disposer that removes the listener.
 */
export function attachApprovalBridge(ctx, bridge) {
  if (typeof ctx?.on !== 'function') {
    throw new BridgeError('capability_unavailable', { details: { capability: 'approval' } });
  }
  const dispose = ctx.on('approval/request', bridge.listener, { prepend: true });
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    if (typeof dispose === 'function') dispose();
  };
}

/**
 * Normalize any answerer result to the closed outcome vocabulary (§12.3).
 *
 * `unavailable` and `cancelled` mean fail-closed and are preserved; an unknown
 * value is never promoted to a grant.
 * @param {unknown} outcome - candidate outcome.
 * @returns {string} one of the four protocol outcomes.
 */
export function normaliseOutcome(outcome) {
  // The candidate arrives from a host answerer, so it is `unknown`: only a
  // string can name an outcome, and a non-string is not in the vocabulary
  // either way, so the typeof check cannot change the result.
  if (typeof outcome === 'string' && /** @type {readonly string[]} */ (Object.values(ApprovalOutcome)).includes(outcome)) {
    return outcome;
  }
  return ApprovalOutcome.UNAVAILABLE;
}

/**
 * Whether one outcome grants the action.
 *
 * Only `allowed-once` grants, and only for the single action it was asked about:
 * this is the only place the bridge answers "yes", so no bug can widen a grant
 * into standing permission (§12.1).
 * @param {string} outcome - protocol outcome.
 * @returns {boolean} whether the action may proceed.
 */
export function isGrant(outcome) {
  return outcome === ApprovalOutcome.ALLOWED_ONCE;
}

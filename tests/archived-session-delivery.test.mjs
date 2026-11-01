/**
 * Archive actually stops delivery (protocol §9.7, §15.3 `session_archived`).
 *
 * `session.manage{action:'archive'}` durably records a disposition, but the
 * disposition only mattered where it was read. Neither production path did:
 *
 *   - `TaskService.submitInbound` checked `store.isAuthorized` and nothing
 *     else, so a task naming an archived session was accepted and executed;
 *   - `NotifyService.wake` delivered into the originating session without
 *     asking whether it had been archived, so archive did not stop the
 *     automatic traffic it exists to stop.
 *
 * The suite drives the real `BridgeStore`, the real `SessionService` (whose
 * disposition is what `manage()` writes to disk) and the real
 * `TaskService`/`NotifyService` against each other. The host stub only *counts*
 * deliveries; it never decides anything, so a passing assertion cannot be the
 * stub agreeing with the implementation.
 *
 * What is asserted:
 *
 *   - before an archive a delivery succeeds, after it zero deliveries happen;
 *   - the block survives a rebuilt service and a reopened store, because the
 *     disposition — not an in-memory flag — is what refuses;
 *   - a task already accepted when the archive lands does not execute;
 *   - a wake into an archived session is suppressed, and one suppressed wake
 *     does not cost a wake slot or rewrite an unrelated task;
 *   - an unauthorized session is refused as unauthorized, never
 *     `session_archived`, so the refusal cannot be used to probe for archived
 *     sessions (§9.7 hides existence rather than refusing it);
 *   - an unarchived, authorized session keeps working (no regression).
 *
 * Fixture basis: a control task whose only purpose is to measure archive
 * behaviour claims `origin: 'human'` and targets a session the peer granted with
 * `granted_by: 'human'` — the two facts §12.5 point 5 requires before a
 * submission may run without an approval reference. A submission that named no
 * session has no grant to corroborate it, so that control carries a real
 * human-decided `approval_ref` instead of a weakened gate. The approval gate
 * itself is not weakened for this suite: the counterweights below show an
 * LLM submission and an `agent_auto` grant are still held for a human.
 * @module dsh-plugin-astrbot-bridge/tests/archived-session-delivery
 */

import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ApprovalService } from '../lib/app/approvals.js';
import { NotifyService } from '../lib/app/notify.js';
import { SessionService } from '../lib/app/sessions.js';
import { TaskService } from '../lib/app/tasks.js';
import { ApprovalOutcome } from '../lib/constants.js';
import { BridgeError } from '../lib/errors.js';
import { BridgeStore } from '../lib/store.js';

/** Logger stub: this suite asserts behaviour, not log text. */
const SILENT = { info() {}, warn() {}, failure() {}, debug() {}, error() {} };

/**
 * Host stub that only counts what it is asked to do.
 *
 * `deliver` is the single side effect both services perform, so counting it is
 * the whole point of the fixture: "0 deliveries" is what archive must mean.
 * @param {object} [options] - stub behaviour.
 * @param {string[]} [options.live] - sessions the host reports as existing.
 * @param {boolean} [options.deliverThrows] - make delivery fail.
 * @param {boolean} [options.idle] - what `waitIdle` answers.
 * @returns {object} host stub with a `deliveries` array.
 */
function makeHost(options = {}) {
  const deliveries = [];
  return {
    deliveries,
    listSessions: () => (options.live ?? ['s1']).map((sessionId) => ({ session_id: sessionId, state: 'idle' })),
    async deliver(input) {
      deliveries.push(input);
      if (options.deliverThrows === true) throw new BridgeError('session_not_found');
      return { strategy: 'followup', session_id: input.sessionId, degraded: [] };
    },
    async waitIdle() {
      return options.idle !== false;
    },
    cancel: () => true,
    async createSession(input) {
      return input.sessionId;
    },
  };
}

/**
 * Fake peer session: records outbound messages, answers like a peer.
 * @returns {object} session stub.
 */
function makePeerSession() {
  return {
    emitted: [],
    async emit(m, params) {
      this.emitted.push({ m, params });
    },
    async call(m, params) {
      return { task_id: params?.task_id ?? '', status: 'accepted', session_id: null, dedup: false };
    },
  };
}

/**
 * Open a durable store in a fresh temporary root.
 * @param {string} root - directory holding the store.
 * @returns {Promise<BridgeStore>} opened store.
 */
async function openStore(root) {
  const store = new BridgeStore({ dataRoot: root });
  await store.init();
  return store;
}

/**
 * Build the real service trio over one store, exactly as `_buildServices` does.
 *
 * The `SessionService` instance handed to the other two is the *same* object
 * `manage()` writes through, which is also the contract the composition root
 * owes: one session service per connection, shared, not a second copy.
 * @param {object} options - fixture inputs.
 * @param {BridgeStore} options.store - store to use.
 * @param {object} [options.host] - host stub.
 * @param {object} [options.session] - peer session stub.
 * @param {boolean} [options.wireSessions] - pass `sessions` to both services.
 * @returns {object} fixture with `sessions`, `tasks`, `notify`.
 */
function makeServices(options) {
  const host = options.host ?? makeHost();
  const session = options.session ?? makePeerSession();
  const config = {
    id: 'default',
    approvalTimeoutSeconds: 300,
    allowedSessionPurposes: [],
    wakeMaxChain: 8,
    wakeRatePerMinute: 10,
    imageMaxCount: 4,
    imageMaxBytes: 10_485_760,
    imageTotalMaxBytes: 20_971_520,
    imageAllowedMime: ['image/png'],
  };
  const sessions = new SessionService({ store: options.store, host, config, logger: SILENT });
  const wired = options.wireSessions === false ? null : sessions;
  const notify = new NotifyService({
    store: options.store,
    session,
    host,
    config,
    logger: SILENT,
    sessions: wired,
  });
  const tasks = new TaskService({
    store: options.store,
    session,
    host,
    notify,
    config,
    logger: SILENT,
    sessions: wired,
  });
  let approvals = null;
  if (options.approvals === true) {
    approvals = new ApprovalService({
      store: options.store,
      session,
      host,
      notify,
      config,
      logger: SILENT,
    });
    approvals.onSessionReady('default', 'sid-test');
    tasks.approvals = approvals;
  }
  return { host, session, sessions, notify, tasks, config, approvals };
}

/**
 * Build one valid `task.submit` parameter set.
 *
 * The default is a **human** submission into a session a human granted — the one
 * combination §12.5 point 5 releases without an approval reference. This suite
 * measures archive, so its control task must be allowed to run for reasons that
 * have nothing to do with archive; the approval counterweights at the end keep
 * the gate itself under test. (The previous `origin: 'llm'` default was the
 * fixture defect the newer security rule exposed: every control task parked in
 * `pending_approval` and never reached the delivery boundary at all.)
 * @param {object} [overrides] - field overrides.
 * @returns {object} parameters.
 */
function submitParams(overrides = {}) {
  return {
    task_id: '22222222-2222-4222-8222-222222222222',
    root_task_id: '22222222-2222-4222-8222-222222222222',
    kind: 'dsh_agent_run',
    origin: 'human',
    input_parts: [{ type: 'text', text: 'do the thing' }],
    attachments: [],
    tool_hints: [],
    session_id: 's1',
    purpose: 'code-review',
    timeout_s: 60,
    meta: {},
    approval_ref: null,
    ...overrides,
  };
}

/**
 * One grant exactly as A pushes it over `session.authz` (§9.7).
 *
 * `granted_by` is not decoration: `TaskService._humanGranted` reads it to decide
 * whether a human command may run without an approval reference. Omitting it
 * (or letting `applyAuthz` default it away) would park every control task in
 * `pending_approval`, which is what this suite's controls must not do.
 */
const GRANT_DEFAULTS = Object.freeze({
  purpose: null,
  granted_by: 'human',
  granted_by_id: 'astrbot_admin:admin',
  expires_at: null,
  created_by_task: null,
});

/**
 * Push one authorization snapshot with real grants.
 * @param {BridgeStore} store - store to update.
 * @param {Array<string|object>} grants - session ids or grant objects.
 * @returns {Promise<void>} resolution after the push is applied.
 */
async function grant(store, grants) {
  await store.applyAuthz({
    version: 1,
    grants: grants.map((entry) => ({
      ...GRANT_DEFAULTS,
      ...(typeof entry === 'string' ? { session_id: entry } : entry),
    })),
  });
}

/**
 * Give one submission a genuine human-decided `cross_end_submit` approval.
 *
 * Needed only where the fixture cannot claim the §12.5 point 5 corroboration:
 * a submission naming no session has no grant to point at, so it must carry a
 * real digest-bound reference rather than a softened gate. The reference is
 * built from the production `submitDigestOf` and a decided approval row, so the
 * verification path under test is the real one.
 * @param {BridgeStore} store - store holding the approval.
 * @param {TaskService} tasks - service that computes the digest.
 * @param {object} params - the `task.submit` parameters to approve.
 * @returns {Promise<object>} the same parameters with `approval_ref` attached.
 */
async function withHumanApproval(fixture, params) {
  const tasks = fixture.tasks;
  const approvals = fixture.approvals;
  const approval = await approvals.requestSubmitApproval({
    task: {
      task_id: params.task_id,
      root_task_id: params.root_task_id,
      session_id: params.session_id,
    },
    tool: params.kind,
    reason: 'cross-end task submission',
    submitDigest: await tasks.submitDigestOf(params),
  });
  const decided = await approvals.decide(approval.approval_id, {
    outcome: ApprovalOutcome.ALLOWED_ONCE,
    actor: 'astrbot_admin:admin',
    actor_kind: 'human',
    channel: 'im',
  });
  assert.equal(decided.applied, true, 'the human approval must be durable');
  return {
    ...params,
    approval_ref: {
      approval_id: approval.approval_id,
      submit_digest: await tasks.submitDigestOf(params),
      expires_at: approval.expires_at,
      actor_kind: 'human',
    },
  };
}

/**
 * Poll until a task reaches a terminal-or-parked status.
 *
 * Execution is detached by design (`submitInbound` answers before it runs), so
 * a test must wait for a *decision* rather than for a fixed delay. Polling a
 * small number of times also fails loudly instead of hanging when the state
 * machine stops making progress.
 * @param {BridgeStore} store - store holding the task.
 * @param {string} taskId - task identity.
 * @param {string[]} statuses - statuses to stop at.
 * @returns {Promise<object>} the observed task record.
 */
async function waitForStatus(store, taskId, statuses) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const task = await store.getTask(taskId);
    if (task !== null && statuses.includes(task.status)) return task;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const task = await store.getTask(taskId);
  throw new Error(`task ${taskId} never reached ${statuses.join('/')} (stuck at ${task?.status})`);
}

test('an inbound task into an archived session is refused, and succeeds before the archive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-archived-'));
  const store = await openStore(root);
  const fixture = makeServices({ store });
  await grant(store, ['s1']);

  // Control: the same fixture, the same session, before any archive. Without
  // this the refusals below could be caused by anything.
  const before = await fixture.tasks.submitInbound(submitParams({ task_id: 'before-archive' }));
  assert.equal(before.status, 'accepted', 'an authorized, unarchived session accepts work');
  await waitForStatus(store, 'before-archive', ['succeeded']);
  assert.equal(fixture.host.deliveries.length, 1, 'the control task really executed once');

  await fixture.sessions.manage({ session_id: 's1', action: 'archive' });

  await assert.rejects(
    fixture.tasks.submitInbound(submitParams({ task_id: 'after-archive' })),
    (error) => error instanceof BridgeError && error.code === 'session_archived',
    'the refusal must be the protocol code, not an invented one',
  );
  assert.equal(await store.getTask('after-archive'), null, 'a refused submit persists no task');
  assert.equal(fixture.host.deliveries.length, 1, 'nothing ran after the archive');
  await store.close();
});

test('the archive block survives a rebuilt service and a reopened store', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-archived-'));
  const first = await openStore(root);
  const a = makeServices({ store: first });
  await grant(first, ['s1']);
  await a.sessions.manage({ session_id: 's1', action: 'archive' });
  await first.close();

  // Next handshake: new store handle, new session service, same root. A gate
  // that read an in-memory flag would let this through.
  const second = await openStore(root);
  const b = makeServices({ store: second });
  await assert.rejects(
    b.tasks.submitInbound(submitParams({ task_id: 'after-reopen' })),
    (error) => error instanceof BridgeError && error.code === 'session_archived',
  );
  // The interaction the bug report named: archive then rename must not
  // un-archive, and re-archive must stay idempotent.
  await b.sessions.manage({ session_id: 's1', action: 'rename', title: 'still here' });
  await assert.rejects(
    b.tasks.submitInbound(submitParams({ task_id: 'after-rename' })),
    (error) => error instanceof BridgeError && error.code === 'session_archived',
  );
  assert.equal(b.host.deliveries.length, 0);
  await second.close();
});

test('an unauthorized session is refused as unauthorized, never as archived', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-archived-'));
  const store = await openStore(root);
  const fixture = makeServices({ store });
  await grant(store, ['s1']);

  // Archive a granted session, then revoke it. Refusing the now-unauthorized
  // session as `session_archived` would tell the peer it had been archived,
  // which is exactly the existence leak §9.7 avoids.
  await fixture.sessions.manage({ session_id: 's1', action: 'archive' });
  await store.applyAuthz({ version: 2, grants: [], revoked: ['s1'] });

  await assert.rejects(
    fixture.tasks.submitInbound(submitParams({ task_id: 'revoked' })),
    (error) => error instanceof BridgeError && error.code === 'session_not_authorized',
    'authorization is decided before the disposition, so archived state is not leaked',
  );

  // A session the peer never granted is likewise unauthorized, archived or not.
  await assert.rejects(
    fixture.tasks.submitInbound(submitParams({ task_id: 'never-granted', session_id: 's-never' })),
    (error) => error instanceof BridgeError && error.code === 'session_not_authorized',
  );
  assert.equal(fixture.host.deliveries.length, 0);
  await store.close();
});

test('a task accepted before the archive does not execute after it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-archived-'));
  const store = await openStore(root);
  const fixture = makeServices({ store });
  await grant(store, ['s1']);

  // Reproduce the durable state a crash or a slow queue leaves behind: the
  // task is already `accepted` (the peer holds that answer) and has not run
  // yet. Archiving now must stop the execution boundary, not just the submit
  // boundary — this is the window a submit-time-only check misses.
  await store.putTask({
    task_id: 'race',
    root_task_id: 'race',
    kind: 'dsh_agent_run',
    origin: 'llm',
    direction: 'inbound',
    status: 'accepted',
    session_id: 's1',
    purpose: 'code-review',
    timeout_s: 60,
    input_parts: [{ type: 'text', text: 'do the thing' }],
    attachments: [],
    tool_hints: [],
    meta: {},
    approval_ref: null,
    eseq: 0,
    attempts: 0,
    needs_human: false,
    result: null,
    error: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  await fixture.sessions.manage({ session_id: 's1', action: 'archive' });

  // Drive the real execution entry point, deterministically.
  await fixture.tasks._runInbound(await store.getTask('race'));

  const task = await store.getTask('race');
  assert.equal(task.status, 'needs_human', 'an already-accepted task is parked, not run and not failed');
  assert.equal(task.error.code, 'session_archived', 'the reason is the persisted protocol code');
  assert.equal(task.needs_human, true);
  assert.equal(fixture.host.deliveries.length, 0, 'the execution boundary refused the delivery');
  // It never claimed to be queued or running: a refused task must not pretend
  // it got further than it did.
  const events = (await store.list('notifies')).map((record) => record.payload.event);
  assert.deepEqual(events, ['needs_human'], 'no running/queued event was ever emitted');
  await store.close();
});

test('a wake into an archived session is suppressed and costs no wake slot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-archived-'));
  const store = await openStore(root);
  const fixture = makeServices({ store });
  await grant(store, ['s1']);
  await store.putTask({
    task_id: 'out1',
    root_task_id: 'out1',
    status: 'running',
    direction: 'outbound',
    session_id: 's1',
    eseq: 0,
    updated_at: new Date().toISOString(),
  });
  const task = await store.getTask('out1');

  // Control: a wake to the unarchived session does reach the host.
  await fixture.notify.wake({ task, event: 'completed', text: 'x', rootTaskId: 'out1' });
  assert.equal(fixture.host.deliveries.length, 1, 'an unarchived session is woken');

  await fixture.sessions.manage({ session_id: 's1', action: 'archive' });
  await fixture.notify.wake({ task, event: 'completed', text: 'x', rootTaskId: 'out1' });
  assert.equal(fixture.host.deliveries.length, 1, 'an archived session is not woken');

  // A suppressed wake must not be charged to the §16.6 budget. Eight is the
  // chain limit, so a suppression that consumed a slot would show up as an
  // earlier refusal on the next eight *real* wake attempts.
  for (let index = 0; index < 8; index += 1) {
    const decision = await fixture.notify.authoriseWake('out1', 's1');
    assert.equal(decision.allowed, true, `wake slot ${index + 1} survived the suppressed wake`);
  }
  await store.close();
});

test('a suppressed wake does not rewrite an unrelated task to needs_human', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-archived-'));
  const store = await openStore(root);
  const fixture = makeServices({ store });
  await grant(store, ['s1']);
  await store.putTask({
    task_id: 'out2',
    root_task_id: 'out2',
    status: 'succeeded',
    direction: 'outbound',
    session_id: 's1',
    eseq: 2,
    needs_human: false,
    updated_at: new Date().toISOString(),
  });
  await fixture.sessions.manage({ session_id: 's1', action: 'archive' });

  // Drive the real event path, which is what decides whether a wake runs.
  await fixture.tasks.onEvent({
    task_id: 'out2',
    root_task_id: 'out2',
    eseq: 3,
    event: 'completed',
    status: 'succeeded',
    notify_id: 'n-suppressed',
    result: { summary: 'ok', text: 'done', attachments: [] },
    error: null,
    decision: null,
    approval: null,
  });

  const task = await store.getTask('out2');
  assert.equal(fixture.host.deliveries.length, 0, 'the archived session was not woken');
  assert.equal(task.status, 'succeeded', 'its own outcome is left alone');
  assert.equal(task.needs_human, false, 'a suppressed wake is not a reason to page a human');
  await store.close();
});

test('an authorized, unarchived session keeps delivering normally', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-archived-'));
  const store = await openStore(root);
  const fixture = makeServices({ store });
  await grant(store, ['s1', { session_id: 's2', purpose: 'ops' }]);

  const result = await fixture.tasks.submitInbound(submitParams({ task_id: 'normal' }));
  assert.equal(result.status, 'accepted');
  const task = await waitForStatus(store, 'normal', ['succeeded']);
  assert.equal(task.status, 'succeeded');
  assert.equal(fixture.host.deliveries.length, 1);
  assert.equal(fixture.host.deliveries[0].sessionId, 's1');

  // Archiving one session must not affect a different authorized one.
  await fixture.sessions.manage({ session_id: 's1', action: 'archive' });
  const other = await fixture.tasks.submitInbound(
    submitParams({ task_id: 'other-session', session_id: 's2', purpose: 'ops' }),
  );
  assert.equal(other.status, 'accepted', 'an unrelated session is untouched');
  await waitForStatus(store, 'other-session', ['succeeded']);
  assert.equal(fixture.host.deliveries.length, 2);
  await store.close();
});

test('an archived session is not auto-picked for a task that named none', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-archived-'));
  const store = await openStore(root);
  const fixture = makeServices({ store, approvals: true });
  // `_pickSession` matches the grant by purpose, so the grant has to carry the
  // same one the task will name; otherwise the refusal would be about the
  // purpose filter and would not prove anything about archive.
  await grant(store, [{ session_id: 's1', purpose: 'code-review' }]);
  await fixture.sessions.manage({ session_id: 's1', action: 'archive' });

  // `session_id: null` means "let the executor pick". Picking the archived
  // session and then refusing at the boundary would park a task that has no
  // usable target anyway, so it is refused up front with the same code.
  //
  // A submission that names no session has no grant to corroborate it, so
  // §12.5 point 5 would hold it for a human and it would never reach the picker.
  // The control therefore carries a real human-decided approval; archive is what
  // this test measures, not the approval gate.
  await fixture.tasks.submitInbound(
    await withHumanApproval(fixture, submitParams({ task_id: 'auto-pick', session_id: null })),
  );
  const task = await waitForStatus(store, 'auto-pick', ['needs_human', 'failed', 'succeeded']);
  assert.equal(task.status, 'needs_human');
  assert.equal(task.error.code, 'session_archived');
  assert.equal(fixture.host.deliveries.length, 0);
  await store.close();
});

test('an archived session can still be listed and managed, only delivery is refused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-archived-'));
  const store = await openStore(root);
  const fixture = makeServices({ store });
  await grant(store, ['s1']);
  await fixture.sessions.manage({ session_id: 's1', action: 'archive' });

  // Archive narrows delivery, not visibility: §9.7 `session.list` still reports
  // the grant, so an operator can see and un-archive it.
  const listed = await fixture.sessions.list({});
  assert.deepEqual(
    listed.sessions.map((entry) => entry.session_id),
    ['s1'],
  );
  assert.equal(await fixture.sessions.isDeliverable('s1'), false);
  assert.equal((await store.getTask('never-created')), null);
  await store.close();
});

test('without the sessions dependency the gate reports the wiring gap instead of faking it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-archived-'));
  const store = await openStore(root);
  // This is the *current* `lib/index.js` state: `TaskService`/`NotifyService`
  // are built without the `SessionService` `_buildServices` already creates.
  const fixture = makeServices({ store, wireSessions: false });
  await grant(store, ['s1']);
  await fixture.sessions.manage({ session_id: 's1', action: 'archive' });

  const warnings = [];
  const logger = {
    info() {},
    debug() {},
    failure() {},
    error() {},
    warn(event, context) {
      warnings.push({ event, context });
    },
  };
  const unwiredNotify = new NotifyService({
    store,
    session: fixture.session,
    host: fixture.host,
    config: fixture.config,
    logger,
    sessions: null,
  });
  const unwiredTasks = new TaskService({
    store,
    session: fixture.session,
    host: fixture.host,
    notify: unwiredNotify,
    config: fixture.config,
    logger,
    sessions: null,
  });
  await store.putTask({
    task_id: 'out3',
    root_task_id: 'out3',
    status: 'running',
    direction: 'outbound',
    session_id: 's1',
    eseq: 0,
    updated_at: new Date().toISOString(),
  });

  // Authorization is still enforced without `sessions`: it is the peer's table.
  await assert.rejects(
    unwiredTasks.submitInbound(submitParams({ task_id: 'unwired-denied', session_id: 's-other' })),
    (error) => error instanceof BridgeError && error.code === 'session_not_authorized',
  );
  // But the archive disposition is genuinely unreadable, so it is reported, and
  // the gap is announced exactly once rather than per call.
  await unwiredTasks.submitInbound(submitParams({ task_id: 'unwired-allowed' }));
  await unwiredNotify.wake({
    task: await store.getTask('out3'),
    event: 'completed',
    text: 'x',
    rootTaskId: 'out3',
  });
  const gaps = warnings.filter((entry) => entry.event === 'archive_gate_unwired');
  assert.deepEqual(
    gaps.map((entry) => entry.context.service).sort(),
    ['notify', 'tasks'],
    'each service announces the gap once, naming itself',
  );
  await store.close();
});

// Counterweights to the fixture's `origin: 'human'` default. Making the archive
// controls human submissions must not be mistaken for weakening the approval
// gate: these two prove the gate still holds an LLM submission and a submission
// into an agent-created grant, in *this* suite's fixture, before any archive is
// involved.

test('an LLM submission into a human-granted session is still held for a human', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-archived-'));
  const store = await openStore(root);
  const fixture = makeServices({ store });
  await grant(store, ['s1']);

  const params = submitParams({ task_id: 'llm-held', origin: 'llm' });
  const result = await fixture.tasks.submitInbound(params);
  assert.equal(result.status, 'pending_approval', 'origin llm never runs unattended');
  // Detached work must settle as held, not merely be reported as held.
  await new Promise((resolve) => setImmediate(resolve));
  const task = await store.getTask('llm-held');
  assert.equal(task.status, 'pending_approval', 'the durable record is held too');
  assert.equal(task.needs_human, true, 'an unwired approval gate is fail-closed');
  assert.equal(fixture.host.deliveries.length, 0, 'nothing ran before a human answered');
  await store.close();
});

test('a human submission into an agent-created grant is still held for a human', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-archived-'));
  const store = await openStore(root);
  const fixture = makeServices({ store });
  // An `agent_auto` grant is not human corroboration, so the payload's claim of
  // a human origin cannot carry it through the gate.
  await grant(store, [{ session_id: 's1', purpose: 'code-review', granted_by: 'agent_auto' }]);

  const result = await fixture.tasks.submitInbound(submitParams({ task_id: 'agent-grant-held' }));
  assert.equal(result.status, 'pending_approval');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await store.getTask('agent-grant-held')).status, 'pending_approval');
  assert.equal(fixture.host.deliveries.length, 0);
  await store.close();
});

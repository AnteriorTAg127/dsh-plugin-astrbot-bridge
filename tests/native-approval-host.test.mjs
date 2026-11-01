/**
 * Native-approval host control flow (protocol §12 + `native-approval-id-decision.md` §3.0).
 *
 * The subject of this suite is the **claim-versus-delegate** decision and its
 * settlement, exercised through a waterfall that reproduces the real Cordis
 * composition (`@deepseek-ai/cordis` `lib/index.js:317-325`):
 *
 * ```js
 * const cbs = dispatch("waterfall", args);   // registration order, `prepend` unshifts
 * const inner = args.pop();
 * const next = () => (cbs.shift() ?? inner)(...args);
 * ```
 *
 * A listener that returns without calling `next()` vetoes the rest of the chain,
 * and the host only ever sees the outermost return value. Because that is the
 * whole contract the harness relies on, the assertions below are written against
 * the *composed* waterfall result — never against an internal promise — so a
 * regression that keeps the bridge's promise alive but lets the host settle with
 * a different outcome fails here.
 *
 * The last two cases use the **real** host packages (Cordis `Context` and
 * `dsh-user-approval`'s `ApprovalService`) when they resolve from this
 * repository's `node_modules`; when they cannot be imported the case is skipped
 * with an explicit reason rather than reported as passing.
 * @module dsh-plugin-astrbot-bridge/tests/native-approval-host
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { createApprovalBridge, attachApprovalBridge, isGrant } from '../lib/host/approval.js';
import { BridgeError } from '../lib/errors.js';

/** A logger that records nothing but satisfies the bridge's interface. */
const SILENT = Object.freeze({
  info() {},
  warn() {},
  failure() {},
  debug() {},
  error() {},
});

/**
 * A logger that records every event so audit claims can be asserted.
 * @returns {{info: Function, warn: Function, failure: Function, debug: Function,
 *   error: Function, events: object[]}} logger with a captured event list.
 */
function recordingLogger() {
  const events = [];
  const push = (level) => (event, fields) => events.push({ level, event, ...(fields ?? {}) });
  return { info: push('info'), warn: push('warn'), failure: push('failure'), debug: push('debug'), error: push('error'), events };
}

/**
 * Build a minimal Cordis-compatible event bus.
 *
 * It mirrors the real `EventsService.waterfall` exactly: listeners are collected
 * in registration order (`prepend` unshifts), the last argument is the innermost
 * `next`, and each `next()` consumes the following listener. Everything the
 * bridge does is observed through {@link waterfall}'s return value.
 * @returns {{ctx: object, waterfall: Function, listeners: Function[],
 *   disposers: Function[]}} stub host.
 */
function stubHost() {
  /** @type {Map<string, Function[]>} */
  const hooks = new Map();
  const disposers = [];
  const ctx = {
    on(name, listener, options) {
      const prepend = options === true || (typeof options === 'object' && options?.prepend === true);
      const list = hooks.get(name) ?? [];
      if (prepend) list.unshift(listener);
      else list.push(listener);
      hooks.set(name, list);
      let active = true;
      const dispose = () => {
        if (!active) return;
        active = false;
        const index = list.indexOf(listener);
        if (index >= 0) list.splice(index, 1);
      };
      disposers.push(dispose);
      return dispose;
    },
  };
  return {
    ctx,
    disposers,
    listeners: () => [...(hooks.get('approval/request') ?? [])],
    /**
     * Run one composed dispatch through the registered listeners.
     * @param {object} request - harness approval request.
     * @param {() => Promise<string>} [inner] - built-in behaviour.
     * @returns {Promise<string>} the outcome the host would record.
     */
    waterfall(request, inner = () => Promise.resolve('unavailable')) {
      const cbs = [...(hooks.get('approval/request') ?? [])];
      const next = () => (cbs.shift() ?? inner)(request, next);
      return next();
    },
  };
}

/**
 * A request as the harness raises it; `callId` is optional and omitted here.
 * @param {object} [overrides] - field overrides.
 * @returns {object} request.
 */
function harnessRequest(overrides = {}) {
  return {
    agent: { session: { id: 'session-1' } },
    toolName: 'bash',
    reason: 'run the test suite',
    ...overrides,
  };
}

/**
 * Build a bridge plus its host wiring.
 * @param {object} [options] - behaviour overrides.
 * @param {boolean|Function} [options.claim] - `canClaim` answer.
 * @param {Function} [options.forward] - forward implementation.
 * @param {Function} [options.confirmClaim] - confirmation implementation.
 * @param {object} [options.logger] - logger.
 * @param {Function} [options.now] - clock.
 * @returns {object} fixture.
 */
function makeBridge(options = {}) {
  const host = stubHost();
  const forwarded = [];
  const settled = [];
  const claimGate = [];
  const bridge = createApprovalBridge(
    {
      canClaim: (request) => {
        claimGate.push(request);
        return typeof options.claim === 'function' ? options.claim(request) : options.claim === true;
      },
      forward:
        options.forward ??
        (async (record) => {
          forwarded.push(record);
        }),
      confirmClaim: options.confirmClaim ?? (async () => true),
      onSettled: (record, outcome) => settled.push({ record, outcome }),
    },
    options.logger ?? SILENT,
    options.now ?? (() => Date.now()),
  );
  const detach = attachApprovalBridge(host.ctx, bridge);
  return { host, bridge, forwarded, settled, claimGate, detach };
}

/** Let every microtask of the claim path run (forward → confirm → deadline). */
async function drain() {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

test('a claimable request is claimed and the local UI is never consulted', async () => {
  const { host, bridge, forwarded } = makeBridge({ claim: true });
  let uiCalls = 0;
  // A UI stand-in registered *after* the bridge, exactly like `dsh-api-remotes`.
  host.ctx.on('approval/request', async () => {
    uiCalls += 1;
    return 'rejected';
  });

  const hostOutcome = host.waterfall(harnessRequest());
  await drain();
  assert.equal(uiCalls, 0, 'a claimed request must short-circuit the chain');
  assert.equal(forwarded.length, 1, 'the claim forwards exactly one real request');
  assert.match(forwarded[0].approval_id, /^[0-9a-f-]{36}$/i, 'the bridge mints its own UUID');
  assert.equal(forwarded[0].session_id, 'session-1', 'the session comes from req.agent.session.id');
  assert.equal(forwarded[0].call_id, null, 'a missing callId stays null rather than a fake id');

  assert.equal(bridge.settleExternal(forwarded[0].approval_id, 'allowed-once'), true);
  assert.equal(await hostOutcome, 'allowed-once', 'the remote allow is the host outcome');
  assert.equal(uiCalls, 0);
  assert.equal(isGrant(await hostOutcome), true);
});

test('an ineligible request is delegated and creates no bridge state', async () => {
  const { host, bridge, forwarded } = makeBridge({ claim: false });
  let uiCalls = 0;
  host.ctx.on('approval/request', async () => {
    uiCalls += 1;
    return 'rejected';
  });

  const outcome = await host.waterfall(harnessRequest());
  assert.equal(outcome, 'rejected', 'the local answerer settles a delegated request');
  assert.equal(uiCalls, 1, 'delegation must reach the next listener');
  assert.equal(forwarded.length, 0, 'a delegated request is never published');
  assert.equal(bridge.pending.size, 0, 'a delegated request has no pending handle');
});

test('a remote answer cannot rescue a delegated request', async () => {
  const { host, bridge } = makeBridge({ claim: false });
  host.ctx.on('approval/request', async () => 'rejected');
  assert.equal(await host.waterfall(harnessRequest()), 'rejected');
  assert.equal(bridge.pending.size, 0);
  // Whatever a peer sends later, there is no handle to settle: the host result
  // is already decided by the local answerer.
  assert.equal(bridge.settleExternal('any-id', 'allowed-once'), false);
  assert.equal(bridge.failAll('channel'), 0);
});

test('a withdrawn claim settles cancelled and discards a late allow', async () => {
  const logger = recordingLogger();
  const { host, bridge, forwarded } = makeBridge({ claim: true, logger });
  const controller = new AbortController();
  const hostOutcome = host.waterfall(harnessRequest({ signal: controller.signal }));
  await drain();
  controller.abort();
  assert.equal(await hostOutcome, 'cancelled', 'abort is the host withdrawing the request');

  const approvalId = forwarded[0].approval_id;
  assert.equal(bridge.settleExternal(approvalId, 'allowed-once'), false, 'a late allow must not apply');
  assert.ok(
    logger.events.some((entry) => entry.event === 'approval_late_answer_discarded'),
    'the discarded answer is audited',
  );
});

test('an already-aborted request is not claimed and is not forwarded', async () => {
  const { host, forwarded, bridge } = makeBridge({ claim: true });
  const controller = new AbortController();
  controller.abort();
  let uiCalls = 0;
  host.ctx.on('approval/request', async () => {
    uiCalls += 1;
    return 'rejected';
  });
  const outcome = await host.waterfall(harnessRequest({ signal: controller.signal }));
  assert.equal(outcome, 'cancelled');
  assert.equal(forwarded.length, 0, 'a dead request must not reach the peer');
  assert.equal(uiCalls, 0);
  assert.equal(bridge.pending.size, 0);
});

test('an unanswered claim expires into rejected, never into a grant', async () => {
  let now = Date.now();
  const { host, bridge, forwarded } = makeBridge({ claim: true, now: () => now });
  const hostOutcome = host.waterfall(harnessRequest());
  await drain();
  const approvalId = forwarded[0].approval_id;
  now += 30;
  assert.equal(bridge.armDeadline(approvalId, new Date(now).toISOString()), true);
  assert.equal(await hostOutcome, 'rejected', 'expiry denies');
  assert.equal(bridge.settleExternal(approvalId, 'allowed-once'), false, 'a late allow is dropped');
});

test('an unusable channel fails a claimed request closed instead of falling back', async () => {
  let uiCalls = 0;
  const { host, bridge } = makeBridge({
    claim: true,
    forward: async () => {
      throw new BridgeError('not_ready');
    },
  });
  host.ctx.on('approval/request', async () => {
    uiCalls += 1;
    return 'allowed-once';
  });
  const outcome = await host.waterfall(harnessRequest());
  assert.equal(outcome, 'unavailable', 'an unusable channel denies');
  assert.equal(uiCalls, 0, 'the claim is not replayed into the chain a second time');
  assert.equal(isGrant(outcome), false);
  assert.equal(bridge.pending.size, 0);
});

test('a peer that refuses the question fails the claim closed', async () => {
  let uiCalls = 0;
  const { host, bridge } = makeBridge({ claim: true, confirmClaim: async () => false });
  host.ctx.on('approval/request', async () => {
    uiCalls += 1;
    return 'allowed-once';
  });
  const outcome = await host.waterfall(harnessRequest());
  assert.equal(outcome, 'unavailable');
  assert.equal(uiCalls, 0, 'no second `next()` after a claim');
  assert.equal(bridge.pending.size, 0);
});

test('a throwing claim gate delegates instead of hanging the host', async () => {
  const { host, forwarded, bridge } = makeBridge({
    claim: () => {
      throw new Error('gate exploded');
    },
  });
  host.ctx.on('approval/request', async () => 'rejected');
  assert.equal(await host.waterfall(harnessRequest()), 'rejected');
  assert.equal(forwarded.length, 0);
  assert.equal(bridge.pending.size, 0);
});

test('concurrent requests without a callId stay independent', async () => {
  const { host, forwarded } = makeBridge({ claim: true });
  const first = host.waterfall(harnessRequest());
  const second = host.waterfall(harnessRequest({ toolName: 'bash', reason: 'another' }));
  await drain();
  assert.equal(forwarded.length, 2);
  const ids = forwarded.map((record) => record.approval_id);
  assert.notEqual(ids[0], ids[1], 'each approval gets its own bridge id');
  assert.equal(forwarded[0].call_id, null);
  assert.equal(forwarded[1].call_id, null);

  const { bridge } = makeBridge({ claim: true });
  void bridge;
});

test('settling one concurrent claim leaves the other untouched', async () => {
  const { host, bridge, forwarded } = makeBridge({ claim: true });
  const first = host.waterfall(harnessRequest());
  const second = host.waterfall(harnessRequest());
  await drain();
  const [a, b] = forwarded.map((record) => record.approval_id);
  assert.equal(bridge.settleExternal(a, 'allowed-once'), true);
  assert.equal(await first, 'allowed-once');
  assert.equal(bridge.pending.size, 1, 'the other request is still pending');
  assert.equal(bridge.settleExternal(b, 'rejected'), true);
  assert.equal(await second, 'rejected');
});

test('channel loss settles every claimed handle as unavailable', async () => {
  const { host, bridge, forwarded } = makeBridge({ claim: true });
  const first = host.waterfall(harnessRequest());
  const second = host.waterfall(harnessRequest());
  await drain();
  assert.equal(bridge.failAll('channel'), 2);
  assert.equal(await first, 'unavailable');
  assert.equal(await second, 'unavailable');
  for (const record of forwarded) {
    assert.equal(bridge.settleExternal(record.approval_id, 'allowed-once'), false);
  }
});

test('disposal settles live claims so the host never waits on a dead listener', async () => {
  const { host, bridge, forwarded } = makeBridge({ claim: true });
  const hostOutcome = host.waterfall(harnessRequest());
  await drain();
  bridge.dispose();
  assert.equal(await hostOutcome, 'unavailable', 'teardown fails closed');
  assert.equal(bridge.settleExternal(forwarded[0].approval_id, 'allowed-once'), false);
});

test('the bridge registers outside the deployment UI forwarder', () => {
  const host = stubHost();
  const order = [];
  host.ctx.on('approval/request', async () => {
    order.push('ui');
    return 'rejected';
  });
  const bridge = createApprovalBridge(
    { canClaim: () => true, forward: async () => {}, confirmClaim: async () => true },
    SILENT,
  );
  attachApprovalBridge(host.ctx, bridge);
  const listeners = host.listeners();
  assert.equal(listeners.length, 2);
  assert.equal(listeners[0], bridge.listener, 'prepend must place the bridge outermost');
});

test('the claim path never calls next, and next is only used to delegate', () => {
  const source = readFileSync(new URL('../lib/host/approval.js', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('const listener = (request, next) =>'));
  const listenerBody = body.slice(0, body.indexOf('\n  return {'));
  const nextCalls = listenerBody.match(/next\?\.\(/g) ?? [];
  assert.equal(nextCalls.length, 1, 'exactly one delegation site, reached only before a UUID is minted');
  const claimStart = listenerBody.indexOf('const approvalId = randomUUID()');
  assert.ok(claimStart > 0);
  assert.ok(
    listenerBody.indexOf('next?.(') < claimStart,
    'delegation must happen before any claim state exists',
  );
});

test('no source file rewrites the approval policy or reads the audit log', () => {
  for (const relative of ['../lib/host/approval.js', '../lib/app/approvals.js']) {
    const source = readFileSync(new URL(relative, import.meta.url), 'utf8');
    for (const forbidden of ['setApprovalPolicy', 'setPolicy(', "on('approval/asked'", "on('approval/decided'"]) {
      assert.ok(!source.includes(forbidden), `${relative} must not contain ${forbidden}`);
    }
  }
});

/**
 * Import a host package, or report why it is unavailable.
 * @param {string} specifier - package name.
 * @returns {Promise<{module: object|null, reason: string|null}>} resolution.
 */
async function tryImport(specifier) {
  try {
    return { module: await import(specifier), reason: null };
  } catch (error) {
    return { module: null, reason: error.message };
  }
}

test('a never policy rejects in the host before the listener is reached', async (t) => {
  const cordis = await tryImport('@deepseek-ai/cordis');
  const approval = await tryImport('@deepseek-ai/dsh-user-approval');
  if (cordis.module === null || approval.module === null) {
    // No fabrication either way: without the real service this cannot be proven.
    t.skip(`real host packages unavailable (${cordis.reason ?? approval.reason})`);
    return;
  }
  const ctx = new cordis.module.Context();
  const bridge = createApprovalBridge(
    {
      canClaim: () => {
        throw new Error('the claim gate must never run under `never`');
      },
      forward: async () => {
        throw new Error('nothing may be forwarded under `never`');
      },
      confirmClaim: async () => true,
    },
    SILENT,
  );
  let seen = 0;
  ctx.on('approval/request', (request, next) => {
    seen += 1;
    return bridge.listener(request, next);
  });

  const service = new approval.module.ApprovalService(ctx, { policy: 'never' });
  const events = [];
  const session = {
    seq: 1,
    eventAt: () => ({ type: 'turn/start' }),
    append(type, data) {
      events.push({ type, data });
    },
  };
  const outcome = await service.request({ agent: { session }, toolName: 'bash' });
  assert.equal(outcome, 'rejected', 'the host denies before asking anyone');
  assert.equal(seen, 0, 'the bridge listener is not invoked under `never`');
  assert.equal(bridge.pending.size, 0);
  assert.deepEqual(events.map((entry) => entry.type), ['approval/asked', 'approval/decided']);
});

test('a claimed allow really becomes the host outcome through the real service', async (t) => {
  const cordis = await tryImport('@deepseek-ai/cordis');
  const approval = await tryImport('@deepseek-ai/dsh-user-approval');
  if (cordis.module === null || approval.module === null) {
    t.skip(`real host packages unavailable (${cordis.reason ?? approval.reason})`);
    return;
  }
  const ctx = new cordis.module.Context();
  const forwarded = [];
  const bridge = createApprovalBridge(
    {
      canClaim: (request) => request?.agent?.session?.id === 'session-real',
      forward: async (record) => forwarded.push(record),
      confirmClaim: async () => true,
    },
    SILENT,
  );
  attachApprovalBridge(ctx, bridge);
  let uiCalls = 0;
  ctx.on('approval/request', async () => {
    uiCalls += 1;
    return 'rejected';
  });

  const service = new approval.module.ApprovalService(ctx, { policy: 'ask' });
  const events = [];
  const session = {
    get id() {
      return 'session-real';
    },
    seq: 1,
    eventAt: () => ({ type: 'turn/start' }),
    append(type, data) {
      events.push({ type, data });
    },
  };
  const pending = service.request({ agent: { session }, toolName: 'bash', reason: 'needs a human' });
  await drain();
  assert.equal(forwarded.length, 1, 'the real request reached the peer');
  assert.equal(uiCalls, 0, 'the real UI listener was short-circuited');
  bridge.settleExternal(forwarded[0].approval_id, 'allowed-once');
  assert.equal(await pending, 'allowed-once', 'the host records the remote grant');
  const decided = events.find((entry) => entry.type === 'approval/decided');
  assert.equal(decided.data.outcome, 'allowed-once');
});

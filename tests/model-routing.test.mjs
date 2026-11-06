/**
 * Model routing tests (v0.3 R3/R4/R5).
 *
 * Three properties are asserted here, each at the boundary the implementation
 * actually uses:
 *
 *   - a delivery never reaches an agent without a route, and `session.create`
 *     still succeeds without one (R3);
 *   - a route change is applied through the host's mutable model-selection ref
 *     at `deliver()` — never by rewriting `agent.options`, never by cancelling a
 *     running turn (R4);
 *   - the policy leaves are volatile refs read per delivery, so an edit is
 *     effective on the next delivery without a plugin reload, and no ref is
 *     spread/clamped into the plain settings object (R5).
 * @module dsh-plugin-astrbot-bridge/tests/model-routing
 */

import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { Config, normaliseConfig } from '../lib/index.js';
import { AgentHost } from '../lib/host/agents.js';
import { NotifyService } from '../lib/app/notify.js';
import { TaskService } from '../lib/app/tasks.js';
import { BridgeStore } from '../lib/store.js';

/** A logger that records events instead of writing to the console. */
function recordingLogger() {
  /** @type {object[]} */
  const events = [];
  const push = (level) => (event, fields) => events.push({ level, event, ...(fields ?? {}) });
  /** @type {object} */
  const logger = {
    info: push('info'),
    warn: push('warn'),
    failure: push('failure'),
    debug: push('debug'),
    error: push('error'),
    events,
    child() {
      return logger;
    },
  };
  return logger;
}

/**
 * One agent-scoped context: enough for `installModelSelection` to register its
 * three listeners, and for a test to drive the assembly waterfall by hand.
 * @returns {object} agent context.
 */
function agentContext() {
  /** @type {Map<string, Function[]>} */
  const handlers = new Map();
  return {
    handlers,
    /**
     * @param {string} name - event name.
     * @param {Function} handler - listener.
     * @returns {Function} disposer.
     */
    on(name, handler) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
      return () => {
        const current = handlers.get(name) ?? [];
        handlers.set(
          name,
          current.filter((entry) => entry !== handler),
        );
      };
    },
  };
}

/**
 * Build one fake live agent.
 * @param {string} sessionId - session identity.
 * @param {object} agentOptions - route the registry was created with.
 * @returns {object} agent.
 */
function makeAgent(sessionId, agentOptions) {
  return {
    id: String(sessionId),
    options: agentOptions ?? {},
    ctx: agentContext(),
    status: 'idle',
    inbox: [],
    cancels: 0,
    followup(message) {
      this.inbox.push(message);
    },
    inject(message) {
      this.inbox.push(message);
    },
    steer(message) {
      this.inbox.push(message);
    },
    async whenIdle() {},
    cancel() {
      this.cancels += 1;
    },
  };
}

/**
 * Build a fake agent registry with the real create/resume signatures.
 * @returns {object} registry.
 */
function fakeRegistry() {
  /** @type {object[]} */
  const created = [];
  /** @type {object[]} */
  const resumed = [];
  /** @type {object[]} */
  const live = [];
  return {
    created,
    resumed,
    live,
    list: () => live,
    get: (id) => live.find((agent) => agent.id === String(id)),
    async create(options) {
      created.push(options);
      const agent = makeAgent(options.sessionId, options.agentOptions);
      live.push(agent);
      return {
        agent,
        dispose: async () => {
          const index = live.indexOf(agent);
          if (index >= 0) live.splice(index, 1);
        },
      };
    },
    async resume(options) {
      resumed.push(options);
      const agent = makeAgent(options.resumeSessionId, options.agentOptions);
      live.push(agent);
      return {
        agent,
        dispose: async () => {
          const index = live.indexOf(agent);
          if (index >= 0) live.splice(index, 1);
        },
      };
    },
  };
}

/**
 * Build the host context `AgentHost` reads.
 * @param {object} options - context options.
 * @param {object} options.registry - fake agent registry.
 * @param {object} [options.services] - optional host services.
 * @returns {object} context.
 */
function fakeHostContext(options) {
  const services = options.services ?? {};
  return {
    agents: options.registry,
    get(name) {
      return services[name] ?? null;
    },
  };
}

/**
 * Build an agent host wired to a fake registry and a fake working directory.
 * @param {object} [options] - world options.
 * @returns {Promise<object>} world.
 */
async function makeWorld(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'bridge-model-routing-'));
  const registry = options.registry ?? fakeRegistry();
  const services = { workingDirectory: { defaultDirectory: root }, ...(options.services ?? {}) };
  const logger = options.logger ?? recordingLogger();
  const host = new AgentHost({
    ctx: fakeHostContext({ registry, services }),
    logger,
    modelPolicy: options.modelPolicy,
  });
  return { root, registry, services, logger, host };
}

/** Read the value a volatile ref currently holds, via its private write symbol. */
function writeVolatile(ref, value) {
  const symbol = Object.getOwnPropertySymbols(ref).find((entry) => String(entry).includes('volatile.write'));
  assert.ok(symbol !== undefined, 'a volatile ref exposes its write symbol');
  ref[symbol](value);
}

/** Drive one listener chain the way the host waterfall would. */
async function assemble(agent) {
  const handlers = agent.ctx.handlers.get('system-prompt/assemble') ?? [];
  assert.ok(handlers.length > 0, 'the model selection must be installed on the agent context');
  let next = async () => ({ variables: {} });
  for (const handler of [...handlers].reverse()) {
    const inner = next;
    next = () => handler({}, {}, inner);
  }
  const assembled = await next();
  return assembled.variables;
}

/**
 * Drive the `agent/pre-step` listener chain installed by `installModelSelection`
 * and return the notice messages it contributes.
 *
 * The host only inserts the `[model changed: …]` notice from step 2 onward (at
 * step 1 an empty decision is skipped), so the default `step` here is 2.
 * @param {object} agent - fake agent whose context carries the listeners.
 * @param {object} previous - route of the persisted request header.
 * @param {number} [step] - proposed step number.
 * @returns {Promise<string[]>} notice texts.
 */
async function preStepNotices(agent, previous, step = 2) {
  agent.session = { requestHeader: () => ({ config: previous }) };
  const handlers = agent.ctx.handlers.get('agent/pre-step') ?? [];
  assert.ok(handlers.length > 0, 'the model selection must install its pre-step notice listener');
  let next = async () => ({ messages: [] });
  for (const handler of [...handlers].reverse()) {
    const inner = next;
    next = () => handler({ agent, messages: [], signal: { aborted: false }, step }, inner);
  }
  const decision = await next();
  return (decision.messages ?? []).map((message) => message.content?.[0]?.text ?? '');
}

/**
 * Build a task service on a temporary store with one authorized session.
 * @param {object} host - agent host (or a double).
 * @returns {Promise<object>} fixture.
 */
async function makeTasks(host) {
  const root = await mkdtemp(join(tmpdir(), 'bridge-model-routing-tasks-'));
  const store = new BridgeStore({ dataRoot: root });
  await store.init();
  await store.applyAuthz({
    version: 1,
    grants: [{ session_id: 's1', purpose: 'code-review', granted_by: 'human' }],
  });
  const session = {
    async emit() {},
    async call() {
      return {};
    },
  };
  const notify = new NotifyService({
    store,
    session,
    host,
    config: { wakeMaxChain: 8, wakeRatePerMinute: 10 },
    logger: null,
  });
  const tasks = new TaskService({
    store,
    session,
    host,
    notify,
    config: {
      wakeMaxChain: 8,
      wakeRatePerMinute: 10,
      imageMaxCount: 0,
      imageMaxBytes: 1,
      imageTotalMaxBytes: 1,
      imageAllowedMime: [],
    },
    logger: null,
  });
  return { root, store, session, tasks };
}

/** Submit one inbound task and wait until it reaches a terminal status. */
async function runTask(tasks, store, overrides = {}) {
  await tasks.submitInbound({
    task_id: '11111111-1111-4111-8111-111111111111',
    root_task_id: '11111111-1111-4111-8111-111111111111',
    kind: 'dsh_agent_run',
    origin: 'human',
    input_parts: [{ type: 'text', text: 'do the thing' }],
    attachments: [],
    tool_hints: [],
    session_id: 's1',
    purpose: 'code-review',
    timeout_s: 5,
    meta: {},
    approval_ref: null,
    ...overrides,
  });
  const deadline = Date.now() + 5_000;
  let task = null;
  while (Date.now() < deadline) {
    task = await store.getTask('11111111-1111-4111-8111-111111111111');
    if (task !== null && ['succeeded', 'failed', 'needs_human', 'rejected', 'canceled'].includes(task.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(task !== null, 'the task record must exist');
  return task;
}

test('R3: the host default model routes a new session and is reported as source=default', async () => {
  const world = await makeWorld({
    services: {
      agentDefaultModel: { currentSelection: () => ({ provider: 'host-provider', model: 'host-model', reasoningEffort: 'high' }) },
    },
  });
  const sessionId = await world.host.createSession({ sessionId: 's1', purpose: 'code-review' });
  assert.equal(sessionId, 's1');
  assert.deepEqual(world.registry.created[0].agentOptions, {
    provider: 'host-provider',
    model: 'host-model',
    reasoningEffort: 'high',
  });
  const created = world.logger.events.find((entry) => entry.event === 'agent_created');
  assert.equal(created.provider, 'host-provider');
  assert.equal(created.model, 'host-model');
  assert.equal(created.source, 'default');
  await world.host.dispose();
});

test('R3: the explicit override wins over the purpose map and the host default', async () => {
  const world = await makeWorld({
    services: {
      agentDefaultModel: { currentSelection: () => ({ provider: 'host-provider', model: 'host-model' }) },
    },
    modelPolicy: () => ({
      // `maxTokens` is not an accepted bridge field and must be dropped.
      override: { provider: 'override-provider', model: 'override-model', maxTokens: 4096 },
      byPurpose: { 'code-review': { provider: 'purpose-provider', model: 'purpose-model' } },
    }),
  });
  await world.host.createSession({ sessionId: 's1', purpose: 'code-review' });
  assert.deepEqual(world.registry.created[0].agentOptions, {
    provider: 'override-provider',
    model: 'override-model',
  });
  const created = world.logger.events.find((entry) => entry.event === 'agent_created');
  assert.equal(created.source, 'override');
  await world.host.dispose();
});

test('R3: the purpose map is used when the override is unset', async () => {
  const world = await makeWorld({
    modelPolicy: () => ({
      override: null,
      byPurpose: { 'code-review': { provider: 'purpose-provider', model: 'purpose-model' } },
    }),
  });
  await world.host.createSession({ sessionId: 's1', purpose: 'code-review' });
  assert.deepEqual(world.registry.created[0].agentOptions, {
    provider: 'purpose-provider',
    model: 'purpose-model',
  });
  assert.equal(world.logger.events.find((entry) => entry.event === 'agent_created').source, 'purpose');
  await world.host.dispose();
});

test('R3: no resolvable route fails the task at the delivery boundary with no_model_route', async () => {
  const world = await makeWorld();
  const fixture = await makeTasks(world.host);
  try {
    const task = await runTask(fixture.tasks, fixture.store);
    assert.equal(task.status, 'failed', 'a task with no route must not claim success');
    assert.equal(task.error.code, 'capability_unavailable');
    assert.equal(task.error.details.reason, 'no_model_route');
    assert.equal(world.registry.resumed.length, 0, 'no agent may be driven without a route');
    assert.equal(world.registry.created.length, 0, 'no agent may be created without a route');
  } finally {
    await world.host.dispose();
    await fixture.store.close();
  }
});

test('R3: createSession still succeeds when no route can be resolved', async () => {
  const world = await makeWorld();
  const sessionId = await world.host.createSession({ sessionId: 's1' });
  assert.equal(sessionId, 's1');
  assert.equal(world.registry.created.length, 1, 'session.create must not fail on a profile without a default model');
  assert.equal(
    Object.hasOwn(world.registry.created[0], 'agentOptions'),
    false,
    'an empty agentOptions must never be sent',
  );
  await world.host.dispose();
});

test('R4: deliver refreshes the selection ref, never the agent options, and never cancels', async () => {
  const world = await makeWorld({ modelPolicy: () => ({ override: null, byPurpose: {} }) });
  await world.host.createSession({
    sessionId: 's1',
    agentOptions: { provider: 'first-provider', model: 'first-model' },
  });
  const agent = world.registry.live[0];

  // The next delivery resolves a different route (a live policy edit).
  world.host.modelPolicy = () => ({ override: { provider: 'second-provider', model: 'second-model' }, byPurpose: {} });
  const report = await world.host.deliver({ sessionId: 's1', text: 'next round', wake: true });

  assert.equal(report.strategy, 'followup');
  assert.deepEqual(agent.options, { provider: 'first-provider', model: 'first-model' }, 'agent.options is not the switch surface');
  assert.equal(agent.cancels, 0, 'a route change must not cancel the running turn');
  assert.equal(agent.inbox.length, 1, 'the delivery still reached the agent');
  const selection = world.host._selections.get('s1');
  assert.equal(selection.ref.current.provider, 'second-provider', 'the selection ref carries the new route');
  assert.equal(selection.ref.current.model, 'second-model');
  const variables = await assemble(agent);
  assert.equal(variables.provider, 'second-provider', 'the installed selection overrides the prompt variables');
  assert.equal(variables.model, 'second-model');
  await world.host.dispose();
});

test('R4: a running turn is steered, not cancelled, when the route changes', async () => {
  const world = await makeWorld({ modelPolicy: () => ({ override: { provider: 'p1', model: 'm1' }, byPurpose: {} }) });
  await world.host.createSession({ sessionId: 's1', purpose: 'code-review' });
  const agent = world.registry.live[0];
  agent.status = 'running';

  world.host.modelPolicy = () => ({ override: { provider: 'p2', model: 'm2' }, byPurpose: {} });
  const report = await world.host.deliver({ sessionId: 's1', text: 'mid-turn input', wake: true });

  assert.equal(report.strategy, 'steer');
  assert.equal(agent.cancels, 0);
  assert.equal(world.host._selections.get('s1').ref.current.provider, 'p2');
  assert.equal(agent.options.provider, 'p1', 'the live agent keeps its creation options');
  await world.host.dispose();
});

test('R4: a failed refresh keeps the previous route and warns instead of failing the task', async () => {
  const world = await makeWorld({
    modelPolicy: () => {
      throw new Error('policy reader exploded');
    },
  });
  await world.host.createSession({
    sessionId: 's1',
    agentOptions: { provider: 'kept-provider', model: 'kept-model' },
  });
  const agent = world.registry.live[0];
  const report = await world.host.deliver({ sessionId: 's1', text: 'still deliver', wake: true });

  assert.equal(report.strategy, 'followup');
  assert.equal(world.host._selections.get('s1').ref.current.provider, 'kept-provider');
  assert.equal(agent.inbox.length, 1, 'the task was not interrupted');
  assert.ok(
    world.logger.events.some((entry) => entry.event === 'model_route_refresh_failed' && entry.level === 'warn'),
    'the failed refresh is reported',
  );
  await world.host.dispose();
});

test('R5: the policy leaves are volatile refs and are not spread into the settings object', async () => {
  const parsed = Config({});
  assert.equal(typeof parsed.modelOverride?.get, 'function', 'modelOverride must be a volatile ref');
  assert.equal(typeof parsed.modelByPurpose?.get, 'function', 'modelByPurpose must be a volatile ref');
  assert.deepEqual(parsed.modelOverride.get(), { provider: '', model: '', reasoningEffort: '' });
  assert.deepEqual(parsed.modelByPurpose.get(), {});

  const settings = normaliseConfig(
    Config({ modelOverride: { provider: 'vp', model: 'vm' }, modelByPurpose: { 'code-review': { provider: 'pp', model: 'pm' } } }),
  );
  assert.equal(Object.hasOwn(settings, 'modelOverride'), false, 'a volatile ref must never be spread into settings');
  assert.equal(Object.hasOwn(settings, 'modelByPurpose'), false);

  // Half-filled policies are not routes; creation falls back instead of
  // forwarding a provider without a model.
  const half = await makeWorld({ modelPolicy: () => ({ override: { provider: 'only-provider' }, byPurpose: {} }) });
  await half.host.createSession({ sessionId: 's1' });
  assert.equal(
    Object.hasOwn(half.registry.created[0], 'agentOptions'),
    false,
    'a half-filled override is not a route',
  );
  await half.host.dispose();
});

test('R4/L-2: a cold resume installs the selection, and an unchanged route emits no notice', async () => {
  const world = await makeWorld({
    services: {
      agentDefaultModel: { currentSelection: () => ({ provider: 'host-provider', model: 'host-model' }) },
    },
  });
  const agent = await world.host.resumeSession('s1');
  assert.ok(
    world.host._selections.has('s1'),
    'resume must install the selection immediately, not wait for the first delivery',
  );

  // The route the session was resumed with is already assembled, so the host
  // must not manufacture a "model changed" notice for a switch that never
  // happened.
  const variables = await assemble(agent);
  assert.equal(variables.provider, 'host-provider');
  const unchanged = await preStepNotices(agent, { provider: 'host-provider', model: 'host-model' });
  assert.deepEqual(unchanged, []);

  // Positive control: a real route change is still announced, so the empty
  // result above is not the test passing vacuously.
  world.host._selections.get('s1').ref.current = { provider: 'next-provider', model: 'next-model' };
  await assemble(agent);
  const changed = await preStepNotices(agent, { provider: 'host-provider', model: 'host-model' });
  assert.equal(changed.length, 1, 'a real model change must still be announced');
  assert.match(changed[0], /^\[model changed: .*host-provider\/host-model.*next-provider\/next-model\]$/);
  await world.host.dispose();
});

test('R5: a policy edit is visible to the next delivery without any reload', async () => {
  const parsed = Config({ modelOverride: { provider: 'before-provider', model: 'before-model' } });
  const world = await makeWorld({
    modelPolicy: () => ({
      override: parsed.modelOverride.get(),
      byPurpose: parsed.modelByPurpose.get(),
    }),
  });
  await world.host.createSession({ sessionId: 's1' });
  const agent = world.registry.live[0];
  assert.equal(world.host._selections.get('s1').ref.current.provider, 'before-provider');

  // Same host, same agent, same plugin lifetime: only the ref changed.
  writeVolatile(parsed.modelOverride, { provider: 'after-provider', model: 'after-model', reasoningEffort: '' });
  await world.host.deliver({ sessionId: 's1', text: 'next round', wake: true });

  assert.equal(world.host._selections.get('s1').ref.current.provider, 'after-provider');
  assert.equal(world.registry.created.length, 1, 'no session was recreated and nothing was reloaded');
  const variables = await assemble(agent);
  assert.equal(variables.provider, 'after-provider');
  assert.equal(variables.model, 'after-model');
  await world.host.dispose();
});

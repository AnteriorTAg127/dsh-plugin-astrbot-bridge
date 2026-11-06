/**
 * Turn-failure tests (v0.3 R6).
 *
 * `whenIdle()` cannot report a failure: the agent loop catches the turn error
 * in `kick()` and still reports idle. The only evidence is the host's
 * `agent/error` event and the durable `turn/start`, `assistant/message` and
 * `turn/end` events replayed on `session/event`, so these tests drive a real
 * `AgentHost` over a small event bus and assert the task verdict at the task
 * boundary:
 *
 *   - a failed turn is `failed` (`agent_turn_failed`);
 *   - an unattributable turn is `needs_human`, never `succeeded`;
 *   - a completed turn with assistant text is `succeeded` and its
 *     `result.text` is exactly that text;
 *   - a completed turn with no assistant text is `needs_human`
 *     (`agent_output_missing`), never `succeeded`;
 *   - a `turn/end` from a previous turn cannot decide this delivery;
 *   - a host double that does not implement the probe keeps the old success path.
 * @module dsh-plugin-astrbot-bridge/tests/turn-failure
 */

import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { AgentHost } from '../lib/host/agents.js';
import { NotifyService } from '../lib/app/notify.js';
import { TaskService } from '../lib/app/tasks.js';
import { BridgeStore } from '../lib/store.js';

/** Task id shared by every case; each case uses its own temporary store. */
const TASK_ID = '11111111-1111-4111-8111-111111111111';

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
 * Build a host context with or without an event bus.
 * @param {object} options - context options.
 * @param {object} options.registry - fake agent registry.
 * @param {boolean} [options.withEvents] - whether `ctx.on` exists.
 * @returns {object} context.
 */
function fakeHostContext(options) {
  /** @type {Map<string, Function[]>} */
  const bus = new Map();
  const services = options.services ?? {};
  const ctx = {
    agents: options.registry,
    get(name) {
      return services[name] ?? null;
    },
    bus,
    /** Fire one host event. */
    emit(name, ...args) {
      for (const handler of bus.get(name) ?? []) handler(...args);
    },
  };
  if (options.withEvents === false) return ctx;
  ctx.on = (name, handler) => {
    const list = bus.get(name) ?? [];
    list.push(handler);
    bus.set(name, list);
    return () => {
      bus.set(
        name,
        (bus.get(name) ?? []).filter((entry) => entry !== handler),
      );
    };
  };
  return ctx;
}

/**
 * Build the host world: fake registry, event bus and a real `AgentHost`.
 *
 * The agent's `followup()` is the hook a test uses to publish the events that
 * belong to the turn it just started, which is exactly the window the real
 * host reports them in.
 * @param {object} [options] - world options.
 * @param {boolean} [options.withEvents] - whether the context has an event bus.
 * @param {Function} [options.onFollowup] - called with the agent that was woken.
 * @returns {Promise<object>} world.
 */
async function makeWorld(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'bridge-turn-failure-'));
  /** @type {object[]} */
  const live = [];
  const registry = {
    live,
    list: () => live,
    get: (id) => live.find((agent) => agent.id === String(id)),
    async create(input) {
      const agent = {
        id: String(input.sessionId),
        options: input.agentOptions ?? {},
        status: 'idle',
        inbox: [],
        cancels: 0,
        followup(message) {
          this.inbox.push(message);
          options.onFollowup?.(this);
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
      live.push(agent);
      return {
        agent,
        dispose: async () => {
          const index = live.indexOf(agent);
          if (index >= 0) live.splice(index, 1);
        },
      };
    },
    async resume() {
      throw new Error('resume is not used by this suite');
    },
  };
  const ctx = fakeHostContext({
    registry,
    withEvents: options.withEvents,
    services: { workingDirectory: { defaultDirectory: root } },
  });
  const host = new AgentHost({ ctx, logger: recordingLogger() });
  const sessionId = await host.createSession({
    sessionId: 's1',
    agentOptions: { provider: 'test-provider', model: 'test-model' },
  });
  return { root, registry, ctx, host, sessionId };
}

/**
 * Build a task service on a temporary store with one authorized session.
 * @param {object} host - agent host (or double).
 * @returns {Promise<object>} fixture.
 */
async function makeTasks(host) {
  const root = await mkdtemp(join(tmpdir(), 'bridge-turn-failure-tasks-'));
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
async function runTask(tasks, store) {
  await tasks.submitInbound({
    task_id: TASK_ID,
    root_task_id: TASK_ID,
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
  });
  const deadline = Date.now() + 5_000;
  let task = null;
  while (Date.now() < deadline) {
    task = await store.getTask(TASK_ID);
    if (task !== null && ['succeeded', 'failed', 'needs_human', 'rejected', 'canceled'].includes(task.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(task !== null, 'the task record must exist');
  return task;
}

test('R6: an agent/error raised by the delivered turn fails the task with agent_turn_failed', async () => {
  const world = await makeWorld({
    onFollowup: (agent) => {
      world.ctx.emit('agent/error', {
        agent,
        turn: 1,
        step: 1,
        error: { code: 'PROVIDER_ERROR', message: 'provider refused the request' },
      });
    },
  });
  const fixture = await makeTasks(world.host);
  try {
    const task = await runTask(fixture.tasks, fixture.store);
    assert.equal(task.status, 'failed', 'a failed turn must never be reported as success');
    assert.equal(task.error.code, 'agent_turn_failed');
    assert.equal(task.error.details.code, 'PROVIDER_ERROR');
    assert.equal(task.needs_human, false);
  } finally {
    await world.host.dispose();
    await fixture.store.close();
  }
});

test('R6: a turn/end error replayed on session/event fails the task', async () => {
  const world = await makeWorld({
    onFollowup: () => {
      world.ctx.emit('session/event', { id: 's1' }, { type: 'turn/start', seq: 5, time: 0, data: { turn: 1 } });
      world.ctx.emit(
        'session/event',
        { id: 's1' },
        {
          type: 'turn/end',
          seq: 7,
          time: 0,
          data: { turn: 1, reason: { kind: 'error', error: { code: 'NO_ADAPTER', message: 'no adapter' } } },
        },
      );
    },
  });
  const fixture = await makeTasks(world.host);
  try {
    const task = await runTask(fixture.tasks, fixture.store);
    assert.equal(task.status, 'failed');
    assert.equal(task.error.code, 'agent_turn_failed');
    assert.equal(task.error.details.turn, 1);
  } finally {
    await world.host.dispose();
    await fixture.store.close();
  }
});

test('R6: a completed turn with assistant text succeeds and carries result.text', async () => {
  const world = await makeWorld({
    onFollowup: () => {
      world.ctx.emit('session/event', { id: 's1' }, { type: 'turn/start', seq: 5, time: 0, data: { turn: 1 } });
      world.ctx.emit(
        'session/event',
        { id: 's1' },
        {
          type: 'assistant/message',
          seq: 6,
          time: 0,
          data: {
            turn: 1,
            step: 1,
            message: { role: 'assistant', content: [{ type: 'text', text: 'the answer' }] },
          },
        },
      );
      world.ctx.emit(
        'session/event',
        { id: 's1' },
        { type: 'turn/end', seq: 9, time: 0, data: { turn: 1, reason: { kind: 'completed' } } },
      );
    },
  });
  const fixture = await makeTasks(world.host);
  try {
    const task = await runTask(fixture.tasks, fixture.store);
    assert.equal(task.status, 'succeeded');
    assert.equal(task.error, null);
    assert.equal(task.needs_human, false);
    assert.equal(task.result.text, 'the answer', 'the extracted assistant text is the task result');
    assert.notEqual(task.result.text, '', 'a succeeded task must not carry an empty answer');
    assert.deepEqual(task.result.degraded, []);
  } finally {
    await world.host.dispose();
    await fixture.store.close();
  }
});

test('R6: only the last assistant message in the turn is the answer', async () => {
  const world = await makeWorld({
    onFollowup: () => {
      world.ctx.emit('session/event', { id: 's1' }, { type: 'turn/start', seq: 5, time: 0, data: { turn: 1 } });
      world.ctx.emit(
        'session/event',
        { id: 's1' },
        {
          type: 'assistant/message',
          seq: 6,
          time: 0,
          data: {
            turn: 1,
            step: 1,
            message: {
              role: 'assistant',
              content: [
                { type: 'text', text: 'I will inspect the file' },
                { type: 'tool-call', callId: 'c1', name: 'read', arguments: {} },
              ],
            },
          },
        },
      );
      world.ctx.emit(
        'session/event',
        { id: 's1' },
        {
          type: 'assistant/message',
          seq: 8,
          time: 0,
          data: {
            turn: 1,
            step: 2,
            // Two text blocks in the final message are concatenated verbatim.
            message: {
              role: 'assistant',
              content: [
                { type: 'text', text: 'final ' },
                { type: 'text', text: 'answer' },
              ],
            },
          },
        },
      );
      world.ctx.emit(
        'session/event',
        { id: 's1' },
        { type: 'turn/end', seq: 9, time: 0, data: { turn: 1, reason: { kind: 'completed' } } },
      );
    },
  });
  const fixture = await makeTasks(world.host);
  try {
    const task = await runTask(fixture.tasks, fixture.store);
    assert.equal(task.status, 'succeeded');
    assert.equal(task.result.text, 'final answer', 'intermediate tool-step text is not concatenated');
  } finally {
    await world.host.dispose();
    await fixture.store.close();
  }
});

test('R6: a completed turn without assistant text parks for a human', async () => {
  const world = await makeWorld({
    onFollowup: () => {
      world.ctx.emit('session/event', { id: 's1' }, { type: 'turn/start', seq: 5, time: 0, data: { turn: 1 } });
      world.ctx.emit(
        'session/event',
        { id: 's1' },
        { type: 'turn/end', seq: 9, time: 0, data: { turn: 1, reason: { kind: 'completed' } } },
      );
    },
  });
  const fixture = await makeTasks(world.host);
  try {
    const task = await runTask(fixture.tasks, fixture.store);
    assert.equal(task.status, 'needs_human', 'an empty answer is not an earned success');
    assert.equal(task.error.code, 'agent_output_missing');
    assert.equal(task.error.details.turn, 1);
    assert.equal(task.needs_human, true);
    assert.equal(task.result, null);
  } finally {
    await world.host.dispose();
    await fixture.store.close();
  }
});

test('R6: a text-less final assistant message does not fall back to tool-step text', async () => {
  const world = await makeWorld({
    onFollowup: () => {
      world.ctx.emit('session/event', { id: 's1' }, { type: 'turn/start', seq: 5, time: 0, data: { turn: 1 } });
      world.ctx.emit(
        'session/event',
        { id: 's1' },
        {
          type: 'assistant/message',
          seq: 6,
          time: 0,
          data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'intermediate' }] } },
        },
      );
      world.ctx.emit(
        'session/event',
        { id: 's1' },
        {
          type: 'assistant/message',
          seq: 8,
          time: 0,
          data: {
            turn: 1,
            step: 2,
            message: { content: [{ type: 'tool-call', callId: 'c1', name: 'read', arguments: {} }] },
          },
        },
      );
      world.ctx.emit(
        'session/event',
        { id: 's1' },
        { type: 'turn/end', seq: 9, time: 0, data: { turn: 1, reason: { kind: 'completed' } } },
      );
    },
  });
  const fixture = await makeTasks(world.host);
  try {
    const task = await runTask(fixture.tasks, fixture.store);
    assert.equal(task.status, 'needs_human');
    assert.equal(task.error.code, 'agent_output_missing');
    assert.equal(task.needs_human, true);
  } finally {
    await world.host.dispose();
    await fixture.store.close();
  }
});

test('R6: a previous turn\'s turn/end cannot decide this delivery', async () => {
  const world = await makeWorld({
    onFollowup: () => {
      // The delivery opens turn 2 and answers it...
      world.ctx.emit('session/event', { id: 's1' }, { type: 'turn/start', seq: 20, time: 0, data: { turn: 2 } });
      // ...a stale assistant message from turn 1 must not replace the answer...
      world.ctx.emit(
        'session/event',
        { id: 's1' },
        {
          type: 'assistant/message',
          seq: 21,
          time: 0,
          data: { turn: 1, step: 3, message: { content: [{ type: 'text', text: 'stale answer' }] } },
        },
      );
      world.ctx.emit(
        'session/event',
        { id: 's1' },
        {
          type: 'assistant/message',
          seq: 22,
          time: 0,
          data: { turn: 2, step: 1, message: { content: [{ type: 'text', text: 'fresh answer' }] } },
        },
      );
      world.ctx.emit(
        'session/event',
        { id: 's1' },
        { type: 'turn/end', seq: 23, time: 0, data: { turn: 2, reason: { kind: 'completed' } } },
      );
      // ...and a late turn/end from turn 1 (delivery race, M-4) must be ignored.
      world.ctx.emit(
        'session/event',
        { id: 's1' },
        {
          type: 'turn/end',
          seq: 24,
          time: 0,
          data: { turn: 1, reason: { kind: 'error', error: { code: 'STALE', message: 'previous turn' } } },
        },
      );
    },
  });
  const fixture = await makeTasks(world.host);
  try {
    const task = await runTask(fixture.tasks, fixture.store);
    assert.equal(task.status, 'succeeded', 'the stale turn/end must not fail the delivery');
    assert.equal(task.result.text, 'fresh answer');
  } finally {
    await world.host.dispose();
    await fixture.store.close();
  }
});

test('R6: an error followed by a completed retry is not a task failure', async () => {
  const world = await makeWorld({
    onFollowup: (agent) => {
      world.ctx.emit('agent/error', { agent, turn: 1, step: 1, error: { code: 'TRANSIENT', message: 'retry' } });
      world.ctx.emit('session/event', { id: 's1' }, { type: 'turn/start', seq: 10, time: 0, data: { turn: 1 } });
      world.ctx.emit(
        'session/event',
        { id: 's1' },
        {
          type: 'assistant/message',
          seq: 11,
          time: 0,
          data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'recovered' }] } },
        },
      );
      world.ctx.emit(
        'session/event',
        { id: 's1' },
        { type: 'turn/end', seq: 12, time: 0, data: { turn: 1, reason: { kind: 'completed' } } },
      );
    },
  });
  const fixture = await makeTasks(world.host);
  try {
    const task = await runTask(fixture.tasks, fixture.store);
    assert.equal(task.status, 'succeeded', 'only the final turn verdict is terminal');
    assert.equal(task.result.text, 'recovered');
  } finally {
    await world.host.dispose();
    await fixture.store.close();
  }
});

test('R6: an unattributable turn never succeeds — the task parks for a human', async () => {
  // The event bus is mounted but nothing closes the turn, so the bridge cannot
  // prove the turn succeeded. It must not guess.
  const world = await makeWorld();
  const fixture = await makeTasks(world.host);
  try {
    const task = await runTask(fixture.tasks, fixture.store);
    assert.equal(task.status, 'needs_human');
    assert.equal(task.error.code, 'agent_outcome_unknown');
    assert.equal(task.needs_human, true);
  } finally {
    await world.host.dispose();
    await fixture.store.close();
  }
});

test('R6: a host without an event bus is treated as unattributable, not successful', async () => {
  const world = await makeWorld({ withEvents: false });
  const fixture = await makeTasks(world.host);
  try {
    const task = await runTask(fixture.tasks, fixture.store);
    assert.equal(task.status, 'needs_human');
    assert.equal(task.error.code, 'agent_outcome_unknown');
    assert.equal(task.error.details.reason, 'event_tracking_unavailable');
  } finally {
    await world.host.dispose();
    await fixture.store.close();
  }
});

test('R6: a host double without the outcome probe keeps the pre-v0.3 success path', async () => {
  const deliveries = [];
  const host = {
    listSessions: () => [{ session_id: 's1', state: 'idle' }],
    async deliver(input) {
      deliveries.push(input);
      return { strategy: 'followup', session_id: input.sessionId, degraded: [] };
    },
    async waitIdle() {
      return true;
    },
    cancel: () => true,
  };
  const fixture = await makeTasks(host);
  try {
    const task = await runTask(fixture.tasks, fixture.store);
    assert.equal(task.status, 'succeeded');
    assert.equal(deliveries.length, 1);
  } finally {
    await fixture.store.close();
  }
});

test('R6: the delivery carries the task purpose so the route map can use it', async () => {
  const deliveries = [];
  const host = {
    listSessions: () => [{ session_id: 's1', state: 'idle' }],
    async deliver(input) {
      deliveries.push(input);
      return { strategy: 'followup', session_id: input.sessionId, degraded: [] };
    },
    async waitIdle() {
      return true;
    },
    cancel: () => true,
    takeTurnOutcome: () => ({ kind: 'ok', turn: 1, text: 'done' }),
  };
  const fixture = await makeTasks(host);
  try {
    await runTask(fixture.tasks, fixture.store);
    assert.equal(deliveries[0].purpose, 'code-review');
  } finally {
    await fixture.store.close();
  }
});

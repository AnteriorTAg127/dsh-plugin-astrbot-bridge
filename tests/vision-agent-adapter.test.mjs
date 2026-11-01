/**
 * Vision delivery and agent-creation wiring against the **real** host API
 * surface (protocol §13.5, §9.7).
 *
 * The previous adapter read `route.modalities` off `agent.options`, but the real
 * `AgentOptions` is only `{provider, model, reasoningEffort, maxTokens}`, so that
 * check could never be true and every image was silently degraded. Likewise
 * `create` was called with `meta.cwd: undefined`, although `CreateAgentOptions`
 * documents a validated absolute `cwd`. Both defects are invisible to a suite
 * that hand-builds objects with invented fields, so this file asserts against
 * the real types instead:
 *
 *   - `AgentHost` is the real exported adapter (`lib/host/agents.js`);
 *   - the LLM authority is the real `LlmRuntime` from `@deepseek-ai/dsh-llm`
 *     with a real `LlmAdapter` subclass, queried through
 *     `resolveModelInfo()` / `inputModalities`;
 *   - the workspace authority is the real `@deepseek-ai/dsh-fs-local`
 *     filesystem (and a `workingDirectory` service with the real
 *     `defaultDirectory` field shape);
 *   - the created session metadata is validated by the real
 *     `@deepseek-ai/dsh-session` store, which rejects a non-absolute `cwd`;
 *   - delivered messages are the real `createUserMessage` output.
 *
 * No real provider is called: the adapter only answers capability metadata, and
 * `AgentHost.deliver` is asserted through the live agent's inbox methods.
 * @module dsh-plugin-astrbot-bridge/tests/vision-agent-adapter
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { Context, Service } from '@deepseek-ai/cordis';
import { LlmAdapter, LlmRuntime } from '@deepseek-ai/dsh-llm';
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local';
import SessionStore from '@deepseek-ai/dsh-session';

import { AgentHost } from '../lib/host/agents.js';
import { VisionCapability, visionCapabilityOf } from '../lib/host/llm.js';

/** Silent logger so capability warnings do not pollute test output. */
const SILENT = Object.freeze({
  info() {},
  warn() {},
  failure() {},
  debug() {},
  error() {},
  child() {
    return SILENT;
  },
});

/** One `ImageAttachmentRef` with the real field shape (no invented keys). */
const IMAGE_REF = Object.freeze({
  attachmentId: 'att-1',
  mediaType: 'image/png',
  bytes: 70,
  width: 1,
  height: 1,
});

/**
 * Real `LlmAdapter` subclass that only answers exact-model capability metadata.
 *
 * `resolveModel` is the documented capability query; `stream` must exist because
 * it is the adapter's one abstract method, but nothing here calls a provider.
 */
class CapabilityAdapter extends LlmAdapter {
  /**
   * @param {Map<string, object>} models - model id → resolved metadata (or an Error to throw).
   */
  constructor(models) {
    super();
    this.models = models;
    /** @type {string[]} every (provider, model) pair that was queried. */
    this.queries = [];
  }

  /** @returns {Promise<never[]>} empty advisory catalog. */
  async listModels() {
    return [];
  }

  /**
   * Resolve one exact model's metadata.
   * @param {string} provider - provider route.
   * @param {string} model - model id.
   * @returns {Promise<object>} `LlmResolvedModelInfo`.
   */
  async resolveModel(provider, model) {
    this.queries.push(`${provider}/${model}`);
    const entry = this.models.get(model);
    if (entry instanceof Error) throw entry;
    if (entry === undefined) {
      // An adapter miss is a real error type in the host, not `undefined`.
      throw new Error(`unknown model "${model}"`);
    }
    return { provider, id: model, name: model, ...entry };
  }

  /** @returns {AsyncIterable<never>} unused by these tests. */
  async *stream() {}
}

/**
 * `ctx.agents` double in the real registry shape.
 *
 * `create` runs the real session store's `prepare()` on the supplied metadata,
 * so a missing or relative `cwd` fails exactly as it would in the host instead
 * of being papered over by the double.
 */
class AgentsDouble extends Service {
  /**
   * @param {Context} ctx - owning context.
   * @param {object} sessions - real `SessionStore`.
   */
  constructor(ctx, sessions) {
    super(ctx, 'agents');
    this.sessions = sessions;
    /** @type {object[]} */
    this.created = [];
    /** @type {object[]} created agents, live in the registry. */
    this.live = [];
    /** Creation failure injected for the "host refuses" case. */
    this.createError = undefined;
  }

  /** @returns {object[]} live agents in the real registry shape. */
  list() {
    return this.live;
  }

  /**
   * @param {string} id - session id.
   * @returns {object|undefined} live agent.
   */
  get(id) {
    return this.live.find((agent) => agent.id === id);
  }

  /**
   * Create one agent; validates `meta` through the real session store.
   * @param {object} options - real `CreateAgentOptions`.
   * @returns {Promise<{agent: object, dispose: Function}>} handle.
   */
  async create(options) {
    if (this.createError !== undefined) throw this.createError;
    // Real header validation: `meta.cwd`, when present, must be absolute.
    const session = this.sessions.prepare(String(options.sessionId), {
      ...(options.meta === undefined ? {} : { meta: options.meta }),
    });
    const agent = {
      id: String(options.sessionId),
      options: options.agentOptions ?? {},
      session,
      status: 'idle',
      /** @type {object[]} messages received through any inbox method. */
      inbox: [],
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
      cancel() {},
    };
    this.created.push({ options, session });
    this.live.push(agent);
    return {
      agent,
      dispose: async () => {
        this.live = this.live.filter((entry) => entry !== agent);
      },
    };
  }

  /**
   * Resume is not exercised here; the adapter's cold path is covered elsewhere.
   * @returns {Promise<never>} always rejects.
   */
  async resume() {
    throw new Error('no persistence in this suite');
  }
}

/** `workingDirectory` in the real service's public field shape. */
class WorkingDirectoryDouble extends Service {
  /**
   * @param {Context} ctx - owning context.
   * @param {string} defaultDirectory - absolute deployment fallback.
   */
  constructor(ctx, defaultDirectory) {
    super(ctx, 'workingDirectory');
    /** Absolute execution-world fallback, exactly as the real service exposes it. */
    this.defaultDirectory = defaultDirectory;
  }
}

/**
 * Mount one host world: real LLM runtime, real session store, real filesystem,
 * and the agent registry double.
 * @param {object} options - world options.
 * @param {object} [options.models] - model id → capability metadata or Error.
 * @param {boolean} [options.withWorkspace] - mount `workingDirectory`.
 * @param {boolean} [options.withFs] - mount the real local filesystem.
 * @param {boolean} [options.withLlm] - mount the real LLM runtime.
 * @returns {Promise<object>} mounted world.
 */
async function mountWorld(options = {}) {
  const workspace = await mkdtemp(join(tmpdir(), 'bridge-vision-'));
  const app = new Context();
  const sessions = new SessionStore(app);
  const adapter = new CapabilityAdapter(new Map(Object.entries(options.models ?? {})));
  const agents = new AgentsDouble(app, sessions);
  let llm;
  if (options.withLlm !== false) {
    llm = new LlmRuntime(app);
    llm.registerAdapter(['vision-provider'], adapter);
  }
  if (options.withWorkspace !== false) new WorkingDirectoryDouble(app, workspace);
  const fs =
    options.withFs === false
      ? undefined
      : new LocalFileSystem(app, { cwd: workspace, diffBasisMaxBytes: 1 << 20 });
  const host = new AgentHost({ ctx: app, logger: SILENT });
  return {
    app,
    sessions,
    adapter,
    agents,
    fs,
    llm,
    workspace,
    host,
    /**
     * Tear the world down and remove its temporary directory.
     * @returns {Promise<void>} completion.
     */
    async dispose() {
      await rm(workspace, { recursive: true, force: true });
    },
  };
}

test('a route that declares the image input modality keeps real image blocks', async () => {
  const world = await mountWorld({ models: { 'vision-model': { inputModalities: ['text', 'image'] } } });
  try {
    const sessionId = await world.host.createSession({
      sessionId: 's-vision',
      agentOptions: { provider: 'vision-provider', model: 'vision-model' },
    });
    const result = await world.host.deliver({
      sessionId,
      text: 'look at this',
      images: [IMAGE_REF],
      wake: true,
    });

    assert.deepEqual(result.degraded, [], 'a vision route must not report a degradation');
    assert.deepEqual(world.adapter.queries, ['vision-provider/vision-model'], 'capability comes from the real LLM registry');
    const agent = world.agents.get(sessionId);
    const message = agent.inbox[0];
    assert.equal(message.content.length, 2);
    assert.equal(message.content[0].type, 'text');
    assert.equal(message.content[1].type, 'image', 'the image block must survive delivery');
    // The real message factory deep-clones the reference, so identity is by value.
    assert.deepEqual(message.content[1].attachment, IMAGE_REF, 'the exact attachment is retained');
    assert.ok(Object.isFrozen(message), 'the host message factory freezes the value');
  } finally {
    await world.dispose();
  }
});

test('an explicit text-only modality declaration degrades the image and says why', async () => {
  const world = await mountWorld({ models: { 'text-model': { inputModalities: ['text'] } } });
  try {
    const sessionId = await world.host.createSession({
      sessionId: 's-text',
      agentOptions: { provider: 'vision-provider', model: 'text-model' },
    });
    const result = await world.host.deliver({
      sessionId,
      text: 'look at this',
      images: [IMAGE_REF],
      wake: true,
    });

    assert.deepEqual(result.degraded, ['model_without_vision']);
    const message = world.agents.get(sessionId).inbox[0];
    assert.equal(message.content.length, 2, 'the image is replaced, never dropped');
    assert.equal(message.content[1].type, 'text');
    assert.match(message.content[1].text, /image omitted/);
  } finally {
    await world.dispose();
  }
});

test('an unknown capability (no declared modalities) fails closed as text', async () => {
  const world = await mountWorld({ models: { 'mystery-model': {} } });
  try {
    const sessionId = await world.host.createSession({
      sessionId: 's-unknown',
      agentOptions: { provider: 'vision-provider', model: 'mystery-model' },
    });
    const result = await world.host.deliver({
      sessionId,
      text: 'look at this',
      images: [IMAGE_REF],
      wake: true,
    });

    assert.deepEqual(result.degraded, ['model_without_vision'], 'absence of a declaration is never treated as vision');
    assert.equal(world.agents.get(sessionId).inbox[0].content[1].type, 'text');
  } finally {
    await world.dispose();
  }
});

test('a failed capability resolution fails closed instead of claiming vision', async () => {
  const world = await mountWorld({
    models: { 'broken-model': new Error('adapter exploded') },
  });
  try {
    const sessionId = await world.host.createSession({
      sessionId: 's-broken',
      agentOptions: { provider: 'vision-provider', model: 'broken-model' },
    });
    const result = await world.host.deliver({
      sessionId,
      text: 'look',
      images: [IMAGE_REF],
      wake: true,
    });
    assert.deepEqual(result.degraded, ['model_without_vision']);
    assert.equal(world.agents.get(sessionId).inbox[0].content[1].type, 'text');
  } finally {
    await world.dispose();
  }
});

test('a profile without an LLM service cannot claim vision', async () => {
  const world = await mountWorld({ withLlm: false, models: {} });
  try {
    const sessionId = await world.host.createSession({
      sessionId: 's-no-llm',
      agentOptions: { provider: 'vision-provider', model: 'vision-model' },
    });
    const result = await world.host.deliver({
      sessionId,
      text: 'look',
      images: [IMAGE_REF],
      wake: true,
    });
    assert.deepEqual(result.degraded, ['model_without_vision']);
    assert.equal(world.agents.get(sessionId).inbox[0].content[1].type, 'text');
  } finally {
    await world.dispose();
  }
});

test('text-only answers are graded from the declared modalities, never from agent.options', async () => {
  // Real `AgentOptions` has no capability field at all: the old reader answered
  // "no vision" for every route. This pins the real field as the only authority.
  const options = { provider: 'vision-provider', model: 'vision-model', maxTokens: 8192 };
  assert.equal(visionCapabilityOf({ inputModalities: ['text', 'image'] }), VisionCapability.IMAGE);
  assert.equal(visionCapabilityOf({ inputModalities: ['text'] }), VisionCapability.TEXT);
  assert.equal(visionCapabilityOf({}), VisionCapability.UNKNOWN);
  assert.equal(visionCapabilityOf(undefined), VisionCapability.UNKNOWN);
  assert.equal(visionCapabilityOf(options), VisionCapability.UNKNOWN, 'AgentOptions carries no modalities');
});

test('createSession passes an absolute workspace cwd to the real create() options', async () => {
  const world = await mountWorld({});
  try {
    const sessionId = await world.host.createSession({
      sessionId: 's-cwd',
      agentOptions: { provider: 'vision-provider', model: 'vision-model' },
      // A peer-supplied path must never become the session cwd.
      cwd: '/definitely-not-the-workspace',
    });
    assert.equal(world.agents.created.length, 1);
    const { options, session } = world.agents.created[0];
    assert.equal(options.sessionId, sessionId);
    assert.equal(options.meta.cwd, world.workspace, 'cwd comes from the host workspace, not from caller input');
    assert.equal(session.header.cwd, world.workspace, 'the real session header accepted the value');
  } finally {
    await world.dispose();
  }
});

test('without a workingDirectory service the cwd is derived from the real filesystem', async () => {
  const world = await mountWorld({ withWorkspace: false });
  try {
    await world.host.createSession({ sessionId: 's-fs-cwd' });
    const { options } = world.agents.created[0];
    assert.equal(options.meta.cwd, world.workspace, 'fs.resolve(".") through processPath yields the workspace');
  } finally {
    await world.dispose();
  }
});

test('without any workspace the creation fails closed and creates nothing', async () => {
  const world = await mountWorld({ withWorkspace: false, withFs: false });
  try {
    await assert.rejects(
      world.host.createSession({ sessionId: 's-no-workspace' }),
      (error) => error.code === 'capability_unavailable' && error.details?.capability === 'workspace',
    );
    assert.equal(world.agents.created.length, 0, 'no session is minted without a validated directory');
  } finally {
    await world.dispose();
  }
});

test('delivery without images never queries capability', async () => {
  const world = await mountWorld({ models: { 'text-model': { inputModalities: ['text'] } } });
  try {
    const sessionId = await world.host.createSession({
      sessionId: 's-plain',
      agentOptions: { provider: 'vision-provider', model: 'text-model' },
    });
    const result = await world.host.deliver({ sessionId, text: 'hello', wake: true });
    assert.deepEqual(result.degraded, []);
    assert.deepEqual(world.adapter.queries, [], 'a text-only delivery costs no model lookup');
    assert.equal(world.agents.get(sessionId).inbox[0].content.length, 1);
  } finally {
    await world.dispose();
  }
});

test('a caller-forced textOnly still reports the omission for a vision route', async () => {
  // Even a route that could see the image must say so when the caller withholds
  // it: "attached" and "seen" are different facts (§13.5).
  const world = await mountWorld({ models: { 'vision-model': { inputModalities: ['text', 'image'] } } });
  try {
    const sessionId = await world.host.createSession({
      sessionId: 's-forced',
      agentOptions: { provider: 'vision-provider', model: 'vision-model' },
    });
    const result = await world.host.deliver({
      sessionId,
      text: 'look',
      images: [IMAGE_REF],
      wake: true,
      textOnly: true,
    });
    assert.deepEqual(result.degraded, ['model_without_vision']);
    const message = world.agents.get(sessionId).inbox[0];
    assert.equal(message.content[1].type, 'text');
    assert.equal(world.adapter.queries.length, 0, 'an explicit override needs no capability lookup');
  } finally {
    await world.dispose();
  }
});

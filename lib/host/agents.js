/**
 * Host agent adapter: run tasks on real DSH agents and deliver wake-ups
 * (protocol §6.5, §16.6).
 *
 * The adapter is the only place that knows about `ctx.agents`. Two behaviours
 * matter for correctness:
 *
 *   - **Delivery is state-dependent.** A busy agent gets `steer` (or `inject`
 *     for context that must not start a turn), an idle agent gets `followup`,
 *     and a cold session is `resume`d first. Sending everything as `followup`
 *     would let the bridge open a turn while the agent is mid-step.
 *   - **A cold session is resumed, never recreated.** `create` on an existing
 *     session id is a protocol error; `resume` loads the persisted log so the
 *     wake-up lands in the conversation that started the task.
 * @module dsh-plugin-astrbot-bridge/host/agents
 */

import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';

import { BridgeError } from '../errors.js';
import { defaultLogger } from '../log.js';
import { VisionCapability, buildUserMessage, visionCapabilityOf } from './llm.js';

/** Delivery strategies (`§6.5` / §16.6). */
export const Delivery = Object.freeze({
  FOLLOWUP: 'followup',
  STEER: 'steer',
  INJECT: 'inject',
  RESUME: 'resume',
});

/** Agent adapter over `ctx.agents`. */
export class AgentHost {
  /**
   * @param {object} options - adapter options.
   * @param {object|null} [options.ctx] - Cordis context carrying `agents`.
   * @param {Function} [options.now] - injectable clock.
   * @param {import('../log.js').Logger} [options.logger] - structured logger.
   */
  constructor(options = {}) {
    this.ctx = options.ctx ?? null;
    this.now = options.now ?? (() => Date.now());
    this.logger = options.logger ?? defaultLogger.child('host:agents');
    /** @type {Map<string, {agent: object, dispose: Function}>} live agents created by this bridge. */
    this._owned = new Map();
  }

  /**
   * The agent registry, if mounted.
   * @returns {object|null} registry.
   */
  get registry() {
    return this.ctx?.agents ?? null;
  }

  /**
   * Read one optional host service without widening this plugin's `inject`.
   *
   * `ctx.get(name)` is the host's documented inject-free read, whereas
   * `ctx[name]` throws `cannot get property ... without inject` for a service
   * the plugin did not declare. Capability queries must therefore go through
   * `ctx.get`, and a profile that does not mount the service answers `null`
   * rather than failing.
   * @param {string} name - Cordis service name.
   * @returns {object|null} the service, or null when unavailable.
   */
  service(name) {
    if (this.ctx === null || typeof this.ctx.get !== 'function') return null;
    return this.ctx.get(name) ?? null;
  }

  /**
   * The LLM registry used for real model-capability resolution.
   * @returns {object|null} `ctx.llm`, or null when not mounted.
   */
  get llm() {
    return this.service('llm');
  }

  /**
   * Whether the host can create and drive agents.
   * @returns {boolean} capability flag.
   */
  available() {
    const registry = this.registry;
    return registry !== null && typeof registry.create === 'function' && typeof registry.resume === 'function';
  }

  /**
   * Find a live agent by session id.
   * @param {string} sessionId - session identity.
   * @returns {object|undefined} live agent.
   */
  live(sessionId) {
    return this.registry?.get?.(sessionId) ?? undefined;
  }

  /**
   * Classify one session for delivery (§16.6).
   * @param {string} sessionId - session identity.
   * @returns {'busy'|'idle'|'cold'} state.
   */
  stateOf(sessionId) {
    const agent = this.live(sessionId);
    if (agent === undefined) return 'cold';
    return agent.status === 'running' ? 'busy' : 'idle';
  }

  /**
   * List live sessions with their state, for `session.list` (§9.7).
   * @returns {{session_id: string, state: string}[]} sessions.
   */
  listSessions() {
    const registry = this.registry;
    if (registry === null || typeof registry.list !== 'function') return [];
    return registry.list().map((agent) => ({
      session_id: String(agent.id),
      state: agent.status === 'running' ? 'busy' : 'idle',
    }));
  }

  /**
   * Create one agent session.
   *
   * `CreateAgentOptions.meta.cwd` is durable session data that the session
   * boundary validates as an **absolute** path (it keys storage directories and
   * the workspace registry), so it is never filled from caller input: the value
   * comes from the host's own execution world — `ctx.workingDirectory`'s
   * validated `defaultDirectory`, else `ctx.fs.resolve('.')` mapped through
   * `processPath`. Neither source is the plugin checkout, and neither is derived
   * from a peer-provided string. When the host exposes no workspace, creation
   * fails closed rather than minting a session with an unknown directory.
   * @param {object} input - creation input.
   * @param {string} [input.sessionId] - requested identity; generated when absent.
   * @param {object} [input.agentOptions] - provider/model route; the caller owns it.
   * @param {string} [input.purpose] - purpose label used for auditing only.
   * @returns {Promise<string>} the created session id.
   * @throws {BridgeError} `capability_unavailable` when the host cannot create
   *   agents or cannot resolve a workspace directory for the session.
   */
  async createSession(input = {}) {
    const registry = this.registry;
    if (registry === null || typeof registry.create !== 'function') {
      throw new BridgeError('capability_unavailable', { details: { capability: 'agents' } });
    }
    const workingDirectory = this.service('workingDirectory');
    let cwd = workingDirectory?.defaultDirectory;
    if (typeof cwd !== 'string' || cwd.length === 0 || !isAbsolute(cwd)) {
      const fs = this.service('fs');
      if (fs !== null && typeof fs.resolve === 'function' && typeof fs.processPath === 'function') {
        try {
          const resolved = fs.processPath(await fs.resolve('.'));
          cwd = typeof resolved === 'string' && isAbsolute(resolved) ? resolved : undefined;
        } catch (error) {
          // An unresolvable execution world is "unknown workspace", not a
          // session without one: the failure is reported, not swallowed.
          this.logger.failure('workspace_resolve_failed', error, {});
          cwd = undefined;
        }
      }
    }
    if (typeof cwd !== 'string' || !isAbsolute(cwd)) {
      throw new BridgeError('capability_unavailable', { details: { capability: 'workspace' } });
    }
    const sessionId = input.sessionId ?? randomUUID();
    const handle = await registry.create({
      sessionId,
      agentOptions: input.agentOptions ?? {},
      meta: { cwd },
    });
    this._owned.set(String(sessionId), handle);
    this.logger.info('agent_created', { session: String(sessionId), purpose: input.purpose ?? null });
    return String(sessionId);
  }

  /**
   * Resume a persisted session so a wake-up can be delivered into it.
   * @param {string} sessionId - persisted session identity.
   * @param {object} [agentOptions] - route override.
   * @returns {Promise<object>} the live agent.
   * @throws {BridgeError} `session_not_found` when the session cannot be resumed.
   */
  async resumeSession(sessionId, agentOptions = {}) {
    const existing = this.live(sessionId);
    if (existing !== undefined) return existing;
    const registry = this.registry;
    if (registry === null || typeof registry.resume !== 'function') {
      throw new BridgeError('capability_unavailable', { details: { capability: 'agents' } });
    }
    try {
      const handle = await registry.resume({
        resumeSessionId: sessionId,
        agentOptions,
      });
      this._owned.set(String(sessionId), handle);
      this.logger.info('agent_resumed', { session: String(sessionId) });
      return handle.agent;
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      throw new BridgeError('session_not_found');
    }
  }

  /**
   * Resolve one live agent's vision capability from the real LLM registry.
   *
   * `agent.options` is a true `AgentOptions` (`provider`, `model`,
   * `reasoningEffort`, `maxTokens`) and carries **no** capability field, so the
   * answer must be resolved through
   * `ctx.llm.resolveModelInfo(provider, model)` and read off
   * `LlmModelInfo.inputModalities`. Anything that prevents a positive answer —
   * no LLM service, no route on the agent, an adapter that does not declare
   * modalities, or a failed resolution — is `UNKNOWN`, which the delivery path
   * treats as "no image bytes" (§13.5: never assume vision).
   * @param {object} agent - live agent (`Agent.options` route).
   * @returns {Promise<'image'|'text'|'unknown'>} capability.
   */
  async resolveVision(agent) {
    const provider = agent?.options?.provider;
    const model = agent?.options?.model;
    if (typeof provider !== 'string' || provider.length === 0) return VisionCapability.UNKNOWN;
    if (typeof model !== 'string' || model.length === 0) return VisionCapability.UNKNOWN;
    const llm = this.llm;
    if (llm === null || typeof llm.resolveModelInfo !== 'function') {
      this.logger.warn('vision_capability_unavailable', { capability: 'llm' });
      return VisionCapability.UNKNOWN;
    }
    try {
      return visionCapabilityOf(await llm.resolveModelInfo(provider, model));
    } catch (error) {
      // A registry miss is an unknown capability, not a text-only route: the
      // caller degrades the same way, but the log keeps the distinction.
      this.logger.failure('vision_capability_unresolved', error, { provider, model });
      return VisionCapability.UNKNOWN;
    }
  }

  /**
   * Deliver one message to a session, choosing the strategy from its state.
   *
   * `inject` is used for context that must not start a turn on its own; a
   * wake-up that requires the agent to act uses `steer` (busy) or `followup`
   * (idle), matching §16.6.
   *
   * Images are attached as real `image` blocks only when the resolved route
   * declares the image input modality. A text-only route and an unresolved
   * capability both degrade to the host's text placeholder and record
   * `model_without_vision`, so a picture is never silently dropped and never
   * assumed to have been seen.
   * @param {object} input - delivery input.
   * @param {string} input.sessionId - target session.
   * @param {string} input.text - message text.
   * @param {object[]} [input.images] - `ImageAttachmentRef` values.
   * @param {boolean} [input.wake=true] - whether the delivery may start a turn.
   * @param {boolean} [input.textOnly] - force image degradation regardless of capability.
   * @returns {Promise<{strategy: string, session_id: string, degraded: string[]}>} delivery report.
   * @throws {BridgeError} `session_not_found` when a cold session cannot be resumed.
   */
  async deliver(input) {
    const state = this.stateOf(input.sessionId);
    const degraded = [];
    let agent;
    let strategy;
    if (state === 'cold') {
      agent = await this.resumeSession(input.sessionId);
      strategy = Delivery.RESUME;
    } else {
      agent = this.live(input.sessionId);
      strategy = input.wake === false ? Delivery.INJECT : state === 'busy' ? Delivery.STEER : Delivery.FOLLOWUP;
    }

    const hasImages = (input.images?.length ?? 0) > 0;
    let textOnly = input.textOnly === true;
    if (hasImages && !textOnly) {
      textOnly = (await this.resolveVision(agent)) !== VisionCapability.IMAGE;
    }
    // An image that did not become an `image` block is always reported: a
    // text-only route, an undeclared/failed capability lookup, and a caller
    // override all mean "the model did not see this" (§13.5).
    if (hasImages && textOnly) degraded.push('model_without_vision');

    const message = buildUserMessage({
      text: input.text,
      images: input.images,
      textOnly,
    });

    if (strategy === Delivery.RESUME) agent.followup(message);
    else if (strategy === Delivery.INJECT) agent.inject(message);
    else if (strategy === Delivery.STEER) agent.steer(message);
    else agent.followup(message);

    this.logger.info('delivery', {
      session: input.sessionId,
      strategy,
      state,
      degraded: degraded.join(','),
    });
    return { strategy, session_id: input.sessionId, degraded };
  }

  /**
   * Wait until one agent is idle, bounded by a deadline.
   * @param {string} sessionId - session identity.
   * @param {number} [timeoutMs] - deadline.
   * @returns {Promise<boolean>} whether the agent became idle in time.
   */
  async waitIdle(sessionId, timeoutMs = 60_000) {
    const agent = this.live(sessionId);
    if (agent === undefined) return false;
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    try {
      const idle = agent.whenIdle().then(() => true);
      return await Promise.race([idle, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Cancel the active turn of one agent, keeping its queued work.
   * @param {string} sessionId - session identity.
   * @returns {boolean} whether an agent was cancelled.
   */
  cancel(sessionId) {
    const agent = this.live(sessionId);
    if (agent === undefined) return false;
    // `AgentCancelCause` is a closed union; a bridge-initiated stop is a user
    // action from the harness's point of view (`{kind:'user'}`).
    agent.cancel({ kind: 'user' }, { keepInbox: true });
    return true;
  }

  /**
   * Dispose every agent this adapter created.
   * @returns {Promise<void>} resolution after teardown.
   */
  async dispose() {
    const handles = [...this._owned.values()];
    this._owned.clear();
    for (const handle of handles) {
      try {
        await handle.dispose();
      } catch (error) {
        this.logger.failure('agent_dispose_failed', error, {});
      }
    }
  }
}

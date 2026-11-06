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

import { installModelSelection } from '@deepseek-ai/dsh-agent';

import { BridgeError } from '../errors.js';
import { defaultLogger } from '../log.js';
import { VisionCapability, buildUserMessage, visionCapabilityOf } from './llm.js';

/**
 * Narrow one candidate route to the options an Agent accepts (R3).
 *
 * The host's `AgentOptions` is closed over `provider`/`model`/`reasoningEffort`/
 * `maxTokens`; the bridge never carries a token budget, so `maxTokens` is
 * dropped rather than forwarded. A route without both a provider and a model is
 * no route at all, which is what keeps `capability_unavailable/no_model_route`
 * from being raised for a half-filled override.
 * @param {unknown} value - candidate route (`{provider, model, reasoningEffort}`).
 * @returns {{provider: string, model: string, reasoningEffort?: string}|null} route or null.
 */
function routeOf(value) {
  if (value === null || typeof value !== 'object') return null;
  const candidate = /** @type {{provider?: unknown, model?: unknown, reasoningEffort?: unknown}} */ (value);
  const provider = typeof candidate.provider === 'string' ? candidate.provider.trim() : '';
  const model = typeof candidate.model === 'string' ? candidate.model.trim() : '';
  if (provider.length === 0 || model.length === 0) return null;
  const route = { provider, model };
  if (typeof candidate.reasoningEffort === 'string' && candidate.reasoningEffort.length > 0) {
    route.reasoningEffort = candidate.reasoningEffort;
  }
  return route;
}

/**
 * Whether two routes name the same provider/model pair.
 * @param {object|null} left - route.
 * @param {object|null} right - route.
 * @returns {boolean} whether the pair is unchanged (effort alone does not matter).
 */
function sameModel(left, right) {
  if (left === null || left === undefined || right === null || right === undefined) return false;
  return left.provider === right.provider && left.model === right.model;
}

/** How many raw agent errors are kept per delivery before the oldest is dropped. */
const MAX_AGENT_ERRORS = 8;

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
   * @param {Function} [options.modelPolicy] - reads the live model policy
   *   (`{override, byPurpose}`). Read once per delivery, so a volatile config
   *   edit takes effect on the next delivery without a reload (R5).
   * @param {import('../log.js').Logger} [options.logger] - structured logger.
   */
  constructor(options = {}) {
    this.ctx = options.ctx ?? null;
    this.now = options.now ?? (() => Date.now());
    this.logger = options.logger ?? defaultLogger.child('host:agents');
    /**
     * Live model policy reader. The default resolves nothing, which makes the
     * host default (`agentDefaultModel`) the only policy source.
     * @type {Function}
     */
    this.modelPolicy =
      typeof options.modelPolicy === 'function' ? options.modelPolicy : () => ({ override: null, byPurpose: {} });
    /** @type {Map<string, {agent: object, dispose: Function}>} live agents created by this bridge. */
    this._owned = new Map();
    /** @type {Map<string, {agent: object, ref: object, dispose: Function|null}>} model selections. */
    this._selections = new Map();
    /** @type {Map<string, object>} failure evidence of the last delivery per session. */
    this._faults = new Map();
    /** Whether the host event bus exposes agent/session failures; null until probed. */
    this._faultTracking = null;
    this._faultDisposers = [];
    this._subscribeFaults();
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
   * Subscribe the two host failure signals (R6).
   *
   * `whenIdle()` cannot report a turn failure — the loop's `kick()` swallows the
   * error and still sets the agent idle — so the only reliable evidence is the
   * live `agent/error` event and the durable `turn/end.reason` replayed through
   * `session/event`. A plugin-level listener receives every agent's events, so
   * each handler filters by the session id this adapter owns. When the host
   * exposes no event bus the tracking is marked unreliable, which downstream
   * turns into `needs_human` instead of an unearned success.
   * @returns {void}
   */
  _subscribeFaults() {
    const ctx = this.ctx;
    if (ctx === null || typeof ctx.on !== 'function') {
      this._faultTracking = false;
      return;
    }
    try {
      this._faultDisposers.push(ctx.on('agent/error', (payload) => this._recordAgentError(payload)));
      this._faultDisposers.push(ctx.on('session/event', (session, event) => this._recordSessionEvent(session, event)));
      this._faultTracking = true;
    } catch (error) {
      // An unsubscribable bus is "cannot attribute", never "nothing failed".
      this._faultTracking = false;
      this.logger.failure('agent_fault_tracking_failed', error, {});
    }
  }

  /**
   * Read (or create) the failure record of one session.
   * @param {string} sessionId - session identity.
   * @returns {object} mutable record.
   */
  _faultRecord(sessionId) {
    let record = this._faults.get(sessionId);
    if (record === undefined) {
      record = {
        armed: false,
        reliable: this._faultTracking === true,
        agentErrors: [],
        lastTurnEnd: null,
        // Turn-boundary tracking survives across deliveries: `lastSeenTurn` /
        // `openTurn` let arming tell a still-running turn (which belongs to the
        // next window) from a turn that already closed (M-4).
        lastSeenTurn: null,
        openTurn: false,
        armedTurn: null,
        // Last assistant message text admitted inside the armed window. Reset
        // per delivery, never appended across steps (tool-call intermediates
        // must not leak into the final answer).
        assistantText: '',
      };
      this._faults.set(sessionId, record);
    }
    return record;
  }

  /**
   * Start a fresh failure window for one delivery.
   *
   * Evidence is cleared here, not after `waitIdle()`, so an error that happens
   * while the delivery is still being admitted is attributed to this delivery
   * rather than to the previous one.
   * @param {string} sessionId - session identity.
   * @returns {void}
   */
  _armFaultRecord(sessionId) {
    const record = this._faultRecord(sessionId);
    record.armed = true;
    record.reliable = this._faultTracking === true;
    record.agentErrors = [];
    record.lastTurnEnd = null;
    record.assistantText = '';
    // A turn already open when the delivery is admitted (steer/inject into a
    // busy agent) belongs to this window too. An idle agent's next `turn/start`
    // opens the boundary instead, so a late `turn/end` from the previous turn
    // cannot be attributed to this delivery (M-4).
    record.armedTurn = record.openTurn === true ? record.lastSeenTurn : null;
  }

  /**
   * Record one live `agent/error` event.
   * @param {object} payload - `{agent, turn, step, error}`.
   * @returns {void}
   */
  _recordAgentError(payload) {
    const sessionId = String(payload?.agent?.id ?? '');
    if (sessionId.length === 0 || !this._owned.has(sessionId)) return;
    const record = this._faultRecord(sessionId);
    record.agentErrors.push({
      turn: payload.turn ?? null,
      step: payload.step ?? null,
      error: payload.error ?? null,
    });
    if (record.agentErrors.length > MAX_AGENT_ERRORS) record.agentErrors.shift();
  }

  /**
   * Record one durable session event: the turn boundary and assistant output.
   *
   * Only events of sessions this bridge owns are considered, and only turns at
   * or after the armed turn boundary count. The boundary is established by the
   * first `turn/start` after arming, or by the still-open turn when a
   * steer/inject lands in a running turn. A `turn/end` or `assistant/message`
   * from a previous turn therefore cannot be attributed to this delivery (M-4).
   *
   * For `assistant/message`, only `text` content blocks are kept and the last
   * admitted message replaces the previous one: a multi-step turn must answer
   * with its final assistant message, not with the concatenation of every
   * intermediate tool-calling step.
   * @param {object} session - session that produced the event.
   * @param {object} event - `SessionEvent` (`{type, seq, time, data}`).
   * @returns {void}
   */
  _recordSessionEvent(session, event) {
    const sessionId = String(session?.id ?? '');
    if (sessionId.length === 0 || !this._owned.has(sessionId)) return;
    const type = event?.type;
    if (type !== 'turn/start' && type !== 'turn/end' && type !== 'assistant/message') return;
    const record = this._faultRecord(sessionId);
    const rawTurn = event.data?.turn;
    const turn = Number.isInteger(rawTurn) ? rawTurn : null;

    if (type === 'turn/start') {
      if (turn === null) return;
      record.lastSeenTurn = Math.max(record.lastSeenTurn ?? 0, turn);
      record.openTurn = true;
      if (record.armed === true && record.armedTurn === null) record.armedTurn = turn;
      return;
    }

    const inWindow =
      record.armed === true && record.armedTurn !== null && turn !== null && turn >= record.armedTurn;

    if (type === 'turn/end') {
      if (inWindow) {
        record.lastTurnEnd = {
          turn,
          reason: event.data?.reason ?? null,
          seq: event.seq ?? null,
        };
      }
      if (turn !== null) {
        record.lastSeenTurn = Math.max(record.lastSeenTurn ?? 0, turn);
        record.openTurn = false;
      }
      return;
    }

    if (!inWindow) return;
    const content = event.data?.message?.content;
    record.assistantText = Array.isArray(content)
      ? content
          .filter((block) => block?.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text)
          .join('')
      : '';
  }

  /**
   * Classify the turn a delivery started (R6).
   *
   * `ok` is the only value that lets a caller claim success. A failed turn is
   * `error`; a turn that ended for a reason this bridge does not model, or one
   * it could not observe at all, is `unknown` — never success. A missing record
   * (`null`) means no tracked delivery happened, which is the compatibility
   * path for a host double that carries no event bus; the caller then keeps the
   * pre-v0.3 behaviour instead of inventing a verdict.
   *
   * An `ok` verdict also carries the text of the last assistant message in the
   * armed window. That text is what the task reports as its answer; an empty
   * string means the turn produced no answer at all, which the task boundary
   * treats as `needs_human` rather than an earned success.
   * @param {string} sessionId - session identity.
   * @returns {{kind: 'ok'|'error'|'unknown', turn?: number|null, text?: string, error?: object, reason?: string}|null} verdict.
   */
  takeTurnOutcome(sessionId) {
    const record = this._faults.get(String(sessionId));
    if (record === undefined || record.armed !== true) return null;
    if (record.reliable !== true) return { kind: 'unknown', reason: 'event_tracking_unavailable' };
    const end = record.lastTurnEnd;
    if (end !== null) {
      const reason = end.reason;
      const kind = reason?.kind;
      if (kind === 'error') return { kind: 'error', turn: end.turn, error: reason.error ?? null };
      if (kind === 'completed' || kind === 'max-tokens') {
        return { kind: 'ok', turn: end.turn, text: record.assistantText };
      }
      if (kind === 'aborted' && reason?.reason?.kind === 'user') {
        // The bridge's own `cancel()` owns the status; the durable turn closer
        // is not a failure and must not overwrite the cancellation.
        return { kind: 'ok', turn: end.turn, text: record.assistantText };
      }
      return { kind: 'unknown', reason: `turn_end_${String(kind ?? 'unknown')}` };
    }
    const lastError = record.agentErrors.at(-1);
    if (lastError !== undefined) return { kind: 'error', turn: lastError.turn, error: lastError.error };
    return { kind: 'unknown', reason: 'no_turn_end' };
  }

  /**
   * Resolve the model route for one delivery (R3, R5).
   *
   * Order: the live plugin policy override, then the purpose mapping, then the
   * host default (`agentDefaultModel.currentSelection()`, which re-reads its own
   * config refs on every call). An absent route is `null`; the caller decides
   * whether to fail closed. The plugin policy is read through a function on
   * every call, which is what makes a volatile edit effective on the next
   * delivery without reloading the plugin.
   * @param {string|null} [purpose] - task purpose, when known.
   * @returns {{route: object, source: 'override'|'purpose'|'default'}|null} resolution.
   */
  _resolveRoute(purpose) {
    const policy = this.modelPolicy();
    const override = routeOf(policy?.override);
    if (override !== null) return { route: override, source: 'override' };
    const byPurpose = policy?.byPurpose;
    if (purpose !== null && purpose !== undefined && typeof purpose === 'string' && byPurpose !== null) {
      const mapped = routeOf(byPurpose?.[purpose]);
      if (mapped !== null) return { route: mapped, source: 'purpose' };
    }
    const selection = this.service('agentDefaultModel');
    if (selection !== null && typeof selection.currentSelection === 'function') {
      try {
        const selected = routeOf(selection.currentSelection());
        if (selected !== null) return { route: selected, source: 'default' };
      } catch (error) {
        // A host service that throws is an unavailable route, not a crash: the
        // caller keeps the route the agent already has (R4).
        this.logger.failure('model_default_selection_failed', error, { purpose: purpose ?? null });
      }
    }
    return null;
  }

  /**
   * The route an existing agent/session is actually using.
   * @param {string} sessionId - session identity.
   * @returns {object|null} route or null when the session has none.
   */
  _routeOf(sessionId) {
    const entry = this._selections.get(String(sessionId));
    const selected = routeOf(entry?.ref?.current);
    if (selected !== null) return selected;
    return routeOf(this.live(sessionId)?.options);
  }

  /**
   * Install (once per agent) or refresh (per delivery) the model selection.
   *
   * The refresh must go through `installModelSelection`'s mutable ref rather
   * than `agent.options`: after the first turn the request seed comes from the
   * persisted header, so editing `options` would change `{{provider}}/{{model}}`
   * in the prompt while the real request kept the old route. The host snapshots
   * the ref per step, so writing it while a turn is running takes effect on a
   * later step of that turn and never interrupts an in-flight request.
   * @param {string} sessionId - session identity.
   * @param {object} agent - live agent.
   * @param {object} route - resolved route.
   * @returns {object} the selection ref.
   */
  _installSelection(sessionId, agent, route) {
    const key = String(sessionId);
    let entry = this._selections.get(key);
    if (entry !== undefined && entry.agent !== agent) {
      // The agent was replaced (cold resume); its scoped listeners died with it.
      try {
        entry.dispose?.();
      } catch {
        // A dead scope cannot be disposed twice; nothing to report.
      }
      entry = undefined;
    }
    if (entry === undefined) {
      const ref = { current: route, assembled: undefined };
      entry = { agent, ref, dispose: null };
      this._selections.set(key, entry);
      if (agent?.ctx !== null && agent?.ctx !== undefined && typeof agent.ctx.on === 'function') {
        try {
          entry.dispose = installModelSelection(agent.ctx, ref);
        } catch (error) {
          // Falling back is strictly better than failing the whole delivery:
          // the route still reaches the request seed at the next cold resume.
          this.logger.failure('model_selection_install_failed', error, { session: key });
        }
      } else {
        this.logger.warn('model_selection_install_skipped', { session: key, reason: 'agent_context_unavailable' });
      }
    } else {
      entry.ref.current = route;
    }
    return entry.ref;
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
   * @param {string} [input.purpose] - purpose label used for routing and auditing.
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
    // Routing is resolved here when the host knows one, but creation never fails
    // closed: `session.create` must keep working on a profile with no default
    // model, and the task boundary is where a missing route is refused (R3).
    const explicit = routeOf(input.agentOptions);
    let resolution = explicit === null ? null : { route: explicit, source: 'explicit' };
    if (resolution === null) {
      try {
        resolution = this._resolveRoute(input.purpose ?? null);
      } catch (error) {
        this.logger.failure('model_route_resolve_failed', error, { purpose: input.purpose ?? null });
      }
    }
    const sessionId = input.sessionId ?? randomUUID();
    const handle = await registry.create({
      sessionId,
      ...(resolution === null ? {} : { agentOptions: resolution.route }),
      meta: { cwd },
    });
    this._owned.set(String(sessionId), handle);
    // Install at creation (including a route that came from the host default):
    // the selection machine must not start mid-life at the first delivery,
    // which is what can make the host announce a change that never happened
    // (L-2).
    if (resolution !== null) this._installSelection(sessionId, handle.agent, resolution.route);
    this.logger.info('agent_created', {
      session: String(sessionId),
      purpose: input.purpose ?? null,
      provider: resolution?.route.provider ?? null,
      model: resolution?.route.model ?? null,
      source: resolution?.source ?? null,
    });
    return String(sessionId);
  }

  /**
   * Resume a persisted session so a wake-up can be delivered into it.
   *
   * A cold resume rebuilds the request seed from `agentOptions`, so the route
   * resolved for this delivery is passed through; when no route is known the
   * option is omitted rather than sent empty (`session.create`/`resume` must
   * never be handed an empty route).
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
    let route = routeOf(agentOptions);
    if (route === null) {
      try {
        route = this._resolveRoute(null)?.route ?? null;
      } catch (error) {
        this.logger.failure('model_route_resolve_failed', error, { session: String(sessionId) });
      }
    }
    try {
      const handle = await registry.resume({
        resumeSessionId: sessionId,
        ...(route === null ? {} : { agentOptions: route }),
      });
      this._owned.set(String(sessionId), handle);
      // Install the selection at resume, not at the first delivery (L-2): the
      // host's `[model changed: …]` notice compares the assembled route with
      // the persisted request header, so the selection machine must start from
      // the same route the session is resumed with. A resume that installs
      // nothing and a delivery that installs later would leave the first turn
      // in an undefined-selection state.
      if (route !== null) this._installSelection(sessionId, handle.agent, route);
      this.logger.info('agent_resumed', {
        session: String(sessionId),
        provider: route?.provider ?? null,
        model: route?.model ?? null,
      });
      return handle.agent;
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      throw new BridgeError('session_not_found');
    }
  }

  /**
   * Resolve one live agent's vision capability from the real LLM registry.
   *
   * A route carries **no** capability field, so the answer must be resolved
   * through `ctx.llm.resolveModelInfo(provider, model)` and read off
   * `LlmModelInfo.inputModalities`. The route is read from the installed model
   * selection (falling back to `agent.options`), so a mid-flight model switch
   * cannot make image handling disagree with the model that will see the turn.
   * Anything that prevents a positive answer — no LLM service, no route, an
   * adapter that does not declare modalities, or a failed resolution — is
   * `UNKNOWN`, which the delivery path treats as "no image bytes" (§13.5:
   * never assume vision).
   * @param {object} agent - live agent.
   * @returns {Promise<'image'|'text'|'unknown'>} capability.
   */
  async resolveVision(agent) {
    // The installed selection is the authoritative route once a delivery has
    // resolved one; `agent.options` is only the fallback for a bare handle.
    const route =
      agent?.id === undefined || agent?.id === null ? routeOf(agent?.options) : this._routeOf(agent.id);
    const provider = route?.provider;
    const model = route?.model;
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
   * This is the **single model-route refresh point** (R4/R5): the live policy is
   * read here, the selection ref is updated here, and the delivery is refused
   * here when no route can be resolved at all (R3). Resolving anywhere earlier
   * — `createSession`, for one — would make `session.create` fail on a profile
   * with no default model, which the protocol does not allow.
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
   * @param {string|null} [input.purpose] - task purpose, used for the purpose map.
   * @returns {Promise<{strategy: string, session_id: string, degraded: string[]}>} delivery report.
   * @throws {BridgeError} `capability_unavailable` with `details.reason ===
   *   'no_model_route'` when neither policy nor the existing agent has a route,
   *   and `session_not_found` when a cold session cannot be resumed.
   */
  async deliver(input) {
    const sessionId = input.sessionId;
    // Resolve first: a delivery must never reach an agent with no route, and a
    // failed refresh keeps the route the agent already has (R4) instead of
    // interrupting the task.
    let resolution = null;
    try {
      resolution = this._resolveRoute(input.purpose ?? null);
    } catch (error) {
      this.logger.warn('model_route_refresh_failed', {
        session: String(sessionId),
        reason: 'policy_unreadable',
        error: error instanceof Error ? error.name : 'Error',
      });
    }
    const current = this._routeOf(sessionId);
    const route = resolution?.route ?? current;
    if (route === null || route === undefined) {
      throw new BridgeError('capability_unavailable', {
        details: { capability: 'model', reason: 'no_model_route' },
      });
    }

    const state = this.stateOf(sessionId);
    const degraded = [];
    let agent;
    let strategy;
    if (state === 'cold') {
      agent = await this.resumeSession(sessionId, route);
      strategy = Delivery.RESUME;
    } else {
      agent = this.live(sessionId);
      strategy = input.wake === false ? Delivery.INJECT : state === 'busy' ? Delivery.STEER : Delivery.FOLLOWUP;
    }

    // The unique refresh point: update the selection the host snapshots per
    // step, so the next step/turn uses the new route and the current request is
    // never interrupted.
    this._installSelection(sessionId, agent, route);
    if (resolution !== null && !sameModel(route, current)) {
      this.logger.info('model_route_selected', {
        session: String(sessionId),
        provider: route.provider,
        model: route.model,
        source: resolution.source,
      });
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

    // Start a fresh failure window before the wake-up can run a turn, so an
    // error raised while the turn is admitted still belongs to this delivery.
    this._armFaultRecord(String(sessionId));

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
    const disposers = this._faultDisposers;
    this._faultDisposers = [];
    for (const dispose of disposers) {
      try {
        dispose();
      } catch (error) {
        this.logger.failure('agent_fault_unsubscribe_failed', error, {});
      }
    }
    for (const entry of this._selections.values()) {
      try {
        entry.dispose?.();
      } catch {
        // The agent scope is being torn down; a failing unsubscribe changes
        // nothing about the teardown itself.
      }
    }
    this._selections.clear();
    this._faults.clear();
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

/**
 * Entry lifecycle regression (v0.1, tools / reconnect / storage / disposal).
 *
 * Every case here exists because a defect was only visible *through the
 * composition root*, never through a layer suite:
 *
 *   1. tools were registered per connection, so the second ready peer hit the
 *      harness registry's duplicate-name error and stopping one connection
 *      removed the tools of all the others;
 *   2. a peer that was not ready hid the tools from the model instead of
 *      answering `not_ready`, and `apply` was the only place that could fix it;
 *   3. `TransportManager.runForever` had no caller, so a lost carrier was never
 *      reconnected and a degraded webhook never fell back;
 *   4. the entry read `ctx.storage` without declaring it (fiber FAILED at load)
 *      and never passed the hub to the store;
 *   5. `imageEnabled` was accepted by the schema and ignored by the code;
 *   6. `_buildServices` built `SessionService` last and never passed it to the
 *      task and notification services, so the archive gate only ever warned.
 *
 * The host facilities are the real ones wherever the contract matters: real
 * `@deepseek-ai/cordis` lifecycle, real `ToolRuntime` registry, real
 * `dsh-storage` + `dsh-storage-json` hub, real `Session` handshake and real
 * `WsTransport` sockets. Only the facilities the bridge consumes as an opaque
 * seam (agents, attachments, approval, system prompt) are stubs, and they are
 * named `*Stub` so a reader cannot mistake one for a host implementation.
 *
 * What this file does **not** prove: a real DSH profile boot, a real AstrBot
 * peer, and the 3-probe webhook degradation end to end (that path is covered by
 * `transport-webhook.test.mjs`; here the supervisor's `degraded` → fallback
 * wiring is asserted at both ends of the seam).
 * @module dsh-plugin-astrbot-bridge/tests/entry-lifecycle-regression
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { Context, Service } from '@deepseek-ai/cordis';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';

import bridge, { Config, Supervisor, apply, inject, name, normaliseConfig } from 'dsh-plugin-astrbot-bridge';
import { SessionState } from '../lib/constants.js';
import { BridgeError } from '../lib/errors.js';
import { registerBridgeTools } from '../lib/tools.js';
import { BridgeStore } from '../lib/store.js';
import { Session, buildCaps } from '../lib/session.js';
import { TransportManager } from '../lib/transport/manager.js';
import { WsTransport } from '../lib/transport/ws.js';

/** A logger that records events and never writes to the console. */
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

/** A logger that only satisfies the interface. */
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

/**
 * Wait until one predicate holds, without assuming a number of event-loop hops.
 * @param {() => boolean|Promise<boolean>} predicate - condition.
 * @param {string} label - failure label.
 * @param {number} [timeoutMs] - deadline.
 * @returns {Promise<void>} resolution once it holds.
 */
async function until(predicate, label, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${label}`);
}

/** One Cordis facility stub: a real service with stub behaviour. */
class FacilityStub extends Service {
  /**
   * @param {Context} ctx - owning context.
   * @param {string} serviceName - service name to provide.
   */
  constructor(ctx, serviceName) {
    super(ctx, serviceName);
  }
}

/** `ctx.agents`: an empty live registry. */
class AgentsStub extends FacilityStub {
  /** @param {Context} ctx - owning context. */
  constructor(ctx) {
    super(ctx, 'agents');
  }

  /** @returns {object[]} no live agents. */
  list() {
    return [];
  }

  /** @returns {object|undefined} never a live agent. */
  get() {
    return undefined;
  }
}

/** `ctx.attachments`: only exists so capability checks can see it. */
class AttachmentsStub extends FacilityStub {
  /** @param {Context} ctx - owning context. */
  constructor(ctx) {
    super(ctx, 'attachments');
  }
}

/** `ctx.approval`: only exists so the claim seam can be detected. */
class ApprovalStub extends FacilityStub {
  /** @param {Context} ctx - owning context. */
  constructor(ctx) {
    super(ctx, 'approval');
  }
}

/** `ctx.systemPrompt`: the three no-ops `ToolRuntime` calls while registering. */
class PromptStub extends FacilityStub {
  /** @param {Context} ctx - owning context. */
  constructor(ctx) {
    super(ctx, 'systemPrompt');
  }

  /** @returns {() => void} no-op disposer. */
  tools() {
    return () => {};
  }

  /** @returns {() => void} no-op disposer. */
  section() {
    return () => {};
  }

  /** @returns {number} stable order. */
  order() {
    return 0;
  }

  /** @returns {number} stable order. */
  getSectionOrder() {
    return 0;
  }
}

/**
 * Mount one context with the four non-storage facilities the entry declares.
 * @returns {{app: Context, tools: () => ToolRuntime|undefined}} context and registry.
 */
function mountFacilities() {
  const app = new Context();
  let tools;
  app.plugin({
    name: 'entry-lifecycle-facilities',
    apply(ctx) {
      // `ToolRuntime` injects `systemPrompt`, so the prompt service must exist
      // before the registry is constructed; the rest are order-independent.
      new PromptStub(ctx);
      tools = new ToolRuntime(ctx);
      new AgentsStub(ctx);
      new AttachmentsStub(ctx);
      new ApprovalStub(ctx);
    },
  });
  return { app, tools: () => tools };
}

/**
 * Mount the real storage hub (and its json backend) under one context.
 * @param {Context} app - host context.
 * @param {string} root - backend root.
 * @returns {Promise<void>} resolution once mounted.
 */
async function mountStorage(app, root) {
  const storage = await import('@deepseek-ai/dsh-storage');
  const json = await import('@deepseek-ai/dsh-storage-json');
  await app.plugin(storage.default);
  await app.plugin(json, { root });
}

/**
 * Mount the bridge on one context, keeping its fiber reachable.
 * @param {Context} app - host context.
 * @param {object} config - raw plugin config.
 * @returns {{fiber: () => object|undefined}} mounting handle.
 */
function mountBridge(app, config) {
  let fiber;
  // The configuration must travel through `ctx.plugin(plugin, config)`, exactly
  // as `cordis.patch.yml` delivers it. Passing it only to `apply` would make the
  // fixture agree with itself while the real load path stayed untested — and a
  // case that asserts a non-default setting would silently run on defaults.
  app.plugin(
    {
      name: 'astrbot-bridge',
      inject: bridge.inject,
      apply: (ctx, raw) => {
        fiber = ctx.fiber;
        return bridge.apply(ctx, raw ?? {});
      },
    },
    config,
  );
  return { fiber: () => fiber };
}

/** A connection record that reaches nothing: an empty PSK parks it. */
function parkedConnection(id) {
  return {
    id,
    mode: 'listen',
    transport: 'ws',
    transportFallback: ['longpoll'],
    host: '127.0.0.1',
    port: 0,
    path: '/dsh-bridge',
    tlsEnabled: false,
    pskId: '',
    pskSecret: '',
    allowPrivateAddr: false,
  };
}

/** An in-process carrier pair; only the transport seam is faked. */
class FakePair {
  constructor() {
    this.a = new FakeCarrier(this, 'a');
    this.b = new FakeCarrier(this, 'b');
    this.a.peer = this.b;
    this.b.peer = this.a;
  }

  /**
   * Deliver one hop on a later tick, swallowing a closed peer's refusal.
   * @param {Function} deliver - delivery action.
   * @returns {void}
   */
  hop(deliver) {
    setImmediate(() => {
      try {
        Promise.resolve(deliver()).catch(() => {});
      } catch {
        // A stopped peer cannot accept the frame; the sender already knows.
      }
    });
  }
}

/** One side of {@link FakePair}. */
class FakeCarrier {
  constructor(pair, label) {
    this.pair = pair;
    this.label = label;
    this.peer = null;
    this.hooks = null;
    this.stopped = true;
    this.pendingPlain = null;
  }

  async start(_cfg, hooks) {
    this.hooks = hooks;
    this.stopped = false;
  }

  async stop() {
    this.stopped = true;
  }

  async sendEnvelope(envelope) {
    const peer = this.peer;
    this.pair.hop(() => {
      void peer.hooks.onEnvelope(structuredClone(envelope));
    });
  }

  async sendPlain(object) {
    const peer = this.peer;
    return new Promise((resolve) => {
      this.pendingPlain = resolve;
      this.pair.hop(() => {
        void peer.hooks.onPlain(structuredClone(object));
      });
      setTimeout(() => {
        if (this.pendingPlain === resolve) {
          this.pendingPlain = null;
          resolve(undefined);
        }
      }, 200).unref?.();
    });
  }

  respondPlain(object) {
    const peer = this.peer;
    this.pair.hop(() => {
      peer.pendingPlain?.(structuredClone(object));
    });
  }

  alive() {
    return !this.stopped;
  }

  /**
   * Report a carrier fact the way the real carriers do.
   * @param {string} state - `degraded`, `stale`, `ready`, `closed`.
   * @returns {void}
   */
  report(state) {
    this.hooks?.onState?.(state);
  }
}

/** Capabilities for the peer (A) side of a fake or real channel. */
function peerCaps() {
  return buildCaps({
    side: 'A',
    host: 'astrbot',
    version: '0.1.0',
    transports: ['ws', 'webhook', 'longpoll'],
    tls: false,
    rolesInitiate: true,
    rolesExecute: true,
    approvals: { business_decision: true, cross_end_submit: true, native_tool: false },
    attachments: {
      mime: ['image/gif', 'image/jpeg', 'image/png', 'image/webp'],
      max_bytes: 10485760,
      max_count: 4,
      max_total_bytes: 20971520,
      max_pixels: 100000000,
      max_dimension: 8192,
    },
  });
}

/**
 * Build one supervisor wired to a fake carrier pair through `_startSession`.
 * @param {object} options - fixture options.
 * @param {object} options.ctx - host context.
 * @param {object} [options.connection] - connection record.
 * @param {object} [options.settings] - normalized settings overrides.
 * @param {object} [options.store] - bridge store.
 * @param {object} [options.agentHost] - agent adapter stub.
 * @returns {{supervisor: Supervisor, pair: FakePair, peer: Session}} fixture.
 */
function makeSupervisorFixture(options) {
  const logger = options.logger ?? recordingLogger();
  const supervisor = new Supervisor({
    ctx: options.ctx,
    settings: normaliseConfig({ remoteNativeApproval: false, ...(options.settings ?? {}) }),
    connection: options.connection ?? {
      id: 'conn-a',
      mode: 'listen',
      transport: 'ws',
      transportFallback: [],
      host: '127.0.0.1',
      port: 0,
      path: '/dsh-bridge',
      tlsEnabled: false,
      pskId: 'default',
      pskSecret: 'correct horse battery staple',
      allowPrivateAddr: false,
    },
    store: options.store ?? {},
    agentHost: options.agentHost ?? { listSessions: () => [], dispose: async () => {} },
    attachmentHost: {},
    logger,
  });
  const pair = new FakePair();
  // The peer must name the same `conn`: an unknown id is refused by the session
  // layer (§4.1), so the fixture derives it from the supervisor's own record.
  const conn = {
    id: supervisor.connection.id,
    pskId: supervisor.connection.pskId,
    pskSecret: supervisor.connection.pskSecret,
  };
  const peer = new Session(
    {
      conn,
      side: 'A',
      role: 'initiator',
      transportName: 'ws',
      caps: peerCaps(),
      heartbeatS: 30,
      handshakeTimeoutMs: 2000,
      logger,
    },
    pair.a,
    { onMessage() {} },
  );
  return { supervisor, pair, peer };
}

/**
 * Connect one fake peer to one supervisor, the way a carrier would.
 * @param {object} fixture - from {@link makeSupervisorFixture}.
 * @returns {Promise<void>} resolution once both sides are ready.
 */
async function connectFixture(fixture) {
  const wired = fixture.supervisor._startSession(fixture.pair.b, 'ws');
  const started = fixture.peer.start();
  await Promise.all([wired, started]);
}

/** Release a fake-path fixture. */
async function releaseFixture(fixture) {
  await fixture.supervisor.stop();
  try {
    await fixture.peer.close('draining', 'test', { notifyPeer: false });
  } catch {
    // Already closed by the supervisor.
  }
}

/** A minimal store for the supervisor cases: durable writes go to a temp root. */
async function tempStore() {
  const root = await mkdtemp(join(tmpdir(), 'entry-lifecycle-'));
  const store = new BridgeStore({ dataRoot: root, logger: SILENT });
  await store.init();
  return { root, store };
}

/**
 * A session factory for the real manager: fails a scripted number of times,
 * then reports the carrier as running.
 * @param {object} script - mutable script.
 * @returns {Function} session factory.
 */
function scriptedFactory(script) {
  return (carrier, name) => async () => {
    script.calls.push({ name, at: Date.now() });
    if (script.failUntil > script.calls.length) {
      throw new BridgeError(script.code ?? 'internal_error', { details: { reason: 'network' } });
    }
    script.started.push(name);
  };
}

test('the entry registers each bridge tool once, before any peer is ready', async () => {
  const { app, tools } = mountFacilities();
  const storages = await mkdtemp(join(tmpdir(), 'entry-hub-'));
  const home = await mkdtemp(join(tmpdir(), 'entry-home-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    await mountStorage(app, storages);
    const { fiber } = mountBridge(app, { connections: [parkedConnection('conn-a'), parkedConnection('conn-b')] });
    await until(() => fiber()?.state === 2, 'the fiber to become ACTIVE');

    const names = tools().schemas(undefined).map((schema) => schema.name).sort();
    assert.deepEqual(
      names,
      ['bridge_call_astr_tool', 'bridge_list_sessions', 'bridge_submit_task', 'bridge_task_status'],
      'the tools must be visible to the model even with no ready peer',
    );

    // Not ready is a readable failure, not a missing capability: the model can
    // see the tool and learns why the call did not run.
    const definition = tools().get('bridge_submit_task');
    await assert.rejects(
      () => definition.execute({ text: 'hello' }, {}),
      (error) => error instanceof BridgeError && error.code === 'not_ready',
    );

    await fiber().dispose();
    assert.equal(fiber().state, 4, 'the fiber must be DISPOSED');
    assert.deepEqual(tools().schemas(undefined), [], 'dispose must unregister every tool');
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    await rm(storages, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('two ready connections share one registration and stopping one keeps the tools', async () => {
  const { app, tools } = mountFacilities();
  const { root, store } = await tempStore();
  const ctx = { tools: app.tools, approval: {}, on: () => () => {} };
  const agentHost = { listSessions: () => [], dispose: async () => {} };
  const first = makeSupervisorFixture({ ctx, store, agentHost });
  const second = makeSupervisorFixture({
    ctx,
    store,
    agentHost,
    connection: {
      id: 'conn-b',
      mode: 'listen',
      transport: 'ws',
      transportFallback: [],
      host: '127.0.0.1',
      port: 0,
      path: '/dsh-bridge',
      tlsEnabled: false,
      pskId: 'default',
      pskSecret: 'correct horse battery staple',
      allowPrivateAddr: false,
    },
  });
  const supervisors = [first.supervisor, second.supervisor];

  // The composition root registers once, and resolves services lazily so a tool
  // call always reaches whichever connection is ready *now*. Registering per
  // connection is what made the second ready peer fail on a duplicate name and
  // made stopping one peer delete every peer's tools.
  const disposeTools = registerBridgeTools(ctx, {
    get tasks() {
      for (const supervisor of supervisors) {
        const services = supervisor.readyServices();
        if (services !== null) return services.tasks;
      }
      throw new BridgeError('not_ready', { details: { reason: 'no_ready_connection' } });
    },
    get sessions() {
      return {};
    },
    config: normaliseConfig({}),
    logger: SILENT,
  });
  try {
    await connectFixture(first);
    await connectFixture(second);
    assert.equal(tools().schemas(undefined).length, 4, 'the second ready peer must not add or duplicate a tool');

    await first.supervisor.stop();
    assert.equal(tools().schemas(undefined).length, 4, 'stopping one connection removed the global tools');
    assert.equal(first.supervisor.readyServices(), null);
    assert.equal(second.supervisor.readyServices() !== null, true, 'the other connection stays ready');
    assert.equal(
      supervisors.map((supervisor) => supervisor.readyServices()).filter(Boolean).length,
      1,
      'exactly one connection is still ready, so tool calls route to it',
    );

    await second.supervisor.stop();
    assert.equal(tools().schemas(undefined).length, 4, 'the entry, not a connection, owns the tools');
    disposeTools();
    assert.deepEqual(tools().schemas(undefined), [], 'the entry disposer unregisters the tools');
  } finally {
    disposeTools();
    for (const fixture of [first, second]) {
      await fixture.supervisor.stop();
      await fixture.peer.close('draining', 'test over', { notifyPeer: false }).catch(() => {});
    }
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('the public config carries an explicit bind/peer split through to the carriers', () => {
  const parsed = Config({
    connections: [
      {
        id: 'c1',
        mode: 'listen',
        transport: 'webhook',
        bindHost: '127.0.0.1',
        bindPort: 18772,
        peerHost: '127.0.0.1',
        peerPort: 18773,
      },
    ],
  });
  const [connection] = parsed.connections;
  assert.equal(connection.bindHost, '127.0.0.1');
  assert.equal(connection.bindPort, 18772);
  assert.equal(connection.peerHost, '127.0.0.1');
  assert.equal(connection.peerPort, 18773);

  const settings = normaliseConfig(parsed);
  assert.equal(settings.connections[0].peerPort, 18773, 'normalisation must not drop the peer address');
  assert.equal(settings.connections[0].bindPort, 18772, 'normalisation must not drop the bind address');

  // An unset peer is *unset*, never a copy of the bind address: that copy is
  // precisely the self-post defect.
  const bare = normaliseConfig({ connections: [{ id: 'c2', mode: 'listen', host: '0.0.0.0', port: 8765 }] });
  assert.equal(bare.connections[0].peerHost, '');
  assert.equal(bare.connections[0].peerPort, 0);
  assert.notEqual(bare.connections[0].host, bare.connections[0].peerHost);
});

test('a webhook peer is never this endpoint’s own bind address', async () => {
  const { WebhookTransport } = await import('../lib/transport/webhook.js');
  const base = {
    id: 'self',
    mode: 'listen',
    transport: 'webhook',
    host: '127.0.0.1',
    port: 8765,
    path: '/dsh-bridge',
    tlsEnabled: false,
    allowPrivateAddr: false,
  };
  const hooks = { onPlain() {}, onEnvelope() {}, onState() {} };

  // Half a peer address is a configuration error, not a prompt to guess the
  // other half out of the bind address.
  const half = new WebhookTransport({ logger: SILENT });
  await assert.rejects(
    () => half.start({ ...base, peerHost: '127.0.0.1', peerPort: 0 }, hooks),
    (error) => error instanceof BridgeError && error.code === 'config_invalid',
  );

  // A peer that *is* the bind address is refused before the first frame, rather
  // than feeding this endpoint's own reverse traffic back into itself.
  const selfPost = new WebhookTransport({ logger: SILENT });
  await assert.rejects(
    () =>
      selfPost.start(
        { ...base, bindHost: '127.0.0.1', bindPort: 8765, peerHost: '127.0.0.1', peerPort: 8765 },
        hooks,
      ),
    (error) => error instanceof BridgeError && error.code === 'config_invalid' && error.details.field === 'peerHost',
  );

  // Without a peer at all, reverse delivery refuses loudly: posting "home" is
  // the defect, an explicit failure is the contract.
  const noPeer = new WebhookTransport({ logger: SILENT });
  await noPeer.start({ ...base, bindHost: '127.0.0.1', bindPort: 0, peerHost: '', peerPort: 0 }, hooks);
  try {
    await assert.rejects(
      () => noPeer.sendEnvelope({ sid: 's', seq: 1, ct: 'x' }),
      (error) => error instanceof BridgeError && error.code === 'config_invalid',
    );
  } finally {
    await noPeer.stop();
  }

  // A distinct peer is accepted and used as the POST target.
  const real = new WebhookTransport({ logger: SILENT });
  await real.start(
    { ...base, bindHost: '127.0.0.1', bindPort: 0, peerHost: '127.0.0.1', peerPort: 8766 },
    hooks,
  );
  assert.equal(real._peer.port, 8766, 'reverse delivery must address the peer, never the bind port');
  await real.stop();
});

test('a lost session reconnects to the preferred carrier with backoff, and stop ends the loop', async () => {
  const script = { calls: [], started: [], failUntil: Number.POSITIVE_INFINITY };
  const manager = new TransportManager(
    {
      id: 'loop',
      mode: 'connect',
      transport: 'ws',
      transportFallback: ['longpoll'],
      host: '127.0.0.1',
      port: 1,
      path: '/dsh-bridge',
      tlsEnabled: false,
      reconnectMaxBackoff: 1,
    },
    {},
    { logger: recordingLogger(), retryPreferredMs: 120 },
  );
  const factory = scriptedFactory(script);
  // `lost` while the peer is down; `hold` once it is back, so the carrier stays
  // adopted and the post-success assertions can observe a live connection.
  let watchMode = 'lost';
  const loop = manager.runForever(factory, {
    watch: async (signal) => {
      if (watchMode === 'hold') {
        await waitOrAbort(5000, signal);
        return 'stopped';
      }
      return 'lost';
    },
  });

  // Two full rounds prove both rules at once: every carrier is tried once per
  // round (§7.5 order), and the preferred one always comes first.
  await until(() => script.calls.length >= 4, 'two failed rounds');
  assert.deepEqual(
    script.calls.slice(0, 4).map((call) => call.name),
    ['ws', 'longpoll', 'ws', 'longpoll'],
    'each round must try the preferred carrier first and then the fallbacks',
  );

  // Backoff belongs *between* rounds, not between the carriers of one round: a
  // peer that is down should not cost a full second before the fallback is even
  // attempted.
  const roundGap = script.calls[2].at - script.calls[1].at;
  // 1 s base with ±20% jitter, capped by `reconnectMaxBackoff: 1`.
  assert.ok(roundGap >= 700, `a failed round must back off (saw ${roundGap} ms)`);
  assert.ok(roundGap <= 1500, `backoff must respect reconnectMaxBackoff (saw ${roundGap} ms)`);
  assert.equal(manager.diagnostics().maxBackoffMs, 1000, 'the ceiling comes from reconnectMaxBackoff');

  watchMode = 'hold';
  script.failUntil = script.calls.length;
  await until(
    () => script.started.length > 0 && manager.diagnostics().reachable === true,
    'the loop to connect once the peer returns',
  );
  assert.equal(manager.current(), 'ws', 'the preferred carrier must be preferred again');
  assert.equal(manager.diagnostics().reachable, true);

  await manager.stop();
  assert.equal(manager.running(), false);
  const settled = script.calls.length;
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(script.calls.length, settled, 'nothing may reconnect after stop()');
  assert.equal(manager.diagnostics().current, null, 'the carrier is released on stop');
  await loop;
});

test('a degraded carrier moves to the fallback order and is retried later', async () => {
  const script = { calls: [], started: [], failUntil: 0 };
  const manager = new TransportManager(
    {
      id: 'degrade',
      mode: 'listen',
      transport: 'webhook',
      transportFallback: ['longpoll'],
      host: '127.0.0.1',
      port: 0,
      path: '/dsh-bridge',
      tlsEnabled: false,
      reconnectMaxBackoff: 5,
    },
    {},
    { logger: recordingLogger(), retryPreferredMs: 120 },
  );
  let outcomes = ['degraded', 'lost'];
  const factory = (carrier, name) => async () => {
    script.calls.push(name);
  };
  const loop = manager.runForever(factory, {
    watch: async () => outcomes.shift() ?? 'stopped',
  });
  await until(() => script.calls.length >= 2, 'the fallback carrier to be tried');
  assert.deepEqual(script.calls.slice(0, 2), ['webhook', 'longpoll'], 'a degrade must move to the next carrier');
  assert.deepEqual(manager.history().map((record) => `${record.from}->${record.to}`), ['webhook->longpoll']);

  // The fallback is retried as the preferred carrier after the retry period; a
  // failed attempt must leave the fallback running rather than drop the link.
  script.calls.length = 0;
  await until(() => script.calls.length >= 1, 'the preferred carrier to be retried');
  assert.equal(script.calls[0], 'webhook');
  await manager.stop();
  await loop;
  assert.equal(manager.running(), false);
});

test('the supervisor turns real session states into loop outcomes', async () => {
  const { root, store } = await tempStore();
  const degradedFixture = makeSupervisorFixture({ ctx: { approval: {}, on: () => () => {} }, store });
  const lostFixture = makeSupervisorFixture({ ctx: { approval: {}, on: () => () => {} }, store });
  try {
    // A degraded carrier asks for the fallback carrier, while the session stays
    // usable for the frames already in flight (§7.3 rule 6).
    await connectFixture(degradedFixture);
    const session = degradedFixture.supervisor.currentSession;
    assert.equal(session.state, SessionState.READY);
    const degraded = degradedFixture.supervisor._watchSession();
    degradedFixture.pair.b.report('degraded');
    assert.equal(await degraded, 'degraded', 'a carrier degrade must ask for the fallback carrier');
    assert.equal(session.state, SessionState.DEGRADED);

    // A closed session asks for a reconnect, and the watcher settles on the
    // state transition rather than waiting for the heartbeat to notice.
    await connectFixture(lostFixture);
    const gone = lostFixture.supervisor.currentSession;
    const lost = lostFixture.supervisor._watchSession();
    await gone.close('peer_closed', 'peer went away', { notifyPeer: false });
    assert.equal(await lost, 'lost', 'a closed session must ask the loop to reconnect');
  } finally {
    await releaseFixture(degradedFixture);
    await releaseFixture(lostFixture);
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
  assert.equal(name, 'astrbot-bridge');
  assert.equal(typeof apply, 'function');
});

test('a listener that disappears is reconnected on a fresh sid and stops on dispose', async () => {
  const peerConnFor = () => ({ id: 'conn-a', pskId: 'default', pskSecret: 'correct horse battery staple' });
  const listenerOptions = (port) => ({
    conn: { ...peerConnFor(), mode: 'listen', host: '127.0.0.1', port, path: '/dsh-bridge', tlsEnabled: false },
    side: 'A',
    role: 'responder',
    transportName: 'ws',
    caps: peerCaps(),
    handshakeTimeoutMs: 3000,
    logger: SILENT,
  });

  /**
   * Start a real ws listener, returning its port.
   * @param {number} port - port to bind (0 for ephemeral).
   * @returns {Promise<{session: Session, transport: WsTransport, port: number}>} listener.
   */
  const startListener = async (port) => {
    const transport = new WsTransport({ logger: SILENT });
    const session = new Session(listenerOptions(port), transport, { onMessage() {} });
    const started = session.start().catch((error) => error);
    await until(() => transport._server?.address() !== undefined && transport._server?.address() !== null, 'bind');
    return { session, transport, port: transport._server.address().port, started };
  };

  const first = await startListener(0);
  const { root, store } = await tempStore();
  const logger = recordingLogger();
  const supervisor = new Supervisor({
    ctx: { approval: {}, on: () => () => {} },
    settings: normaliseConfig({ remoteNativeApproval: false, reconnectMaxBackoff: 1, heartbeatInterval: 5 }),
    connection: {
      id: 'conn-a',
      mode: 'connect',
      transport: 'ws',
      transportFallback: ['longpoll'],
      host: '127.0.0.1',
      port: first.port,
      path: '/dsh-bridge',
      tlsEnabled: false,
      pskId: 'default',
      pskSecret: 'correct horse battery staple',
      allowPrivateAddr: false,
    },
    store,
    agentHost: { listSessions: () => [], dispose: async () => {} },
    attachmentHost: {},
    logger,
  });
  try {
    await supervisor.start();
    await until(() => supervisor.ready, 'the supervisor to become ready', 10_000);
    const firstSid = supervisor.currentSession.sid;
    assert.ok(firstSid, 'a ready session must have a sid');
    assert.equal(supervisor.manager.running(), true, 'the carrier loop must be running');

    // The peer disappears: the loop must retry, not park silently.
    await first.session.close('draining', 'listener goes away');
    await first.transport.stop();
    await until(() => !supervisor.ready, 'the session to be lost');
    const attemptsAfterLoss = supervisor.manager.diagnostics().attempted.length;
    await until(
      () => supervisor.manager.diagnostics().attempted.length > attemptsAfterLoss,
      'a reconnect attempt after the loss',
    );

    // The peer comes back on the same port: the loop must reconnect with a new sid.
    const second = await startListener(first.port);
    await until(() => supervisor.ready, 'the supervisor to reconnect', 10_000);
    const secondSid = supervisor.currentSession.sid;
    assert.notEqual(secondSid, firstSid, 'a reconnect must use a fresh handshake and sid');

    await supervisor.stop();
    assert.equal(supervisor.manager, null, 'stop must release the manager');
    const frozen = logger.events.length;
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(logger.events.length, frozen, 'nothing may happen after stop()');
    assert.equal(supervisor.currentSession, null);
    await second.session.close('draining', 'test over', { notifyPeer: false });
    await second.transport.stop();
  } finally {
    await supervisor.stop();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a real storage hub activates the entry and owns the records', async () => {
  const { app, tools } = mountFacilities();
  const storages = await mkdtemp(join(tmpdir(), 'entry-hub-'));
  const home = await mkdtemp(join(tmpdir(), 'entry-home-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    await mountStorage(app, storages);
    const { fiber } = mountBridge(app, { connections: [] });
    await until(() => fiber()?.state === 2, 'the fiber to become ACTIVE with a storage hub');
    assert.equal(tools().schemas(undefined).length, 4, 'the tools are registered even while idle');

    // The entry used the *hub*, not the file fallback: the file backend
    // materialises `<DSH_HOME>/bridge/astrbot` at init and is only reached when
    // no hub was supplied, so its absence is the observable evidence that
    // `ctx.storage` was handed to the store.
    const { stat } = await import('node:fs/promises');
    const fallback = await stat(join(home, 'bridge', 'astrbot')).catch(() => null);
    assert.equal(fallback, null, 'the file fallback must not be used when a hub is supplied');

    // The live entry owns the `(name, version)` unit: the hub refuses a second
    // concurrent opener, which is only possible if this entry opened it through
    // `ctx.storage` rather than through the file fallback.
    await assert.rejects(
      () => new BridgeStore({ storage: app.storage }).init(),
      (error) => error instanceof BridgeError && error.code === 'internal_error',
      'the entry must be the hub unit’s single opener',
    );
    assert.equal(
      await stat(join(home, 'bridge', 'astrbot')).catch(() => null),
      null,
      'a refused concurrent open must not create the file root either',
    );

    await fiber().dispose();
    assert.equal(fiber().state, 4);
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    await rm(storages, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('a profile without the storage service parks the fiber instead of failing it', async () => {
  const { app } = mountFacilities();
  let message = null;
  const fiber = app.plugin({
    name: 'astrbot-bridge',
    inject,
    apply: (ctx, raw) => bridge.apply(ctx, raw),
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(fiber.state, 0, 'a missing injected service must leave the fiber PENDING');
  message = fiber._error?.message ?? null;
  assert.equal(message, null, `the fiber must not fail with an undeclared-property error (${message})`);
  await fiber.dispose();
});

test('the composition root wires the archive gate instead of reporting the gap', async () => {
  const { root, store } = await tempStore();
  const logger = recordingLogger();
  const fixture = makeSupervisorFixture({
    ctx: { approval: {}, on: () => () => {} },
    store,
    logger,
    agentHost: { listSessions: () => [], dispose: async () => {} },
  });
  try {
    await connectFixture(fixture);
    const services = fixture.supervisor.services;
    // The gate is only effective when the *same* session service instance that
    // `manage()` writes through is the one delivery consults; building the two
    // other services before it left both silently unwired.
    assert.equal(services.tasks.sessions, services.sessions);
    assert.equal(services.notify.sessions, services.sessions);
    assert.equal(typeof services.sessions.isDeliverable, 'function');
    assert.deepEqual(
      logger.events.filter((entry) => entry.event === 'archive_gate_unwired'),
      [],
      'a correctly wired entry must never announce the gap',
    );
  } finally {
    await releaseFixture(fixture);
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('imageEnabled is enforced at the host boundary', async () => {
  const { root, store } = await tempStore();
  const fakeSession = { sid: 'sid', async call() { return {}; }, async emit() {} };
  const attachments = {};
  try {
    const settings = normaliseConfig({ imageEnabled: false, remoteNativeApproval: false });
    const supervisor = new Supervisor({
      ctx: { approval: {}, on: () => () => {} },
      settings,
      connection: parkedConnection('conn-image'),
      store,
      agentHost: {},
      attachmentHost: attachments,
      logger: SILENT,
    });
    const off = supervisor._buildServices(fakeSession).blobs;
    assert.equal(off.limits.maxCount, 0, 'imageEnabled:false must accept no image count');
    assert.deepEqual(off.limits.mime, [], 'imageEnabled:false must accept no media type');
    // Both refusals are the denials the peer sees: a single blob fails on its
    // media type, and a task carrying one fails on the zero allowance first
    // (the count check precedes the type check). Either way nothing is accepted.
    assert.throws(
      () => off.validateMetadata({ media_type: 'image/png', bytes: 10, width: 1, height: 1 }),
      (error) => error instanceof BridgeError && error.code === 'attachment_type_denied',
    );
    assert.throws(
      () => off.validateTaskAttachments([{ kind: 'blob', blob_id: 'b', media_type: 'image/png', bytes: 10, width: 1, height: 1 }]),
      (error) => error instanceof BridgeError && error.code === 'attachment_count_exceeded',
    );

    const enabled = new Supervisor({
      ctx: { approval: {}, on: () => () => {} },
      settings: normaliseConfig({ remoteNativeApproval: false }),
      connection: parkedConnection('conn-image'),
      store,
      agentHost: {},
      attachmentHost: attachments,
      logger: SILENT,
    });
    const on = enabled._buildServices(fakeSession).blobs;
    assert.equal(on.limits.maxCount, 4, 'the default still accepts images');
    assert.ok(on.limits.mime.includes('image/png'));
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('task retention deletes only terminal records older than the configured window', async () => {
  const { root, store } = await tempStore();
  try {
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const fresh = new Date().toISOString();
    // `putTask` stamps `updated_at` with the current time, so the records are
    // seeded through `put` to control the age retention is measured against.
    await store.put('tasks', 'old-done', { task_id: 'old-done', status: 'succeeded', updated_at: old });
    await store.put('tasks', 'new-done', { task_id: 'new-done', status: 'succeeded', updated_at: fresh });
    // A live task outside the window must survive: retention is not deletion of
    // business state, it is removal of terminal history.
    await store.put('tasks', 'old-running', { task_id: 'old-running', status: 'running', updated_at: old });

    const removed = await store.cleanupExpired(3);
    assert.equal(removed, 1, 'exactly one terminal record was outside the window');
    assert.equal(await store.getTask('old-done'), null);
    assert.equal((await store.getTask('new-done'))?.status, 'succeeded');
    assert.equal((await store.getTask('old-running'))?.status, 'running', 'a live task is never deleted');

    // The window is clamped rather than switchable off, so a typo cannot disable
    // retention entirely.
    assert.equal(normaliseConfig({ taskRetentionDays: 3 }).taskRetentionDays, 3);
    assert.equal(normaliseConfig({ taskRetentionDays: 0 }).taskRetentionDays, 1);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('the entry arms a periodic sweep and passes the configured retention window', async () => {
  const { app } = mountFacilities();
  const storages = await mkdtemp(join(tmpdir(), 'entry-hub-'));
  const home = await mkdtemp(join(tmpdir(), 'entry-home-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  // Capture the interval the entry installs, and record the window it passes to
  // the store. Asserting a private field would tie the test to the
  // implementation; capturing both ends proves the wiring instead.
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const armed = [];
  const cleared = [];
  globalThis.setInterval = (callback, delay, ...rest) => {
    const handle = realSetInterval(callback, delay, ...rest);
    armed.push({ handle, callback, delay });
    return handle;
  };
  globalThis.clearInterval = (handle) => {
    cleared.push(handle);
    return realClearInterval(handle);
  };
  const realCleanup = BridgeStore.prototype.cleanupExpired;
  const windows = [];
  BridgeStore.prototype.cleanupExpired = async function record(retentionDays) {
    windows.push(retentionDays);
    return 0;
  };
  try {
    await mountStorage(app, storages);
    const { fiber } = mountBridge(app, { connections: [], taskRetentionDays: 3 });
    await until(() => fiber()?.state === 2, 'the fiber to become ACTIVE');
    const sweeps = armed.filter((entry) => entry.delay === 60 * 60 * 1000);
    assert.equal(sweeps.length, 1, 'the entry must arm exactly one hourly sweep');

    // Drive the armed callback: the entry must sweep with the *configured*
    // window, not the store's 7-day default.
    sweeps[0].callback();
    await until(() => windows.length === 1, 'the sweep to reach the store');
    assert.deepEqual(windows, [3], 'the sweep must use taskRetentionDays');

    await fiber().dispose();
    assert.equal(fiber().state, 4);
    // A disposed entry leaves no timer behind: the exact handle it armed is the
    // one it cleared, so nothing keeps firing against the closed store.
    assert.ok(
      cleared.includes(sweeps[0].handle),
      'dispose must clear the retention interval it armed',
    );
  } finally {
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
    BridgeStore.prototype.cleanupExpired = realCleanup;
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    await rm(storages, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

/**
 * Wait for a delay, resolving `false` early when the signal aborts.
 * @param {number} ms - delay.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<boolean>} whether the delay elapsed.
 */
function waitOrAbort(ms, signal) {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const finish = (value) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(true), ms);
    timer.unref?.();
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

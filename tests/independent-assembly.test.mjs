/**
 * Independent assembly review (v0.1 acceptance, reviewer-owned).
 *
 * This suite is deliberately *not* another unit suite: the existing 234 tests
 * exercise each layer through its own seams, and that is exactly why a broken
 * **composition** can stay green. Every case here goes through the real entry
 * point — `dsh-plugin-astrbot-bridge` resolved by package self-reference, the
 * real `@deepseek-ai/cordis` `Context`/`Fiber` lifecycle, the real
 * `@deepseek-ai/dsh-tools` registry and schema compiler, the real
 * `@deepseek-ai/dsh-storage` hub when it is mounted, and the real
 * `@deepseek-ai/dsh-home-paths` resolver.
 *
 * The host facilities the entry declares (`agents`, `attachments`, `approval`,
 * `tools`) are provided by *minimal wiring stubs* whose only job is to exist and
 * to record calls, so activation and teardown can be observed. **A stub is never
 * treated as proof that the real runtime behaviour is correct**: every case that
 * needs a real contract asserts against a real package (Cordis, dsh-tools,
 * dsh-storage, dsh-home-paths), and the stubs are named `*Stub` so a reader
 * cannot mistake one for a host implementation.
 *
 * `storage` is the exception: the entry hands `ctx.storage` to the store, which
 * opens the hub's `json` backend, so the fixture mounts the *real* storage hub
 * and `dsh-storage-json` over a temporary root. A `{}` stand-in cannot store
 * anything and would only prove that the entry fails closed.
 *
 * Domain behaviour (wire frames, crypto, task state machine, approval
 * settlement) is out of scope here — the layer suites own it.
 * @module dsh-plugin-astrbot-bridge/tests/independent-assembly
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { Context, Service } from '@deepseek-ai/cordis';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';

import bridge, { Config, Supervisor, inject, apply, name, normaliseConfig } from 'dsh-plugin-astrbot-bridge';
import { BridgeStore, UNIT_NAME } from '../lib/store.js';
import { ApprovalService } from '../lib/app/approvals.js';
import { BridgeError } from '../lib/errors.js';
import { Logger } from '../lib/log.js';
import { resolveDataRoot } from '../lib/host/storage.js';
import { Endpoints, bindTarget, peerTarget, sameEndpoint } from '../lib/transport/base.js';
import { LongPollTransport } from '../lib/transport/longpoll.js';
import { WebhookTransport } from '../lib/transport/webhook.js';
import { registerBridgeTools } from '../lib/tools.js';

/** Repository root, resolved from this test file. */
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Import a host package, or report why it is unavailable.
 *
 * The composition fixture needs the *real* storage hub; a hand-written object
 * would satisfy `inject` and then prove nothing about persistence. When the
 * package is genuinely absent the dependent case skips with this reason.
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

const STORAGE_HUB = await tryImport('@deepseek-ai/dsh-storage');
const STORAGE_JSON = await tryImport('@deepseek-ai/dsh-storage-json');

/** Why the real storage fixture is unavailable, or null when it is mounted. */
const STORAGE_FIXTURE_REASON =
  STORAGE_HUB.module === null
    ? `real storage hub unavailable (${STORAGE_HUB.reason})`
    : STORAGE_JSON.module === null
      ? `real json backend unavailable (${STORAGE_JSON.reason})`
      : null;

/** A structured logger for objects the entry constructs directly. */
const LOGGER = new Logger('assembly-review');

/** A logger-shaped stub for services that only log on the paths under test. */
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
 * Provide one service object under one Cordis service name.
 *
 * `Service` is the real Cordis base class, so registration, injection and
 * disposal follow the host's own rules; only the *behaviour* is a stub.
 */
class FacilityStub extends Service {
  /**
   * @param {Context} ctx - owning context.
   * @param {string} serviceName - Cordis service name to provide.
   */
  constructor(ctx, serviceName) {
    super(ctx, serviceName);
  }
}

/** `ctx.tools` stub: records registrations so wiring can be observed. */
class ToolsStub extends FacilityStub {
  /** @param {Context} ctx - owning context. */
  constructor(ctx) {
    super(ctx, 'tools');
    /** @type {Map<string, object>} tool definitions by name. */
    this.registered = new Map();
  }

  /**
   * Record one tool.
   * @param {object} definition - tool definition.
   * @returns {() => void} disposer removing it.
   */
  register(definition) {
    this.registered.set(definition.name, definition);
    return () => {
      this.registered.delete(definition.name);
    };
  }
}

/** `ctx.agents` stub: an empty live registry. */
class AgentsStub extends FacilityStub {
  /** @param {Context} ctx - owning context. */
  constructor(ctx) {
    super(ctx, 'agents');
  }

  /** @returns {object[]} no live agents. */
  list() {
    return [];
  }
}

/** `ctx.attachments` stub: only exists so capability checks can see it. */
class AttachmentsStub extends FacilityStub {
  /** @param {Context} ctx - owning context. */
  constructor(ctx) {
    super(ctx, 'attachments');
  }
}

/** `ctx.approval` stub: only exists so the claim seam can be detected. */
class ApprovalStub extends FacilityStub {
  /** @param {Context} ctx - owning context. */
  constructor(ctx) {
    super(ctx, 'approval');
  }
}

/**
 * `ctx.systemPrompt` stub — the one extra facility `ToolRuntime` needs.
 *
 * The real `@deepseek-ai/dsh-system-prompt` service owns prompt assembly, which
 * this suite does not test; the registry only calls three of its methods while
 * registering and describing tools, so they are stubbed to no-ops here. Nothing
 * about prompt text is asserted anywhere in this file.
 */
class PromptStub extends FacilityStub {
  /** @param {Context} ctx - owning context. */
  constructor(ctx) {
    super(ctx, 'systemPrompt');
  }

  /** @returns {() => void} no-op registration disposer. */
  tools() {
    return () => {};
  }

  /** @returns {() => void} no-op registration disposer. */
  section() {
    return () => {};
  }

  /** @returns {number} stable order. */
  getSectionOrder() {
    return 0;
  }
}

/**
 * Mount a context that provides every service the entry declares.
 *
 * Four of the five are stubs, because their real owners (agent registry,
 * attachment store, approval service) are out of scope here. `storage` is not a
 * stub: the entry passes `ctx.storage` to the store, which opens the hub's
 * `json` backend, so the fixture mounts the real `dsh-storage` hub and the real
 * `dsh-storage-json` backend over a fresh temporary root. A `{}` object would
 * satisfy the injection check and then fail the very contract under test.
 *
 * Plugins activate asynchronously, so the recorder is read through a getter: a
 * plain field would be observed before the host plugin has run.
 * @param {object} [options] - fixture options.
 * @param {boolean} [options.withStorage] - mount the real hub (default true).
 *   `false` models a profile that mounts no storage: Cordis must park the fiber
 *   in `PENDING` instead of running `apply` and failing a property read.
 * @returns {Promise<{app: Context, tools: () => ToolsStub|undefined, storagesRoot: string}>}
 *   context, recorder, and the hub root the caller removes.
 */
async function mountHostFacilities({ withStorage = true } = {}) {
  const storagesRoot = await mkdtemp(join(tmpdir(), 'assembly-storages-'));
  const app = new Context();
  let tools;
  app.plugin({
    name: 'assembly-host-facilities',
    apply(ctx) {
      tools = new ToolsStub(ctx);
      new AgentsStub(ctx);
      new AttachmentsStub(ctx);
      new ApprovalStub(ctx);
    },
  });
  if (withStorage) {
    if (STORAGE_FIXTURE_REASON !== null) throw new Error(STORAGE_FIXTURE_REASON);
    // Order is the profile's own: the hub first, then its json backend.
    await app.plugin(STORAGE_HUB.module.default);
    await app.plugin(STORAGE_JSON.module, { root: storagesRoot });
  }
  return { app, tools: () => tools, storagesRoot };
}

/**
 * Mount the bridge itself on one context, capturing its fiber.
 *
 * `ctx.plugin` returns the fiber immediately, while `apply` may not have run:
 * with an unresolved dependency it stays `PENDING` and never runs at all. The
 * returned handle is therefore the only way to observe that state — the
 * `ctx.fiber` capture inside `apply` only exists once the fiber is ACTIVE.
 * @param {Context} app - host context.
 * @param {object} config - raw plugin config.
 * @returns {{fiber: () => object|undefined}} mounting handle.
 */
function mountBridge(app, config) {
  let fiber;
  const mounted = app.plugin({
    name: 'astrbot-bridge',
    inject: bridge.inject,
    apply: (ctx, raw) => {
      fiber = ctx.fiber;
      return bridge.apply(ctx, raw);
    },
  });
  return { fiber: () => fiber ?? mounted };
}

/** Wait for Cordis to finish a background activation, without sleeping on a job. */
const tick = (ms = 900) => new Promise((resolve) => setTimeout(resolve, ms));

/** A settings object with every field the Supervisor's `caps()` reads. */
function supervisorSettings() {
  return {
    ...normaliseConfig({}),
    remoteNativeApproval: false,
  };
}

/** A connection record with no PSK: nothing in these cases dials out. */
function connectionRecord(id) {
  return {
    id,
    mode: 'listen',
    transport: 'ws',
    transportFallback: [],
    host: '127.0.0.1',
    port: 0,
    path: '/dsh-bridge',
    tlsEnabled: false,
    pskId: '',
    pskSecret: '',
    allowPrivateAddr: false,
  };
}

/**
 * Reserve one free loopback port.
 *
 * A listen-mode carrier needs a real port in its config, and a fixed one (8765)
 * would make the case flaky on a busy machine. The socket is closed before the
 * carrier binds, which is the only way to learn the port beforehand.
 * @returns {Promise<number>} a loopback port that was free a moment ago.
 */
async function freePort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/**
 * Start a real loopback peer that records what a carrier POSTs to it.
 *
 * The carrier's outbound path is `fetch`, so only a real socket proves both
 * "the frame reached the configured peer" and "it did not come back here". The
 * returned `close()` destroys live sockets before closing: `fetch` keeps them
 * alive, and a plain `server.close()` would wait for the keep-alive timeout and
 * hang the runner if an assertion failed first.
 * @returns {Promise<{port: number, seen: Array<{method: string, url: string}>, close: () => Promise<void>}>}
 *   the peer's port, its request log, and an idempotent closer.
 */
async function startRecordingPeer() {
  const seen = [];
  const sockets = new Set();
  const server = createHttpServer((req, res) => {
    seen.push({ method: req.method, url: req.url });
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      // Mirror the protocol: probes get `probe_ack`, frame batches a 202.
      if (req.url.endsWith(Endpoints.PROBE)) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ v: 1, type: 'probe_ack' }));
        return;
      }
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ v: 1, accepted: [], rejected: [] }));
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  let closed = false;
  return {
    port: server.address().port,
    seen,
    close: async () => {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

test('the package entry is importable by name and exposes the Cordis plugin surface', () => {
  assert.equal(name, 'astrbot-bridge');
  // The entry hands `ctx.storage` to the store, so the hub must be declared:
  // Cordis throws on an undeclared read, and a profile that mounts no hub must
  // park the fiber, not crash it.
  assert.deepEqual(inject, ['agents', 'attachments', 'approval', 'tools', 'storage']);
  assert.equal(typeof apply, 'function');
  assert.deepEqual(Object.keys(bridge).sort(), ['Config', 'apply', 'inject', 'name']);
  // `package.json` `exports` must also make the declared type surface reachable.
  assert.ok(existsSync(join(ROOT, 'lib', 'types', 'index.d.ts')), 'declared types file is missing');
});

test('every bare @deepseek-ai import is declared for installation', async () => {
  const manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  const declared = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ]);
  // A bare import that no profile can resolve fails at *install* time, which no
  // unit test can observe; the entry is the only place that knows them all.
  const entry = await readFile(join(ROOT, 'lib', 'index.js'), 'utf8');
  const storage = await readFile(join(ROOT, 'lib', 'host', 'storage.js'), 'utf8');
  const tools = await readFile(join(ROOT, 'lib', 'tools.js'), 'utf8');
  const llm = await readFile(join(ROOT, 'lib', 'host', 'llm.js'), 'utf8');
  const sources = [entry, storage, tools, llm].join('\n');
  const bare = new Set(
    [...sources.matchAll(/from\s+'(@deepseek-ai\/[^']+)'/g)].map((match) => match[1]),
  );
  // Dynamic `import(...)` of a bare specifier counts too: it fails just as hard.
  for (const match of sources.matchAll(/import\(\s*'(@deepseek-ai\/[^']+)'\s*\)/g)) bare.add(match[1]);
  for (const specifier of bare) {
    assert.ok(declared.has(specifier), `${specifier} is imported but not declared in package.json`);
  }
  // `ws` is a runtime dependency of the websocket carrier.
  assert.ok(declared.has('ws'), 'ws is imported by the ws carrier but not declared');
});

test('the bridge activates on the real Cordis lifecycle and tears down through ctx.effect', async (t) => {
  if (STORAGE_FIXTURE_REASON !== null) {
    t.skip(STORAGE_FIXTURE_REASON);
    return;
  }
  const { app, tools, storagesRoot } = await mountHostFacilities();
  try {
    const { fiber } = mountBridge(app, { connections: [] });
    await tick();

    const mounted = fiber();
    assert.ok(mounted, 'apply never ran');
    assert.equal(mounted.state, 2, 'fiber is not ACTIVE after apply');
    // Tools belong to the entry, not to a connection: they are visible even
    // with no ready peer, and answer `not_ready` when called. Registering per
    // connection is what made a second peer fail to start.
    assert.deepEqual(
      [...tools().registered.keys()].sort(),
      ['bridge_call_astr_tool', 'bridge_list_sessions', 'bridge_submit_task', 'bridge_task_status'],
      'the entry must register the four bridge tools exactly once',
    );

    await mounted.dispose();
    assert.equal(mounted.state, 4, 'fiber is not DISPOSED after dispose');
    assert.equal(tools().registered.size, 0, 'teardown left a tool registered');
  } finally {
    await rm(storagesRoot, { recursive: true, force: true });
  }
});

test('a profile without the storage hub parks the fiber instead of failing it', async (t) => {
  if (STORAGE_FIXTURE_REASON !== null) {
    t.skip(STORAGE_FIXTURE_REASON);
    return;
  }
  // `storage` is a declared dependency, so a profile that does not mount the
  // hub must leave the bridge PENDING (it starts when the service appears), and
  // must never run `apply` far enough to read an undeclared property.
  const { app, storagesRoot } = await mountHostFacilities({ withStorage: false });
  try {
    const { fiber } = mountBridge(app, { connections: [] });
    await tick();

    const mounted = fiber();
    assert.ok(mounted, 'the plugin was never mounted');
    assert.equal(mounted.state, 0, 'a missing storage hub must leave the fiber PENDING, not FAILED');
    assert.equal(inject.includes('storage'), true, 'storage must stay a declared dependency');

    // A parked fiber still disposes cleanly: unload must not wait for a service.
    await mounted.dispose();
    assert.equal(mounted.state, 4, 'a parked fiber must dispose');
  } finally {
    await rm(storagesRoot, { recursive: true, force: true });
  }
});

test('the real hub receives the records the entry persists', async (t) => {
  if (STORAGE_FIXTURE_REASON !== null) {
    t.skip(STORAGE_FIXTURE_REASON);
    return;
  }
  // The store is a real `BridgeStore` over the real hub — not a `{}` stand-in.
  // A stub object cannot store anything, so it would only prove the entry calls
  // `init()`; this case proves the records land in the hub's per-record layout.
  const { app, storagesRoot } = await mountHostFacilities();
  try {
    const store = new BridgeStore({ storage: app.storage, logger: LOGGER });
    await store.init();
    try {
      assert.equal(store._unit?.constructor?.name, 'HostUnit', 'the hub backend must be chosen');
      await store.putTask({ task_id: 'assembly:t:1', status: 'accepted', root_task_id: 'assembly:t:1' });
      assert.equal((await store.getTask('assembly:t:1'))?.status, 'accepted');
    } finally {
      await store.close();
    }
    // The hub writes under its own root; the record must be interrogable after
    // a reopen, which is the whole point of using the hub instead of a stub.
    const reopened = new BridgeStore({ storage: app.storage, logger: LOGGER });
    await reopened.init();
    try {
      assert.equal((await reopened.getTask('assembly:t:1'))?.status, 'accepted');
    } finally {
      await reopened.close();
    }
    // The hub's own unit-name rule is the real one; assert against it rather
    // than against this project's copy of the regex.
    assert.match(UNIT_NAME, STORAGE_HUB.module.UNIT_NAME_RE, 'the unit name must satisfy the hub rule');
    assert.ok(existsSync(join(storagesRoot, UNIT_NAME, 'tasks')), 'records must live under the hub root');
  } finally {
    await rm(storagesRoot, { recursive: true, force: true });
  }
});

test('the default config is valid and idles without a connection', async () => {
  const parsed = Config({});
  assert.deepEqual(parsed.connections, []);
  assert.equal(parsed.side, 'B');
  assert.equal(parsed.remoteNativeApproval, true);
  assert.equal(parsed.approvalTimeoutSeconds, 1800);
  // The documented defaults must survive normalisation unchanged.
  const settings = normaliseConfig(parsed);
  assert.equal(settings.heartbeatInterval, 30);
  assert.equal(settings.wakeMaxChain, 8);
  assert.deepEqual(settings.imageAllowedMime, ['image/gif', 'image/jpeg', 'image/png', 'image/webp']);
  // Values outside the protocol's hard bounds are clamped, never silently kept.
  assert.equal(normaliseConfig({ heartbeatInterval: 0 }).heartbeatInterval, 5);
  assert.equal(normaliseConfig({ wakeMaxChain: 999 }).wakeMaxChain, 64);
  assert.equal(normaliseConfig({ approvalTimeoutSeconds: 1 }).approvalTimeoutSeconds, 30);
});

test('tool registration is owned by the entry: registered once, reversed on unload', async () => {
  // Tools belong to the entry, not to a connection. The real registry rejects a
  // duplicate name, so a per-connection registration made the second ready peer
  // fail to start and made `stop()` remove every other connection's tools.
  const app = new Context();
  new PromptStub(app);
  const runtime = new ToolRuntime(app);
  /** @returns {string[]} names the real registry would present to a model. */
  const registeredNames = () => runtime.schemas(undefined).map((schema) => schema.name).sort();
  const deps = { tasks: {}, sessions: {}, config: {}, logger: SILENT };

  const dispose = registerBridgeTools(app, deps);
  assert.deepEqual(registeredNames(), [
    'bridge_call_astr_tool',
    'bridge_list_sessions',
    'bridge_submit_task',
    'bridge_task_status',
  ]);

  // The registry itself refuses the duplicate: this is why registration cannot
  // happen per connection or per reconnect.
  assert.throws(
    () => registerBridgeTools(app, deps),
    /already registered/,
    'a second registration must be refused by the real registry',
  );
  assert.equal(registeredNames().length, 4, 'a refused duplicate must not change the registry');

  // Unload reverses exactly what it added, and a reload can register again.
  dispose();
  assert.deepEqual(registeredNames(), [], 'unload did not reverse tool registration');
  const reloaded = registerBridgeTools(app, deps);
  assert.equal(registeredNames().length, 4, 'a reload after unload must register again');
  reloaded();
  assert.deepEqual(registeredNames(), []);

  // A supervisor's `stop()` must not touch the entry's tools.
  const supervisor = new Supervisor({
    ctx: app,
    settings: supervisorSettings(),
    connection: connectionRecord('conn-a'),
    store: {},
    agentHost: {},
    attachmentHost: {},
    logger: LOGGER,
  });
  supervisor.services = {
    tasks: {},
    sessions: {},
    approvals: { onSessionLost() {}, stop() {} },
    notify: { stop() {} },
  };
  const entryTools = registerBridgeTools(app, deps);
  await supervisor.stop();
  assert.equal(registeredNames().length, 4, 'stopping one connection must not remove the entry tools');
  entryTools();
});

test('the tools the entry registers satisfy the real argument compiler', async () => {
  const app = new Context();
  new PromptStub(app);
  const runtime = new ToolRuntime(app);
  const { submitTaskTool } = await import('../lib/tools.js');
  const tool = submitTaskTool({
    tasks: {
      async submitOutbound() {
        return { task_id: 't', root_task_id: 't', status: 'accepted', dedup: false };
      },
    },
    sessions: {},
    config: {},
    logger: SILENT,
  });
  // The real registry compiles the declared parameter spec; a schema the harness
  // rejects would only surface when a model calls the tool.
  runtime.register(tool);
  // `defineTool` compiles the author spec into a raw JSON Schema object root.
  assert.equal(tool.parameters.type, 'object');
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ['purpose', 'session_id', 'text']);
  assert.deepEqual(tool.parameters.required, ['text']);
  const result = await tool.execute({ text: 'hi' }, {});
  assert.equal(result.task_id, 't');
  assert.deepEqual(tool.output.render({}, result).map((block) => block.type), ['text']);
});

test('the bridge store persists under its own root and refuses unsafe roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'assembly-store-'));
  try {
    const first = new BridgeStore({ dataRoot: root, logger: LOGGER });
    await first.init();
    await first.putTask({ task_id: 'task-1', status: 'accepted', root_task_id: 'task-1' });
    await first.applyAuthz({ version: 1, grants: [{ session_id: 's1' }], allow_agent_create: false, max_agent_sessions: 0 });
    await first.close();

    // A restart must recover both records from the same root — this is the
    // "持久恢复" half of the PRD, and it is the file backend's own contract.
    const second = new BridgeStore({ dataRoot: root, logger: LOGGER });
    await second.init();
    assert.equal((await second.getTask('task-1'))?.status, 'accepted');
    assert.equal((await second.authzSnapshot()).version, 1);
    await second.close();

    // Data must never land in the plugin checkout, nor depend on the cwd.
    await assert.rejects(() => resolveDataRoot({ dataRoot: 'relative/data' }), /internal|absolute/i);
    await assert.rejects(() => resolveDataRoot({ dataRoot: join(ROOT, 'data') }), /internal|inside/i);
    const resolved = await resolveDataRoot({ dataRoot: root });
    assert.equal(resolved, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a claim needs a bound sid and a peer authorization, not just a known session', async () => {
  const app = new Context();
  const root = await mkdtemp(join(tmpdir(), 'assembly-claim-'));
  try {
    const store = new BridgeStore({ dataRoot: root, logger: LOGGER });
    await store.init();
    await store.applyAuthz({ version: 1, grants: [{ session_id: 'granted' }], allow_agent_create: false, max_agent_sessions: 0 });

    const forwarded = [];
    const session = {
      sid: 'sid-1',
      async call(_m, params) {
        forwarded.push(params);
        return { accepted: true };
      },
    };
    const service = new ApprovalService({
      store,
      session,
      host: {},
      notify: { startResendLoop() {}, stop() {} },
      config: { approvalTimeoutSeconds: 1800 },
      logger: SILENT,
      remoteApprovalEnabled: true,
    });
    // Nothing is bound yet: every request must fall through to the local answerer.
    await service.attach(app);
    const bare = await app.waterfall(
      'approval/request',
      { agent: { session: { id: 'granted' } }, toolName: 'bash' },
      () => Promise.resolve('delegated'),
    );
    assert.equal(bare, 'delegated');
    assert.equal(forwarded.length, 0);

    service.onSessionReady('conn-a', 'sid-1');
    // An ungranted session still delegates, even though it is bound and online.
    const ungranted = await app.waterfall(
      'approval/request',
      { agent: { session: { id: 'other' } }, toolName: 'bash' },
      () => Promise.resolve('delegated'),
    );
    assert.equal(ungranted, 'delegated');
    assert.equal(forwarded.length, 0);

    // The granted session is claimed: the peer receives the question and no
    // local answerer runs.
    const claimed = app.waterfall(
      'approval/request',
      { agent: { session: { id: 'granted' } }, toolName: 'bash' },
      () => Promise.resolve('delegated'),
    );
    await tick(60);
    assert.equal(forwarded.length, 1);
    assert.equal(forwarded[0].session_id, 'granted');
    service.stop();
    assert.equal(await claimed, 'unavailable', 'a torn-down channel must fail closed');
    await store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('webhook keeps an inbound endpoint in both roles; only long poll goes without one', async () => {
  // The contract under test, in one place:
  //   - webhook is bidirectional by design, so *both* roles own an inbound
  //     listener. A `connect` endpoint with no server can send but never receive
  //     reverse events, which is the defect this asserts against.
  //   - the address each side POSTs to comes from configuration
  //     (`peerHost`/`peerPort`), never from the local bind address, so a frame
  //     is never delivered back to its own sender.
  //   - long poll is the carrier that works one-way: its `connect` role must
  //     still open no listener and must still need no reverse reachability.
  const peer = await startRecordingPeer();
  const peerPort = peer.port;
  const hooks = { onPlain() {}, onEnvelope() {}, onState() {} };
  const ownInbound = [];
  const recordingHooks = { ...hooks, onEnvelope: (frame) => ownInbound.push(frame) };
  // `host`/`port` keep their historical meaning. On the connect side they name
  // the peer, so the local bind must come from `bindHost`/`bindPort` — binding
  // the peer's port is how a carrier ends up talking to itself.
  const connectCfg = {
    id: 'probe',
    mode: 'connect',
    host: '127.0.0.1',
    port: peerPort,
    path: '/dsh-bridge',
    tlsEnabled: false,
    bindHost: '127.0.0.1',
    bindPort: 0,
    peerHost: '127.0.0.1',
    peerPort,
  };

  // `connect`: the local listener exists so the peer can POST reverse frames.
  const connect = new WebhookTransport({ logger: SILENT, probeIntervalMs: 60_000 });
  try {
    await connect.start(connectCfg, recordingHooks);
    assert.notEqual(connect._server, null, 'connect mode must open its own inbound endpoint');
    assert.ok(connect.boundPort > 0, 'connect mode must bind a real port');
    assert.notEqual(connect.boundPort, peerPort, 'connect mode must not bind the peer port');
    // Its inbound endpoint is live: the peer can reach it.
    const health = await fetch(`http://127.0.0.1:${connect.boundPort}${connectCfg.path}/health`);
    assert.equal(health.status, 200, 'the inbound endpoint must serve /health');
    await health.text();
    // The outbound target is the configured peer, and the frame lands there —
    // not on this endpoint's own inbound handler.
    assert.deepEqual(peerTarget(connectCfg), { host: '127.0.0.1', port: peerPort });
    assert.deepEqual(bindTarget(connectCfg), { host: '127.0.0.1', port: 0 });
    assert.equal(sameEndpoint(peerTarget(connectCfg), { host: '127.0.0.1', port: connect.boundPort }), false);
    await connect.sendEnvelope({ seq: 1, type: 'evt', sid: null });
    assert.deepEqual(
      peer.seen.filter((entry) => entry.url.endsWith('/frames')).map((entry) => entry.method),
      ['POST'],
      'the frame must be POSTed to the configured peer',
    );
    assert.deepEqual(ownInbound, [], 'a frame must never be delivered back to its own sender');
    assert.equal(connect.boundPort, connect._server.address().port);
  } finally {
    await connect.stop();
    await peer.close();
  }

  // `listen`: same requirement in the other direction. The listener serves
  // inbound frames and still POSTs reverse ones to its configured peer.
  const peer2 = await startRecordingPeer();
  const listenCfg = {
    ...connectCfg,
    id: 'probe-listen',
    mode: 'listen',
    // Listen mode keeps the historical meaning: `host`/`port` *is* the bind
    // address when `bindPort` says nothing (0 = unset).
    bindHost: '',
    bindPort: 0,
    port: await freePort(),
    peerPort: peer2.port,
  };
  const listen = new WebhookTransport({ logger: SILENT, probeIntervalMs: 60_000 });
  try {
    await listen.start(listenCfg, recordingHooks);
    assert.notEqual(listen._server, null, 'listen mode must open its inbound endpoint');
    assert.equal(listen.boundPort, listenCfg.port, 'listen mode binds the historical port');
    // `host`/`port` keep their listen meaning, but the peer pair is separate, so
    // the listener never posts reverse frames to `host:port`.
    assert.deepEqual(peerTarget(listenCfg), { host: '127.0.0.1', port: peer2.port });
    assert.notEqual(peer2.port, listenCfg.port);
    await listen.sendEnvelope({ seq: 2, type: 'evt', sid: null });
    assert.equal(peer2.seen.filter((entry) => entry.url.endsWith('/frames')).length, 1);
    assert.notEqual(listen.boundPort, peer2.port);
  } finally {
    await listen.stop();
    await peer2.close();
  }

  // A listen endpoint with no configured peer still listens, but its outbound
  // path fails closed instead of falling back to its own address.
  const noPeer = new WebhookTransport({ logger: SILENT, probeIntervalMs: 60_000 });
  try {
    const cfg = {
      id: 'no-peer',
      mode: 'listen',
      host: '127.0.0.1',
      port: 0,
      path: connectCfg.path,
      tlsEnabled: false,
    };
    await noPeer.start(cfg, hooks);
    assert.notEqual(noPeer._server, null);
    assert.equal(peerTarget(cfg), null, 'listen mode must not fall back to its own bind address');
    await assert.rejects(
      () => noPeer.sendEnvelope({ seq: 3, type: 'evt' }),
      (error) => error instanceof BridgeError && error.code === 'config_invalid',
      'an unconfigured peer must fail closed, not post to itself',
    );
    // The configuration gap is not a network fault: it must not count towards
    // degradation, which would otherwise trigger a pointless fallback.
    assert.equal(await noPeer.probeOnce(), false);
    assert.equal(noPeer.probeFailures, 0);
  } finally {
    await noPeer.stop();
  }

  // Long poll, by contrast, must keep working with *no* inbound endpoint and no
  // reachable peer at all: reverse delivery is a `GET /poll` this side pulls.
  const longpoll = new LongPollTransport({ logger: SILENT });
  try {
    let polls = 0;
    longpoll._pollOnce = async () => {
      polls += 1;
      longpoll._polling = false;
    };
    // Port 9 (discard) is used precisely because nothing listens there: a
    // carrier that needed reverse reachability could not start.
    await longpoll.start(
      { id: 'probe', mode: 'connect', host: '127.0.0.1', port: 9, path: '/dsh-bridge', tlsEnabled: false },
      hooks,
    );
    assert.equal(longpoll._server, null, 'long poll connect mode must not open a listening socket');
    longpoll.setSessionIdentity('sid-1', 'B');
    await tick(60);
    assert.equal(polls, 1, 'connect mode never started the pull loop');
  } finally {
    await longpoll.stop();
  }
});

test('the published bundle contains every path the manifest promises', async () => {
  const manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  const packed = JSON.parse(
    execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: ROOT, encoding: 'utf8' }),
  );
  const files = new Set(packed[0].files.map((file) => file.path));
  for (const required of ['lib/index.js', 'lib/tools.js', 'lib/store.js', 'cordis.patch.yml', 'lib/types/index.d.ts']) {
    assert.ok(files.has(required), `${required} is missing from the published bundle`);
  }
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  assert.ok(files.has('cordis.patch.yml'));
});

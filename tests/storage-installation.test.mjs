/**
 * Installation and storage-root tests (PRD §5, protocol §10.1/§10.2).
 *
 * These tests exist because of a real installation blocker. The store used to
 * read `ctx.storage` inside `init()`:
 *
 *   1. Cordis resolves context properties through a proxy whose `get` trap
 *      **throws** for any name the plugin did not declare in `inject`
 *      (`cannot get property "storage" without inject`). The entry declares
 *      `['agents', 'attachments', 'approval', 'tools']`, so `store.init()`
 *      threw before the bridge could start at all.
 *   2. A `catch` around it would have been worse than the crash: it turned a
 *      missing host backend into a *different*, silently chosen store, and the
 *      bridge would report "persisted" while writing somewhere nobody expected.
 *   3. `UNIT_NAME = 'astrbot-bridge'` violated the hub's `/^[a-z][a-z0-9_]*$/`
 *      rule, so even a correctly injected hub rejected every `open` with
 *      `malformed-medium`.
 *   4. The host unit wrote keys through `safeKey()` but returned the encoded
 *      keys unchanged from `loadAll()`, so every record whose identity contains
 *      `:` or `.` was invisible after a restart.
 *
 * The suite therefore proves the current behaviour against the **real** Cordis
 * and storage packages, never a hand-made imitation: activation, durability
 * across a reopen, and fail-closed write/open errors.
 * @module dsh-plugin-astrbot-bridge/tests/storage-installation
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { BridgeError } from '../lib/errors.js';
import { BridgeStore, UNIT_NAME } from '../lib/store.js';

/** Resolver for `package.json` lookups of the installed dependency tree. */
const require = createRequire(import.meta.url);

/** Services the entry declares in `inject`; a real profile provides them. */
const ENTRY_SERVICES = ['agents', 'attachments', 'approval', 'tools', 'storage'];

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

/**
 * Create a temporary directory removed by the caller.
 * @param {string} prefix - directory name prefix.
 * @returns {Promise<string>} absolute path.
 */
async function tempRoot(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

/**
 * Run one callback with `DSH_HOME` pointed at a temporary directory.
 * @param {Function} body - receives the temporary home.
 * @returns {Promise<void>} resolution after cleanup.
 */
async function withDshHome(body) {
  const home = await tempRoot('bridge-dsh-home-');
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    await body(home);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
}

/**
 * Build a real Cordis context with the entry's services provided.
 *
 * The four non-storage services are genuine Cordis services whose only job is to
 * exist, so the fiber activates for the same reason it would in a profile: every
 * declared dependency resolves. `storage` is not stubbed: the entry hands
 * `ctx.storage` to the store, so the fixture mounts the **real** `dsh-storage`
 * hub and the **real** `dsh-storage-json` backend over a temporary root. An
 * arbitrary `{}` would satisfy the injection check while proving nothing about
 * whether the entry can actually persist, which is the whole point of this
 * suite.
 * @param {object} cordis - the real `@deepseek-ai/cordis` module.
 * @param {object} [options] - fixture options.
 * @param {string} [options.storagesRoot] - json backend root (required: the hub
 *   writes here, so the caller owns the temporary directory).
 * @param {boolean} [options.withStorage] - mount the hub (default true).
 * @returns {Promise<object>} the context.
 */
async function contextWithEntryServices(cordis, { storagesRoot, withStorage = true } = {}) {
  const ctx = new cordis.Context();
  for (const serviceName of ENTRY_SERVICES) {
    // `storage` is mounted as the real service below; stubbing it would make the
    // store's own "is there a hub" branch untested.
    if (serviceName === 'storage') continue;
    const Stub = class extends cordis.Service {
      constructor(parent) {
        super(parent, serviceName);
        // `tools` is a registry in the real host: the entry registers the four
        // bridge tools through it, so the stub must accept a definition and
        // return a disposer. Every other stub only has to exist.
        if (serviceName === 'tools') {
          /** @type {Map<string, object>} */
          this.registered = new Map();
        }
      }

      /**
       * Record one tool definition (only meaningful for `tools`).
       * @param {object} definition - tool definition.
       * @returns {() => void} disposer removing it.
       */
      register(definition) {
        this.registered.set(definition.name, definition);
        return () => {
          this.registered.delete(definition.name);
        };
      }
    };
    new Stub(ctx);
  }
  if (withStorage) {
    if (typeof storagesRoot !== 'string' || storagesRoot.length === 0) {
      throw new Error('the real storage fixture needs a temporary root');
    }
    const hub = await tryImport('@deepseek-ai/dsh-storage');
    const json = await tryImport('@deepseek-ai/dsh-storage-json');
    if (hub.module === null || json.module === null) {
      throw new Error(`real storage packages unavailable (${hub.reason ?? json.reason})`);
    }
    await ctx.plugin(hub.module.default);
    await ctx.plugin(json.module, { root: storagesRoot });
  }
  return ctx;
}

/**
 * Wait for an unsettled fiber, resolving with its failure instead of throwing.
 * @param {Promise<object>} fiber - plugin fiber.
 * @returns {Promise<{error: Error|null}>} outcome.
 */
async function settle(fiber) {
  try {
    await fiber;
    return { error: null };
  } catch (error) {
    return { error };
  }
}

test('the original failure is real: an undeclared ctx.storage read throws', async (t) => {
  const cordis = await tryImport('@deepseek-ai/cordis');
  if (cordis.module === null) {
    t.skip(`real host package unavailable (${cordis.reason})`);
    return;
  }
  const storagesRoot = await tempRoot('bridge-storages-');
  try {
    // The hub *is* mounted — that is what makes the original bug so easy to
    // misread. Cordis does not hand out services that were not declared, so a
    // profile-provided hub was never reachable through `ctx.storage`; the fibre
    // failed on the property read itself, before `try`/`catch` could help.
    const ctx = await contextWithEntryServices(cordis.module, { storagesRoot });
    const fiber = ctx.plugin({
      name: 'repro-undeclared-service',
      // The declaration the entry had when the installation blocker shipped.
      inject: ['agents', 'attachments', 'approval', 'tools'],
      apply(context) {
        // This is exactly what `BridgeStore.init()` used to do.
        void context.storage;
      },
    });
    const { error } = await settle(fiber);
    assert.ok(error !== null, 'reading a service outside inject must fail the fiber');
    assert.match(error.message, /cannot get property "storage" without inject/);
    await fiber.dispose();

    // And the unchanged counterpart: once declared, the same read is legal.
    const declared = ctx.plugin({
      name: 'repro-declared-service',
      inject: ENTRY_SERVICES,
      apply(context) {
        assert.notEqual(context.storage, undefined, 'a declared service must be readable');
      },
    });
    assert.equal((await settle(declared)).error, null);
    await declared.dispose();
  } finally {
    await rm(storagesRoot, { recursive: true, force: true });
  }
});

test('the store adds no undeclared context property to the entry', async () => {
  const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const source = stripComments(await readFile(new URL('../lib/store.js', import.meta.url), 'utf8'));
  for (const pattern of [/ctx\s*\?\.\s*storage/, /\bctx\.storage/, /this\.ctx\b/]) {
    assert.ok(!pattern.test(source), `store.js must not read the context (${pattern})`);
  }
  assert.match(source, /options\.storage/, 'the hub must arrive as an explicit option');
  const entry = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8');
  const declared = entry.match(/export const inject = \[([^\]]+)\]/);
  assert.ok(declared !== null, 'the entry must declare its injected services');
  const services = declared[1].split(',').map((name) => name.trim().replace(/^'|'$/g, ''));
  // The store itself no longer depends on this list; the assertion pins the
  // current declaration so a future change here has to be deliberate.
  assert.deepEqual(services, ENTRY_SERVICES);
});

test('the entry activates with default connections against the real hub', async (t) => {
  const cordis = await tryImport('@deepseek-ai/cordis');
  if (cordis.module === null) {
    t.skip(`real host package unavailable (${cordis.reason})`);
    return;
  }
  const storagesRoot = await tempRoot('bridge-storages-');
  try {
    await withDshHome(async (home) => {
      const entry = await import('../lib/index.js');
      const ctx = await contextWithEntryServices(cordis.module, { storagesRoot });
      const fiber = ctx.plugin(entry.default, { connections: [] });
      const { error } = await settle(fiber);
      assert.equal(error, null, `the bridge must start with no connections (${error?.message})`);
      assert.equal(fiber.state, 2, 'the fiber must be ACTIVE, not FAILED or PENDING');

      // The entry must have used the *hub*, not the file fallback: the file
      // backend materialises `<DSH_HOME>/bridge/astrbot` at init, and it is only
      // reached when no hub was supplied. Its absence is the observable evidence
      // that `ctx.storage` was handed to the store.
      const fileRoot = await stat(join(home, 'bridge', 'astrbot')).catch(() => null);
      assert.equal(
        fileRoot,
        null,
        'the file backend must not be opened when the profile provides a storage hub',
      );

      // While the entry is live it owns the unit: the hub does not hand the same
      // `(name, version)` to a second opener, so a concurrent store must fail
      // closed rather than silently split the records across two writers.
      await assert.rejects(
        new BridgeStore({ storage: ctx.storage }).init(),
        (error) => error instanceof BridgeError && error.code === 'internal_error',
        'a second concurrent opener must fail closed',
      );
      assert.equal(
        await stat(join(home, 'bridge', 'astrbot')).catch(() => null),
        null,
        'a refused concurrent open must not create the file root either',
      );

      await fiber.dispose();
      assert.equal(fiber.state, 4, 'the fiber must DISPOSE cleanly');

      // After unload the same hub is free again, and it is a working hub — not a
      // stand-in: a record written through `ctx.storage` lands in the hub's
      // per-record layout and reads back after a reopen.
      const store = new BridgeStore({ storage: ctx.storage });
      await store.init();
      try {
        assert.equal(store._unit?.constructor?.name, 'HostUnit', 'the hub backend must be chosen');
        await store.putTask({ task_id: 'install:t:1', status: 'queued', root_task_id: 'install:t:1' });
      } finally {
        await store.close();
      }
      const unitDir = join(storagesRoot, UNIT_NAME);
      const info = await stat(unitDir).catch(() => null);
      assert.ok(info !== null && info.isDirectory(), `the hub unit must exist (${unitDir})`);

      const reopened = new BridgeStore({ storage: ctx.storage });
      await reopened.init();
      try {
        assert.equal((await reopened.getTask('install:t:1'))?.status, 'queued', 'the hub must be durable');
      } finally {
        await reopened.close();
      }

      // Nothing may be written into the plugin checkout.
      assert.ok(
        !unitDir.startsWith(new URL('..', import.meta.url).pathname),
        'the storage root must not be inside the package',
      );
    });
  } finally {
    await rm(storagesRoot, { recursive: true, force: true });
  }
});

test('a profile that mounts no storage parks the entry instead of failing it', async (t) => {
  const cordis = await tryImport('@deepseek-ai/cordis');
  if (cordis.module === null) {
    t.skip(`real host package unavailable (${cordis.reason})`);
    return;
  }
  // `storage` is a declared dependency. A profile without it must leave the
  // bridge PENDING — it starts when the service appears — and must never run
  // `apply` far enough to crash on the property read (the original blocker).
  const ctx = await contextWithEntryServices(cordis.module, { withStorage: false });
  const entry = await import('../lib/index.js');
  const fiber = ctx.plugin(entry.default, { connections: [] });
  // `await fiber` resolves on disposal too, so an observation window is the only
  // way to distinguish "parked" from "quickly disposed".
  const { error } = await Promise.race([
    settle(fiber),
    new Promise((resolve) => setTimeout(() => resolve({ error: null }), 400)),
  ]);
  assert.equal(error, null, `a parked fiber must not fail (${error?.message})`);
  assert.equal(fiber.state, 0, 'a missing storage hub must leave the fiber PENDING, not FAILED');
  assert.notEqual(fiber.state, 3, 'the original installation blocker must not come back');

  // A parked fiber still disposes: unloading must not wait for a service.
  await fiber.dispose();
  assert.equal(fiber.state, 4, 'a parked fiber must dispose');
});

test('a supplied storage hub is used, stays durable and keeps names valid', async (t) => {
  const cordis = await tryImport('@deepseek-ai/cordis');
  const storage = await tryImport('@deepseek-ai/dsh-storage');
  const json = await tryImport('@deepseek-ai/dsh-storage-json');
  if (cordis.module === null || storage.module === null || json.module === null) {
    t.skip(`real host packages unavailable (${cordis.reason ?? storage.reason ?? json.reason})`);
    return;
  }
  const storagesRoot = await tempRoot('bridge-storages-');
  const dataRoot = await tempRoot('bridge-files-');
  try {
    const ctx = new cordis.module.Context();
    await ctx.plugin(storage.module.default);
    await ctx.plugin(json.module, { root: storagesRoot });

    // The hub rejects a name outside ITS own rule; assert the real one.
    assert.match(UNIT_NAME, storage.module.UNIT_NAME_RE);

    const store = new BridgeStore({ storage: ctx.storage, dataRoot });
    await store.init();
    assert.equal(store._unit.constructor.name, 'HostUnit', 'the hub backend must win over the file root');
    const task = {
      task_id: 'conn:default:t:1',
      root_task_id: 'conn:default:t:1',
      status: 'queued',
      updated_at: new Date().toISOString(),
    };
    await store.putTask(task);
    // A key with `:` is encoded on the medium; it must still be readable.
    assert.equal((await store.getTask(task.task_id)).status, 'queued');
    await store.close();

    // Nothing may have been written to the file root: one backend, not two.
    assert.deepEqual(await readdir(dataRoot), []);
    const unitDir = join(storagesRoot, UNIT_NAME, 'tasks');
    assert.ok((await readdir(unitDir)).length > 0, 'the host backend must hold the records');

    // Reopen: durability and key decoding both survive a restart.
    const reopened = new BridgeStore({ storage: ctx.storage, dataRoot });
    await reopened.init();
    assert.equal((await reopened.getTask(task.task_id)).status, 'queued', 'a colon key must read back after reopen');
    await reopened.close();
  } finally {
    await rm(storagesRoot, { recursive: true, force: true });
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('a present but unusable hub fails closed instead of falling back', async () => {
  const dataRoot = await tempRoot('bridge-files-');
  try {
    const noBackend = { backend: { get: () => { throw new Error('backend-not-found'); } } };
    await assert.rejects(
      new BridgeStore({ storage: noBackend, dataRoot }).init(),
      (error) => error instanceof BridgeError && error.code === 'internal_error',
    );
    const rejectedUnit = {
      backend: { get: () => ({ kv: { open: async () => { throw new Error('malformed-medium'); } } }) },
    };
    await assert.rejects(
      new BridgeStore({ storage: rejectedUnit, dataRoot }).init(),
      (error) => error instanceof BridgeError && error.code === 'internal_error',
    );
    const noKvFacet = { backend: { get: () => ({}) } };
    await assert.rejects(
      new BridgeStore({ storage: noKvFacet, dataRoot }).init(),
      (error) => error instanceof BridgeError && error.code === 'internal_error',
    );
    // No fallback wrote anything: the file root is still untouched.
    assert.deepEqual(await readdir(dataRoot), []);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('an unwritable data root fails at startup, not on the first task', async () => {
  const parent = await tempRoot('bridge-files-');
  try {
    // A regular file where the store needs a directory: creating the root fails.
    const blocker = join(parent, 'blocked');
    await writeFile(blocker, 'not a directory');
    await assert.rejects(
      new BridgeStore({ dataRoot: join(blocker, 'nested') }).init(),
      (error) => error instanceof BridgeError && error.code === 'internal_error',
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('a write failure rejects instead of reporting a durable success', async () => {
  const parent = await tempRoot('bridge-files-');
  try {
    const store = new BridgeStore({ dataRoot: parent });
    await store.init();
    // A file where the `tasks` table directory belongs: later record writes fail.
    await writeFile(join(parent, 'tasks'), 'not a directory');
    await assert.rejects(store.putTask({ task_id: 't1', status: 'queued' }));
    assert.equal(await store.get('tasks', 't1'), null, 'a failed write must not be readable as success');
    await store.close();
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('the store refuses to open without a durable root or a hub', async () => {
  await assert.rejects(
    new BridgeStore({}).init(),
    (error) => error instanceof BridgeError && error.code === 'internal_error',
  );
  await assert.rejects(
    new BridgeStore({ dataRoot: '   ' }).init(),
    (error) => error instanceof BridgeError && error.code === 'internal_error',
  );
});

test('the data-root resolver never returns a repository or relative path', async () => {
  const { resolveDataRoot } = await import('../lib/host/storage.js');
  const packageRoot = new URL('..', import.meta.url).pathname;
  const home = await tempRoot('bridge-home-');
  try {
    assert.equal(
      await resolveDataRoot({ dataRoot: join(home, 'custom') }),
      join(home, 'custom'),
      'an absolute override is honoured as-is',
    );
    await assert.rejects(
      resolveDataRoot({ dataRoot: 'relative/data' }),
      (error) => error instanceof BridgeError && error.code === 'internal_error',
    );
    await assert.rejects(
      resolveDataRoot({ dataRoot: join(packageRoot, 'data') }),
      (error) => error instanceof BridgeError && error.code === 'internal_error',
    );
    // The real helper puts the root under the harness home.
    const dshHome = await tempRoot('bridge-dshhome-');
    process.env.DSH_HOME = dshHome;
    try {
      assert.equal(await resolveDataRoot({}), join(dshHome, 'bridge', 'astrbot'));
    } finally {
      delete process.env.DSH_HOME;
      await rm(dshHome, { recursive: true, force: true });
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('a missing home-paths package falls back loudly, never to the CWD', async () => {
  // The dynamic import can only be forced to fail in a fresh module graph, so
  // the branch is exercised in a child process with a resolve hook that blocks
  // the package. This is the "dynamic import failed" path the store must never
  // turn into a repository-relative root.
  const module = new URL('../lib/host/storage.js', import.meta.url).href;
  const program = `
    import { registerHooks } from 'node:module';
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === '@deepseek-ai/dsh-home-paths') throw new Error('blocked by test');
        return nextResolve(specifier, context);
      },
    });
    const { resolveDataRoot } = await import(process.argv[1]);
    const warned = [];
    const logger = { warn: (event) => warned.push(event), error() {}, info() {}, debug() {}, failure() {} };
    try {
      const root = await resolveDataRoot({ env: { DSH_HOME: process.argv[2], HOME: '' }, logger });
      console.log(JSON.stringify({ ok: true, root, warned }));
    } catch (error) {
      console.log(JSON.stringify({ ok: false, code: error.code, reason: error.details?.reason, warned }));
    }
  `;
  /**
   * Run the probe with one `DSH_HOME` value.
   * @param {string} dshHome - anchor to pass.
   * @returns {Promise<object>} parsed probe output.
   */
  const probe = (dshHome) =>
    new Promise((resolve, reject) => {
      execFile(
        process.execPath,
        ['--input-type=module', '-e', program, module, dshHome],
        (error, stdout, stderr) => {
          if (error) reject(new Error(`${error.message}\n${stderr}`));
          else resolve(JSON.parse(stdout));
        },
      );
    });

  const anchored = await probe('/tmp/bridge-fallback-anchor');
  assert.equal(anchored.ok, true, 'the documented $DSH_HOME rule must still resolve');
  assert.equal(anchored.root, join('/tmp/bridge-fallback-anchor', 'bridge', 'astrbot'));
  assert.deepEqual(anchored.warned, ['storage_root_fallback'], 'the fallback must be logged, not swallowed');

  const anchorless = await probe('');
  assert.equal(anchorless.ok, false, 'no anchor must fail rather than fall back to the CWD');
  assert.equal(anchorless.code, 'internal_error');
  assert.equal(anchorless.reason, 'home_unresolved');
});

test('a blank DSH_HOME never resolves the root to the working directory', async () => {
  const { resolveDataRoot } = await import('../lib/host/storage.js');
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = '   ';
  try {
    const root = await resolveDataRoot({});
    assert.ok(root.startsWith('/'), 'the root must stay absolute');
    assert.notEqual(root, join(process.cwd(), 'bridge', 'astrbot'), 'a blank override is not the CWD');
    assert.ok(root.endsWith(join('bridge', 'astrbot')), `unexpected root ${root}`);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  }
});

test('every bare import of the package is declared at the installed version', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const declared = { ...manifest.dependencies, ...manifest.peerDependencies };
  const files = ['lib/index.js', 'lib/store.js', 'lib/tools.js', 'lib/host/llm.js', 'lib/host/storage.js'];
  const specifiers = new Set();
  for (const relative of files) {
    const source = await readFile(new URL(`../${relative}`, import.meta.url), 'utf8');
    for (const match of source.matchAll(/(?:from|import\()\s*['"]([^'".][^'"]*)['"]/g)) {
      const specifier = match[1];
      if (specifier.startsWith('node:')) continue;
      specifiers.add(specifier);
    }
  }
  assert.ok(specifiers.has('@deepseek-ai/schemastery'), 'the entry imports schemastery directly');
  assert.ok(specifiers.has('@deepseek-ai/dsh-home-paths'), 'the resolver imports the home helper directly');
  for (const specifier of specifiers) {
    assert.ok(specifier === 'ws' || specifier.startsWith('@deepseek-ai/'), `unexpected import ${specifier}`);
    assert.ok(
      Object.hasOwn(declared, specifier),
      `${specifier} is imported but not declared in dependencies/peerDependencies`,
    );
  }
  for (const name of ['@deepseek-ai/schemastery', '@deepseek-ai/dsh-home-paths']) {
    let manifest = null;
    try {
      manifest = JSON.parse(await readFile(require.resolve(`${name}/package.json`), 'utf8'));
    } catch {
      // A consumer install may hoist the package outside this resolution path;
      // the declaration check above still holds, so nothing to compare here.
      continue;
    }
    const { version } = manifest;
    const range = declared[name];
    assert.equal(
      String(version).startsWith(range.replace(/^[~^]/, '')),
      true,
      `${name} must declare the installed version (declared ${range}, installed ${version})`,
    );
  }
});

test('the packed file list includes the storage modules and their types', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(manifest.files.includes('lib/store.js'));
  assert.ok(manifest.files.includes('lib/host/*.js'), 'the host adapter directory must ship');
});

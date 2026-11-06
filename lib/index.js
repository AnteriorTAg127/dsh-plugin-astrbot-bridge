/**
 * Cordis plugin entry for the AstrBot bridge (PRD §1.1, 分工 B5).
 *
 * This file is the composition root and nothing else: it wires the four layers
 * (transport → session → app → host), registers the model-facing tools *once*,
 * and installs disposal so a profile reload never leaks a socket, a timer or a
 * task.
 *
 * Two properties are structural rather than incidental:
 *
 *   - **Tools are registered by the entry, not by a connection.** The harness
 *     registry rejects a duplicate name, so registering per connection made the
 *     second ready peer fail to start and a single `stop()` remove the tools of
 *     every other connection. Registration happens once, here, and resolves the
 *     services of whichever connection is currently ready. With no ready
 *     connection the tools stay visible to the model and answer `not_ready`,
 *     which is a readable failure instead of a missing capability.
 *   - **The carrier loop is owned by the entry's lifetime.** A connection
 *     reconnects in the background with the protocol's exponential backoff,
 *     falls back in the configured order, and returns to the preferred carrier;
 *     `dispose()` aborts it, so nothing reconnects after unload.
 *
 * Every effect is registered on `ctx` so Cordis owns its teardown.
 * @module dsh-plugin-astrbot-bridge
 */

import z from '@deepseek-ai/schemastery';

import { resolveDataRoot } from './host/storage.js';
import { AgentHost } from './host/agents.js';
import { AttachmentHost } from './host/attachments.js';
import { BlobService } from './app/blobs.js';
import { ApprovalService } from './app/approvals.js';
import { NotifyService } from './app/notify.js';
import { SessionService } from './app/sessions.js';
import { TaskService } from './app/tasks.js';
import { BridgeError, asBridgeError } from './errors.js';
import { Limits, MessageName, SessionState, Side } from './constants.js';
import { defaultLogger, Logger } from './log.js';
import { Router } from './router.js';
import { Session, buildCaps } from './session.js';
import { BridgeStore } from './store.js';
import { TransportManager } from './transport/manager.js';
import { registerBridgeTools } from './tools.js';

/** Plugin name shown by the harness. */
export const name = 'astrbot-bridge';

/**
 * Services this plugin needs; it loads only when all of them are mounted.
 *
 * `storage` is declared because the entry reads `ctx.storage` to hand the host
 * storage hub to the store: Cordis throws on a property read that was never
 * declared, and a profile without the service parks the fiber in `PENDING`
 * (which is the correct behaviour) instead of failing it.
 */
export const inject = ['agents', 'attachments', 'approval', 'tools', 'storage'];

/** How often the retention sweep runs (protocol §10.1). */
const RETENTION_SWEEP_MS = 60 * 60 * 1000;

/**
 * How often a ready session re-checks its carrier's own health.
 *
 * A session state transition is the primary loss signal, but a carrier whose
 * socket or server is gone can report `alive() === false` without emitting one;
 * the heartbeat would only notice after `heartbeatS * HEARTBEAT_MISS`. This poll
 * is what keeps a dead connection from staying `ready` for a minute.
 */
const CARRIER_LIVENESS_POLL_MS = 1000;

/** Connection schema: one entry per bridge peer (§14). */
const ConnectionSchema = z.object({
  id: z.string().default('default').description('Connection identity, must match the peer.'),
  mode: z.union(['listen', 'connect']).default('listen').description('Who opens the carrier.'),
  transport: z.union(['ws', 'webhook', 'longpoll']).default('ws').description('Preferred carrier.'),
  transportFallback: z.array(z.string()).default(['longpoll']).description('Fallback order.'),
  host: z.string().default('127.0.0.1').description('Bind address (listen) or peer address (connect).'),
  port: z.number().default(8765).description('Bind or peer port.'),
  bindHost: z.string().default('').description('Explicit bind address; empty reuses `host`.'),
  bindPort: z.number().default(0).description('Explicit bind port; 0 reuses `port`.'),
  peerHost: z.string().default('').description('Explicit peer address for reverse delivery; empty means unset.'),
  peerPort: z.number().default(0).description('Explicit peer port for reverse delivery; 0 means unset.'),
  path: z.string().default('/dsh-bridge').description('Path prefix for every endpoint.'),
  tlsEnabled: z.boolean().default(false).description('Serve/consume TLS.'),
  tlsCertPath: z.string().default('').description('Server certificate path.'),
  tlsKeyPath: z.string().default('').description('Server private key path.'),
  tlsFingerprint: z.string().default('').description('Expected peer certificate fingerprint.'),
  pskId: z.string().default('').description('PSK identifier, never a secret.'),
  pskSecret: z.string().role('secret').default('').description('Pre-shared secret; empty refuses the connection.'),
  allowPrivateAddr: z.boolean().default(false).description('Allow a private non-loopback peer address.'),
});

/** Plugin configuration (protocol §14, PRD §4). */
export const Config = z.object({
  connections: z.array(ConnectionSchema).default([]).description('Bridge peers; empty means idle.'),
  side: z.union(['A', 'B']).default('B').description('This endpoint side; the peer must use the other.'),
  heartbeatInterval: z.number().default(30).description('Heartbeat period in seconds.'),
  reconnectMaxBackoff: z.number().default(60).description('Maximum reconnect backoff in seconds.'),
  taskRetentionDays: z.number().default(7).description('Task retention in days.'),
  wakeMaxChain: z.number().default(8).description('Automatic wake-ups per root task.'),
  wakeRatePerMinute: z.number().default(10).description('Automatic wake-ups per minute per session.'),
  approvalTimeoutSeconds: z.number().default(1800).description('Approval timeout; expiry is a rejection.'),
  imageEnabled: z.boolean().default(true).description('Allow image attachments.'),
  imageMaxCount: z.number().default(4).description('Maximum images per task.'),
  imageMaxBytes: z.number().default(10485760).description('Maximum bytes per image.'),
  imageTotalMaxBytes: z.number().default(20971520).description('Maximum bytes per task.'),
  imageAllowedMime: z
    .array(z.string())
    .default(['image/gif', 'image/jpeg', 'image/png', 'image/webp'])
    .description('Accepted image media types.'),
  remoteNativeApproval: z
    .boolean()
    .default(true)
    .description('Claim harness approval requests and forward them to the peer for a human answer.'),
  allowedSessionPurposes: z.array(z.string()).default([]).description('Local purpose allow-list; empty means any.'),
  dataRoot: z.string().default('').description('Bridge data root; empty uses DSH_HOME/bridge/astrbot.'),
  // Model policy (R3/R5). These three leaves are **volatile**: the host commits
  // a volatile-only config diff in place, so an edit takes effect on the next
  // delivery instead of restarting the plugin and dropping every live agent.
  // A volatile leaf must not sit inside another volatile node, which is why the
  // parent objects below stay ordinary.
  modelOverride: z
    .object({
      provider: z.string().default('').description('Provider id; empty means unset.'),
      model: z.string().default('').description('Model id; empty means unset.'),
      reasoningEffort: z.string().default('').description('Optional effort id; empty means the provider default.'),
    })
    .default({ provider: '', model: '', reasoningEffort: '' })
    .description('Explicit route for bridge-started turns; wins over the purpose map and the host default.')
    .volatile(),
  modelByPurpose: z
    .dict(
      z.object({
        provider: z.string().default('').description('Provider id for this purpose.'),
        model: z.string().default('').description('Model id for this purpose.'),
        reasoningEffort: z.string().default('').description('Optional effort id for this purpose.'),
      }),
    )
    .default({})
    .description('Per-purpose route map, consulted when the explicit override is unset.')
    .volatile(),
});

/**
 * Install the bridge inside one Cordis context.
 *
 * Composition only: parse config, resolve the data root, build the layers, and
 * hand control to the per-connection supervisors. No business logic lives here,
 * and nothing in this function waits for a peer: `apply` must not block profile
 * boot on a bridge that may be unreachable for minutes.
 * @param {object} ctx - Cordis context.
 * @param {object} config - validated plugin configuration.
 * @returns {Promise<void>} resolves once the bridge is wired and starting.
 */
export async function apply(ctx, config) {
  const settings = normaliseConfig(config);
  const logger = new Logger(name, typeof ctx.logger === 'function' ? ctx.logger(name) : null);
  const dataRoot = await resolveDataRoot({ dataRoot: settings.dataRoot });

  // The store never reads the context itself: Cordis throws for an undeclared
  // property, so the hub is resolved here, in the one place allowed (`inject`).
  const store = new BridgeStore({ storage: ctx.storage, dataRoot, logger: logger.child('store') });
  await store.init();

  const agentHost = new AgentHost({
    ctx,
    logger: logger.child('agents'),
    // Read, never copied: the model policy leaves are volatile refs whose value
    // changes in place, so resolving them per delivery is what makes a config
    // edit effective without a reload (R5).
    modelPolicy: () => readModelPolicy(config),
  });
  const attachmentHost = new AttachmentHost({ ctx });

  /** @type {Supervisor[]} */
  const supervisors = [];
  let disposed = false;

  /**
   * Services of the first ready connection.
   *
   * Tool calls are global while the peers are per connection, so every call
   * resolves its target at execution time. With no ready peer the failure is
   * `not_ready`, which the model can read and retry, rather than a silent
   * misroute into a half-open session.
   * @returns {object} services of a ready supervisor.
   * @throws {BridgeError} `not_ready` when no connection is up.
   */
  const readyServices = () => {
    for (const supervisor of supervisors) {
      const services = supervisor.readyServices();
      if (services !== null) return services;
    }
    throw new BridgeError('not_ready', { details: { reason: 'no_ready_connection' } });
  };

  // Registered once per entry: a duplicate name is a hard failure in the real
  // registry, so no connection-specific registration may ever happen.
  const disposeTools = registerBridgeTools(ctx, {
    get tasks() {
      return readyServices().tasks;
    },
    get sessions() {
      return readyServices().sessions;
    },
    config: settings,
    logger: logger.child('tools'),
  });

  // Task retention (§10.1): the store owns the deletion rule (terminal records
  // only), so the entry only drives it; nothing here deletes live work.
  let retentionTimer = null;
  if (settings.taskRetentionDays > 0) {
    retentionTimer = setInterval(() => {
      void store.cleanupExpired(settings.taskRetentionDays).then(
        (removed) => {
          if (removed > 0) logger.info('store_retention_swept', { removed });
        },
        (error) => logger.failure('store_retention_failed', error, {}),
      );
    }, RETENTION_SWEEP_MS);
    if (typeof retentionTimer.unref === 'function') retentionTimer.unref();
  }

  const disposeAll = async () => {
    if (disposed) return;
    disposed = true;
    // Connections first: their services settle claims and stop carriers while
    // the store is still open. Then the entry-level tool registration, which is
    // the only owner of those names.
    for (const supervisor of supervisors) await supervisor.stop();
    disposeTools();
    if (retentionTimer !== null) {
      clearInterval(retentionTimer);
      retentionTimer = null;
    }
    await agentHost.dispose();
    await store.close();
    logger.info('bridge_stopped', {});
  };

  // Cordis owns teardown: the disposer registered by `ctx.effect` runs on
  // reload, on unload and on an explicit `dispose()`, and it is idempotent.
  ctx.effect(() => () => disposeAll());

  for (const connection of settings.connections) {
    const supervisor = new Supervisor({
      ctx,
      settings,
      connection,
      store,
      agentHost,
      attachmentHost,
      logger: logger.child(`conn:${connection.id}`),
    });
    supervisors.push(supervisor);
    // Start in the background: `apply` must not block profile boot on a peer
    // that may be unreachable for minutes. The loop reports its own failures.
    void supervisor.start().catch((error) => {
      logger.failure('connection_start_failed', asBridgeError(error), { conn: connection.id });
    });
  }

  logger.info('bridge_started', { connections: settings.connections.length, side: settings.side });
  return undefined;
}

/**
 * Apply defaults and clamp values that the protocol treats as hard bounds.
 *
 * The model policy fields are deliberately **not** carried into the returned
 * settings object: their live shape is a volatile ref (`{get, [write]}`), and
 * spreading or clamping a ref would silently turn it into an opaque object. The
 * agent host reads them through {@link readModelPolicy} at each delivery.
 * @param {object|undefined} config - raw configuration.
 * @returns {object} normalized configuration.
 */
export function normaliseConfig(config) {
  const { modelOverride: _override, modelByPurpose: _byPurpose, ...plain } = config ?? {};
  // Referenced only to document the intentional removal; neither ref is a value
  // that any service should ever see.
  void _override;
  void _byPurpose;
  const settings = { ...plain };
  settings.connections = Array.isArray(settings.connections)
    ? settings.connections.filter((conn) => conn !== null && typeof conn === 'object').map(normaliseConnection)
    : [];
  settings.side = settings.side === 'A' ? Side.A : Side.B;
  settings.heartbeatInterval = clamp(settings.heartbeatInterval, 5, 3600, Limits.HEARTBEAT_S);
  settings.reconnectMaxBackoff = clamp(settings.reconnectMaxBackoff, 1, 3600, 60);
  settings.taskRetentionDays = clamp(settings.taskRetentionDays, 1, 365, 7);
  settings.wakeMaxChain = clamp(settings.wakeMaxChain, 0, 64, 8);
  settings.wakeRatePerMinute = clamp(settings.wakeRatePerMinute, 1, 600, 10);
  settings.approvalTimeoutSeconds = clamp(settings.approvalTimeoutSeconds, 30, 86_400, 1800);
  settings.imageMaxCount = clamp(settings.imageMaxCount, 0, Limits.MAX_IMAGE_COUNT, Limits.MAX_IMAGE_COUNT);
  settings.imageMaxBytes = clamp(settings.imageMaxBytes, 1, Limits.MAX_IMAGE_BYTES, Limits.MAX_IMAGE_BYTES);
  settings.imageTotalMaxBytes = clamp(
    settings.imageTotalMaxBytes,
    1,
    Limits.MAX_TOTAL_IMAGE_BYTES,
    Limits.MAX_TOTAL_IMAGE_BYTES,
  );
  settings.imageAllowedMime = Array.isArray(settings.imageAllowedMime) && settings.imageAllowedMime.length > 0
    ? settings.imageAllowedMime
    : ['image/gif', 'image/jpeg', 'image/png', 'image/webp'];
  settings.allowedSessionPurposes = Array.isArray(settings.allowedSessionPurposes)
    ? settings.allowedSessionPurposes
    : [];
  settings.remoteNativeApproval = settings.remoteNativeApproval !== false;
  settings.imageEnabled = settings.imageEnabled !== false;
  settings.dataRoot = typeof settings.dataRoot === 'string' ? settings.dataRoot : '';
  return settings;
}

/**
 * Read one configuration value that may be a volatile ref or a plain value.
 *
 * Volatile fields have no `watch` API — only `get()` — so every read is
 * performed at the point of use. A value that is not a ref (tests, plain
 * profile objects) is returned as is.
 * @param {unknown} value - candidate value or volatile ref.
 * @param {unknown} fallback - value used when the ref throws or is absent.
 * @returns {unknown} the current value.
 */
function readConfigValue(value, fallback) {
  if (value !== null && typeof value === 'object' && 'get' in value && typeof value.get === 'function') {
    try {
      return value.get();
    } catch {
      return fallback;
    }
  }
  return value === undefined || value === null ? fallback : value;
}

/**
 * Read the live model policy (R3/R5).
 *
 * Called once per delivery by {@link AgentHost}; returning fresh values is the
 * entire hot-reload mechanism for these fields.
 * @param {object} config - raw plugin configuration (possibly carrying refs).
 * @returns {{override: object|null, byPurpose: object}} live policy.
 */
function readModelPolicy(config) {
  const override = readConfigValue(config?.modelOverride, null);
  const byPurpose = readConfigValue(config?.modelByPurpose, null);
  return {
    override: override ?? null,
    byPurpose: byPurpose !== null && typeof byPurpose === 'object' ? byPurpose : {},
  };
}

/**
 * Normalise one connection record.
 *
 * The bind/peer split is carried through verbatim: `bindHost`/`bindPort` are
 * where this endpoint listens, `peerHost`/`peerPort` are where the peer listens.
 * Neither is derived from the other — a listen-side webhook that assumed its own
 * address was the peer's posted every reverse event back to itself, which is
 * exactly the failure this split exists to prevent.
 * @param {object} connection - raw connection record.
 * @returns {object} normalized connection record.
 */
function normaliseConnection(connection) {
  const text = (value, fallback) => (typeof value === 'string' && value.length > 0 ? value : fallback);
  const port = (value, fallback) => {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(65_535, Math.max(0, Math.trunc(number)));
  };
  return {
    ...connection,
    id: text(connection.id, 'default'),
    mode: connection.mode === 'connect' ? 'connect' : 'listen',
    transport: text(connection.transport, 'ws'),
    transportFallback: Array.isArray(connection.transportFallback) ? connection.transportFallback : [],
    host: text(connection.host, '127.0.0.1'),
    port: port(connection.port, 8765),
    bindHost: typeof connection.bindHost === 'string' ? connection.bindHost : '',
    bindPort: port(connection.bindPort, 0),
    peerHost: typeof connection.peerHost === 'string' ? connection.peerHost : '',
    peerPort: port(connection.peerPort, 0),
    path: text(connection.path, '/dsh-bridge'),
    tlsEnabled: connection.tlsEnabled === true,
    tlsCertPath: typeof connection.tlsCertPath === 'string' ? connection.tlsCertPath : '',
    tlsKeyPath: typeof connection.tlsKeyPath === 'string' ? connection.tlsKeyPath : '',
    tlsFingerprint: typeof connection.tlsFingerprint === 'string' ? connection.tlsFingerprint : '',
    pskId: typeof connection.pskId === 'string' ? connection.pskId : '',
    pskSecret: typeof connection.pskSecret === 'string' ? connection.pskSecret : '',
    allowPrivateAddr: connection.allowPrivateAddr === true,
  };
}

/**
 * Clamp one numeric setting.
 * @param {unknown} value - candidate value.
 * @param {number} min - lower bound.
 * @param {number} max - upper bound.
 * @param {number} fallback - value used when the candidate is not a number.
 * @returns {number} clamped value.
 */
function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

/**
 * One connection's lifecycle: carrier selection, session, services and teardown.
 *
 * Keeping this per connection is what makes the bridge support more than one
 * peer without shared mutable state between them. Tools are deliberately *not*
 * part of this object: they belong to the entry, because the harness registry is
 * global to the context.
 */
export class Supervisor {
  /**
   * @param {object} options - supervisor dependencies.
   * @param {object} options.ctx - Cordis context.
   * @param {object} options.settings - normalized plugin settings.
   * @param {object} options.connection - one connection record.
   * @param {object} options.store - bridge store.
   * @param {object} options.agentHost - agent adapter.
   * @param {object} options.attachmentHost - attachment adapter.
   * @param {Function} [options.createManager] - builds the carrier manager
   *   (composition seam; defaults to the real {@link TransportManager}).
   * @param {import('./log.js').Logger} options.logger - structured logger.
   */
  constructor(options) {
    this.ctx = options.ctx;
    this.settings = options.settings;
    this.connection = options.connection;
    this.store = options.store;
    this.agentHost = options.agentHost;
    this.attachmentHost = options.attachmentHost;
    this.logger = options.logger;
    /** @type {object|null} live session, replaced on every handshake. */
    this.session = null;
    this.router = new Router({ logger: this.logger.child('router') });
    this.manager = null;
    this.services = null;
    this._stopped = true;
    this._loop = null;
    /** Session watcher installed by the carrier loop, if a loop is running. */
    this._watch = null;
    /** Whether one process-wide restart reconciliation already ran. */
    this._recovered = false;
    this._createManager = options.createManager ?? ((conn, hooks, opts) => new TransportManager(conn, hooks, opts));
    // Remote native approval is enabled whenever this side can observe the
    // harness approval seam at all; a deployment that does not want it sets
    // `remoteNativeApproval: false`. This is a local capability fact, never the
    // negotiated `caps.approvals.native_tool` value (A declares `false`).
    this.remoteApprovalEnabled =
      this.settings.remoteNativeApproval !== false && this.ctx?.approval !== undefined && this.ctx?.approval !== null;
  }

  /** Current session, or null before the carrier is up. */
  get currentSession() {
    return this.session;
  }

  /** Whether this connection currently has a ready session. */
  get ready() {
    return this.session !== null && this.session.state === SessionState.READY;
  }

  /**
   * Services of this connection when it is ready, otherwise null.
   * @returns {object|null} services.
   */
  readyServices() {
    return this.ready ? this.services : null;
  }

  /** Why this connection cannot start, if the carriers refused it; null otherwise. */
  get parked() {
    return this.manager?.parked ?? null;
  }

  /**
   * Build the capability declaration for this endpoint (§4.5).
   * @returns {object} caps.
   */
  caps() {
    const transports = [this.connection.transport, ...(this.connection.transportFallback ?? [])];
    return buildCaps({
      side: this.settings.side,
      host: 'dsh',
      version: '0.1.0',
      transports,
      tls: this.connection.tlsEnabled === true,
      rolesInitiate: true,
      rolesExecute: true,
      approvals: {
        business_decision: true,
        cross_end_submit: true,
        // The bridge only claims native-tool forwarding when it can actually
        // observe the harness request *and* the deployment enabled remote native
        // approval. Advertising it from `ctx.approval` alone told the peer a
        // capability this endpoint was configured not to use.
        native_tool: this.remoteApprovalEnabled === true,
      },
      attachments: {
        mime: this.settings.imageAllowedMime,
        max_bytes: this.settings.imageMaxBytes,
        max_count: this.settings.imageMaxCount,
        max_total_bytes: this.settings.imageTotalMaxBytes,
        max_pixels: Limits.MAX_IMAGE_PIXELS,
        max_dimension: Limits.MAX_IMAGE_DIMENSION,
      },
    });
  }

  /**
   * Start the connection: run the carrier loop in the background.
   *
   * The loop keeps the connection alive for as long as the plugin is installed —
   * reconnect with backoff after a loss, fall back in the configured order when a
   * carrier degrades, and try the preferred carrier again after a fallback. This
   * method returns as soon as the loop is running, because a peer that is down
   * must never delay profile boot; `stop()` is what ends the loop.
   * @returns {Promise<void>} resolution when the loop is running (or parked).
   */
  async start() {
    if (!this._stopped) return;
    this._stopped = false;
    this._disposed = false;
    if (this.settings.side === Side.A) {
      // The peer must be the opposite side; two `A` endpoints is a configuration
      // error the protocol refuses to resolve by guessing (§4.1).
      this.logger.error('side_mismatch', { side: this.settings.side, conn: this.connection.id });
    }
    this.manager = this._createManager(
      { ...this.connection, reconnectMaxBackoff: this.settings.reconnectMaxBackoff },
      {},
      {
        logger: this.logger.child('carrier'),
        onSession: (carrier, carrierName) => async () => {
          await this._startSession(carrier, carrierName);
        },
        onSwitch: (record) => {
          this.logger.warn('transport_switched', {
            conn: this.connection.id,
            from: record.from,
            to: record.to,
            reason: record.reason,
          });
        },
      },
    );
    this._loop = this.manager.runForever(
      (carrier, carrierName) => async () => {
        await this._startSession(carrier, carrierName);
      },
      { watch: (signal) => this._watchSession(signal) },
    );
    // The loop reports its own failures; it never rejects into this call.
    void this._loop.catch((error) => {
      this.logger.failure('connection_loop_failed', asBridgeError(error), { conn: this.connection.id });
    });
  }

  /**
   * Wait for the live session to stop being usable.
   *
   * The carrier loop calls this right after a successful start, so the value it
   * settles with decides what happens next: `degraded` moves to the fallback
   * order, `lost` restarts from the preferred carrier after a backoff, and
   * `stopped` ends the loop. A session that is already gone when the watcher is
   * installed settles immediately instead of hanging the loop.
   * @param {AbortSignal} [signal] - aborted when the loop stops watching.
   * @returns {Promise<string>} `degraded`, `lost` or `stopped`.
   */
  _watchSession(signal) {
    const session = this.session;
    if (session === null) return Promise.resolve('lost');
    if (session.state === SessionState.DEGRADED) return Promise.resolve('degraded');
    if (session.state !== SessionState.READY) return Promise.resolve('lost');
    return new Promise((resolve) => {
      let settled = false;
      // Declared before `finish` so an already-aborted signal, handled below,
      // can clear a timer that does not exist yet without a temporal-dead-zone
      // throw.
      let liveness = null;
      const finish = (reason) => {
        if (settled) return;
        settled = true;
        if (liveness !== null) clearInterval(liveness);
        if (signal !== undefined) signal.removeEventListener('abort', onAbort);
        if (this._watch !== null && this._watch.session === session && this._watch.finish === finish) {
          this._watch = null;
        }
        resolve(reason);
      };
      const onAbort = () => finish('stopped');
      if (signal !== undefined) {
        if (signal.aborted) {
          finish('stopped');
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      // A state transition is the primary signal, but it is not the only one a
      // carrier can give: a transport whose socket or server is gone reports
      // `alive() === false` without changing the session state, and waiting for
      // the heartbeat to notice (up to `heartbeatS * HEARTBEAT_MISS`) would keep
      // a dead connection "ready" for a minute. The poll runs between tasks, so
      // it never observes a carrier mid-transition (the webhook sets `_degraded`
      // and reports `degraded` in one synchronous block).
      liveness = setInterval(() => {
        if (this.session !== session) {
          finish('lost');
          return;
        }
        if (session.state === SessionState.DEGRADED) {
          finish('degraded');
          return;
        }
        if (session.state !== SessionState.READY) {
          finish('lost');
          return;
        }
        const carrier = session.transport;
        if (typeof carrier?.alive === 'function' && carrier.alive() === false) finish('lost');
      }, CARRIER_LIVENESS_POLL_MS);
      liveness.unref?.();
      this._watch = { session, finish };
    });
  }

  /**
   * Wire one carrier into a session and its services.
   * @param {object} carrier - carrier instance.
   * @param {'ws'|'webhook'|'longpoll'} carrierName - carrier name.
   * @returns {Promise<void>} resolution once the session is ready.
   */
  async _startSession(carrier, carrierName) {
    // Any session being replaced is torn down first: a new `sid` is a new answer
    // channel, so the previous claims are unreachable the moment the replacement
    // begins — waiting for it to become ready would leave them pending across a
    // handshake that may itself fail.
    const previous = this.services;
    const closing = this.session;
    // Detach the outgoing session first, so its own teardown transitions are not
    // attributed to the incoming one.
    this.session = null;
    this._watch = null;
    if (previous !== null && previous !== undefined) {
      previous.approvals.onSessionLost();
      previous.approvals.stop();
      previous.notify.stop();
      // A resend already awaiting the store must settle before the store is used
      // again, so the refusal is reported instead of racing the replacement.
      await new Promise((resolve) => setImmediate(resolve));
    }
    if (closing !== null) {
      // The outgoing carrier must release before the replacement binds a new
      // one. A close that fails is logged, never fatal: the new session decides
      // whether this connection is usable at all.
      try {
        await closing.close('superseded', 'replaced by a new session', { notifyPeer: true });
      } catch (error) {
        this.logger.failure('superseded_close_failed', error, { conn: this.connection.id });
      }
    }
    const session = new Session(
      {
        conn: this.connection,
        side: this.settings.side,
        role: this.connection.mode === 'connect' ? 'initiator' : 'responder',
        transportName: carrierName,
        caps: this.caps(),
        heartbeatS: this.settings.heartbeatInterval,
        logger: this.logger.child('session'),
      },
      carrier,
      {
        onMessage: (message) => this.router.dispatch(message, { session }),
        onSecurityEvent: (event) => {
          this.logger.warn('security_event', {
            conn: event.conn,
            sid: event.sid,
            code: event.code,
          });
        },
        onState: (state) => this._onSessionState(session, state),
      },
    );
    this.session = session;
    this.router.setReplySink(async (message) => session.sendMessage(message));
    this.services = this._buildServices(session);
    this._registerHandlers(session);
    await session.start();
    if (typeof session._onMessage !== 'function') {
      throw new BridgeError('internal_error', { details: { reason: 'session_wiring' } });
    }
    if (session.state !== SessionState.READY) {
      throw new BridgeError('internal_error', { details: { reason: 'session_not_ready' } });
    }
    this.services.notify.startResendLoop();
    // The cache of A's authorization table decides claims; reload it before the
    // listener can see a request, since pushes may have been missed while the
    // carrier was down (an empty cache denies, it never allows).
    this.services.approvals.onSessionReady(this.connection.id, session.sid);
    await this.services.approvals.attach(this.ctx);
    if (!this._recovered) {
      // One process-wide reconciliation, after dead-connection gates settled:
      // accepted/queued tasks with a consumed gate resume, running tasks and
      // claimed-but-pending tasks are parked, never re-run.
      this._recovered = true;
      try {
        await this.services.tasks.recoverAfterRestart();
      } catch (error) {
        this.logger.failure('restart_recovery_failed', asBridgeError(error), {
          conn: this.connection.id,
        });
      }
    }
  }

  /**
   * React to one real session state transition.
   *
   * `connecting` and `handshaking` are transient phases of a session that has no
   * claims yet, so they change nothing. `ready` binds the new `(conn, sid)` and
   * settles only the handles of a *different* previous sid — a plain `ready`
   * must never kill requests claimed under the current one. `degraded`,
   * `draining`, `closed`, `disconnected` and `config_error` all mean the answer
   * channel is gone, so each claimed handle is settled `unavailable` at once
   * instead of waiting for a deadline that would misreport a lost channel as a
   * timeout.
   * @param {Session} session - session that produced the transition.
   * @param {string} state - one of `SessionState`.
   * @returns {void}
   */
  _onSessionState(session, state) {
    this.logger.debug('session_state', { conn: this.connection.id, state });
    // The carrier loop is watching this exact session: report the loss as soon as
    // the state is decided, before any service-level bookkeeping can throw.
    if (this._watch !== null && this._watch.session === session) {
      if (state === SessionState.DEGRADED) this._watch.finish('degraded');
      else if (
        state === SessionState.CLOSED ||
        state === SessionState.DISCONNECTED ||
        state === SessionState.DRAINING ||
        state === SessionState.CONFIG_ERROR
      ) {
        this._watch.finish('lost');
      }
    }
    // A session that has already been replaced owns no services here: its
    // handles are settled by the replacement path, once, instead of targeting
    // the live session's services.
    if (session !== this.session) return;
    if (state === SessionState.CONNECTING || state === SessionState.HANDSHAKING) return;
    const approvals = this.services?.approvals;
    if (approvals === undefined || approvals === null) return;
    if (state === SessionState.READY) {
      approvals.onSessionReady(this.connection.id, session.sid);
      return;
    }
    approvals.onSessionLost();
  }

  /**
   * Build the application services for one session.
   * @param {Session} session - live session.
   * @returns {object} services.
   */
  _buildServices(session) {
    // The session service is built first because two other services depend on
    // it: the archive gate refuses delivery to an archived session, and the
    // notification outbox must not resurrect one. Passing it after construction
    // would leave both gates silently unwired (`archive_gate_unwired`), so the
    // dependency is satisfied at the only point where it can be.
    const sessions = new SessionService({
      store: this.store,
      host: this.agentHost,
      config: { ...this.settings, id: this.connection.id },
      logger: this.logger.child('sessions'),
    });
    const notify = new NotifyService({
      store: this.store,
      session,
      host: this.agentHost,
      sessions,
      config: { ...this.settings, id: this.connection.id },
      logger: this.logger.child('notify'),
    });
    const tasks = new TaskService({
      store: this.store,
      session,
      host: this.agentHost,
      notify,
      sessions,
      config: this.settings,
      attachments: this.attachmentHost,
      logger: this.logger.child('tasks'),
    });
    // `imageEnabled: false` is enforced here, at the host boundary, by handing
    // the blob service a configuration that accepts no media type and no image
    // count. The alternative — advertising zero in `caps` — is rejected by the
    // protocol's own validation, so the refusal has to be local and explicit.
    const blobConfig =
      this.settings.imageEnabled === false
        ? { ...this.settings, imageMaxCount: 0, imageAllowedMime: [] }
        : this.settings;
    const blobs = new BlobService({
      store: this.store,
      session,
      config: blobConfig,
      attachments: this.attachmentHost,
      logger: this.logger.child('blobs'),
    });
    blobs.validateTaskAttachments = blobs.validateTaskAttachments.bind(blobs);
    tasks.blobService = blobs;
    const approvals = new ApprovalService({
      store: this.store,
      session,
      host: this.agentHost,
      notify,
      config: this.settings,
      logger: this.logger.child('approvals'),
      // Claiming is a local capability fact, not a negotiated one: the peer's
      // `caps.approvals.native_tool` is false on the AstrBot side by design, and
      // negotiation is a logical AND, so the negotiated value can never switch
      // this on.
      remoteApprovalEnabled: this.remoteApprovalEnabled,
    });
    // §12.5 point 5: an inbound submission the local policy will not pass must
    // open a *real* approval, and the only implementation of "a human decides"
    // is the `ApprovalService` this connection already builds. Assigned here,
    // like `blobService`, because the service needs the same session/store and
    // is constructed after the task service; leaving it unwired would make
    // `submitInbound` fail closed (`approval_gate_unwired`) and park every
    // LLM-originated cross-end submission instead of asking a human.
    tasks.approvals = approvals;
    return { notify, tasks, blobs, sessions, approvals };
  }

  /**
   * Register every inbound message handler (§9.2 vocabulary).
   * @param {Session} session - live session.
   * @returns {void}
   */
  _registerHandlers(session) {
    const { tasks, blobs, sessions, approvals, notify } = this.services;
    this.router.register(MessageName.TASK_SUBMIT, 'req', async (params) => {
      // Attachments are validated atomically before any execution is queued.
      blobs.validateTaskAttachments(params.attachments ?? []);
      return tasks.submitInbound(params);
    });
    this.router.register(MessageName.TASK_STATUS, 'req', (params) => tasks.status(params));
    this.router.register(MessageName.TASK_LIST_OPEN, 'req', (params) => tasks.listOpen(params));
    this.router.register(MessageName.TASK_CANCEL, 'req', (params) => tasks.cancel(params));
    this.router.register(MessageName.TASK_EVENT, 'evt', (params) => tasks.onEvent(params));
    this.router.register(MessageName.SESSION_LIST, 'req', (params) => sessions.list(params));
    this.router.register(MessageName.SESSION_CREATE, 'req', (params) => sessions.create(params));
    this.router.register(MessageName.SESSION_SELECT, 'req', (params) => sessions.select(params));
    this.router.register(MessageName.SESSION_MANAGE, 'req', (params) => sessions.manage(params));
    this.router.register(MessageName.SESSION_AUTHZ, 'evt', async (params) => {
      const result = await sessions.onAuthz(params);
      if (result?.applied === true) {
        // A revocation has to bite on the next harness request, and the claim
        // check is synchronous, so the cache is refreshed on every applied push
        // rather than lazily at the next read.
        await approvals.syncAuthz();
      }
      return result;
    });
    this.router.register(MessageName.APPROVAL_REQUEST, 'req', (params) => approvals.handleRequest(params));
    this.router.register(MessageName.APPROVAL_DECISION, 'evt', (params) => approvals.onDecisionEvent(params));
    this.router.register(MessageName.APPROVAL_LOOKUP, 'req', (params) => approvals.lookup(params));
    this.router.register(MessageName.DECISION_ANSWER, 'req', (params) => approvals.onDecisionAnswer(params));
    this.router.register(MessageName.EVENT_ACK, 'req', (params) => notify.onAck(params));
    this.router.register(MessageName.BLOB_BEGIN, 'evt', (params) => blobs.begin(params));
    this.router.register(MessageName.BLOB_CHUNK, 'evt', (params) => blobs.chunk(params));
    this.router.register(MessageName.BLOB_COMMIT, 'evt', (params) => blobs.commit(params));
    this.router.register(MessageName.BLOB_ABORT, 'evt', (params) => blobs.abort(params));
    void session;
  }

  /**
   * Stop the connection and release every resource.
   *
   * The carrier loop is aborted first, so nothing reconnects while the rest is
   * being torn down; the session is then closed (which settles claims
   * `unavailable`) and the carrier released. Idempotent: a second call, or a
   * call that races a replacement, must not settle a handle twice. The tools are
   * *not* touched here — they belong to the entry.
   * @returns {Promise<void>} resolution after teardown.
   */
  async stop() {
    // A supervisor that never started and never wired a session has nothing to
    // release; one that wired a session must still be torn down, because a
    // direct `_startSession` skips `start()`.
    if (this._stopped && this.session === null && this.services === null && this.manager === null) return;
    this._stopped = true;
    // The answer channel is going away: every claimed request becomes
    // `unavailable` instead of waiting for a reply that cannot arrive. Both
    // steps are idempotent — `onSessionLost` only has live handles to settle
    // while the bridge exists, and `stop` clears the bridge once.
    const services = this.services;
    this.services = null;
    this._watch = null;
    if (services !== null && services !== undefined) {
      services.approvals.onSessionLost();
      services.notify.stop();
      services.approvals.stop();
      // `notify.stop()` clears the timer but cannot recall a resend that is
      // already awaiting the store; let it settle before the caller closes the
      // store beneath it.
      await new Promise((resolve) => setImmediate(resolve));
    }
    if (this.session !== null) {
      const session = this.session;
      this.session = null;
      try {
        await session.close('draining', 'shutdown', { notifyPeer: true });
      } catch (error) {
        this.logger.failure('session_close_failed', error, { conn: this.connection.id });
      }
    }
    if (this.manager !== null) {
      const manager = this.manager;
      this.manager = null;
      await manager.stop();
    }
    this._loop = null;
  }
}

/** Default export keeps the plugin usable as `ctx.plugin(module)`. */
export default { name, inject, Config, apply };

void defaultLogger;

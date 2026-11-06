/**
 * Public type surface of the AstrBot bridge plugin.
 *
 * The implementation is plain ESM with JSDoc; this file exists so consumers and
 * `tsc --noEmit` (see `tsconfig.json`) can check their use of the plugin without
 * reading the sources. Every field here is also accepted by the runtime
 * `Config` schema — a field this file omits is a field a TypeScript deployment
 * cannot set, which is why `remoteNativeApproval` is listed even though it is
 * security-sensitive.
 * @module dsh-plugin-astrbot-bridge/types
 */

import type { Context } from '@deepseek-ai/cordis';

/**
 * One bridge connection. The peer must use the opposite `mode` and `side`.
 *
 * `bindHost`/`bindPort` and `peerHost`/`peerPort` are separate on purpose: the
 * bind pair is where this endpoint listens, the peer pair is where the peer
 * listens. Reverse delivery (webhook `POST /frames`, long-poll `GET /poll`) is
 * addressed from the peer pair only, so a `listen` connection that does not set
 * one has no reverse path rather than silently posting to itself.
 */
export interface ConnectionConfig {
  /** Connection identity; must match the peer's `conn`. */
  id?: string;
  /** Who opens the carrier. The two endpoints must differ. */
  mode?: 'listen' | 'connect';
  /** Preferred carrier. */
  transport?: 'ws' | 'webhook' | 'longpoll';
  /** Carriers tried, in order, when the preferred one fails or degrades. */
  transportFallback?: string[];
  /**
   * Bind address (`listen`) or peer address (`connect`).
   *
   * Historical single-address field: it is the bind address for `listen` and
   * the peer address for `connect`. Use the explicit pairs below to separate
   * them.
   */
  host?: string;
  /** Bind port (`listen`) or peer port (`connect`). */
  port?: number;
  /** Explicit bind address; empty reuses `host`. */
  bindHost?: string;
  /** Explicit bind port; 0 reuses `port`. */
  bindPort?: number;
  /** Explicit peer address for reverse delivery; empty means unset. */
  peerHost?: string;
  /** Explicit peer port for reverse delivery; 0 means unset. */
  peerPort?: number;
  /** Path prefix shared by every endpoint. */
  path?: string;
  /** Serve or require TLS. */
  tlsEnabled?: boolean;
  /** Server certificate path. */
  tlsCertPath?: string;
  /** Server private-key path. */
  tlsKeyPath?: string;
  /** Expected peer certificate fingerprint. */
  tlsFingerprint?: string;
  /** PSK identifier; never a secret and safe to log. */
  pskId?: string;
  /** Pre-shared secret. Empty refuses the connection instead of degrading. */
  pskSecret?: string;
  /** Allow a private, non-loopback peer address. */
  allowPrivateAddr?: boolean;
}

/** Plugin configuration. */
export interface Config {
  /** Bridge peers. Empty means the plugin starts idle. */
  connections?: ConnectionConfig[];
  /** This endpoint's side; the peer must use the other one. */
  side?: 'A' | 'B';
  /** Heartbeat period in seconds. */
  heartbeatInterval?: number;
  /** Maximum reconnect backoff in seconds (exponential, jittered). */
  reconnectMaxBackoff?: number;
  /** Task retention in days; the bridge sweeps terminal records hourly. */
  taskRetentionDays?: number;
  /** Automatic wake-ups allowed per root task. */
  wakeMaxChain?: number;
  /** Automatic wake-ups allowed per minute per session. */
  wakeRatePerMinute?: number;
  /** Approval timeout in seconds; expiry is a rejection. */
  approvalTimeoutSeconds?: number;
  /**
   * Allow image attachments.
   *
   * Enforced at the host boundary: when `false`, every inbound blob and every
   * declared image attachment is refused, because the protocol's capability
   * validation rejects a zero-image declaration and therefore cannot express
   * "disabled" in `caps`.
   */
  imageEnabled?: boolean;
  /** Maximum images per task. */
  imageMaxCount?: number;
  /** Maximum bytes per image. */
  imageMaxBytes?: number;
  /** Maximum bytes per task. */
  imageTotalMaxBytes?: number;
  /** Accepted image media types. */
  imageAllowedMime?: string[];
  /**
   * Claim harness-native approval requests and forward them to the peer's human.
   *
   * Enabled by default when the host mounts an approval service. A deployment
   * that must keep every approval local sets this to `false`.
   */
  remoteNativeApproval?: boolean;
  /** Local purpose allow-list; empty means any purpose. */
  allowedSessionPurposes?: string[];
  /** Bridge data root; empty resolves under the harness home. */
  dataRoot?: string;
  /**
   * Explicit model route for bridge-started turns (R3).
   *
   * Precedence: this override, then `modelByPurpose`, then the host default
   * (`agentDefaultModel.currentSelection()`). When none resolves, the task fails
   * at the delivery boundary with `capability_unavailable` /
   * `no_model_route`; `session.create` still succeeds without a route.
   *
   * **Volatile**: an edit takes effect on the next delivery without reloading
   * the plugin, so live agents and connections survive the change.
   */
  modelOverride?: ModelRouteConfig;
  /**
   * Per-purpose model route map, consulted when `modelOverride` is unset.
   *
   * **Volatile**, like `modelOverride`.
   */
  modelByPurpose?: Record<string, ModelRouteConfig>;
}

/** One model route (R3: only these fields ever reach the host). */
export interface ModelRouteConfig {
  /** Provider id; empty means unset. */
  provider?: string;
  /** Model id; empty means unset. */
  model?: string;
  /** Optional reasoning effort; empty means the provider default. */
  reasoningEffort?: string;
}

/** Services this plugin requires. */
export declare const inject: string[];

/** Plugin name. */
export declare const name: string;

/** Configuration schema. */
export declare const Config: unknown;

/**
 * Install the bridge in one context.
 * @param ctx - host context.
 * @param config - validated configuration.
 * @returns resolution once the bridge is wired.
 */
export declare function apply(ctx: Context, config: Config): Promise<void>;

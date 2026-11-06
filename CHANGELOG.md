# Changelog

All notable changes to this plugin are recorded here. The development-process
log lives in `开发/changelog.md`, which is not committed.

## [0.3.0] - 2026-11-06

DSH-side model routing, live configuration, and honest turn outcomes (v0.3
R3–R6). No wire/frame, `LABEL`, crypto, AAD or golden-vector change; `inject`
and the entry module's export set are unchanged.

### Added

- **Model routing (R3).** Every delivery resolves a route in order:
  `modelOverride` → `modelByPurpose[purpose]` → host default
  (`ctx.get('agentDefaultModel').currentSelection()`). The route is applied at
  `AgentHost.deliver`, so `session.create` keeps working on a profile with no
  default model. With no resolvable route the task fails with
  `capability_unavailable` / `details.reason = "no_model_route"` and no agent is
  created, resumed or woken. Only `provider`/`model`/`reasoningEffort` reach the
  host (`maxTokens` is dropped), and `agent_created` logs `provider`/`model`/
  `source` (`explicit` for caller-supplied options, else `override`/`purpose`/
  `default`).
- **Mid-session model switch (R4).** Routes are switched through
  `installModelSelection(agent.ctx, ref)` + `ref.current`, never by editing
  `agent.options` (after the first turn the request seed comes from the
  persisted header, so options-only edits would split the prompt from the real
  route). `deliver()` is the single refresh point: the change lands on a later
  step/turn and an in-flight request is never interrupted. A failed refresh
  keeps the previous route and logs `model_route_refresh_failed` at `warn`.
  The host's `[model changed: …]` user-role notice is passed through untouched.
- **Live model configuration (R5).** `modelOverride` and `modelByPurpose` are
  volatile schemastery leaves, read once per delivery through a closure: an edit
  takes effect on the next delivery without restarting the plugin, dropping the
  connection or disposing live agents. They are deliberately excluded from
  `normaliseConfig`'s spread/clamp so a volatile ref never becomes an opaque
  value in the plain settings object. Volatile fields also make the namespace
  appear in `settings.describe()`; secrets keep their redaction.
- **Honest turn outcomes and answer extraction (R6).** The host adapter
  subscribes to `agent/error` and to `session/event`'s `turn/start`,
  `assistant/message` and `turn/end`. A turn that ended with `error` fails the
  task (`error.code = "agent_turn_failed"`); a turn with no attributable evidence
  (`blocked`, unknown reason kind, no event bus) parks it as `needs_human`
  (`error.code = "agent_outcome_unknown"`). For a `completed` / `max-tokens`
  turn, the `type: "text"` blocks of the **last** `assistant/message` in the turn
  are concatenated and reported as `result.text`; that turn succeeds only when
  the text is non-empty. A completed turn with no assistant text parks as
  `needs_human` with `error.code = "agent_output_missing"` instead of returning
  an empty answer. A retried error followed by a completed turn is a success,
  and the bridge's own cancel is not reported as a failure. Only events with
  `turn >= armedTurn` count (the next `turn/start` after arming, or the turn
  already open for a steer), so a late `turn/end` or assistant message from the
  previous turn cannot decide this delivery (M-4). The probe is optional, so
  hosts/doubles without it keep the old path.
- **Selection installed from the start (L-2).** `createSession` already installed
  the resolved route (including the host-default route); `resumeSession` now does
  too, instead of waiting for the first `deliver()`. The host's
  `[model changed: …]` notice compares the assembled route with the persisted
  request header, so starting the selection machine at the session's own route
  keeps an unchanged route free of a manufactured notice. A real change is still
  announced.
- `tests/model-routing.test.mjs` (11 cases) and `tests/turn-failure.test.mjs`
  (12 cases) exercise these behaviours against a real
  `BridgeStore`/`ApprovalService` and minimal host doubles with optional-method
  semantics. The R6 extraction, empty-output, stale-turn and L-2 resume cases
  were red against the pre-fix working tree (7 failures) and are green with this
  change; run against the pristine `0.2.0` tree the whole v0.3 set is red.

### Changed

- `normaliseConfig()` no longer carries the volatile model policy keys into the
  plain settings object.
- Deliveries now carry the task `purpose` to the host, so the purpose route map
  is applied at the point that actually drives a turn.
- `lib/types/index.d.ts` documents `modelOverride`, `modelByPurpose` and
  `ModelRouteConfig`.

### Notes / honest boundaries

- Policy approvals (auto-approval) are deferred to v0.4 and are not supported in
  this release.
- Real-host acceptance stays **BLOCKED-ENV**: `agentDefaultModel` and
  `installModelSelection` were validated against local doubles, not a live DSH
  host; GUI form auto-generation for the new namespace and profile-patch hot
  reload are **unverified**.
- A concurrent GUI per-session model selection can install a second selection
  alongside the bridge's; the bridge treats its own model selection as
  authoritative and external per-session selection is unsupported.
- `turn/end.reason.kind` was checked against the installed
  `@deepseek-ai/dsh-agent-loop` `0.2.1-rc.2` source: `completed`, `blocked`,
  `aborted` (reason such as `user`), `error`, `max-tokens`. `assistant/message`
  was checked the same way (`{turn, step, message, interrupted?, usage?,
  stream?}` with a content-block array); only `text` blocks are extracted.
- **`0 skipped` is a run-environment fact, not a suite property.** Ten
  conditional `t.skip(...)` branches in four older suites skip silently when a
  host package cannot be imported; the 447-passed figure assumes the host
  dependency tree is installed.
- The original "local UI and remote human both answer, first answer wins"
  approval race is still **unimplemented** (claim-or-hand-back remains).

## [0.2.0] - 2026-11-04

Authorization authority instances (v0.2 R1): a rebuilt AstrBot database no longer
leaves this side rejecting every snapshot.

### Added

- **Authority instance identity.** The cached `session.authz` table now stores
  `instance_id` (the UUID of the A database that produced it) and
  `instance_started_at` (Unix seconds when it was first created), and
  `authzSnapshot()` exposes both (`null` when absent). A push whose
  `instance_id` differs from the cached one replaces the table — even when its
  `version` is lower — only if both sides carry a valid non-negative integer
  `instance_started_at` and the pushed one is **strictly larger**. The same
  instance keeps strict version monotonicity, and an absent or non-string
  `instance_id` falls back to the v0.1 version-only rule without switching the
  cached identity. Invalid optional values are logged and treated as absent; a
  non-integer `version` is still `bad_params`.
- **v0.1 upgrade path (rule 0).** A cached table with no usable `instance_id`
  (written before this release) accepts the first complete pushed identity —
  `instance_id` plus a valid non-negative integer `instance_started_at` — and
  records it even when the pushed `version` is lower. Without this, a B upgraded
  from v0.1 whose A database was rebuilt would keep rejecting the new authority.
  A pushed id without a usable start still falls back to version monotonicity,
  and once the identity is recorded an older-instance snapshot is refused like
  any other replay.
- **No downgrade replay.** A different instance whose start is missing, equal,
  smaller, negative or non-integer is refused (`applied: false`, old table
  kept) and logged as `authz_instance_rollback_refused`. This closes the window
  where a replayed snapshot from an older authority could roll the cached
  authorization table back on demand; the rule never degrades to
  "a different instance is always accepted".
- **Serialized pushes.** `BridgeStore.applyAuthz()` now runs its whole
  read-check-write inside the store's existing `_serialized` write chain (the
  same primitive as `claimApprovalRelease`), so two concurrent pushes cannot
  both read the old table and let the lower-version one overwrite the
  higher-version one and drop a grant.
- **Approval-claim cache follows the instance.** `ApprovalService.syncAuthz()`
  now keys its decision on `(instance_id, instance_started_at, version)` and
  rebuilds for a strictly later instance, a higher version of the same instance,
  or the first complete identity when the cache is still empty (the v0.1
  upgrade path). An older instance snapshot never rebuilds it, and an id without
  a usable start follows version monotonicity without recording a partial
  identity, so a replay cannot resurrect a revoked grant; a failed table read
  still clears the cache (fail-closed).
- **Regression coverage.** `tests/authz-instance.test.mjs` now covers
  the v0.1 upgrade path and its missing-start fallback, the rollback guard after
  an upgrade, same-instance monotonicity, valid and refused instance switches,
  `instance_started_at` equal/missing/invalid cases, the T-05 downgrade replay,
  concurrent pushes, the missing-field fallbacks and the approval cache
  rebuild/refusal/fail-closed paths against a real
  `BridgeStore`/`ApprovalService`. `tests/session-authz-fixture.test.mjs` adds
  five cross-end contract cases driven by the byte-identical A-side
  `tests/fixtures/session_authz_v02.json`, covering the real snapshot shape, the
  upgrade path and the refused older-instance replay.

### Changed

- Agent-auto session creation preserves both cached instance fields when it
  bumps the local table, so a local quota bump cannot erase the authority
  identity or weaken the rollback guard.
- Package version is now `0.2.0`.

## [0.1.0] - 2026-10-30

First implementation of the DSH side of `dsh-bridge/v1`.

### Added

- **Protocol core.** JCS-ASCII and `jcs_frame` canonicalization, SHA-256,
  HMAC-SHA256, hand-written HKDF extract/expand (expand-only over a PRK, because
  `crypto.hkdfSync` always extracts first), `psk_master`, the four handshake MAC
  keys, the four direction-specific session keys, ChaCha20-Poly1305 frame
  sealing with `ciphertext || tag` layout, constant-time comparison, transcript
  digest, and the `input_parts`/`submit`/`approval request` digests.
- **Golden vectors.** All 18 checks of protocol §18.6 pass against
  `tests/fixtures/protocol_vectors_v1.json`, including a negative test proving
  `hkdfSync` cannot reproduce the fixture keys.
- **Session layer.** Four-step handshake with MAC verification, hello replay
  cache, clock-skew rejection, capability validation and negotiation, transcript
  comparison, single-writer send lock (100 concurrent calls produce
  duplicate-free ascending sequence numbers), 64-slot replay window,
  application heartbeat, graceful drain, and fatal-security-event reporting.
- **Routing.** `req`/`rep` pairing with orphan handling, per-`(conn, m, id)`
  idempotent reply cache, event handlers whose failures cannot disconnect the
  session, and strict message-kind validation.
- **Carriers.** WebSocket/WSS (own server, `dsh-bridge.v1` subprotocol, text
  frames, subprotocol refusal), HTTP webhook (`/hello`, `/frames`, `/probe`,
  `/health`, batch validation, inline `auth_ack` response), HTTP long poll
  (`/poll` with MAC-authenticated query, `/poll/ack`, bounded retention, expiry
  without ciphertext reuse), and a manager providing ordered fallback, switch
  history and diagnostics.
- **Application layer.** Task submit/status/list/cancel with strict parameter
  validation, persisted state transitions checked against the §16.1 table,
  immediate-return submissions, duplicate detection, `needs_human` parking for
  unknown outcomes; session list/create/select/manage inside the peer's
  authorization table with quota enforcement and idempotent creation;
  notification outbox with at-least-once delivery, acknowledgements, three-attempt
  wake delivery and a persisted wake budget; approval queueing, single-answer
  settlement, timeout-as-rejection, and decision handling; chunked image transfer
  with magic-byte verification, atomic limit rejection and a TTL sweep.
- **Host adapters.** `ctx.agents` create/resume with state-dependent
  `followup`/`steer`/`inject` delivery, `ctx.attachments` save/read, an
  `approval/request` listener registered with `prepend` that either claims the
  request (bound session, online, remote approval enabled) or hands it back to
  the local UI — never both, because the harness waterfall is a sequential chain
  — `createUserMessage` construction with text-only image degradation, and
  `DSH_HOME`-based data-root resolution. Bridge-local `approval_id` UUIDs are
  used purely as in-process correlation keys; they are never presented as the
  harness `ApprovalRequestId` and are never recovered from audit events.
- **Plugin entry.** Cordis `name`/`inject`/`Config`/`apply`, bundle patch,
  per-connection supervisors, `ctx.effect` disposal that drains sockets, timers
  and agents, and four model-facing tools registered once per entry (a second
  ready peer no longer collides on the registry, and with no ready connection the
  tools answer `not_ready` instead of disappearing).

### Documentation

- README lists `npm` as a prerequisite for the complete test suite, because
  `tests/independent-assembly.test.mjs` executes `npm pack --dry-run --json`.
- The declared license now matches `package.json`: `AGPL-3.0-or-later`. The
  `LICENSE` text (standard GNU AGPL v3, including its appendix example) is
  unchanged.
- The bundle-patch description now matches `cordis.patch.yml`: a `profileContext`
  enables the row, while the default empty `connections` list opens no listener.

### Tests

- The current full-suite snapshot is **377 passed / 0 failed / 0
  skipped** (`node --test 'tests/**/*.test.mjs'`, exit 0, 33.63s, 2026-11-01).
  Cross-repo evidence in the same round: A **427 passed**, A+B real-socket
  business roundtrip **24 passed**, cross-transport **26 passed**, independent
  crypto verification **36/36**, and `tsc -p tsconfig.json --noEmit` **exit 0**.
  The earlier 355/348/310/247 counts and the 22-case business snapshot are
  historical only.
  The suite spans vectors, crypto, replay, handshake, router, the three carriers,
  store, tasks, notify/sessions, approvals, blobs, host adapters, storage
  installation, entry lifecycle and layering.
  The approval suite covers claim exclusivity, hand-back, withdrawal, deadline,
  channel loss, concurrent requests without a `callId`, sid change invalidation
  and late-answer discard.
  The approval and layering suites scan the sources to prove the approval policy
  can never be rewritten and that no layer imports upward.

### Notes

- The harness this plugin targets is `@deepseek-ai/dsh` **0.2.1-rc.2`;
  `peerDependencies` pins that line (`dsh-agent`, `dsh-attachment`,
  `dsh-home-paths`, `dsh-llm`, `dsh-storage`, `dsh-tools`,
  `dsh-user-approval`, plus `@deepseek-ai/cordis`). Runtime dependencies are
  `ws` and `@deepseek-ai/schemastery`. `开发/v0.1/protocol.md` still refers to the
  `0.2.0-rc.2` series, but the wire contract did not change.
- `inject` declares `storage` besides `agents`/`attachments`/`approval`/`tools`:
  the entry reads `ctx.storage` to hand the host storage hub to the store. A
  profile without the service parks the fiber in `PENDING` rather than failing it,
  and the durable data root falls back to `DSH_HOME/bridge/astrbot`.
- `开发/v0.1/protocol.md` and `开发/v0.1/vectors.json` are read-only inputs shared
  byte-for-byte with the AstrBot side. The implementation follows the frozen
  fixture: `LABEL` is `dsh-bridge/v1`, and a test asserts that the constant, the
  fixture label and every golden AAD agree.
- The poll-acknowledgement MAC uses the *requesting* side's HTTP key (§7.4), so a
  poll issued by side A and its acknowledgement both use the A→B key.
- Native-approval settlement follows
  `开发/v0.1/native-approval-id-decision.md`: the bridge claims or hands back, the
  `approval_id` is bridge-local, and a handle dies with its process and its `sid`.
  Claim-or-hand-back is exclusive, so the local UI and the remote human are never
  both presented the same request. **This is not equivalent** to the original
  requirement that both sides can answer and the first answer wins; that
  first-answer race remains unimplemented. `prd.md` §3.5 and `分工.md` B4 still
  describe the older "never claim, race the UI" shape; they are frozen documents,
  and the unmet requirement is recorded here rather than claimed as delivered.
- `approvalRequestDigest` canonicalises with `jcs_frame`, not `jcs_ascii`: the
  approval `reason` is free-form and often Chinese, and the A side's
  `request_digest()` hashes the same bytes.
- Vision capability is resolved from `ctx.llm.resolveModelInfo(provider, model)`
  and its `inputModalities`: `image` means capable, a declared list without
  `image` means text-only, and **an absent `inputModalities` is `unknown`**. Both
  non-image outcomes degrade the attachment to a placeholder and report it in
  `result.degraded`; `unknown` is never silently treated as "supported".

### Known limitations

- **Known operational edges.** Rule 0 re-arms if the local `authz/current` record
  is deleted or corrupted, and `instance_started_at` is second-granular, so a
  same-second authority rebuild is refused rather than rolled back. Both are
  documented fail-safe/operational limits (README "Known limitations") and
  queued for v0.3 hardening.
- **Not verified in a real environment (BLOCKED-ENV).** No real DSH host
  assembly, no real AstrBot peer, no real IM platform, no real LLM route, no real
  OpenAPI/SSE run, no real TLS, no cross-machine network. Everything above is
  unit/protocol evidence over loopback sockets.
- **Final stable acceptance is current for unit/protocol evidence.** The 377
  passed suite, the A/B roundtrip and the type check above are the current tree;
  a real host run is still `BLOCKED-ENV`.
- **Type checking passes.** `tsc -p tsconfig.json --noEmit` exits 0; JSDoc record
  shapes and parameter annotations were made explicit instead of disabling
  `checkJs` or excluding files.
- **The original first-answer race is unimplemented.** Claim-or-hand-back is not
  equivalent to "both sides may answer, first answer wins".
- **`approval.lookup` §12.7 is implemented.** The receiving side queries the
  initiator when it has no complete local evidence, re-checks the captured
  session/capabilities around the call, persists a `peer_lookup` mirror and
  consumes it once. Only `approval_evidence_missing` is passed through; every
  other remote refusal becomes `approval_lookup_failed`. Unknown/unnegotiated
  `peer_caps` refuse the query instead of attempting it.
- **Host boundary and A-side main wiring are integrated.** The AstrBot
  `main.py` notification-channel filter, per-session provider, `can_write`,
  `wake_lock` and `bind_peer_caps(session.peer_caps)` are wired and covered by
  assembly regressions. A real host run is still `BLOCKED-ENV`.
- **Webhook needs two-way reachability** and both sides must bind a reachable
  address with the other's `peerHost`/`peerPort`. The AstrBot peer can now expose
  independent `conn_bind_addr`/`conn_bind_port` fields, so a valid cross-machine
  configuration exists, but it is unverified in reality and A has no
  self-referential-peer check. If only one direction is reachable, use `ws` or
  `longpoll`.
- **Two connections on one machine must not share a `bindPort`**; the second
  listener fails with `config_invalid` instead of sharing a socket.
- **The npm tarball excludes the dev tree and tests**, but the user delivery
  archive must contain `tests/` and `tests/fixtures/`; the npm allow-list is not
  the delivery artifact.

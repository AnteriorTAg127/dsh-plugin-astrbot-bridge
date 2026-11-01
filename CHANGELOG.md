# Changelog

All notable changes to this plugin are recorded here. The development-process
log lives in `开发/changelog.md`, which is not committed.

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

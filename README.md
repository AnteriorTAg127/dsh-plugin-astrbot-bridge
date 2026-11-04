# dsh-plugin-astrbot-bridge

DSH-side peer bridge between **DeepSeek Harness** and **AstrBot**. It is a
symmetric bridge: this side both *executes* tasks the AstrBot side initiates and
*initiates* tasks there, over an authenticated and encrypted channel that works
without TLS.

> **This is a DSH plugin, not an AstrBot plugin.** There is deliberately no
> `main.py` (and no `.py` file at all) in this repository, so AstrBot's plugin
> scanner does not load it. The entry point is the Cordis plugin in
> `lib/index.js`.

**Status: `0.2.0`.** Current B-side snapshot (2026-11-04): **424 passed / 0 failed**
(`node --test 'tests/**/*.test.mjs'`, 0 skipped; 47 v0.2 R1 cases) and
`tsc -p tsconfig.json --noEmit` exit 0. The cross-repo figures remain the v0.1
baseline and were not re-run for `0.2.0`: A `427 passed`, A+B real-socket
business roundtrip **24 passed**, cross-transport **26 passed**, independent
crypto verification 36/36. The §12.7 `approval.lookup` amendment is implemented
and validated in unit/business tests. The plugin has **not** been exercised
against a real DSH host, a real AstrBot peer, a real LLM route, real OpenAPI/SSE
or real network conditions — those remain **BLOCKED-ENV**. Read "Known
limitations" before deploying.

## What it does

- **Bidirectional tasks.** Inbound tasks run on a real DSH agent session; outbound
  tasks are submitted to AstrBot and return their `task_id` immediately (the
  reply never waits for execution).
- **Three carriers, both roles.** WebSocket/WSS, HTTP webhook and HTTP long
  poll, each usable as `listen` or `connect`, with ordered fallback and a
  five-minute retry back to the preferred carrier. When webhook reverse delivery
  breaks, the carrier reports `transport_degraded` and the manager falls back to
  the next configured carrier (long poll by default) instead of silently dropping
  reverse events.
- **Own listener.** The listening side of each carrier runs its own
  `node:http(s)` server (webhook runs one in both modes, because it needs reverse
  delivery either way). It does **not** reuse the DSH web server and it never
  touches the AstrBot dashboard port. Bind and peer addresses are separate fields
  (`bindHost`/`bindPort` vs `peerHost`/`peerPort`), so a `listen` endpoint never
  targets its own socket, two connections on one machine cannot share a
  `bindPort` (the second fails with `config_invalid`), and a self-referential peer
  is refused at start (`config_invalid`) rather than fed back into the reverse
  path. The self-check is applied by the webhook carrier; `ws` and `long poll`
  decide direction from `mode` instead.
- **Authenticated, encrypted frames.** A four-step PSK handshake per connection,
  HKDF-SHA256 key derivation, ChaCha20-Poly1305 sealing of every payload frame,
  per-direction monotonic sequence numbers with a 64-slot replay window, and a
  single-writer lock so a nonce can never repeat. There is no `Authorization`
  header and no bearer token anywhere; such a header is rejected.
- **Durable, idempotent work.** Tasks, idempotent replies, the notification
  outbox, approvals, decisions, the session authorization cache and the wake
  budget all persist through the host storage service (`ctx.storage`, json
  backend), falling back to files under `DSH_HOME/bridge/astrbot` only when no
  storage hub is mounted. A duplicate submit returns the same task; a replay
  never executes twice; a task whose outcome is unknown is parked as
  `needs_human` instead of being re-run.
- **Archived sessions really refuse delivery.** `session.manage` archive state is
  persisted, and both the inbound-task path and the notification wake path check
  it before using a session as a delivery target (`session_archived`).
- **Approvals stay human.** For a bound, online session the plugin *claims* the
  harness `approval/request` and forwards it to the AstrBot side, so the AstrBot
  human is the answerer; for any other request it hands the request back to the
  local DSH UI. It never rewrites the approval policy, never fabricates a
  request, and never grants on its own. When the harness policy is `never` the
  request never reaches the bridge, and that is *not* treated as approval.
  Claim-or-hand-back is exclusive because the harness waterfall is a sequential
  chain: `next()` transfers the remaining authority, so "delegate and also let a
  remote answer win" is not a supported shape. **This is not equivalent to the
  original requirement** that both the local UI and the remote human can answer
  and the first answer wins: under claim-or-hand-back the two are never both
  presented, so that first-answer race is still **unimplemented**. Do not read
  the exclusivity as if the original race had been delivered.
- **Images on the real attachment runtime.** Inbound images are stored through
  `ctx.attachments` (`ImageAttachmentRef`), outbound images are read back with a
  digest check. Vision capability is resolved from the real route
  (`ctx.llm.resolveModelInfo(provider, model).inputModalities`): a route that
  declares `image` gets the image, one that declares a list without `image`
  degrades to placeholders, and a route that does **not** declare
  `inputModalities` at all is treated as `unknown` and degrades too (fail
  closed) — the reason is reported in `result.degraded`.

## Requirements

| Item | Version |
|------|---------|
| Node | `>=22` (verified on `v24.20.0`) |
| npm | bundled with Node (verified with the `v24.20.0` toolchain) — required by the complete test suite, whose independent-assembly test runs `npm pack --dry-run --json` |
| `@deepseek-ai/dsh` | `0.2.1-rc.2` — provided by an installed host, never vendored here |
| Peer plugin | `astrbot_plugin_dsh_bridge` on the AstrBot side |
| AstrBot peer (for the A+B suite) | AstrBot `4.29.3` / Python `3.12.16` (tested) |
| A+B integration tests (A side) | POSIX (Linux/macOS, or WSL on Windows): the A-side harness uses `/proc`, process groups and `SIGKILL` |

Runtime dependencies: `ws` (`^8.21.0`) and `@deepseek-ai/schemastery`
(`~3.18.5`). Peer dependencies are the harness packages this plugin is developed
against: `@deepseek-ai/cordis` (`~4.0.5`), and `dsh-agent`, `dsh-attachment`,
`dsh-home-paths`, `dsh-llm`, `dsh-storage`, `dsh-tools`, `dsh-user-approval`, all
pinned to `0.2.1-rc.2`. Those peer packages are resolved from the **installed
DSH host's own dependency tree**, not from this repository; the tested setup links
them from the host rather than relying on a fresh `npm install` here.

`inject` is `['agents', 'attachments', 'approval', 'tools', 'storage']`. A profile
that does not mount all five leaves the plugin fiber in `PENDING` — the correct
outcome, since a bridge without a storage hub could not persist anything.

The protocol document in `开发/v0.1/protocol.md` is an **internal development
record and is not shipped in the public package**. It predates the `0.2.1-rc.2`
bump and refers to the `0.2.0-rc.2` series; the wire contract is unchanged. It
also carries the 2026-10-31 §12.7 `approval.lookup` evidence amendment whose
final acceptance is still pending; `LABEL`, crypto, AAD and the public fixture
`tests/fixtures/protocol_vectors_v1.json` are unchanged.

## Install

Every command below is a **single line of PowerShell**, to be run in the
directory named in the comment. Paths use `<...>` placeholders you replace
locally.

### 1. Provide the dependencies

`ws` and the `@deepseek-ai/*` packages are **not** vendored in this repository.
The `@deepseek-ai/*` entries are the host's own packages (pinned in
`peerDependencies` to `0.2.1-rc.2`), so they must come from the **real installed
DSH host dependency environment** — the same tree the plugin will run against.

**Supported: link this checkout at the installed host tree** (no network), run in
this repository:

```powershell
Set-Location <path>\dsh-plugin-astrbot-bridge; New-Item -ItemType Junction -Path .\node_modules -Target (Join-Path (npm root -g) '@deepseek-ai\dsh\node_modules')
```

`npm root -g` prints the global `node_modules` directory; if the host is installed
elsewhere, point `-Target` at that host package's `node_modules` yourself. A
junction does not need an elevated shell (a real symlink does). The link resolves
`ws` and every `@deepseek-ai/dsh-*` import, which is what the test suite and a
profile that already ships those packages need. Do not commit `node_modules`.

**Not a substitute: a clean `npm install` in this checkout.** The tested setup
resolves the `@deepseek-ai/*` peer packages from the installed host's dependency
tree; a fresh `npm install` here is not that environment, so it must not be
described as reproducing the tested environment or the full suite. If your
profile or registry already provides the host packages, link that tree instead —
do not claim a bare `npm install` makes every test reproducible.

### 2. Mount the plugin

The bundle ships `cordis.patch.yml`, which inserts the plugin row. The row is
enabled when the host provides a `profileContext` (a normal profile) and stays
disabled without one. Its default `connections` list is empty, so even an enabled
row opens no listener until a connection is configured:

```yaml
- insert:
    - id: astrbot-bridge
      name: 'dsh-plugin-astrbot-bridge'
      disabled: !!js "!ctx.get('profileContext')"
```

Add it to a profile's `dsh.profile.bundles`, or add the same row to your own
`cordis.patch.yml`. Then enable it with real configuration.

### 3. Configure a connection

A connection without a PSK refuses to start — it never degrades to a plaintext
link. Minimal working configuration (in your profile patch):

```yaml
- id: astrbot-bridge
  name: 'dsh-plugin-astrbot-bridge'
  config:
    side: B
    connections:
      - id: default                 # must equal the peer's conn id
        mode: listen                # the peer must use `connect`
        transport: ws               # ws | webhook | longpoll
        transportFallback: [longpoll]
        host: 127.0.0.1             # listen: bind address; connect: peer address
        port: 8765
        path: /dsh-bridge
        pskId: default              # identifier, not a secret
        pskSecret: '<at least 32 random characters>'
        allowPrivateAddr: false
    approvalTimeoutSeconds: 1800
```

For webhook (which needs two-way reachability) add the explicit pairs on both
ends — on this side for example `bindHost: 0.0.0.0`, `bindPort: 18801`,
`peerHost: <the A host>`, `peerPort: 18802`. On the A side use a concrete
`conn_bind_addr` (not `0.0.0.0` when the peer is remote) and a fixed
`conn_bind_port`; A rejects a wildcard/loopback bind address for a remote peer.
With several connections on one machine, give every listener its own `bindPort`;
see "Bind and peer addresses" below.

Generate the secret locally and exchange it out of band — run anywhere:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

**The secret is never logged, never sent on the wire and never stored in the
bridge database.** Configuration files are the only place it lives.

#### Connection fields

| Field | Default | Meaning |
|---|---|---|
| `side` | `B` | This endpoint's side; the peer must use `A` |
| `connections[].id` | `default` | Connection identity, must match the peer |
| `connections[].mode` | `listen` | Who opens the carrier; must be opposite on the peer |
| `connections[].transport` | `ws` | Preferred carrier |
| `connections[].transportFallback` | `[longpoll]` | Fallback order |
| `connections[].host` | `127.0.0.1` | Historical single-address field: bind address in `listen`, peer address in `connect` |
| `connections[].port` | `8765` | Historical single-port field, same split as `host` |
| `connections[].bindHost` | `''` | **Local** bind address; empty reuses `host` (connect: `127.0.0.1`) |
| `connections[].bindPort` | `0` | **Local** bind port; `0` reuses `port` in `listen`, an ephemeral port in `connect` |
| `connections[].peerHost` | `''` | **Peer** address for reverse delivery, used by `webhook` and `longpoll`; empty means unset |
| `connections[].peerPort` | `0` | **Peer** port, same carriers; must be set together with `peerHost` |
| `connections[].path` | `/dsh-bridge` | Path prefix for every endpoint |
| `connections[].tlsEnabled` | `false` | Serve or require TLS |
| `connections[].pskId` / `pskSecret` | `''` | PSK identity and secret; empty refuses the link |
| `heartbeatInterval` | `30` | Heartbeat seconds |
| `reconnectMaxBackoff` | `60` | Maximum reconnect backoff in seconds |
| `wakeMaxChain` | `8` | Automatic wake-ups per root task |
| `wakeRatePerMinute` | `10` | Automatic wake-ups per minute per session |
| `approvalTimeoutSeconds` | `1800` | Approval timeout; expiry is a rejection |
| `imageMaxCount` / `imageMaxBytes` / `imageTotalMaxBytes` | `4` / `10 MiB` / `20 MiB` | Image limits |
| `imageEnabled` | `true` | Accept image attachments |
| `imageAllowedMime` | gif/jpeg/png/webp | Accepted media types |
| `remoteNativeApproval` | `true` | Claim harness approvals and forward them; `false` serves only the local UI |
| `allowedSessionPurposes` | `[]` | Local purpose allow-list; empty means any |
| `dataRoot` | `''` → `DSH_HOME/bridge/astrbot` | Bridge data root |
| `taskRetentionDays` | `7` | Retention for finished tasks and delivered notifications |

#### Bind and peer addresses — read this before picking ports

`bindHost`/`bindPort` are where **this** endpoint listens; `peerHost`/`peerPort`
are where the **peer** listens. Keeping them separate is what makes reverse
delivery possible: a `listen` endpoint that treated its own bind address as the
peer would POST every reverse frame to itself.

- **Webhook: both endpoints listen.** Two-way reachability is a hard requirement,
  so both sides bind a reachable address and both configure the other's
  `peerHost`/`peerPort`. **WS and long poll: only the `listen` side binds**; the
  `connect` side dials (WS, always `host:port`) or polls (long poll, `GET /poll`
  against `peerHost:peerPort` after the handshake), so it needs no inbound
  reachability. Long poll still uploads over `POST /frames`, so the `connect`
  side must be able to reach the listener for both directions of traffic — but
  only outbound, never inbound.
- **Two connections on the same machine must not bind the same port.** The second
  `listen` fails with `config_invalid {field:'port'}`; it does not silently share
  a socket. Give each connection its own `bindPort` (or let `connect`-side
  endpoints use the ephemeral default `0`).
- **A self-referential endpoint is refused at start.** On the `webhook` carrier, if
  `peerHost`/`peerPort` resolves to this endpoint's own bind address on the same
  port, `start()` throws `config_invalid` before binding, so traffic is never fed
  back into its own reverse path. A wildcard bind (`0.0.0.0`) is only considered
  "self" when the peer address is an address this machine actually has. `ws` and
  `longpoll` decide direction from `mode` instead (`ws` dials `host:port`, long
  poll polls `peerHost:peerPort`), so they have no equivalent start-up check.
- **A `listen` endpoint with no `peerHost`/`peerPort` still accepts inbound frames
  but fails outbound closed**: the webhook carrier warns
  `webhook_peer_not_configured` at start and throws `config_invalid` on the first
  reverse send, and long poll throws `config_invalid` when it needs the peer base
  URL. This is deliberate — the fallback that would "guess" the peer from
  `host`/`port` is exactly the self-post defect. Half a peer address (only one of
  the two fields) is always `config_invalid`.
- `host`/`port` remain supported and keep their historical meaning; the explicit
  pairs take precedence when set. For `ws`, the `connect` side always dials
  `host:port` — give a `connect` connection the peer's address there (or use the
  webhook/long-poll `peerHost`/`peerPort` pair).

Carrier reachability, summarised:

| Carrier | Reachability | Reverse path |
|---|---|---|
| `ws` / `wss` | One-way: the `connect` side dials `host:port` of the `listen` side | Frames ride the same socket both ways |
| `longpoll` | One-way: the `connect` side only makes outbound requests (`GET /poll`, `POST /frames`, `POST /poll/ack`) | The listener queues frames; the dialer pulls them |
| `webhook` | **Two-way**: each side must reach the other's bind address | `POST /frames` back to `peerHost:peerPort` |

If only one direction is reachable (NAT, firewall), use `ws` or `longpoll`.

#### Deploying against the AstrBot peer

The AstrBot plugin (`astrbot_plugin_dsh_bridge`) now has **two separate field
pairs**: `conn_bind_addr`/`conn_bind_port` for its own inbound listener and
`conn_host`/`conn_port` for the peer. It can therefore act as either `connect` or
`listen`, with the modes opposite on this side:

- **ws / wss and longpoll:** one-way reachability is enough. A listener may bind
  `0.0.0.0` with a fixed `conn_bind_port`; point this side's `host`/`port` (ws
  `connect`) or `peerHost`/`peerPort` (longpoll `connect`) at that endpoint.
- **webhook:** it is usable on A now, but both endpoints must be reachable. A's
  `connect` side requires an explicit `conn_bind_port > 0`, and a cross-machine
  deployment requires `conn_bind_addr` to be a concrete local address (A rejects
  `0.0.0.0`/loopback when the peer is remote). Set this side's
  `bindHost`/`bindPort` to a reachable address and `peerHost`/`peerPort` to A's
  bind endpoint.
- **Same-machine listeners** still need distinct `bindPort` values; A has no
  self-referential-peer check, so keep its `conn_host` pointed at the peer.
- Earlier statements that A "binds `127.0.0.1` only" or that "webhook cannot work
  on A in either role" are **obsolete** and have been removed from the A README.
  Cross-machine webhook has a valid configuration now, but it is still
  **BLOCKED-ENV**: no real cross-machine reverse delivery has been verified.

### 4. Where data lives

When the profile mounts `ctx.storage`, every record goes through the `json`
backend's per-record layout under the host storage unit. Otherwise the built-in
file writer is used under `DSH_HOME/bridge/astrbot` (or `dataRoot` if set), never
inside this repository, so a reinstall cannot destroy it:

```
$DSH_HOME/bridge/astrbot/
├── tasks/       # one document per task
├── replies/     # idempotent reply cache
├── notifies/    # notification outbox
├── approvals/   # approval requests and their single decision
├── decisions/   # business decisions
├── authz/       # cached session authorization table (authority is the peer)
└── wake/        # per-root-task wake budget
```

### 5. Authority instances and database rebuilds

A is the sole authorization authority. Every A database carries an
`instance_id` (a UUID, not a credential) and the `instance_started_at` Unix
timestamp of when that database was first created; each `session.authz` snapshot
names both. This side accepts a **complete replacement** from a different
instance even when its `version` is lower, but only when the push carries a
strictly larger `instance_started_at`. That is what makes a rebuild survivable:
recreating A's `bridge.db` restarts `version` at 0 with a later start timestamp,
so the rebuilt authority is accepted. Within one instance the version stays
strictly monotonic.

The ordering condition is a security requirement, not a detail. Without it, a
replayed snapshot from an *older* instance — which may carry a much higher
version — could roll the cached table back to an old authorization state on
demand. Such a push is refused (`applied: false`, old table kept) and logged as
`authz_instance_rollback_refused`; a switch whose start is missing, equal,
smaller, negative or non-integer is refused the same way. The rule never
degrades to "a different instance is always accepted". A snapshot that omits
`instance_id` (an older A) falls back to the version-only v0.1 rule and does not
switch the cached instance identity.

Upgrading from v0.1 is a one-time exception. A cached table written before these
fields existed has no identity, so the first complete snapshot from a rebuilt A
(id plus a valid `instance_started_at`) is accepted and recorded even when its
`version` is lower; otherwise the very upgrade this release targets would still
be refused. A pushed id without a usable start does not take that path and falls
back to version monotonicity. Once the identity is recorded, an older-instance
snapshot is refused exactly like any other replay.

The instance fields grant nothing and authenticate nothing: the grants still come
one-for-one from the authenticated A, and `instance_started_at` is only an
ordering hint. The same `(instance_id, instance_started_at, version)` rule drives
the approval-claim cache, so after a rebuild an old session can no longer be
claimed with the stale table, while a replayed older-instance snapshot cannot
resurrect a revoked grant there either. A failed read of the table still clears
that cache (fail-closed: unknown is not allowed).

## Tools exposed to the model

| Tool | Purpose |
|---|---|
| `bridge_submit_task` | Submit work to AstrBot; returns the `task_id` immediately |
| `bridge_task_status` | Read one task's state |
| `bridge_list_sessions` | List AstrBot sessions this bridge is authorized to use |
| `bridge_call_astr_tool` | Ask an AstrBot agent session to use one of its tools |

Tools are registered **once per entry**, not per connection: the harness registry
rejects a duplicate name, so per-connection registration made the second ready
peer fail to start. With no ready connection the tools stay visible and answer
`not_ready` (`details.reason = no_ready_connection`) instead of disappearing.

`bridge_call_astr_tool` is deliberately a *task*, not a tool RPC: AstrBot exposes
no per-tool endpoint, so the request is executed inside an authorized AstrBot
agent session where that side's permission model and human approval still apply.

## What gets published

Two different artifacts exist; do not confuse them.

**1. npm package.** The tarball is an **allow-list** (`files` in `package.json`),
not a filter. `npm pack --dry-run` yields exactly 31 paths:

```
package.json  README.md  CHANGELOG.md  LICENSE  cordis.patch.yml
lib/**/*.js (25 files)   lib/types/index.d.ts
```

The `lib/` tree is 25 JavaScript files: 10 at the root (`index`, `tools`,
`constants`, `errors`, `crypto`, `log`, `replay`, `router`, `session`, `store`),
5 under `lib/transport/`, 5 under `lib/app/` and 5 under `lib/host/`. Everything
else stays out of the tarball: `开发/`, `tests/` including `tests/fixtures/`,
`tsconfig.json`, `.probe-tmp/` and `node_modules`.

**2. User delivery archive.** The deliverable handed to a user is a **complete
repository archive**, not the npm-only tarball. It must contain `tests/`
including `tests/fixtures/protocol_vectors_v1.json`, `package.json`,
`tsconfig.json`, `cordis.patch.yml`, `lib/`, `README.md`, `CHANGELOG.md`,
`LICENSE` and `.gitignore`. Only development process, VCS metadata, credentials,
runtime state, dependencies and caches are excluded. This one-line PowerShell
does that (`<path>` and the output path are local placeholders):

```powershell
$s='<path>\dsh-plugin-astrbot-bridge'; $d=Join-Path $env:TEMP 'dsh-plugin-astrbot-bridge_delivery'; Remove-Item $d -Recurse -Force -ErrorAction SilentlyContinue; robocopy $s $d /E /XD 开发 .git node_modules .probe-tmp __pycache__ /XF *.log *.pem *.key *.p12 secrets.json credentials.json api_config.json .env* | Out-Null; if ($LASTEXITCODE -lt 8) { Compress-Archive -Path (Join-Path $d '*') -DestinationPath '<output>\dsh-plugin-astrbot-bridge-0.1.0.zip' -Force }
```

> `node_modules` here is normally a junction to the harness dependency tree;
> `robocopy /XD node_modules` keeps it out of the archive instead of copying the
> whole host tree. No secret file format is tracked by this repository, and the
> PSK only ever lives in your own profile configuration — the package, the code
> and the docs contain no real credential.

Developers who need to inspect the npm boundary can run it read-only:

```powershell
Set-Location <path>\dsh-plugin-astrbot-bridge; npm pack --dry-run
```

## Development

All commands are single-line PowerShell and run **in this repository directory**.
The suite needs the host dependency tree from "Install" step 1; it is not
reproduced by a clean `npm install`. It also needs `npm` on `PATH`: the complete
suite includes `tests/independent-assembly.test.mjs`, which runs
`npm pack --dry-run --json` to verify the published file allow-list.

```powershell
Set-Location <path>\dsh-plugin-astrbot-bridge; npm test
```

```powershell
Set-Location <path>\dsh-plugin-astrbot-bridge; npm run test:all
```

> `npm test` selects the 32 root `tests/*.test.mjs` files; `npm run test:all`
> uses `tests/**/*.test.mjs`, so it covers every root and nested test file. There
> are no nested test files today, but the full-suite acceptance command uses
> `test:all` so a future nested suite cannot be silently skipped. The current
> full-suite count is **424 passed** against the host dependency tree.

Golden-vector subset:

```powershell
Set-Location <path>\dsh-plugin-astrbot-bridge; node --test tests/vectors.test.mjs
```

Type checking (`checkJs`, `noEmit`) covers **`lib` only**: `tsconfig.json` has
`include: ["lib/**/*.js"]` and excludes `tests`. It needs a TypeScript compiler;
`typescript` is not vendored here:

```powershell
Set-Location <path>\dsh-plugin-astrbot-bridge; npx --yes tsc -p tsconfig.json --noEmit
```

That command exits 0 in this checkout. It does not type-check `tests/`, and the
test suite does not depend on it.

The A-side integration harness (run from the `astrbot_plugin_dsh_bridge`
checkout) reads these environment variables; the defaults are enough when the two
checkouts are siblings:

| Variable | Default | Meaning |
|---|---|---|
| `DSH_BRIDGE_PYTHON` | `sys.executable` of the pytest run | Python used by the A-side peer; highest priority |
| `DSH_BRIDGE_B_ROOT` | sibling `dsh-plugin-astrbot-bridge` checkout | This repository's path |
| `DSH_BRIDGE_NODE` | `node` | Node binary used to launch `b_peer.mjs` |

The A-side cross-transport suite is **POSIX-only** (`/proc`, process groups,
`SIGKILL`); on Windows run the A+B integration from WSL, not native PowerShell.

### Test status (historical snapshot, not current acceptance)

- **Current B-side full-suite snapshot:** `node --test 'tests/**/*.test.mjs'` →
  **424 passed / 0 failed / 0 skipped** (exit 0, 34.67s, `v24.20.0`,
  `DSH_HOME`/data root at a temporary directory), recorded 2026-11-04 and
  including the 42 v0.2 R1 authority-instance cases (v0.1 upgrade path,
  downgrade replay, unorderable switches, serialized concurrent pushes,
  approval-cache rebuild/refusal, fail-closed read).
  `tests/session-authz-fixture.test.mjs` adds five cross-end contract cases that
  read the byte-identical A-side fixture `tests/fixtures/session_authz_v02.json`
  and pin the real snapshot shape, the v0.1 upgrade path and the refused
  older-instance replay, including the approval-claim cache.
- **Cross-repo snapshot (v0.1 baseline, not re-run for `0.2.0`):** A
  `427 passed` (28.27s); A+B real-socket business roundtrip **24 passed**
  (248.38s); cross-transport **26 passed** (160.19s); independent crypto
  verification 36/36. Earlier 394/355/348/310/247 counts and the 22-case
  business snapshot are obsolete.
- **Real host acceptance is still `BLOCKED-ENV`.** No real DSH/AstrBot host,
  IM, LLM, OpenAPI/SSE or TLS run has been performed.
- `tsc -p tsconfig.json --noEmit` exits 0 on the current `lib/` tree (the
  earlier ~151 JSDoc precision errors were fixed with explicit record casts and
  missing parameter annotations).
- Nothing above exercises a real DSH host, a real AstrBot peer, real OpenAPI/SSE,
  a real LLM or real TLS; those are **BLOCKED-ENV**.

The golden-vector suite (`tests/vectors.test.mjs`) pins every derived key, MAC,
digest and frame ciphertext to `tests/fixtures/protocol_vectors_v1.json`, the
public read-only fixture. Its frozen source `开发/v0.1/vectors.json` is an
internal development record and is **not shipped** with the public package, so
the fixture — not that path — is the public reference. The protocol does not
allow an implementation to change the fixture, so a red vector always means the
implementation is wrong.

### Layout

```
lib/
├── index.js            # Cordis entry: composition, lifecycle, per-connection supervisor
├── tools.js            # model-facing tools
├── constants.js        # protocol constants, state tables, error-code metadata
├── errors.js           # BridgeError with the closed §15 vocabulary
├── crypto.js           # JCS, HKDF (hand-written expand), ChaCha20-Poly1305 sealing
├── replay.js           # 64-slot replay window
├── session.js          # handshake state machine, single-writer lock, heartbeat
├── router.js           # req/rep pairing and the idempotent reply cache
├── store.js            # durable bridge domain
├── log.js              # structured English logging with field redaction
├── transport/          # base + ws + webhook + longpoll + manager
├── app/                # tasks, sessions, notify, approvals, blobs
└── host/               # agents, approval, attachments, llm, storage
```

The layering test (`tests/layering.test.mjs`) enforces that carriers never import
the application layer, that the session layer never imports carriers, and that
application code never touches a socket.

## Security notes

- Secrets are never printed. The logger drops known secret/payload field names,
  and `BridgeError` messages are fixed English sentences that cannot echo peer
  input.
- `Authorization`, `Cookie`, `Proxy-Authorization` and `Content-Encoding` are
  rejected on every endpoint; the channel authenticates with a MAC handshake and
  AEAD, not with a bearer token.
- Approval grants apply to exactly one action (`allowed-once`). `unavailable` and
  `cancelled` are refusals, and so are deadline expiry (`rejected`), request
  withdrawal (`cancelled`) and channel loss (`unavailable`).
- A claimed approval handle lives only in this process and only for the current
  handshake `sid`: a reconnect or a restart settles the old handle as
  `unavailable` and it is never re-asked.
- A failed handshake is a structured security event with a fixed code; the
  connection is torn down and never retried with the same nonce.
- The peer address is read from configuration only, never from a request, header
  or handshake object, so a peer cannot redirect this endpoint's outbound traffic.

## Known limitations

- **Not verified against reality (BLOCKED-ENV).** No real DSH host assembly, no
  real AstrBot peer, no real IM platform, no real LLM call, no real OpenAPI/SSE
  run, no real TLS, no cross-machine network. All evidence is local:
  unit/protocol tests and loopback sockets.
- **Real-host final acceptance is still `BLOCKED-ENV`.** The 424-test B suite
  (with the 427/24/26/36 cross-repo figures from the v0.1 baseline) validates
  unit logic, loopback business flows, the cross-transport carriers and crypto
  only; it must not be quoted as a real-host result.
- **The one-time upgrade path can reopen if the local cache is wiped.** Rule 0
  (`no cached identity -> accept the first complete identity`) only applies while
  the cached `authz/current` record has no usable `instance_id`. Deleting or
  corrupting that record therefore re-arms the path: one older-instance snapshot
  would be accepted and the table rolled back. The channel is authenticated and
  the frame `seq` window rejects replays, so this is an operational invariant
  (do not hand-edit the authz record), not a new attack surface; persisting a
  "identity was once recorded" marker is a v0.3 hardening item.
- **`instance_started_at` has one-second resolution.** If the authority database is
  rebuilt within the same second, the new and old values are equal and rule 4
  refuses the new instance even with a higher version. That is the fail-safe
  direction (no sync instead of a rollback); clear the peer's `authz/current`
  record and let it push again. Millisecond/monotonic ordering is a v0.3 item.
- **Type checking passes.** `tsc -p tsconfig.json --noEmit` exits 0; record shapes
  and parameter annotations were made explicit instead of disabling `checkJs` or
  excluding files.
- **The original first-answer race is not implemented.** Native approval is
  claim-or-hand-back: the remote human and the local UI never both answer the
  same request. That exclusivity is *not equivalent* to the PRD requirement that
  both can answer and the first answer wins; earlier design documents that
  describe "show both and let the first answer win" remain the unmet target.
- **`approval.lookup` is implemented and locally validated.** The receiver
  queries the initiating side when it has no local evidence, re-checks the
  session before/after the call, imports a `peer_lookup` mirror and consumes it
  once; failures stay fail-closed. Real-host acceptance remains `BLOCKED-ENV`.
- **Host boundary and A-side main wiring are integrated.** The notification
  channel filter, per-session provider, `can_write`, `wake_lock` and
  `bind_peer_caps(session.peer_caps)` are wired in the AstrBot `main.py` and
  covered by assembly regressions. Real-host acceptance remains `BLOCKED-ENV`.
- **Webhook needs bidirectional reachability.** One-way deployments must use `ws`
  or `longpoll`. The AstrBot peer *can* now expose an independent
  `conn_bind_addr`/`conn_bind_port`, so a cross-machine webhook configuration is
  expressible, but it is unverified in reality; A also has no
  self-referential-peer check of its own. Keep `conn_host` pointed at the peer.
- **The dev tree is not part of the npm package.** `开发/`, `tests/`,
  `tsconfig.json` and scratch directories are excluded from `npm pack`; only the
  `files` allow-list is published. This does **not** apply to the user delivery
  archive, which must include `tests/` and `tests/fixtures/` (see "What gets
  published").

## License

AGPL-3.0-or-later, matching the `license` field in `package.json`. `LICENSE` is
the standard GNU AGPL v3 text, including its "How to Apply These Terms" appendix
example, and is the binding license text.

# Integrity audit 2026-07 — residue register

> Status: **FINDINGS (2026-07-21).** The post-cycle integrity audit (channels/broker
> M-T4.4, realtime M-T1.10, read-path projections, observability M-T7.1, Flutter,
> test-placement) checked, per feature × target, whether a shipped feature has CI,
> and whether it emits correctly or fails honestly. Most of it was healthy. The
> fixes that didn't overlap in-flight read-path work **shipped in #2203**; this doc
> is the durable register of the deferred remainder so nothing is lost.
>
> Sibling proposal (the one substantial feature): [`realtime-tenant-room-parity.md`](./realtime-tenant-room-parity.md).
> Verified against fresh `main`; cite the line, not this prose, when acting.

## Shipped in #2203 (context — do not re-do)

- **Silent channels gap closed** — redis `queue/ephemeral` was accepted by
  `CHANNEL_COMPATIBILITY` but absent from the generator's `SHIPPED_COMBOS`, so it
  emitted no driver and silently fell back to in-process dispatch. Now rejected
  with `loom.channelsource-not-yet-shipped` (`src/language/validators/channel.ts`;
  `SHIPPED_COMBOS` moved to `src/util/channels.ts`).
- **Channels CI wired** — the 16 `test:channels*` e2e legs (redis/rabbit/kafka × 5
  backends + auth) had no workflow; added `channels-e2e.yml` + a broker-bound
  corpus fixture (`channels-broker.ddd`) so the driver code is compile-gated.
- **Elixir runtime gates** — `elixir-oidc-e2e.yml` + `phoenix-ui-e2e.yml` (both
  tests existed, no workflow ran them).
- **Flutter silent drops made honest** — `// TODO(flutter form-field)` markers +
  the parity lint now counts the pack no-renderer fallback + `parity-freeze.test.ts`.
- **Docs reconciled** + **M-T9.10 logged**.

## Residue — deferred findings

### R1 — `persistence: mikroorm` + a projection emits no routes (SILENT) · P1 · S
The Hono emitter gates both projection files on `!usingMikro`
(`src/platform/hono/v4/emit.ts:521,590`), but `validateMikroOrmSupport`
(`src/ir/validate/checks/system-checks.ts:2205`) has **no** projection clause, so a
`deployable { platform: node { persistence: mikroorm } }` hosting a
projection-bearing context passes validation and emits **zero** projection routes.
- **Repro:** any `.ddd` with a `projection` + `persistence: mikroorm` → generate →
  the projection endpoint is absent, no diagnostic.
- **Interim (safe):** add a projection clause to `validateMikroOrmSupport` raising
  `loom.mikroorm-unsupported` (fail honest). One clause, mirrors the sibling rejects.
- **Principled:** a MikroORM projection (read-model) emitter.
- **Coordinate:** projections are being reworked by **#2200** (view removal, merged)
  and **#2202** (projection `ignoring`/`requires`/workflow-source, stacked). Land R1
  in/after that workstream, not against it — this register deliberately does **not**
  touch projection files. (A verified fix was drafted this session and backed out to
  avoid colliding with #2200/#2202.)

### R2 — Elixir absent from the per-feature corpus compile matrix (SILENT-adjacent) · P2 · M
Tracked as mission **[M-T9.10](../../new-plan/T9-toolchain-health.md)**. `corpus-build.yml`
compiles the shared feature manifest on `{tsc, dotnet, java, python}` only — there
is no `test:elixir-corpus`. Every corpus feature's elixir emission is
generation-verified (`corpus-coverage.test.ts`, in-process) but never `mix`-compiled;
elixir's compile gate runs a *separate* curated fixture set
(`test/e2e/fixtures/elixir-vanilla-build/`), not the manifest. A corpus feature whose
elixir output fails to compile ships green per-PR.
- **Fix:** a `test:elixir-corpus` leg + `corpus-elixir-build.yml` (Elixir docker image
  + `LOOM_HEX_MIRROR`, sharded via `LOOM_CORPUS_ELIXIR_CASE`, hex/`_build` cache).
- **Interim:** pin the coverage gap explicitly so it's a reviewed decision.

### R3 — `channels-e2e.yml` first-run tune (INFRA) · P3 · S
The workflow added in #2203 wires all 16 broker legs but couldn't be booted in the
authoring sandbox. On its first real run expect to tune: the rabbitmq erlang-cookie
preseed and kafka KRaft multi-listener config (the suites self-provision these via
`docker run` against the runner's live daemon — coexistence with a GH `services:`
postgres and timeout tuning is unverified), plus `psql`-client availability for the
per-deployable database-create step. Not a bug; a known break-in.

### R4 — Flutter standalone-input widgets + auth gate (SILENT, honest now) · P1 · M
Already owned by **[`flutter-parity-and-native-gates.md`](./flutter-parity-and-native-gates.md)**
missions M-B (Material `TextFormField`/`Switch`/`DefaultTabController` for standalone
`Field`/`Number`/`Select`/`Toggle`/`Tabs`) and M-C (port the Feliz `auth-gate.ts`).
#2203 made these drops **loud** (markers + parity-freeze) but did not emit the
widgets — that needs the `generated-flutter-build` gate to compile-verify real Dart,
so it's the principled follow-up. Cross-referenced here for completeness; the plan
lives in that doc.

## Healthy (audited, no action)

- **Observability (M-T7.1)** — all five backends have obs-e2e workflows that run.
- **Realtime emit parity** — four SSE backends + native Phoenix, five frontends; every
  unsupported combination is behind a `loom.*` warning/error (no silent gap). The one
  real weakness is tenant-room scoping → [`realtime-tenant-room-parity.md`](./realtime-tenant-room-parity.md).
- **Read-path query-time projections** — 5-backend structural parity (`PROJECTION_QT_SUPPORTED`,
  `system-checks.ts`), reworked further by #2200/#2202. The one silent gap (R1) is mikroorm.

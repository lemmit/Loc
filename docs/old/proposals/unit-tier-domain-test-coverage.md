# Unit-tier domain-test coverage — the cross-backend drain

> **Status (2026-07-20): in progress, agent-pickable.** The infrastructure ships
> and four corpus fixtures now carry pure-domain `test` blocks; the rest of the
> corpus is the drain. This doc is the vision + the concrete handoff so any agent
> can pick up the next fixture. Sibling docs: [`test-placement.md`](./test-placement.md)
> (where a `test` belongs), [`test-authoring-language.md`](./test-authoring-language.md)
> (the future `as <user>` / fixture surface), [`platform-parity-debt.md`](./platform-parity-debt.md).

## Problem

A Loom `test "…" { … }` block is a **pure-domain** unit test — construct an
aggregate, call an operation, assert on state or a rejection. Every backend that
runs domain logic (node, python, java, dotnet, elixir) emits it to that
language's test runner (vitest / pytest / JUnit / xUnit / ExUnit) over the
aggregate's pure domain core. The promise is **one authored test, N backends** —
the same idiom exercised on all five, so a domain-logic divergence between
backends is caught mechanically.

The gap was **coverage**, not capability: the emitters existed, but the corpus
carried a domain `test` on essentially one aggregate (`sales`, later
`core-domain`). Broadening past it is where the value is — each new fixture
stresses a different slice of the cross-backend surface (enum construction,
value-object literals, containment folds, derived fields, preconditions), and
**each new surface tends to surface a real per-backend bug**. The three found so
far (B16/B17/B18, `docs/audits/behavioral-parity-bugs-2026-07.md`) all came from
broadening coverage by one aggregate.

## What ships today

- **The five behavioral runners** (`test/behavioral/run*.mjs`) run a per-fixture
  **unit tier** (the `test` blocks) alongside the **api tier** (the `test e2e`
  blocks). node runs in-process on PGlite; python/java/dotnet/elixir boot the
  real generated backend against a Postgres sidecar. See the CLAUDE.md
  "Behavioral tier" section.
- **Domain `test` blocks on four corpus fixtures**: `sales` (behavioral corpus),
  `core-domain` (enum + VO-decimal + collection-containment fold + derived
  field), `saga` (a precondition-gated scalar transition + rejection),
  `single-containment` (a single containment set-through-op + null-safe read).
- **The bug fixes broadening surfaced**: B16 (java/dotnet strong-type coercion of
  id/datetime literals at create/op-call), B17 (elixir collection containment
  `NotLoaded` → `[]` on the pure create), B18 (elixir derived-field pure-core
  accessor), and the **null-safe nullable-field read** emitter fix (node `!` /
  python `cast(...)` for single-containment and optional-field reads).

## The single most important discipline: validate the STRICT gates locally

The behavioral runner is **loose** — vitest/pytest execute the emitted test but do
**not** strict-typecheck it. The per-PR **corpus-build gates do**:
`corpus × tsc` runs `tsc --noEmit`, `corpus × python` runs `ruff` + `mypy
--strict` + `pytest`, `corpus × {java,dotnet}` compile. A domain test can pass
the behavioral runner and still fail the corpus gate. This bit twice:
`single-containment`'s `o.shipment.carrier` ran green behaviorally but failed
`tsc`/`mypy` (`T | null`), and only the corpus gate caught it.

**Before pushing a new domain-test fixture, reproduce the strict gates locally:**

```bash
# node strict tsc
node bin/cli.js generate system <fixture-as-node>.ddd -o /tmp/n && (cd /tmp/n/<depl> && npm i && npx tsc --noEmit)
# python strict (ruff + mypy --strict + pytest)
LOOM_PYTHON_BUILD=1 LOOM_CORPUS_PYTHON_CASE=<id> npx vitest run test/e2e/corpus-python-build.test.ts
LOOM_TS_BUILD=1     LOOM_CORPUS_TSC_CASE=<id>    npx vitest run test/e2e/corpus-tsc-build.test.ts
# elixir: generate and confirm no `@tag :skip` in the emitted *_test.exs
# node/elixir runtime: (cd test/behavioral && node run.mjs <id> ; node run-elixir.mjs <id>)
```

## The drain — remaining corpus fixtures

Only `core-domain`, `saga`, `single-containment` (+ the behavioral `sales`) carry
a domain `test`. The other ~26 `test/fixtures/corpus/*.ddd` are the work. Add
**one fixture per PR**, stressing a surface the existing tests don't, validated on
the strict gates above. **Prefer flat aggregates that read only non-nullable
scalars/enums/VOs** — those emit cleanly with today's emitters. The catch is that
most fixtures weren't authored with domain-test-ability in mind, so they hit
edges. Known edges, so the next agent doesn't rediscover them:

| Fixture | New surface | Edge / gate |
|---|---|---|
| `outbox` | scalar op + emit (stripped in pure core) | clean — good next pick |
| `provenance`, `stamps` | provenanced / managed fields | check the read is non-null |
| `criterion-filter` | reusable `criterion` predicates | criteria are *capability filters*, not domain-object methods — thin unit surface |
| `value-collections` | `Money[]` inline value-object array | **emitter gap**: the test emitters have no `list`-literal arm — a `[VO{…}, …]` create-arg `@tag :skip`s on elixir / won't render. Needs a list arm first. |
| `operation-returns` | value-returning op (`T or Error`) | the union return is a tagged wire shape — asserting `.toBe` on it isn't clean cross-backend; needs a design pass |
| `inheritance`, `tph` | subtype construction | **semantic gap**: inherited fields are **not** in a subtype's domain `create` input (`Customer.create({name,…})` → validator rejects `name`); a subtype domain test can't populate inherited fields yet |
| `state-gate` | `when` canCommand gate | **`loom.when-unsupported` on elixir** — the fixture is already elixir-`COMPILE_SKIP`, so a domain test wouldn't reach 5-backend parity |
| `document`, `embedded*`, `event-sourcing`, `eventsourced-workflow` | non-relational shapes | no pure domain core (`hasPureDomainCore` false) — a `test` there has no `create`/op to bind |

### Emitter gaps worth their own slice (higher-value than one fixture)

1. **List-literal arm in the domain-test emitters** — unblocks `value-collections`
   and any VO/scalar-array create arg. Add a `list` case to `vtExpr`
   (elixir `tests-emit.ts`) + the TS/python `renderTestExpr` if they don't handle
   it, mirroring the object-literal arm.
2. **Inherited fields in a subtype's domain `create` input** — so an inheritance
   subtype domain test can construct a fully-populated instance. Touches the
   create-input projection for `extends` aggregates; verify against
   `inheritance.md`.
3. **Value-returning-op assertions** — a design pass on how a `T or Error` union
   result is asserted in a domain test uniformly across backends (the api tier
   already exercises the wire shape; the unit tier needs an idiom).

## Process notes (learned this session)

- **Re-sync before every fixture and after every merge.** `main` moves fast; a
  stale base both rebuilds merged work and reasons from behaviour that changed
  under you. A red required gate that lives in a file your PR doesn't touch is
  almost always a stale base *or* a genuinely red `main` — check
  `git checkout origin/main -- . && npx vitest run <that test>` before assuming
  it's yours. (This session, a red `main` from #2161's inferred-containment
  change — a stale-merge-base race — blocked every new PR until #2173 fixed it;
  another agent landed the same fix I'd bisected, so the duplicate was closed.)
- **Claim with a draft PR before building** — parallel agents collide; a
  same-shape fix landing from another agent is the norm, not the exception.
- **The heavy ×5 docker validation is real but amortizable** — the elixir leg
  needs the hex-mirror (`scripts/hex-mirror.py` + a CA the container trusts,
  CLAUDE.md "Egress proxy wrinkle"); python/java/dotnet need a Postgres sidecar.
  Run backends **sequentially** against a shared DB (concurrent runs trip a
  Flyway "non-empty schema, no history table" artifact).

## Beyond the drain

Once the corpus carries broad domain-test coverage, the next horizon is the
**test-authoring language** ([`test-authoring-language.md`](./test-authoring-language.md)):
scoped principals (`as <user>`), `background`/`setup` grouping with an
`isolation:` knob, and `unique`/`factory` data-gen — so authored suites cover
multi-actor and multi-fixture scenarios the current single-actor `test`/`test e2e`
idiom can't, still on the one-source-N-backends promise.

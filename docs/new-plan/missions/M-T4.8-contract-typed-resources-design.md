# M-T4.8 — `contract` typed resources (state audit + implementation plan)

> **Verdict (audit 2026-07-29, fresh `main` @ 2f5deb8): the RFC is half stale.**
> The **outbound** direction it proposes has *shipped* — under different names
> (`api … with scaffoldApi(of:)` + `context … with scaffoldHandlers`), with the
> operations and the records both source-visible and `unfold`-ejectable. The
> **inbound** direction is untouched: no code in `src/` reads a foreign spec, and
> the `kind: api` call surface is still the untyped `get(path)`/`post(path, body)`
> verb pair. **Rescope the RFC to inbound-only; do not introduce `contract` for
> the outbound direction** — that would rename shipped surface for no new
> capability.
>
> Sources: [`../../old/proposals/contract-typed-resources.md`](../../old/proposals/contract-typed-resources.md),
> [`resource-model-and-source-types`](../../old/proposals/resource-model-and-source-types.md),
> [`workflow-resource-consumption`](../../old/proposals/workflow-resource-consumption.md),
> [`unfoldable-api-derivation`](../../old/proposals/unfoldable-api-derivation.md),
> `docs/resources.md`, `src/ir/resource-verbs.ts`, `src/macros/stdlib/scaffold/scaffoldApi.macro.ts`.

## 1. Claim-by-claim audit

| RFC claim | State on `main` | Verdict |
|---|---|---|
| §1 outbound — "the published interface isn't a source-level thing"; you must run the generators to know what the API exposes | **`scaffoldApi`** (`src/macros/stdlib/scaffold/scaffoldApi.macro.ts`) splices literal `route <METHOD> "<path>" -> <Ctx>.<Handler>` lines into an `api`; **`scaffoldHandlers`** splices literal `response`/`command`/`query` `PayloadDecl` records (`src/macros/api/factories.ts`, `src/macros/stdlib/scaffold/_contracts-shared.ts`). Both `unfold` to real `.ddd`. All five backends read the explicit routes (`*/explicit-handlers-emit.ts` + `hono/v4/explicit-handlers-builder.ts`) and the *declared* response record instead of re-deriving from `wireShape` (M-T5.10 PR1–PR7: #1900, #1905, #1909–#1912) | **STALE — shipped** |
| §1 inbound — external APIs reachable but untyped | Unchanged. `src/ir/resource-verbs.ts` still gives `kind: api` exactly `get(path): json` / `post(path, body): json` (capability `request`); every `openapi` hit in `src/` is *outbound* (served `/openapi.json`, `java/emit/openapi-customizer.ts`, `elixir/vanilla/openapi-emit.ts`, auth bypass paths). No spec reader exists | **ACCURATE** |
| §2 direction carried by `from` | Only half the table is still live work (inbound). The outbound row now describes `api … from <Subdomain>` + the two scaffold macros | rescope |
| §3 body uses `record Foo { … }` | Loom has **no `record` keyword**. The wire-record vocabulary is `PayloadKind = payload \| command \| query \| response \| error` (`ddd.langium:1340`), with named unions (`payload Foo = A \| B`), `T option`, and the `paged`/`envelope` carriers | **needs rewrite** — reuse `PayloadDecl` |
| §3 `operation` inside a contract | `operation` is an *aggregate lifecycle member* (`ddd.langium:1789`) carrying `requires`/`when`/`audited`/`extern`. A contract operation is a different node in a different position — needs its own AST type **and** a `print-structural.ts` arm (`print-completeness.test.ts` fails otherwise) | accurate in spirit, mechanically distinct |
| §3 "a macro head by default, materialises on unfold" (inbound) | Collides with browser-safety — see §2 below. This is the RFC's one un-analyzed load-bearing decision | **needs a decision** |
| §4 `resource payApi { …, contract: Stripe }` | The `Resource` rule now carries 11 optional clauses (`schema`/`tablePrefix`/`keyPrefix`/`ttl`/`every`/`retain`/`isolationLevel`/`readonly`/`shape`/`index`/`config`), each validated per-kind against the resolved storage `type`. A `contract:` clause slots in identically | **ACCURATE**, bigger than written |
| §5 "typed client per backend … the existing `kind: api` adapter" | The seam exists and is the right home: `ResourceAdapter.emitClientModule` (`src/generator/_adapters/resource-surface.ts`), realized for `restApi` on all five backends (fetch / `HttpClient` / `Req` / `httpx` / `java.net.http`). Note its docstring says call-sites are deliberately out of scope — S4 changes that | **ACCURATE** |
| §6 reconciliation with `unfoldable-api-derivation.md` | That proposal's Layer 2 landed **records-only**, spelled with the payload keywords. "Widening `contract` to include operations" would now be a *rename of shipped surface*, not a greenfield definition | **needs rewrite** |
| §7 drift detection "may share machinery" with `wire-spec.json` | The mirror exists: `src/system/wire-spec.ts` + `src/system/wire-spec-diff.ts` → `.loom/wire-spec.json`. There is **no** `.loom/openapi.json` artifact (the spec is served at runtime, and `src/system/` has an `asyncapi.ts` sibling but no openapi one) | update the OQ with the real names |
| §8 `contract` is a free keyword | Still free: absent from `ddd.langium`, absent from `CommonSoftKeywords`, and no `.ddd` in the repo uses it as an identifier (only prose comments) | **ACCURATE** |
| Header — "design only, no grammar/IR/generator work scheduled" | `docs/new-plan/coverage.md:27` maps it to **M-T4.8** (`partial`, M, P3) as the follow-on | update |

**Code-comment drift spotted (not fixed here — docs-only branch):** the `Route:`
rule comment in `ddd.langium` still says *"These nodes ride alongside `ApiIR` and
are not yet read by any backend."* All five backends read them. Worth a one-line
scrub next time the grammar is touched.

## 2. The load-bearing decision the RFC never makes: where the spec is read

`contract Stripe from openapi("specs/stripe.openapi.json")` as a *live macro head*
puts a filesystem read **and** an OpenAPI parser on the macro-expansion path — and
that path is browser-shared:

- macros expand inside the Langium `DocumentBuilder` listener (`src/macros/expander.ts`),
  which `src/api/` (the transport-neutral toolkit behind the MCP server, the LSP
  adapters, and the web playground) runs on `EmptyFileSystem` and must keep browser-safe;
- `extern from "<path>"` — the closest existing precedent — **never reads the file**;
  it emits an import plus a typed conformance shim so `tsc` fails on mismatch;
- the *only* compile-time `fs` read in the language layer is `src/language/project-loader.ts`
  (transitive `.ddd` imports), and it is Node-only by construction.

Three options:

- **(A) `SpecLoader` seam** injected the way `web/` swaps `_packs/loader-fs.js` for a
  VFS loader. Pure, but every surface must supply one, and the playground inherits an
  OpenAPI parser.
- **(B) Materialize-once CLI** — `ddd contract sync` reads the spec in a Node-only
  command and writes the operations + records into the `.ddd` as literal source. The
  compiler never reads a foreign spec; `contract` is an ordinary declaration.
- **(C)** B now, A deferred behind it.

**Recommendation: (B).** It matches the house rule *"macros emit final AST, not
sentinels"*, mirrors the existing deliberate-capture precedent (`ddd snapshot`, run
like `ef migrations add`), keeps browser-safety free, dodges "which OpenAPI dialect
can the playground parse", and makes drift detection fall out for free (`sync --check`
re-reads and diffs). The RFC's "scaffolded by default, unfoldable to source" framing
becomes simply *"generated by a command, always source"* — strictly less machinery for
the same author experience. Record it as **D-CONTRACT-SPEC-SOURCE** in `docs/decisions.md`.

Consequence for the grammar: because nothing re-derives the HTTP binding at compile
time, each operation must carry its method + path in source (the `via` clause in S1).

## 3. Slices

Sequenced so every slice is independently landable and gated; S1–S3 are additive and
inert until S4 emits.

**S0 — decisions (this doc).** Record `D-CONTRACT-SPEC-SOURCE` (materialize-once) and
`D-CONTRACT-INBOUND-ONLY` (outbound stays `api` + `scaffoldApi`/`scaffoldHandlers`;
`contract` is not introduced for the published interface). Rewrite the RFC's §1/§3/§6/§7
per §1 of this doc. **S** · docs-only.

**S1 — grammar + printer, inert.** System-scope declaration:

```ddd
contract Stripe {
  command CreateCharge { amount: int, currency: string, customer: string? }
  response Charge      { id: string, status: string, amount: int }

  operation createCharge(body: CreateCharge): Charge via POST "/v1/charges"
  operation getCharge(id: string): Charge          via GET  "/v1/charges/{id}"
}
```

Records reuse `PayloadDecl` verbatim (that is what lets S4 reuse each backend's existing
DTO emitter). `ContractOperation` is a new AST type in a new position. Add the
`print-structural.ts` arm (`print-completeness.test.ts` gates it), one parsing test, one
negative validator test. `contract` becomes a hard keyword — free today, so no migration.
**M**.

**S2 — IR + binding.** `ContractIR`/`ContractOperationIR` in `src/ir/types/loom-ir.ts`;
a `lower-contract.ts` leaf wired into the `lower.ts` orchestrator; `Resource.contract`
clause → `DataSourceIR.contract`. Validators in `src/ir/validate/checks/store-checks.ts`:
`contract:` only on `kind: api`; bound sourceType must offer the `request` capability;
operation-name uniqueness; every `{param}` in a path has a matching operation parameter;
param/return types resolve to payload records or primitives. **M**.

**S3 — typed call surface.** `payApi.createCharge({ amount: … })` resolves against the
bound contract's operations *in addition to* `RESOURCE_VERBS` (`src/ir/lower/lower-expr.ts`
+ the resource-op validation). The untyped `get`/`post` verbs stay as the spec-less escape
hatch. Inherits the existing gates unchanged (workflow-bodies-only, not inside a
transactional span, async/awaited call site). New codes: `loom.contract-unknown-operation`,
`loom.contract-arg-mismatch`. **M**.

**S4 — emission, five backends.** The `restApi` `ResourceAdapter.emitClientModule` grows
one typed method per operation (fetch / `HttpClient` / `Req` / `httpx` / `java.net.http`),
with request/response types produced by each backend's *existing* payload-record emitter.
Compile-gated by adding a `contract-api.ddd` fixture to `test/fixtures/corpus/manifest.ts`
— `corpus-build.yml` + `corpus-elixir-build.yml` then fan it across all five. **L**.

**S5 — `ddd contract sync`.** Node-only (`src/cli/`):
`ddd contract sync <file.ddd> --spec <path|url> --into <Name> [--only op,op] [--check]`.
OpenAPI 3.0/3.1 → source: `operationId` → operation name; `requestBody` → a `command`
record; the 2xx response → a `response` record; `oneOf` → `payload A = B | C`;
non-required / nullable → `T?`; arrays → `T[]`; anything unmapped is skipped with a
warning (`--strict` turns it into an error). `--check` re-reads and exits non-zero on
drift — the inbound mirror of `wire-spec-diff`. **M**.

**S6 — docs + runtime gate.** `docs/resources.md` gains a typed-call section replacing
today's "proposed" pointer; `docs/language.md` + `docs/language-reference/` gain the
declaration; a `LOOM_CONTRACT_E2E` leg boots a stub HTTP server and proves a generated
typed client round-trips on each backend (mirroring the Mailpit `LOOM_EMAIL_E2E` pattern),
wired to a `run-contract` label per the CI-gating table. **M**.

Total ≈ **L**, P3 — consistent with M-T4.8's current sizing.

## 4. Open questions to settle before S1

- **Partial import.** With materialize-once this stops being a compiler question: `sync`
  writes what `--only` names (default: everything), and the file is the author's to prune.
  Confirm that's the shipping answer.
- **Auth / per-operation config.** Resource-level for v1 (it already carries `use:` +
  `config`). Operation-level scopes / idempotency keys deferred — no clause reserved.
- **Do inbound contract records enter `.loom/wire-spec.json`?** Proposed **no** — that
  artifact describes *our published* wire; a consumed spec is not it.
- **Other dialects.** AsyncAPI / gRPC / GraphQL are out of scope. The `via <METHOD> "<path>"`
  clause deliberately makes the surface HTTP-specific; another transport adds its own clause
  rather than overloading this one.
- **Naming of the bound handle.** `payApi.createCharge(…)` calls through the *resource*
  name, not the contract name (the RFC's §4 example, kept) — so two resources may bind the
  same contract to different base URLs (staging/prod). Confirm that is desirable before S2.

# `api` open-host-service → OpenAPI tag grouping

> Status: **DESIGN — audited + reviewed + paper-simulated on fresh `main`
> (`43822b8`), awaiting sign-off; not implemented.** Closes strategic item #2 of
> [`docs/audits/generated-code-ddd-review-2026-07.md`](../audits/generated-code-ddd-review-2026-07.md)
> (§ "The `api` contract layer dissolves at emission"). No grammar or validator
> change — pure derive-and-emit. One design decision (§ Open decisions (f)) is
> unresolved and gates a clean start. This proposal is the durable record of the
> language-feature-developer audit/review/simulation passes so the work can resume
> without redoing them.
>
> Companion to [`unfoldable-api-derivation.md`](./unfoldable-api-derivation.md)
> (the `api` block's explicit `route`/handler layer — whose Hono emitter already
> tags explicit-route handlers by api name, the one existing precedent) and
> [`bounded-context-model.md`](./bounded-context-model.md) (context boundaries
> above the database — audit strategic item #1, the sibling gap).

## Problem

A named `api X from <Subdomain>` declaration — Loom's **open-host-service**
contract, the thing a deployable `serves:` — produces **no trace** in the
generated OpenAPI. Every backend tags OpenAPI operations by **aggregate**
(`tags: ["orders"]`), never by the owning api, and there is no document-level
grouping. `SalesApi` / `FulfillmentApi` are unrecoverable from the artifact they
govern: a consumer reading the served `/openapi.json` cannot tell which bounded-
context contract an operation belongs to. The DSL declares the boundary; emission
dissolves it.

## Current state (verified on `main`)

- **NOT STARTED.** No emitter sets a per-api tag, `x-loom-api`, or `x-tagGroups`.
  Every op is tagged by aggregate slug `snake(plural(agg.name))` (`"orders"`,
  `"shipments"`) or a fixed bucket (`"workflows"`, `"views"`, `"projections"`,
  `"auth"`).
- **One precedent:** Hono's explicit-route layer already tags by api name —
  `src/platform/hono/v4/explicit-handlers-builder.ts` emits `tags: ["<apiName>"]`
  for explicit `route <M> "<path>" -> Ctx.Handler` bindings. The auto-derived
  CRUD/operation surface (this proposal's subject) does not.
- `unfoldable-api-derivation.md` explicitly cements today's design: *"One OpenAPI
  tag per aggregate."* This proposal adds a document-level api grouping **on top**
  of that, without changing the per-op aggregate tag.

## Derivation — no new IR, derive at emit

`ApiIR` (`src/ir/types/loom-ir.ts`) already carries `name` + `sourceModule`
(a **subdomain** name, from `api X from source=[Subdomain:ID]`). The chain is
fully available: `operation → aggregate → context → subdomain(name) → served api
where ApiIR.sourceModule === subdomainName`. A deployable's `serves: string[]`
names which apis it exposes.

The api-membership fact is a **pure function of `sys.apis` + the subdomain** and
the document-config emit sites already hold `sys` — so it is **derived at emit
via a shared helper**, NOT stamped in enrichment (design review reframe (i);
"derive don't stamp", CLAUDE.md § Conventions). This differs from
`errorStatusesBySubdomain` (which *is* stamped onto contexts in `enrichments.ts`)
only because that fact's consumer is a per-context route translator that cannot
cheaply reach `sys.apis`; here the consumer is document-level and already has it.

Shared helper — `src/ir/util/openapi-ids.ts` (already the single source of truth
for OpenAPI identity tokens; type-only IR import, no runtime layer edge):

```ts
/** slug a backend stamps as an aggregate's per-op tag. */
const aggTag = (aggName: string) => snake(plural(aggName)); // "Order" → "orders"

/** First-declared served api whose subdomain === `subdomain`, else undefined. */
export function apiForSubdomain(
  sys: SystemIR, subdomain: string, servedApiNames?: readonly string[],
): string | undefined;

/** Redoc nav groups: one per served api, tags = aggregate slugs in its
 *  subdomain. First-declared-api-wins when two served apis share a subdomain. */
export function apiTagGroups(
  sys: SystemIR, servedApiNames?: readonly string[],
): { name: string; tags: string[] }[];

/** Flat doc-level tag list (name + description) for every grouped slug. */
export function apiTags(
  sys: SystemIR, servedApiNames?: readonly string[],
): { name: string; description: string }[];
```

**Ambiguity:** two served apis can share one subdomain. Convention is
**first-declared-wins** — consistent with `urlStyleBySubdomain` /
`errorStatusesBySubdomain` and `checkApiUrlStyle` (which already warns on the
conflicting-`urlStyle` variant of this shape). No new validator needed for
slice 1.

## Design — additive, document-level

For the sample system (`api SalesApi from Sales`, `api FulfillmentApi from
Fulfillment`, `serves: SalesApi, FulfillmentApi`), every served `/openapi.json`
carries the byte-equal:

```json
"tags": [
  { "name": "orders",    "description": "Order aggregate operations" },
  { "name": "shipments", "description": "Shipment aggregate operations" }
],
"x-tagGroups": [
  { "name": "SalesApi",       "tags": ["orders"] },
  { "name": "FulfillmentApi", "tags": ["shipments"] }
]
```

Redoc renders each `api` as a nav group; **Swagger UI ignores `x-tagGroups`
gracefully** (the aggregate tags still render), so it degrades cleanly. The
per-op aggregate `tags:` array is **untouched** on the backends that already emit
it — this is the load-bearing decision that keeps the conformance-parity op-tag
diff and every aggregate-tag test green.

### Per-backend emit sites (all additive; grounded in real output)

| Backend | Doc-config site | Shape added |
|---|---|---|
| **Hono/node** | `src/generator/typescript/emit/routes.ts` (`app.doc("/openapi.json", {…})`) | two keys on the object literal (`tags`, `x-tagGroups`) |
| **.NET** | `src/generator/dotnet/emit/program.ts` (`SwaggerDoc`) | a new `IDocumentFilter` (`ApiTagGroupsFilter`) mirroring `ListResponseWrapperFilter`, writing `swaggerDoc.Tags` + `swaggerDoc.Extensions["x-tagGroups"]` |
| **Phoenix** | `src/generator/elixir/vanilla/openapi-emit.ts` (`renderApiSpec`, `<apiSnake>_spec.ex`) | `tags:` list + `extensions: %{"x-tagGroups" => …}` on the `%OpenApi{}` struct |
| **Python** | `src/generator/python/index.ts` (`custom_openapi()` override) | `schema["tags"]` + `schema["x-tagGroups"]` assignments |
| **Java** | `src/generator/java/emit/openapi-customizer.ts` (`OpenApiContractCustomizer`) | `openApi.setTags(...)` + `openApi.addExtension("x-tagGroups", …)` in the existing customizer lambda |

### Parity test

`test/system/api-taggroup-parity.test.ts`, modeled on
`test/system/concurrency-openapi-409-parity.test.ts`: one `.ddd`, generate all 5,
assert each backend's served-OpenAPI **source** encodes the identical api→tags
mapping in that backend's idiom. A stronger runtime byte-equality diff of the
served `/openapi.json` belongs in `conformance-full` (nightly), matching how the
409 runtime arm sits apart from the 409 declaration gate.

## Open decisions

| # | Question | Leaning |
|---|---|---|
| a | doc-level `tags:[{name,description}]` too, or `x-tagGroups` only? | both (helps Swagger UI; a few lines) |
| b | per-op `x-loom-api` vendor tag in slice 1? | defer to follow-up (keeps slice 1 purely document-level; grouping already works via `x-tagGroups`) |
| c | tag/group descriptions | derive `"<Aggregate> aggregate operations"` (no `ApiIR.description` field exists) |
| d | aggregate whose subdomain no served api covers | omit from groups (ops still reachable, just ungrouped) vs. a fallback `"Ungrouped"` catch-all |
| e | one PR for all 5, or Hono-first? | Hono + shared helper + parity test as PR 1 (test asserts Hono), then stack .NET/Phoenix/Python/Java, flipping each `it(...)` on as it lands |
| **f** | **.NET & Java emit no explicit per-op tag** — Swashbuckle/springdoc default the per-op tag to the *controller* name (`"Orders"`, not `"orders"`), so `x-tagGroups`'s `"orders"` reference will not actually group those ops in Redoc unless an explicit lowercase per-op tag is also emitted there. The "keep per-op tags untouched" rule only holds for the 3 backends that already emit `"orders"`. | **Add explicit `tags:["orders"]` on .NET/Java too** — they have no explicit tag today, so this is not a regression; it *aligns* them with the other 3 (a cross-backend tag-parity improvement) and makes grouping function uniformly. This slightly widens the .NET/Java slice and is the one decision that needs an explicit call. (Runtime default-tag value is extrapolated from Swashbuckle/springdoc defaults, not generate-verified.) |

## Scope boundary — frontend-client grouping is a separate follow-up

Grouping the generated frontend API client per-api (`src/generator/_frontend/api-module.ts`
is one flat module per aggregate at `src/api/<agg>.ts`; grouping would rehome
under `src/api/<apiSlug>/` + a per-api barrel across the 4 frontend placement
sites) is a **different blast radius** — it ripples client import paths into every
page and is gated by the `generated-{react,vue,svelte,angular}-build` workflows,
not `conformance-parity`. It carries no coupling benefit with the OpenAPI slice.
Ship the OpenAPI grouping first; stack the frontend grouping (and the deferred
per-op `x-loom-api` from decision (b)) as a follow-up.

## Implementation plan (when signed off)

1. `src/ir/util/openapi-ids.ts` — the three helpers above (+ unit test).
2. Hono doc site + `test/system/api-taggroup-parity.test.ts` (Hono arm) — PR 1.
3. Fan out .NET / Phoenix / Python / Java, one at a time, flipping each parity
   `it(...)` on as it lands (resolve decision (f) first — it sets whether the
   .NET/Java slice also touches per-op tags).
4. Follow-up PR: per-op `x-loom-api` + frontend-client per-api grouping.

Gates: `conformance-parity.yml` (the served OpenAPI changes), plus the existing
`test/generator/java/generator-java-openapi-customizer.test.ts` and
`test/generator/elixir/vanilla-openapi-spec.test.ts` will need the additive
assertions. `.loom/wire-spec.json` is built from `wireShape`, not OpenAPI tags —
unaffected.

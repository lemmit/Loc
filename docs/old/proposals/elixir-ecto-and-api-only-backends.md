# Elixir/Phoenix **Ecto** (non-Ash) backend, and **API-only** Phoenix variants

> Status: **proposal / research** (historical). This note
> sizes three related additions to the backend matrix — a non-Ash
> Elixir/Phoenix/**Ecto** generator, plus **API-only** flavours of both the
> Ash backend and the new Ecto one (a JSON surface consumed by the
> React frontend) — grounds them in the current `PlatformSurface` /
> adapter / conformance machinery, names the design decisions, and phases
> the work.
>
> **(Superseded 2026: the Ash foundation was removed — `platform: elixir`
> now generates Phoenix LiveView on PLAIN Ecto/Phoenix only. The "vanilla"
> (Ecto) foundation in this note is the only foundation that ships;
> `foundation: ash` is now a validation error. There is no longer an
> Ash-vs-Ecto axis to model — the Ecto domain layer this note proposes is
> what `platform: elixir` emits today. The `foundation:` grammar knob
> remains but resolves to `vanilla` only. The "Ash today" columns and the
> Ash-vs-Ecto modelling options below are retained as a design record.)**

## TL;DR

Three deliverables, very different costs:

| # | Deliverable | Net-new code | Calendar (codebase + Elixir fluent) |
|---|---|---|---|
| 1 | **Phoenix/Ecto full-stack** (LiveView UI + JSON API, no Ash) | ~4,000–5,500 LOC | ~4–6 weeks |
| 2 | **Ash API-only** (no HEEx; React consumes the JSON) | ~300–600 LOC | ~3–6 days |
| 3 | **Ecto API-only** (React consumes the JSON) | flag on #1: ~3–6 days · standalone: ~2,800–3,800 LOC / 3–4 weeks |

The dominant cost is **the Ecto domain/persistence layer** (shared by #1
and #3): `Ash.Resource` + declarative actions/validations/relationships
are replaced by hand-built `Ecto.Schema` + `Ecto.Changeset` + context
modules + `Repo` query functions. Everything else is reuse:

- **The HEEx walker** (`heex-walker.ts` 2,026 + `heex-target.ts` 229 =
  2,255 LOC) is Ash/Ecto-agnostic — it lowers the `ui` DSL, not domain
  logic. Reused verbatim by #1; **not emitted at all** by the API-only
  variants (which is exactly why they are cheap).
- **`MigrationsIR` → Ecto migrations** (`migrations-emit.ts`, 320 LOC)
  already emits Ecto DSL (`.exs`) from the platform-neutral migrations IR.
  A non-Ash backend inherits this **for free**.
- **The JSON REST + OpenAPI surface already exists** on the Ash backend
  (`api-emit.ts` 575, `openapi-emit.ts` 926) and **React already consumes
  any backend** by inheriting `targets:` modules and computing
  `apiBaseUrl` from the target's port. So "API-only" is mostly *not
  emitting* the UI layer, not building new consumption machinery.

The recurring tax on **every** new backend is **strict cross-backend
OpenAPI/wire-spec parity** (a per-PR CI gate, `LOOM_E2E_STRICT_PARITY=1`,
9 dimensions). Budget real time there regardless of LOC.

**Investigation outcome (§2.1):** the Phoenix generator **already** emits a
clean API-only project when a deployable mounts no `ui`
(`liveview-emit.ts:61`) — so #2 needs no new emission path. The only
consumption-side gap is React's `apiBaseUrl`, which appends `/api` solely
for `dotnet`+`ui`; a Phoenix target needs the same `/api` branch
(`react/index.ts:48–52`) plus a CORS plug for the cross-origin call. This
**resolves D-API-ONLY** (API-only = absence of a `ui` mount; no new
platform name).

## 1. Where each piece lives today (the baseline)

The four registered platforms implement `PlatformSurface`
(`src/platform/surface.ts`) and are wired in `src/platform/registry.ts`:

| Platform | `needsDb` | `mountsUi` | `isFrontend` | Role |
|---|---|---|---|---|
| `hono` (`@v4`) | true | false | false | backend only (JSON API) |
| `dotnet` (`@v8`) | true | true | false | backend; may embed a SPA |
| `react` | false | true | **true** | frontend only (consumes a backend) |
| `phoenixLiveView` (`@v1`) | true | **true** | false | **backend *and* server-rendered UI** |

Generator sizes (full directory, `wc -l`):

| Generator | LOC | Shape |
|---|---|---|
| `src/generator/typescript` (Hono) | 4,438 | backend only |
| `src/generator/dotnet` | 8,073 | backend only |
| `src/generator/react` | 9,006 | frontend only |
| `src/generator/phoenix-live-view` | **10,864** | backend **+** frontend |

Phoenix is the largest not from bloat but because it is the only
generator that is **simultaneously a backend and a UI framework**, and it
must hand-emit things the TS/.NET ecosystems get from libraries/runtime
tooling. Top contributors:

| File | LOC | Role | Reuse for a non-Ash variant |
|---|---|---|---|
| `heex-walker.ts` | 2,026 | `ui` DSL → HEEx + `handle_event/3` | **reuse** (UI, not domain) |
| `index.ts` | 1,796 | orchestrator; emits the whole Mix project skeleton | clone + rewire |
| `openapi-emit.ts` | 926 | hand-built OpenAPI 3.1 (Elixir has no Zod/Swashbuckle path Loom leans on) | reuse / light fork |
| `domain-emit.ts` | 731 | `Ash.Resource` (attrs/rels/calcs/validations/actions/policies) | **full rewrite (Ecto)** |
| `page-objects-emit.ts` | 669 | Playwright page objects for the server UI | reuse (UI) / drop for API-only |
| `liveview-emit.ts` | 659 | LiveView page modules; wires events → Ash actions | rewrite (call Ecto contexts) |
| `api-emit.ts` | 575 | JSON controllers under `/api` | controller bodies rewrite |
| `render-expr.ts` | 522 | `ExprIR` → Elixir (Ash query `exists(...)`, `Decimal`) | ~60–70% reuse; query-filter fork |
| `workflow-emit.ts` | 398 | workflow modules | mostly reuse |
| `migrations-emit.ts` | 320 | `MigrationsIR` → **Ecto** `.exs` | **reuse verbatim** |
| `view-emit.ts` / `repository-emit.ts` | 245 / 196 | view queries / find actions | rewrite to `Ecto.Query` |
| `heex-target.ts` | 229 | the HEEx `WalkerTarget` seam | reuse |
| adapters `ash-postgres` / `ash-style` / `by-feature` | 194 / 84 / 219 | persistence / style / layout | persistence+style rewrite; layout reuse |
| `render-stmt.ts` | 109 | `StmtIR` → changeset ops | rewrite to `Ecto.Changeset` |
| `domain-module.ts` / `join-resource-emit.ts` / `jason-camel-emit.ts` | 136 / 88 / 85 | `Ash.Domain` / m2m join / camelCase JSON encoder | replace / rewrite / reuse |

## 2. Why API-only is nearly already there

Two facts collapse the API-only cost:

1. **The Ash backend already serves JSON.** `api-emit.ts` emits
   `*_controller.ex` per aggregate (CRUD + operations + finds) under an
   `/api` scope, returning `conn |> json(...)`; `openapi-emit.ts` emits
   the matching OpenAPI 3.1 spec + schema modules. The fullstack Phoenix
   JSON API is **already in the cross-backend parity matrix**.
2. **React consumes any backend generically.** A `react` deployable
   declares `targets: <backend>`; `enrichments.ts` makes the frontend
   deployable **inherit the target's `contextNames`** (so React sees every
   aggregate + `wireShape` without re-declaration), and
   `generateReactForContexts` computes `apiBaseUrl` from the target
   deployable's `port` (fullstack .NET overrides to `/api` for same-origin
   fetches). The generated client is plain Zod + React Query hooks
   (`api-builder.ts`) hitting `GET/POST/PATCH/DELETE /<tag>`.

So an **API-only Phoenix** is the existing JSON surface **minus** the UI
layer (HEEx walker, `liveview-emit`, sidebar, theme, the design pack,
UI page-objects), with a `react` deployable pointed at it.

### 2.1 Investigation — what's already there vs. the real gap

The decisive open question ("does the generator degrade gracefully with no
`ui` bound, or is LiveView emission unconditional?") was **investigated
against the source. The backend already degrades gracefully** — API-only
is a *capability by absence of a `ui` mount*, not a missing emission path:

- `liveview-emit.ts:61` — `if (!deployable.uiName) return { files: out,
  routes };`. A backend with no `ui:` binding emits **no** HEEx page
  modules, **no** UI page-objects (they're emitted inside the
  `for (page of ui.pages)` loop), and **no** `live` routes.
- `index.ts:174` — the sidebar component is gated on `deployable.uiName`.
- The router renderer (`index.ts`, `renderRouter`) has an explicit
  empty-routes branch (`# No pages declared in this deployable's ui:
  block.`), and the `scope "/api"` block degrades the same way.
- Everything else still emits unconditionally: domain resources, the JSON
  controllers + `/api` routes (`api-emit.ts`), the OpenAPI spec
  (`openapi-emit.ts`), the always-on health controller, migrations, and
  auth.

So **#2 (Ash API-only) needs no new `apiOnly` emission path** — declare a
`phoenixLiveView` deployable that mounts no `ui`, point a `react`
deployable at it. The remaining deltas are small and specific:

1. **Consumption base-path (the one real code gap).** Phoenix serves JSON
   at `/api/<tag>` (route `path: \`/${tag}\`` at `api-emit.ts:43`, wrapped
   in `scope "/api"`). But React's `apiBaseUrl` (`react/index.ts:48–52`)
   only appends `/api` for a `dotnet` target that also mounts a `ui`
   (same-origin embedded SPA); any other target gets
   `http://localhost:<port>` and the generated client hits `<base>/<tag>`
   (`api-builder.ts`). A Phoenix target therefore resolves to
   `http://localhost:4000/<tag>` and **misses** the `/api` scope. Fix: a
   `react/index.ts` branch yielding `http://localhost:<port>/api` for a
   Phoenix (and Hono-vs-Phoenix-symmetric) target. ~5–10 LOC; the
   `dotnet`/`"/api"` special-case is the proof the seam exists.
2. **CORS for the cross-origin call.** Unlike the `dotnet` embedded-SPA
   case (same origin, so no CORS), a standalone `react` deployable calling
   Phoenix is cross-origin — Phoenix needs a CORS plug in its endpoint
   pipeline. This is the *same* consideration as today's standalone
   Hono+React topology; whatever that path does (CORS plug vs. dev proxy),
   Phoenix should mirror it. (Confirm the Hono+React standalone story and
   match it.)
3. **Two harmless leftovers** (optional cleanup). `theme.css`
   (`index.ts:188`) and the root/app HEEx layouts (`index.ts:522–525`) are
   emitted unconditionally and are dead weight in an API-only build.
   Gating them on `deployable.uiName` is a trivial tidy, not a blocker.

This **resolves D-API-ONLY** (see §4): model API-only by absence of a `ui`
mount; do **not** mint `phoenixLiveViewApi`-style platform names. The same
resolution applies to #3 (Ecto API-only) once #1 exists.

## 3. The Ecto domain layer (the real work)

Mapping the platform-neutral, fully-resolved IR onto idiomatic Ecto
(no Ash). This is **larger** per aggregate than the Ash emit, because
Ash's declarative machinery hides volume that Ecto makes explicit:

| IR concern | Ash today | Ecto (proposed) |
|---|---|---|
| Aggregate/part/VO shape (`wireShape`) | `Ash.Resource` `attributes do … end` | `Ecto.Schema` `schema "table" do … end` (+ `embedded_schema` for value objects / containments — see open Q) |
| Repository finds + auto-`findAll` | Ash read actions / code interface | context module functions over `Ecto.Query` against `Repo` |
| Operations / domain logic (`StmtIR`) | `Ash.Changeset` (`change_attribute`, `manage_relationship`) | `Ecto.Changeset` + `Ecto.Multi` for multi-step / relationship ops |
| `X id[]` associations (join tables) | Ash relationship | `many_to_many` with explicit join schema |
| Find filters (`ExprIR`) | `Ash.Query` `exists(rel, …)` | `Ecto.Query` `where`/`join`/`subquery` |
| Domain composition | `Ash.Domain` per context | context module per context |
| Migrations | `MigrationsIR` → Ecto `.exs` | **identical — already Ecto** |
| Wire serialisation (camelCase) | `jason-camel-emit` | **reuse** |

Concretely, #1 needs: Ecto schema+context+changeset emit (~900–1,200),
repository/query functions (~250–350), `liveview-emit` rewrite to call
contexts (~400–500), JSON controllers over contexts (~400–500), a
`render-expr`/`render-stmt` fork for `Ecto.Query` filters + `Ecto.Changeset`
(~370–580), Ecto persistence/style adapters + platform + grammar +
validator + registry (~450–650), and an orchestrator clone+rewire
(~1,200–1,600). Reused: HEEx walker (2,255), migrations (320), the design
pack (the `ashPhoenix` HEEx pack, 1,262 — rename/share as a
Phoenix-LiveView pack independent of persistence), OpenAPI (light fork),
telemetry/theme/page-objects.

## 4. Modelling decision — how does "Ash vs Ecto" enter the system?

The conceptual axis distinguishing the two backends is **persistence +
domain style** (Ash vs Ecto), *not* the UI: both render the same Phoenix
LiveView HEEx. That maps suggestively onto the existing adapter seam
(`adapters().persistence` / `.style`, today `{ ashPostgres }` / `{ ash }`),
which per [D-ADAPTER-HOME](../../decisions.md#d-adapter-home--persistencestylelayout-adapters-live-on-the-backend-surface)
lives on the backend surface. But today `domain-emit` / `repository-emit`
/ `render-expr` are hard-wired to Ash, **not** dispatched through the
adapter — so the "just add an adapter" framing is aspirational until that
seam is widened. Three options:

- **Option A — adapter swap on `phoenixLiveView`.** Add
  `persistence: { ectoPostgres }`, `style: { ecto }` and route
  domain/query/changeset emission through the style adapter. *Cleanest
  conceptually* and matches D-ADAPTER-HOME, but requires extracting the
  Ash-specific emit behind a real adapter contract first (a non-trivial
  refactor of the largest backend). Best **eventual** factoring.
- **Option B — a sibling platform name** (e.g. `phoenix` for the Ecto
  flavour vs `phoenixLiveView` for Ash). *Smallest blast radius*: a new
  `PlatformSurface` + registry entry + a `Platform` token in the grammar +
  a `checkDeployable` arm. Both backends coexist; no refactor of the Ash
  path. Downside: duplicates orchestrator scaffolding until later
  consolidated. **Recommended for v0.**
- **Option C — `family@version`.** Rejected: Ash and Ecto are not
  *versions* of one family (they coexist, neither supersedes the other),
  and the registry keys `BUILTIN_PLATFORM_LATEST` by family.

**API-only** is an orthogonal axis, and the §2.1 investigation settles it:
model it as the existing backend emitting only its API surface when **no
`ui` is bound** to the deployable (with a consuming `react` deployable) —
which is **already the implemented behaviour** (`liveview-emit.ts:61`). Do
**not** mint `phoenixLiveViewApi`-style platform names (which would fork
the matrix combinatorially: {Ash, Ecto} × {fullstack, API-only}); the
only code needed is the React `apiBaseUrl` `/api` branch + CORS from §2.1.

> Requests a pinned decision **D-PHOENIX-ECTO** (Option A vs B for the
> Ash/Ecto axis) recorded in [`../decisions.md`](../../decisions.md).
> **D-API-ONLY is resolved by §2.1**: API-only = absence of a `ui` mount,
> no new platform name, no `apiOnly` emission flag.
>
> **Update — superseded by D-PHOENIX-SURFACE (PINNED).** Option B above (carry
> the Ash/Ecto axis in the *platform name*: `phoenixLiveView`=Ash, `phoenix`=Ecto)
> **collides** with `embedded-frontend-composition.md`, which frees a *second*
> axis (LiveView vs embedded React) off that same `phoenixLiveView` name and
> retires it. D-PHOENIX-SURFACE reconciles them: **one `phoenix` platform**, the
> domain axis carried by the **D-ADAPTER-HOME `style:`/`persistence:` adapter
> surface** (Option A's surface — *not* a platform name, *not* a new `domain:`
> keyword), the framework axis by `ui { framework: }`. The pin's key reframe: the
> Ash/Ecto axis is **universal, not Phoenix-special** — every backend freezes a
> domain framework (hono→Drizzle, dotnet→EF); Phoenix is merely the first with a
> menu of size > 1, so the first where the modifier is ever written. This means
> **Option A is the axis, not a later factoring** — D-PHOENIX-SURFACE pins the
> domain axis onto the adapter surface now; only the Ash-emit extraction behind
> the adapter contract remains the implementation tail Phase 2 carries. Option B's
> other conclusions survive (no `family@version`, no `apiOnly` platform); default
> domain on bare `platform: phoenix` is **`ash`**. The exact adapter field
> (`style:` vs `persistence:`) stays this note's Phase-2 call.

## 5. Conformance — the non-negotiable gate

Every backend must hit **byte-level wire parity** with the others. The
contract is `<out>/.loom/wire-spec.json` (built from `wireShape` in
`src/system/wire-spec.ts`); fast unit conformance tests assert every
aggregate/VO/part appears as the canonical `<Name>Response` etc., and the
e2e parity harness diffs every backend pair across **9 dimensions** (ops
set, response cardinality, schema set, per-schema fields, required flags,
path-param types, request/response body refs, operationIds) under strict
mode in `conformance-parity.yml`. See [`../conformance.md`](../../conformance.md).

Implications:
- **API-only Ash (#2)** inherits parity essentially for free — its JSON is
  the same surface already in the matrix.
- **Ecto (#1/#3)** must reproduce the exact wire shape, camelCase keys
  (reuse `jason-camel-emit`), RFC 7807 error bodies, list-response
  wrappers, and provenance/validation envelopes the others emit. This is
  the bulk of the "last 20%".

## 6. Recommendation & phasing

Ordering matters because the API-only variants are cheap *strips* of a
full backend:

1. ~~**Phase 0** — confirm graceful API-only degradation.~~ **Done (§2.1):**
   the generator already emits a clean API-only project when no `ui` is
   bound (`liveview-emit.ts:61`). D-API-ONLY resolved.
2. **Phase 1 — Ash API-only (#2), ~3–6 days.** Now a short, itemised list
   (per §2.1): (a) the React `apiBaseUrl` `/api` branch for a Phoenix
   target (~5–10 LOC); (b) a CORS plug for the cross-origin React→Phoenix
   call, mirroring the standalone Hono+React story; (c) optional gating of
   the dead `theme.css`/HEEx-layout emits on `deployable.uiName`; (d) a
   `react`-targets-`phoenixLiveView` example + a conformance/CI entry.
   Lowest-risk, immediately useful, and exercises the
   React-consumes-Phoenix path end-to-end before the heavier work.
3. **Phase 2 — Ecto full-stack (#1), ~4–6 weeks.** Decide D-PHOENIX-ECTO
   (recommend Option B sibling platform for v0). Build the Ecto domain
   layer (§3), reuse the HEEx walker + `MigrationsIR` + design pack, add a
   `phoenix-ecto-build.yml` (`mix compile --warnings-as-errors` against a
   real Ecto dep set, mirroring `phoenix-build.yml`) + obs-e2e + parity
   entries. Drive to strict conformance green.
4. **Phase 3 — Ecto API-only (#3), ~3–6 days.** The same UI-absent path
   from Phase 1 applied to the Ecto backend.
5. **Phase 4 (optional, later):** if/when the duplication between the Ash
   and Ecto orchestrators bites, migrate to Option A (adapter swap) under
   the byte-identical-output discipline used for the `WalkerTarget`
   extractions — the persistence/style adapter seam already exists to
   land into.

Each language/grammar touch (a new `Platform` token, a `checkDeployable`
arm, an `apiOnly` modifier) follows the standard "adding a language
feature / adding a backend" recipes in [`technical.md`](../../technical.md):
grammar → scope/validate → IR/flag → lower/consume → one parsing test +
one negative validator test + one generator test per affected backend,
verified with `npm test` and a `LOOM_PHOENIX_BUILD=1` run.

## Related proposals

- [`platform-directory-layout.md`](./platform-directory-layout.md) — the
  framework-version axis and [D-ADAPTER-HOME](../../decisions.md#d-adapter-home--persistencestylelayout-adapters-live-on-the-backend-surface)
  (adapters live on the backend surface) — the seam Option A lands into.
- [`production-readiness.md`](./production-readiness.md) — the
  scaffold→system roadmap; a second Elixir persistence story and an
  API-only deployment shape both sit on it.
- [`storage-and-platform-config.md`](./storage-and-platform-config.md) —
  per-deployable `persistence:` / `style:` / `layout:` and the adapter
  contracts the Ash/Ecto axis would be expressed through under Option A.
- [`terraform-iac-target.md`](./terraform-iac-target.md), [`kubernetes-helm.md`](./kubernetes-helm.md)
  — sibling "reads `SystemIR`, emits artifacts" work; an API-only backend
  + React frontend is a common deployment topology for both.

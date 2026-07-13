# Generated-code review — June 2026 (all platforms)

> **(Superseded 2026: the Ash foundation was removed — `platform: elixir` is plain Ecto/Phoenix only, `foundation: ash` is now a validation error. Phoenix findings below that reference Ash `expr`/resource semantics are historical.)**

> Snapshot-in-time audit. A full review of generated output across all 5
> backends + 3 frontends (driven from `examples/showcase.ddd`,
> `vue-showcase.ddd`, `svelte-shop.ddd`). Each finding is dispositioned below so
> nothing is silently dropped. **Verify-first** was applied throughout — a large
> fraction of flagged items turned out to be intentional/working, and "fixing"
> them blindly would have regressed tested/reference code.

## Fixed (TDD: red generator test → fix → green, in default `npm test`)

| Area | Defect | Commit |
|---|---|---|
| Phoenix | `ViewsController` matched `{:ok, records}` against a `run/1` that returns a bare list (both foundations) → `CaseClauseError` on every view request; also a masked full-form `Map.from_struct` crash | `eae19c6` |
| React (×3) | menu external links rendered the `__external:` sentinel into a `<NavLink>`; boolean cells rendered blank; `applyServerErrors` read an axios `.response` shape the client never throws (every 422 dropped) | `ff58fa2` |
| Vue | named-layout SFC lacked the Vuetify `<v-app>` root | `a9ee4bc` |
| .NET | generated aggregate tests didn't compile (currentUser actor + void→var); `Tests/` csproj wasn't compiled by the build gate | `53ea8d1` |
| Hono | Drizzle schema id columns were `text` while the migration declared them via `idColumnType` (guid→uuid, int→integer, …) | `5abc6e2` |
| Java + Python | `workflow … transactional(serializable)` dropped the isolation level (.NET honored it) | `703e0cb` |
| Svelte | list/table `{#each x.data}` iterated `T[] \| undefined` → likely `svelte-check --fail-on-warnings` CI break | `825ee3e` |
| .NET | `ValidationBehavior` shared one `ValidationContext` across validators run concurrently (`Task.WhenAll`) — latent FluentValidation data race; each validator now gets its own | `600008d` |
| Hono + Python | containment-part FK drifted from the shared SQL migration: ORM index named `<table>_parent_id_idx` (vs the migration's real-column name) + Hono missing `.references()` | `600008d` |
| Walker (all frontends + HEEx) | `Image { "/logo.png" }` positional arg dropped → bare `<Image />`; now feeds `src` | `e94f4b5` |

Plus: tightened the over-claiming showcase status-contract comment, pinned the
two-tier error→status mapping, and the [runtime-conformance-harness](../old/plans/runtime-conformance-harness.md)
plan (Tier-0 fast source assertions, Tier-1 runtime conformance).

## Verified NOT a bug — intentional / consistent / working (left untouched)

- **Invariant/`check` → 400 (not 422)** at the domain floor — the shipped
  two-tier model (`validation-error-extension.md`): field validation → 422 with
  `errors[]`, aggregate `DomainError` → 400. The showcase's `toThrow(422)` cases
  are all field-mirrorable.
- **Vue realtime "missing"** — vue-showcase targets a **dotnet** backend, which
  doesn't serve the realtime wire; skipping the EventSource client is correct
  (svelte-shop targets hono, hence it emits one).
- **Phoenix `record.` in Ash `expr`** — the CI-compiled flagship `acme-lv`
  emits `expr(record.label)`; Ash 3.x resolves it. Established pattern.
- **Python `decimal` → `float`** — deliberate (`dispatch-builder.ts`): `decimal`
  → `float`, `money` → `Decimal` + `Numeric(19,4)`.
- **Java regex `.find()`** — matches the reference TS backend's JS `.test()`
  (substring) semantics; `.matches()` would diverge for unanchored patterns.
- **Hono `z.coerce.boolean()` on the body** — documented, consistent coercion
  strategy across the whole request-primitive table (int/long/decimal/datetime
  /bool); `.default(false)` is for cross-backend required-set parity.
- **Synthesized `inspect()` placeholder (`[string?]`, `[Pipeline[]]`)** —
  documented scope limit in `synthesizeInspect`: optionals/arrays/entity-refs
  render a type-shorthand placeholder (keeps the expression bounded + nil-safe).
  Scalars render real values.

## Real but runtime-cosmetic (no behavioral impact)

_(The Hono/Python part-FK index drift that was here is now FIXED — see `600008d`
above. It was runtime-cosmetic but aligned for cleanliness / no-debt.)_

## Remaining — genuine but unverified here (need a toolchain / are feature-sized)

These were flagged by the review; each needs runtime/toolchain verification this
environment lacks (no Elixir/Ash, no dotnet SDK, docker daemon down), or is a
walker-feature rather than a quick emitter fix. Recorded so they aren't lost:

- **React** `ProjectDetail` `state` block — **RESOLVED**: the inputs used the
  wrong keyword (`value:` not `bind:`; the `bind:` → controlled-input +
  `useState` path works and is tested). Fixed the showcase to `bind:` and added
  a `loom.bindable-input-value-arg` validator warning so the silent no-op can't
  recur (`94de0e9`); the state-controlled `Modal { open: <state> }` is built
  (`84231f7`, React Mantine+shadcn; spec in
  `docs/old/proposals/state-controlled-modal.md`). showcase's ProjectDetail now
  generates a fully controlled, stateful detail page. The controlled-modal
  template now covers ALL EIGHT frontend packs — React (Mantine/shadcn/MUI/
  Chakra, `ec21114`), Vue+Svelte (vuetify/shadcnVue/shadcnSvelte/flowbite,
  `2dc5f0d`), AND Phoenix LiveView (assign-driven `<%= if @open do %>`, a branch
  in heex-primitives `renderModal`). So `Modal { open: <state> }` is now on
  EVERY frontend. Remaining: page-level `requires currentUser.role` client-side
  gating (frontend-acl feature; backend already 403s), and `Avatar { "P" }`'s
  positional arg (ambiguous fallback-initials vs src + undocumented — left for
  the language owner). (`Image`'s positional `src` is FIXED — `e94f4b5`.)
- **Phoenix** (needs Ash compile to confirm): workflow `add_pipeline_project`
  called map-style vs positional; `requires` guard dereferences a possibly-nil
  actor; `manage_relationship` passes a struct where a map is idiomatic;
  side-effects in a `change` body vs `after_action`; `created_at` +
  `timestamps()` type overlap.
- **.NET** `RegisterProject` 403s with the shipped dev stub — **SUPERSEDED, not
  fixing here.** It's not .NET-specific: every backend's dev stub seeds
  `role: "admin"` + **empty** permissions, so any `requires
  currentUser.permissions…` gate 403s out of the box (role gates pass). The dev
  stub is a transitional placeholder being replaced per-backend by generated
  OIDC verifiers in the in-flight auth-providers track (#1222 OIDC providers,
  #1225 default-deny, #1228 .NET `/auth/me`; plan:
  `docs/old/plans/auth-providers-implementation.md` — the OIDC verifier
  auto-registers *instead of* the dev stub when a provider is configured).
  Per the maintainer, the dev stub itself is a candidate for removal once
  authorization is fully in place — so seeding permissions into it now would be
  throwaway and would collide with that active work. Left untouched.
  Non-unique `byName`/`byHandle` index vs single-row finder intent remains a
  separate (uncertain) item.

## Method note

The fast generator-string assertion layer (now ~15 new tests (the controlled-modal test covers all 4 React packs)) catches every fixed
defect in plain `npm test` with no toolchain — the recurrence net the harshness
of the original escape (contract asserted but never executed) motivated.

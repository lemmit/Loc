# D-PHOENIX-SURFACE phases 6–7 — generator wiring + the rename cleanup

> Tracks: [`../decisions.md` § D-PHOENIX-SURFACE](../../decisions.md) (PINNED) and
> [`../proposals/embedded-frontend-composition.md`](../proposals/embedded-frontend-composition.md).
>
> **Phases 1–5 shipped** (merged #774/#775/#776/#780/#783/#788):
> - 1 `PlatformSurface.hostableFrameworks` capability;
> - 2 `framework` on the `ui` declaration (grammar + `UiIR.framework`);
> - 3 validator host-compatibility check (`loom.ui-framework-unhostable`);
> - 4 `hosts:` clause on `deployable` (`DeployableIR.hostedUiNames`, bracketed-multi);
> - 5 `phoenix`/`liveview` aliases canonicalising to `phoenixLiveView`.
>
> Every shipped phase is **additive and zero-generated-output-change**. The
> entire language + validation + lowering surface is live end-to-end:
> `platform: phoenix`, `framework: liveview`, and `hosts: [Ui, …]` all parse,
> validate, and lower today. **What does NOT yet exist is any generator that
> reads these to emit different output.** That is phase 6.

## Why this is its own plan (and not just "phase 6")

Phases 1–5 were each a small, additive, output-neutral slice. Phase 6 is
categorically different — it is the **first phase that changes generated
output** — so it earns a plan rather than a single "continue". Two facts from
the investigation set the shape:

1. **Phoenix-embeds-React is net-new generator code (~140 LOC by the .NET
   precedent).** The Phoenix generator (`src/generator/phoenix-live-view/`)
   today has **zero** React/embed awareness — it assumes every UI is
   LiveView/HEEx and never even reads `deployable.uiFramework`. There is no
   seam to "turn on"; the wiring is new.
2. **The blast radius is real but bounded.** No byte-for-byte Phoenix
   fixtures exist (`test/fixtures/baseline-output/` is .NET only), so nothing
   snapshot-breaks. The live gate is **`phoenix-build.yml`** — a real
   `mix compile --warnings-as-errors` against generated `acme-lv.ddd` +
   `roster.ddd` in an Elixir Docker image — which the local fast suite
   **cannot** run. So phase 6 correctness is genuinely only provable in CI.

## The five seams (from the investigation)

Mirroring the .NET embed precedent (`src/generator/dotnet/index.ts:144–299`),
"Phoenix hosts a React SPA" plugs into five points in
`src/generator/phoenix-live-view/`:

| # | Seam | Location today | Change |
|---|---|---|---|
| S1 | **Framework dispatch** | `index.ts:175` (`if (deployable.uiName)`) + `liveview-emit.ts:61` | Gate LiveView page emission on `uiFramework !== "react"`; when `=== "react"`, take the embed branch instead. |
| S2 | **React project emission** | none (no react import) | `generateReactForContexts(contexts, sys, deployable, { apiBaseUrl: "/api", pathPrefix: "assets/" })`; filter duplicate shell files (Dockerfile/.dockerignore/certs/e2e) exactly as dotnet does. |
| S3 | **Static serving** | `endpoint.ex` `Plug.Static` allowlist (`index.ts:1044`) | Serve the built SPA from `priv/static` (expand the `only:` allowlist / add the SPA asset dir). |
| S4 | **SPA fallback route** | `router.ex` (`index.ts:1127–1157`; `/api` scope already exists) | Add a catch-all serving `index.html` so client-side routes deep-link — the `MapFallbackToFile` analogue. |
| S5 | **Multi-stage Dockerfile** | single-stage Elixir (`index.ts:675–736`) | Prepend a `node … AS spa-build` stage (`npm ci && npm run build`), `COPY --from=spa-build /spa/dist ./priv/static`. |

The API namespace is the one piece that's **already done**: Phoenix routes are
already under `scope "/api"` (and `PlatformSurface.apiBasePath` is `/api`), so —
unlike .NET, which had to *shift* controllers to `/api/*` — Phoenix needs no
route-prefix rework. The `apiBaseUrl: "/api"` the React side bakes in already
lines up.

## Phase 6 — sliced for review and for the CI gate

Each slice is independently mergeable and leaves the tree green. Slices 6a–6b
are **still output-neutral** (no example uses `phoenix` + `framework: react`
yet); 6c is the first to change real example output.

### 6a — React-emit dispatch, behind a dormant branch (~40 LOC)
- Import `generateReactForContexts` into the Phoenix orchestrator.
- Add the S1 framework gate + S2 emit branch, but it only fires when
  `uiFramework === "react"`. **No example triggers it**, so output is
  unchanged and the only proof is unit tests that construct an embedded-react
  Phoenix deployable in-memory and assert the React files land under
  `assets/` with `apiBaseUrl: "/api"`.
- Tests: generator-level (`test/generator/phoenix/`) — embed branch emits the
  SPA tree + skips duplicate shell files; LiveView branch unchanged when
  `framework: liveview`.

### 6b — endpoint/router/Dockerfile embed wiring (S3–S5, ~70 LOC)
- `Plug.Static` allowlist + SPA fallback route + multi-stage Dockerfile, all
  gated on the same embedded-react flag.
- Still output-neutral (no triggering example). Tests assert the emitted
  `endpoint.ex`/`router.ex`/`Dockerfile` contain the SPA serve + fallback +
  node build stage **when** the flag is set, and are byte-identical to today
  when it isn't.

### 6c — a real embedded-react Phoenix example + the CI proof (output-changing)
- Add **one** small example (or a `phoenix-build` fixture
  `test/e2e/fixtures/phoenix-build/phoenix-embed-react.ddd`) that actually
  uses `platform: phoenix, hosts: <react-ui>`.
- This is the slice that makes `phoenix-build.yml` exercise the new path
  (`mix compile --warnings-as-errors`) **and** the react-build matrix compile
  the embedded SPA. **Land 6c with PR CI subscribed** — this is where an
  Elixir/Ash compile error or a Vite/tsc error in the embedded bundle would
  first surface, and neither is catchable locally. (The Phoenix backend now emits
  plain Ecto/Phoenix — the Ash foundation has been removed.)
- Blast radius: the two existing Phoenix examples (`showcase.ddd`,
  `storefront-phoenix.ddd`) stay LiveView and are **untouched** (their UIs
  declare no `framework: react`), so their output does not move.

## Phase 7 — the literal rename `phoenixLiveView` → `phoenix` (separate, mechanical)

Phase 5 made `phoenix`/`liveview` *aliases* that canonicalise to the still-dominant
`phoenixLiveView` literal. Phase 7 flips which name is canonical:

- Make `phoenix` the canonical platform family and `phoenixLiveView` the
  (deprecated) alias; same for `liveview` ↔ `phoenixLiveView` the framework.
- Migrate the 13 literal consumers + the registry key + the two examples +
  the two `phoenix-build` fixtures to the new spelling.
- **This DOES move generated output** (module names, compose service names,
  the `phoenix-build` fixtures) — so it is a coordinated re-baseline moment,
  kept **separate** from phase 6 so a generator bug and a rename churn never
  land in one diff.
- Optional / can be deferred indefinitely: the aliases from phase 5 mean the
  new spelling already works for users **without** phase 7. Phase 7 is
  cosmetic-canonical cleanup, not a capability. Recommend deferring until the
  Ecto domain-axis work lands, so the rename and the domain modifier re-baseline
  the Phoenix fixtures **once**, together. (The foundation axis has since resolved
  to `ecto`/vanilla only — the Ash foundation is removed.)

## Sequencing & risk

```
6a (dormant react-emit dispatch)  ──┐
6b (dormant endpoint/docker wiring) ─┼─ output-neutral, local-provable, low risk
6c (real example + CI proof)  ───────┘─ first output change; CI-gated; subscribe
        │
        ▼
7  (rename cleanup)  ── output churn; coordinate with Ecto domain-axis re-baseline; deferrable
```

- **6a/6b are safe to land like phases 1–5** (additive, dormant, fast-suite
  provable).
- **6c is the real gate** — do not merge on the fast suite alone; require
  `phoenix-build.yml` + the react matrix green, with PR activity subscribed so
  a `mix compile` failure is investigated, not missed.
- **Phase 7 is explicitly optional** and best bundled with the Ecto domain-axis
  re-baseline to avoid churning the Phoenix fixtures twice.

## Open questions for phase 6

1. **SPA mount path under `priv/static`.** dotnet drops the bundle at the
   `wwwroot` root (`/`); Phoenix already serves `assets/fonts/images/...` from
   `priv/static`. Does the SPA land at `priv/static/` root (needs the
   `Plug.Static` `only:` allowlist widened to the SPA's entry files) or under
   a subdir like `priv/static/app/` (cleaner allowlist, but the SPA's base
   href + Vite `base` must match)? Leaning: subdir, mirroring how the SPA's
   `pathPrefix: "assets/"` keeps the source tree tidy.
2. **`mix assets.deploy` vs raw copy.** Phoenix's asset pipeline
   (`esbuild`/`tailwind`) is separate from the embedded SPA's Vite build. The
   embedded SPA should build with its **own** Vite (the `assets/` React
   project), and the Dockerfile just copies its `dist/` — i.e. bypass
   `mix assets.deploy` for the SPA. Confirm this doesn't collide with the
   LiveView path's own `priv/static/assets/` (theme.css etc.).
3. **Does an embedded-react Phoenix still emit the HEEx/LiveView shell at
   all?** No — when `framework: react`, the deployable is a JSON API backend
   that happens to also serve a SPA; it should emit **no** LiveView pages
   (S1 gate). The Ecto/Phoenix domain + `/api` controllers + OpenAPI stay.

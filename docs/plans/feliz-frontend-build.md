# Feliz / Fable / Elmish frontend — build plan & findings

> Status: **IN PROGRESS.** Implements [`docs/proposals/fable-elmish-frontend.md`].
> The proposal proved the target + runtime viable by hand (§7 spikes); this is
> the actual generator build. Last updated 2026-07-12.

## Slice 1 result — the `view` RIDES `walkBody` (empirically confirmed)

A throwaway `felizTarget: WalkerTarget` + a minimal procedural pack was run
against the real Counter page body through the **shared** `walkBody`. Output:

```fsharp
Html.div [
  prop.children [
    Html.h1 [ prop.text "Counter" ]
    Html.p [ Html.text (string (("Count: " + String(model.Count)))) ]
    Html.button [ prop.text "+"; prop.onClick (fun _ -> inc()) ]
    Html.button [ prop.text "-"; prop.onClick (fun _ -> dec()) ]
  ]
]
```

- **Element tree, primitive→pack dispatch, control-flow seams, and
  named-action resolution (`onClick: inc` → `prop.onClick (fun _ -> …)`) all
  ride the shared engine.** No HEEx-style parallel walker is needed — this
  confirms proposal §1/§3a/§9. The Feliz view is expression-valued and lands on
  the React/TSX branch of every seam.
- **One caveat surfaced:** `String(model.Count)` is JavaScript. `emitExpr` /
  `emitStmt` in `walker-core.ts` **hardcode JS expression syntax** with no
  target seam — `String(x)`, `[a, b]` (F# wants `[a; b]`), `(p) => body` (F#
  wants `fun p -> body`), `(c ? t : e)`, JS object literals, `===`/`!==`. All
  four existing shared-walker frontends (React/Vue/Svelte/Angular) embed **JS**
  in markup, so this was never a divergence. Feliz is the first frontend whose
  embedded expression language isn't JS.

## The expression seam — convergence design (no-debt end state)

The debt is that `emitExpr` bakes in one language. The fix mirrors what the
**backend** already does (`src/generator/_expr/target.ts`: one `renderExprWith`
dispatcher + a per-backend leaf table). The frontend gets the same shape:

- A single frontend expression dispatcher owning the `ExprIR.kind` switch +
  recursion, with a **per-frontend leaf table** supplying operator/literal/
  lambda/list/convert/object syntax.
- React/Vue/Svelte/Angular share ONE `jsExprLeaves` table — converted
  **byte-identically** from today's hardcoded arms (gated by the existing
  generator suite, which asserts exact output).
- Feliz supplies `fsharpExprLeaves`.

The frontend keeps its **resolution layer** in the walker (api-hook detection is
top-down/short-circuiting; ref→state/param/store/derived/lambda and
store-action/extern resolution call `WalkerTarget` seams and mutate ctx sinks).
That layer is frontend-inherent and does NOT belong in the backend's bottom-up
`ExprTarget` — so the frontend gets its own dispatcher, not a reuse of
`renderExprWith`. Only the pure-syntax leaves are extracted.

**Build order (second consumer designs the abstraction):** implement the Feliz
expression renderer concretely and prove it compiles via `dotnet fable` FIRST,
THEN extract the shared `jsExprLeaves`/`fsharpExprLeaves` seam with both tables
in hand — not before F# output exists.

## Slices

1. ✅ Confirm `view` rides `walkBody` (throwaway prototype).
2. ✅ Feliz expression renderer + `felizTarget` view emitter + MVU projection
   (Model/Msg/init/update off `state`/`action`s) + a minimal procedural Feliz
   pack → a Counter Fable project that **compiles clean via `dotnet fable`**
   (SDK:8.0 container, §10; the compiled JS has a working `Model`/`Msg`/`update`
   + a `dispatch`-wired `view`). Landed the expression-syntax seam as OPTIONAL
   `WalkerTarget` leaf methods with JS fallback (React/Vue/Svelte/Angular stay
   byte-identical — 728 frontend tests green). `src/generator/feliz/*`.
3. ⚙ Grow the procedural Feliz pack example-by-example (Counter → a scaffold
   example → …). Currently 4 primitives (Stack/Heading/Text/Button); the seam
   methods (`renderMatch`/`For`/`navigate`/api hooks) throw loudly until an
   example needs them.
4. ✅ **No-debt convergence:** the expression-leaf seam methods are now
   REQUIRED on `WalkerTarget`; `emitExpr` delegates every divergent arm with NO
   fallback. React/Vue/Svelte/Angular share one `jsExprLeaves` table
   (`src/generator/_walker/js-expr-leaves.ts`, spread in), Feliz supplies
   `FS_LEAVES`, HEEx (which forks `emitExpr`) gets fail-loud `unreachableExprLeaves`.
   One dispatcher, one leaf table per embedded language — byte-identical gated.
5. ✅ `platform: feliz` / `framework: feliz` reachable end-to-end — grammar
   (langium regen) + `Platform` IR type + `PLATFORM_DESCRIPTORS` +
   `src/platform/feliz.ts` surface + registry + validator (`FRONTEND_KEYWORDS`)
   + the `.ddd`-printer `PLATFORM_KEYWORDS` mirror. Feliz hosts only itself
   (Fable's dotnet+vite build ≠ the vite-only static pipeline, so it's absent
   from `STATIC_BUNDLE_FRAMEWORKS`/`FRONTEND_GENERATORS`). Validates through
   `validateLoomModel` and generates through the system composer; the emitted
   tree ships a multi-stage Dockerfile (Fable→Vite→nginx). Tests incl. a
   `validateLoomModel`-path reachability test (experience §22).
6. ✅ Runtime proof — the CLI-generated Counter ran the full §7.1 pipeline:
   `dotnet fable` → `vite build` → headless Chromium. The MVU loop works
   (`Count: 0` → +,+ → `2` → - → `1`, zero page errors). Fixed a real emit bug
   the proof exposed: `index.html` must reference `./out/src/App.js` (Fable
   mirrors the fsproj layout; the path must be relative for Vite).
7. ✅ **F# wire layer** — Thoth.Json decoders + a `Cmd`-based `Api` module,
   both off `agg.wireShape` (parallel of `src/generator/_frontend/`; reuses the
   IR projection, not the TS/zod emitters). `src/generator/feliz/wire.ts`.
   Un-stubbed the `felizTarget` api seams
   (`buildHookUse`/`renderApiCall`/`renderApiHoisting`/`renderQueryDataAccess`)
   as an **MVU projection** (§2.3/§7.2): a `<param>.<agg>.all` read → a
   `Remote<'T list>` Model field + an init `Cmd.OfAsync.perform` + a `Loaded`
   `Msg` + two `update` arms (`Ok`→`Loaded`, `Error`→`LoadError`). QueryView
   renders through an emitted `View.remoteList` helper (a helper CALL is
   offside-safe inside a Feliz `[ … ]` list where a raw multi-line `match` is
   not). Also landed the deferred control-flow seams: `renderForEach`
   (`yield! coll |> List.map`), `renderConditionalChild` + `renderMatch`/
   `renderMatchChild` (single-line `if/elif/else` — offside-safe). All
   Fable-verified (SDK:8.0 container: decoders + api + MVU + QueryView + For +
   ternary + `match {}` all compile; `vite build` bundles 74 modules).
   Read-free pages (Counter) stay byte-identical (no wire layer emitted).
8. ✅ `generated-feliz-build` CI gate — generate via CLI → `dotnet fable` →
   `vite build` (`.github/workflows/generated-feliz-build.yml`). **Green in
   GitHub Actions** (run #3; first two runs caught a Node-20 `Object.groupBy`
   gap, fixed by pinning Node 22). Slice 7 grew the inline example to a
   **data-driven** page (aggregate + repository + api + `QueryView`), so the
   gate now covers the wire layer end to end.

## Known gaps / next
- ✅ **Multi-page routing.** A >1-page ui emits a `Page` union + `parseUrl` +
  a `React.router` root over a **combined Model** (`CurrentPage` + all pages'
  deduped state/reads), per-page `<page>View` functions, and `UrlChanged`
  wiring — via `Feliz.Router`. Cross-page nav (`Button(to:)` / `navigate`) →
  `Router.navigate(<segments>)`. Single-page uis stay byte-identical (no
  router, no Page union). All Fable + vite verified; the CI example is a
  2-page routed app. **Caveat:** the flat combined Model assumes distinct
  state-field names across pages (same-named fields share one cell); per-page
  sub-models are a follow-up if that bites.
- ✅ **Scaffold primitive coverage (e2e parity).** The pack now renders every
  primitive a `with scaffold(...)` app uses — the containers Stack/Group/Paper/
  Toolbar/Breadcrumbs, the leaves Heading/Text/Button/Card/Badge/Divider/Alert/
  Empty/Skeleton/KeyValueRow/Anchor/IdLink, the `Table` (header + `yield!
  List.map` rows), plus `QueryView` (via `View.remoteList`/`remoteOne`) and the
  forms. A scaffold-generated CRUD app (List/New/Detail/Home) Fable-compiles,
  vite-builds, AND runs (headless-Chromium smoke) — the CI gate now covers both
  the hand-built showcase AND a scaffold app. **Modal** renders its trigger as a
  present-but-inert button (the modal-wrapped operation's open-state wiring is a
  follow-up; the operation FORM itself is still wired via `OperationForm`
  detection). Offside note: containers keep their structural props
  (`className`/`children [`) on the opening line + paren-wrap the whole element,
  else a separate-line `prop.children` aligns with the parent's child column and
  F# parses it as a parent-list element (§29-adjacent; see experience §30).
- ✅ **byId / detail-page reads.** A `QueryView(of: X.byId(id), single: true)`
  on a `:id`-param route projects to a `Remote<'T option>` Model field, a
  `productById (id: string)` Api fetch (`Decode.option` + a `404 → Ok None`
  arm), and a **page-entry `Cmd`** (`pageCmd`) fired on BOTH init and every
  `UrlChanged` — so navigating between `/products/:id` for different ids
  refetches (the byId field resets to `Loading` on entry). The `Page` union
  case carries the route param (`| ProductDetail of string`); `parseUrl` binds
  the segment; the root view threads it to the detail view fn. Un-stubbed
  `renderRouteId → "id"`; rendered through a `View.remoteOne` helper. All
  Fable + vite verified (SDK:8.0 container); the CI example is now a 3-page app
  (counter + list + byId detail). **v1 caveat:** single route param only (bound
  to the magic `id`); multi-param routes bind the first as `id`, the rest `_`.
- ✅ **Delete mutations.** A `DestroyForm(of: X)` on a detail page emits a
  delete button that DISPATCHES `Delete<Agg> id` (via the `renderDestroyForm`
  seam); the mutation lives in `update` — the trigger fires a `DELETE
  /api/<agg>/<id>` `Cmd` (`Http.request |> Http.method DELETE |> Http.send`, 2xx
  → `Ok ()`), and on success the app navigates to the aggregate's list route
  (`Cmd.navigate`). All Fable + vite verified; the CI example's detail page now
  carries a `DestroyForm`. Read-only uis stay byte-identical (no delete Api/Msg).
- ✅ **Create forms.** A `CreateForm(of: X)` projects to Elmish form state: a
  string-typed `<Agg>Form` record in the Model (bound to `Html.input`s), one
  `Set<Agg>Form<Field>` update `Msg` per field, a `Submit<Agg>Form` trigger that
  POSTs the **Thoth-encoded** body (`Encoders` module — the write direction of
  the decoders, off `createInputFields`), and a `<Agg>Created` result that
  resets the form + navigates to the list. The `renderCreateForm` seam emits the
  inputs + submit button; the field set is derived identically in the view walk
  and the MVU assembly (both `felizCreateForm` off the same enriched aggregate).
  All Fable + vite verified; the CI example grew a `ProductNew` page.
  **v1 caveat:** REQUIRED SCALAR create-input fields only (nested part / VO /
  collection inputs need sub-forms — follow-up); all fields string-typed (typed
  form state + validation is a follow-up).
- ✅ **Operation forms.** An `OperationForm(of: X, op: Y)` on a detail page
  projects to Elmish form state (the op's params) + a curried id-qualified Api
  fn (`POST /api/<agg>/<id>/<op>`, 204 → `unit`) + a `Submit<Op><Agg>Form of
  string` trigger (carrying the route id) + a `<Op><Agg>Done` result that resets
  + navigates. Reuses the create-form record/encoder/type renderers via a shared
  `FormRecord`; the delta is the id-qualified endpoint, the curried `Cmd`
  (`Api.<fn> id`), and the id-carrying submit. The `renderOperationForm` seam
  emits the inputs + submit. All Fable + vite verified; the CI example's detail
  page grew an `OperationForm` (a custom `rename` op). **v1 caveat:** the
  addressed `(of:, op:)` form only (the instance-qualified `OperationForm(inst.
  op)` and prefilling the form from the loaded record are follow-ups).
- ✅ **Runtime e2e gate.** `generated-feliz-build.yml` now also PROVES THE
  BUNDLE RUNS (not just compiles): after `vite build` it `vite preview`s the
  static bundle and drives it in headless Chromium (`scripts/feliz-smoke.mjs`) —
  the app mounts, the MVU counter dispatches, routing navigates, and the wire
  layer's `Remote` state settles (no backend → the QueryView's error/empty
  branch, which itself proves the `Cmd` + Thoth-decoder path executed). Folded
  into the build workflow (not a separate `-e2e.yml`) to reuse the single slow
  `dotnet fable` step. The runtime sibling the JSX frontends get from
  `generated-{vue,svelte}-e2e.yml`.
- **Wire layer now covers the full CRUD write path.** list + byId reads, create,
  delete, and operation. Remaining Feliz work: broader pack primitive coverage,
  workflows, and auth. Enum wire fields decode as their string name (a proper DU
  decoder is a follow-up); nested containment/VO records + decoders ARE emitted
  (transitive off `wireShape`).

Known-good deps (proposal §10): Fable 4.29 / Feliz 2.8 / Fable.Elmish.React 4.0
/ Fable.SimpleHttp 3.6 / Thoth.Json 10.2 / net8.0. Avoid Thoth.Fetch (promise-CE
clash) — use Fable.SimpleHttp + Thoth.Json.

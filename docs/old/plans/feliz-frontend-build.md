# Feliz / Fable / Elmish frontend — build plan & findings

> Status: **IN PROGRESS.** Implements [`docs/old/proposals/fable-elmish-frontend.md`].
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
  the hand-built showcase AND a scaffold app. **Modal** renders as a native
  `<details>` DISCLOSURE (the `<summary>` is the trigger label; the wrapped
  operation form is revealed on click) — no MVU open-state needed; see the
  "Modal disclosure" bullet below. Offside note: containers keep their structural props
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
  **Caveat:** SCALAR create-input fields (required + optional; an optional field
  is rendered, exempt from the submit guard, and encodes empty → `null`).  Nested
  part / value object / collection inputs still need a sub-form (follow-up).
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
- ✅ **Workflow forms.** A `WorkflowForm(runs: Y)` projects to Elmish form state
  (the workflow's scalar params) + a PARAMLESS `Submit<Wf>Form` trigger that
  POSTs the Thoth-encoded body to `/api/workflows/<snake wf>` (204 → `unit`) + a
  `<Wf>Done` result that resets + navigates home. Reuses the create/operation
  form machinery via the shared `FormRecord`; the delta is the `/workflows/<wf>`
  endpoint (no id, no response decode). The `renderWorkflowForm` seam emits the
  inputs + submit; `walkBody` now threads the ui's `workflowsByName` so the
  `runs:` ref resolves. Also fixed a latent bug: a SINGLE-page ui with any form
  now opens `Feliz.Router` (+ refs it) for `Cmd.navigate` (create/op/workflow
  all navigate on success — previously only routed uis opened the router). All
  Fable + vite verified; the CI scaffold leg now includes a `workflows:` form.
- ✅ **Auth session gate (D-AUTH-OIDC).** When the target backend is `auth:
  required` AND this ui opts in with `auth: ui` AND the system declares a `user
  {}` claim block (mirrors the React `authUi` gate), the whole app is wrapped in
  an MVU session gate: a `SessionState` (`Checking`/`Authed`/`Anon`) Model field,
  an `Auth` module that probes `/api/auth/me` (status-only) at init and redirects
  to the backend's `/auth/login`/`/auth/logout` via `window.location.href`
  (`Browser.Dom`), and a root `view` that shows a spinner → a sign-in prompt →
  the real `appView` (the existing root, renamed). Loom owns no auth runtime —
  it's the OIDC-handshake redirect the JSX frontends emit. All Fable + vite +
  headless-smoke verified; the CI scaffold leg is now auth-gated. Non-auth uis
  stay byte-identical.
- ✅ **Typed + validated form state.** Every form input (create / operation /
  workflow — via a shared `renderFormInput` seam) is now typed off its wire type:
  numerics (`int`/`long`/`decimal`/`money`) render `prop.type'.number`, `bool`
  renders a `prop.type'.checkbox` (`isChecked` over the string state, bool
  `onChange` writing back `"true"`/`"false"`), everything else a text input. The
  form record STAYS all-string (the Thoth encoder already lifts it); `inputKind`
  is derived from the type, not stamped. A `Validation` module emits one
  `<form>Valid` predicate (every required text/number field non-empty — checkbox
  fields excluded, since unchecked is a legitimate `false`), and each submit
  button reads it via `prop.disabled (not (Validation.fooValid model.F))` — the
  zod-`.min(1)` submit guard. The runtime smoke DRIVES the guard (open form →
  submit `isDisabled()` → fill + toggle checkbox → `isEnabled()`); the showcase
  Product grew a `bool inStock` so all three widget kinds render in CI. All Fable
  + vite + headless-smoke verified.
- ✅ **Optional scalar form fields (+ optional read decoder fix).** Optional
  scalar create-input fields — previously DROPPED (`!f.optional` filter) — are now
  rendered: same typed widget as their required twin, empty string encodes to
  `Encode.nil` (JSON `null`), and they're exempt from the `Validation` submit
  guard (an omitted optional is legitimate). Op/workflow forms pick up optional
  (`x?: T`) params the same way. Also fixed a latent **read-decoder** bug this
  surfaced: an optional wire field double-wrapped its record type
  (`string option option`) vs the `get.Optional.Field` decoder's single `option`
  — a Fable type mismatch that never fired because no prior example READ an
  optional field. Both now key off one optionality signal. All Fable + vite +
  smoke verified; the showcase Product grew an optional `note`.
- ✅ **Enum → `<select>` dropdown.** An enum create/op/workflow field now renders
  as an `Html.select` of `Html.option`s over the enum's values (was a free-text
  input). The values are resolved from the field's owning bounded context — the
  first Feliz form widget needing data off the aggregate — by threading the real
  `bcByAggregate`/`bcByWorkflow` into `walkBody` (previously `new Map()`); the
  seam reads `ctx.bcByAggregate.get(agg)?.enums`, and `index.ts` resolves the same
  set via `enumsFromContexts` so both derivations of the field set agree. A
  REQUIRED enum defaults to its first value (a select always has a selection,
  matching React); an OPTIONAL enum leads with a blank option (→ null on encode)
  and is exempt from the guard. All Fable + vite + smoke verified (the smoke
  `selectOption`s a value); the showcase Product grew an `enum Status`.
- ✅ **Foreign-key `X id` → `<select>` populated from the target list.** An `X id`
  form field renders as a select of the target aggregate's records (was a raw-id
  text input): each option's value is a target `id`, its label the target's
  `display` derived field (else `id`). The target's `.all` is an IMPLICIT list
  read merged into the page's read set (deduped) — so the whole `Remote`/`Api`/
  Model/init/update wiring emits for free — and a `View.idOptions` helper maps the
  loaded `Remote<'T list>` to `<option>`s (offside-safe: a `ReactElement list`
  the call site `::`-prepends the blank option onto). A required FK is guarded
  (must pick); an optional FK is exempt. All Fable + vite + smoke verified; the
  showcase grew a `Category` aggregate + an optional `category: Category id?`
  (optional because a required FK's list can't load in the no-backend smoke).
- ✅ **Nested value-object inputs.** A VO create/op/workflow field (`address:
  Address`) is FLATTENED into one input per scalar VO sub-field (`addressStreet`/
  `addressCity`) — the form record stays flat/all-string, and the encoder RE-NESTS
  them under the object key (`"address", Encode.object [ "street", …; "city", … ]`).
  Sub-field required-ness/optionality flows through (an optional VO sub-field is
  exempt + encodes null). This also fixed a dormant **read-record ordering** bug it
  surfaced: a wire record referencing another (a VO / entity-part field) now emits
  as a mutually-recursive `type X = {…} and Y = {…}` group + `let rec x … and y …`
  decoder (sibling ref UNqualified), since F# is order-sensitive — never fired
  before because no shipped Feliz read had a VO field. Single-record output stays
  byte-identical. All Fable + vite + smoke verified; the showcase grew a
  `Contact` VO. **Caveat:** one level (scalar VO sub-fields); nested-VO /
  array-of-VO / entity-part inputs still need repeatable/sub-form UI (follow-up).
- ✅ **Scalar-array (`X[]`) inputs.** A scalar-array create/op/workflow field
  renders as a single COMMA-SEPARATED text input (`"tags (comma-separated)"`); the
  encoder splits it into a JSON array — `Encode.list (form.tags.Split(',') |>
  Array.toList |> List.map (trim) |> List.filter (drop blanks) |> List.map
  <elemEncode>)` — encoding each element by its type (`Encode.string` /
  `Encode.int (int s)` / …). The form field stays a flat `string`, so the entire
  existing flat pipeline (record / Set-Msg / update-arm / validation) is reused —
  only the encoder differs; an empty input → `Encode.list []` (never null).
  Chosen over dynamic add/remove rows (which would make the field a `string list`
  + need indexed `Add`/`Remove`/`Set` Msgs) as the pragmatic v1. All Fable + vite +
  smoke verified; the showcase grew `tags: string[]?`. **Caveat:** scalar element
  types only; array-of-VO / array-of-entity-part + a proper repeatable-row UI are
  the follow-up.
- ✅ **Modal disclosure.** The scaffold `Modal` (one per public op, wrapping an
  `OperationForm`) — previously a dead inert button — renders as a native
  `<details>`/`<summary>` DISCLOSURE: the summary is the trigger label, and the
  wrapped operation form (rendered through the SAME `renderOperationForm` seam) is
  revealed on click. No MVU open-state (the browser owns open/close); the op
  form's Model/Msg/update/Api wiring is collected independently by `index.ts`.
  Forked via the `renderModal` WalkerTarget seam (like Angular), bypassing the
  React-specific `emitModal` path. All Fable + vite + smoke verified — the scaffold
  smoke navigates to the detail page, expands the disclosure, and asserts the
  revealed input. **`currentUser.<field>` in a body is a CROSS-frontend gap** (the
  shared walker emits `undefined` for React too), NOT Feliz-specific — out of
  scope here.
- ✅ **Page-`requires` UI authorization gate (D-AUTH-OIDC).** A page carrying
  `requires <currentUser gate>` now enforces client-side (the read-side mirror of
  the backend 403). The `auth: ui` probe upgrades from status-only (`Async<bool>`)
  to a claims decode: `/api/auth/me` → a typed `CurrentUser` record (built from the
  statically-declared `user { }` shape) + Thoth decoder, held on the Model
  (`CurrentUser: CurrentUser option`). A gated view wraps its body in
  `match model.CurrentUser with Some currentUser when <gate> -> … | _ ->
  forbiddenView`. The gate is rendered by `auth-gate.ts`'s `renderFelizGate` — the
  F# sibling of the shared `gate-expr.ts` (`==`→`=`, `!=`→`<>`, `.contains`→
  `List.contains`, claim→pascal record field). Gated ONLY when a page has
  `requires` (`pageGate = authUi && sys.user && uiHasPageGate`); a gate-free auth
  app stays byte-for-byte on the boolean probe. Fable + vite + a dedicated
  headless smoke that STUBS `/api/auth/me` to prove BOTH branches (admin→body,
  viewer→forbiddenView); new `generated-feliz-build.yml` auth-gate leg.
- ✅ **One-click actions (`Action { instance.op }`) + action-button gating.** A
  parameterless public op invoked on a single-record (byId) detail instance now
  renders as a native F# dispatch button (was silently emitting broken React
  `mutateAsync` — a dormant gap no example hit). It projects to the MVU exactly
  like the operation form minus the fields: a trigger `Msg` carrying the route id
  → `POST /<id>/<op>` (empty body) → a `Done` result that refetches the detail
  (`pageCmd`, so the UI reflects the mutation). Forked via `felizTarget.
  renderAction` (like Angular) so it never hits the shared React `emitAction`; the
  wiring is collected by `collectPageActions` (a single-QueryView `data:`-param →
  aggregate binding tracker, the `ctx.paramTypes` twin). Under `auth: ui`, a
  currentUser-only op `requires` HIDES the button via the decoded claims
  (`match model.CurrentUser with Some currentUser when <gate> -> button | _ ->
  Html.none`) — the action-level mirror of the page gate, reusing `renderFelizGate`
  + `opActionGate`; a gated action alone pulls in the claims machinery. All Fable +
  vite + runtime-smoke verified (the auth-gate leg now stubs the byId read + the
  POST, clicks the gated Action, and asserts admin → POST fires / viewer → button
  hidden). Also fixed a latent `parseUrl` fallback bug (a param-carrying first page
  produced a partial-application `string -> Page` catch-all).
- **Wire layer covers the full CRUD write path + workflows + auth (session gate +
  page authorization gate + action gate), with a complete scalar + value-object +
  scalar-array form layer + the modal disclosure + one-click actions.** list + byId
  reads, create, delete, operation, workflow runs, the auth session gate, the
  page-`requires` gate, one-click `Action` buttons + action-button gating,
  typed/validated form inputs across every scalar widget — text / number /
  checkbox / enum-select / FK-id-select — plus flattened value-object fields,
  comma-separated scalar arrays, and the `<details>` action modal. Remaining Feliz
  work is refinement: deeper pack coverage, a dynamic-row / array-of-VO /
  entity-part sub-form UI, and `currentUser.<field>` in a body (a cross-frontend
  shared-walker gap). Enum wire fields decode as their string name (a proper DU
  decoder is a follow-up); nested containment/VO records + decoders ARE emitted
  (transitive off `wireShape`).

Known-good deps (proposal §10): Fable 4.29 / Feliz 2.8 / Fable.Elmish.React 4.0
/ Fable.SimpleHttp 3.6 / Thoth.Json 10.2 / net8.0. Avoid Thoth.Fetch (promise-CE
clash) — use Fable.SimpleHttp + Thoth.Json.

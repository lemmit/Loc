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
7. ⚙ F# wire layer — Thoth.Json decoders + `Cmd`-based api (parallel of
   `src/generator/_frontend/`; reuse IR projections like `wireShapeFor`, not the
   TS/zod emitters). Un-stubs the `felizTarget` api seams
   (`buildHookUse`/`renderApiCall`). NOT started.
8. ✅ `generated-feliz-build` CI gate — generate via CLI → `dotnet fable` →
   `vite build` (`.github/workflows/generated-feliz-build.yml`). Steps proven
   locally; first Actions run executes on the PR.

## Known gaps / next
- The procedural pack has 4 primitives (Stack/Heading/Text/Button); the
  `felizTarget` control-flow + api seams (`renderMatch`/`For`/`navigate`/api
  hooks) throw loudly until an example needs them (slice 3 grows both).
- Multi-page routing: `renderAppFs` wires only the first page (visible TODO).

Known-good deps (proposal §10): Fable 4.29 / Feliz 2.8 / Fable.Elmish.React 4.0
/ Fable.SimpleHttp 3.6 / Thoth.Json 10.2 / net8.0. Avoid Thoth.Fetch (promise-CE
clash) — use Fable.SimpleHttp + Thoth.Json.

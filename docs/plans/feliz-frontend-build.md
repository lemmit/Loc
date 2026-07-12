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
2. ⚙ Feliz expression renderer + `felizTarget` view emitter (F#/Feliz) →
   a compiling Counter Fable project (`dotnet fable` in the SDK:8.0 container
   per proposal §10).
3. Minimal procedural Feliz pack — the handful of primitives one example needs,
   grown example-by-example (NOT all ~80). Adds a procedural pack path to the
   loader (`src/generator/_packs/`), shaped by this pack's real needs.
4. Extract the shared frontend expression seam (JS leaves byte-identical;
   F# leaves for Feliz).
5. F# wire layer — Thoth.Json decoders + `Cmd`-based api (parallel of
   `src/generator/_frontend/`; reuse IR projections like `wireShapeFor`, not the
   TS/zod emitters).
6. `PlatformSurface` + registry entry + `framework: feliz` grammar/validator
   (mirror the Svelte/Angular adds).
7. `generated-feliz-build` CI gate (mirror `generated-react-build.yml`).

Known-good deps (proposal §10): Fable 4.29 / Feliz 2.8 / Fable.Elmish.React 4.0
/ Fable.SimpleHttp 3.6 / Thoth.Json 10.2 / net8.0. Avoid Thoth.Fetch (promise-CE
clash) — use Fable.SimpleHttp + Thoth.Json.

# Fable / Feliz / Elmish — an F# frontend target

> Status: **PROPOSED (gap analysis).** Nothing here is implemented. This note
> is the feasibility/distance companion to
> [`named-actions-and-stores.md`](named-actions-and-stores.md). It separates
> the *two* targets that hide under "Fable," estimates the distance to each
> against the real generator code, identifies the one genuinely
> un-precedented risk (pack format), and recommends a de-risking sequence.
> It deliberately does **not** claim the "structural isomorphism" the original
> external analysis led with — that claim is false against today's IR; see §2.

## TL;DR

There is no single "Fable target." There are two, and they are far apart:

1. **Feliz-with-hooks** (React-in-F#): a fifth `WalkerTarget` emitting F#
   instead of TSX. Weeks of work, low risk, **no IR change**. You get a
   type-safe F# frontend and another strict-compiler CI gate. You do **not**
   get MVU, `update`, or exhaustiveness payoff — it is React, spelled in F#.

2. **Real Elmish** (MVU): was a Phoenix/HEEx-class undertaking (parallel
   walker engine + `Msg`/`Model` *synthesis* from anonymous lambdas). The
   [named-actions proposal](named-actions-and-stores.md) removes **both** hard
   parts, turning Elmish from a research project into an incremental
   `update`-emitter on top of (1).

The largest *unknown* is independent of the MVU question: every Loom design
pack is Handlebars emitting **markup strings**, and Feliz has no markup layer
— its "markup" is F# code. That format gap is the cheapest, highest-value
thing to spike first.

The audience caveat is unchanged: F# web is ~5–15k devs. The case for this is
**generator rigor + .NET-shop differentiation**, never reach.

## 1. Precedent: Angular already proved a non-JSX target fits the walker

The repo's strongest evidence is `src/platform/angular.ts` +
`src/generator/angular/walker/angular-target.ts`: a **non-JSX** frontend
(signals, `name.set(v)` writes, `@if`/`@for` control-flow blocks,
`(event)="statement"` handlers) that lives inside the *shared* `walkBody`
engine (`src/generator/_walker/walker-core.ts`) via the `WalkerTarget` seam
contract (`src/generator/_walker/target.ts`). Four frontends share that engine
(React, Vue, Svelte, Angular); only Phoenix/HEEx forked it
(`src/generator/elixir/heex-walker-core.ts`).

The dividing line between "shares `walkBody`" and "forks it" is the whole
ballgame for Feliz, so §3 maps each Fable flavor onto it.

## 2. The isomorphism claim is false today — and what makes it true

The external analysis argued *"Loom already models named, typed actions, so
the Elmish `Msg` union is a projection."* Against the IR, page handlers are
**anonymous lambdas** (`{ kind: "lambda"; body?; block?: StmtIR[] }`,
`src/ir/types/loom-ir.ts:2500-2511`) and page state is a flat list of
independent cells (`StateFieldIR[]`, `loom-ir.ts:1964-1971`) — the React
`useState` shape, not an Elmish `Model` record. So a `Msg` union must be
**synthesized** (gensym a case per handler, thread a model), not projected.

[Named actions](named-actions-and-stores.md) make the claim true:
`action setCustomer(c: CustomerRef)` → `Msg.SetCustomer of CustomerRef`, a
pure body → one `update` arm, `state {}` → `Model`. This note assumes that
proposal as a dependency for flavor (2).

## 3. Work streams and distance

### 3a. Feliz-with-hooks (React-in-F#)

| Stream | Size | Notes |
|---|---|---|
| Platform plumbing | **S** | registry entry, `framework: feliz` (`ddd.langium` `Framework` rule), validator, default pack — identical to the Svelte/Angular adds |
| `felizTarget: WalkerTarget` | **M** | the seam table emitting F#. Feliz fits `walkBody` *more* cleanly than Angular: its markup is expression-valued (`if cond then a else b`, `List.map`), landing on the React/TSX branch of every seam, not the block-control-flow branch Angular/Vue/Svelte need |
| One design pack | **L** | the real lump (~80 primitives) — see §4 |
| `_frontend/` shared utils | **M** | Zod → Thoth.Json decoders; F# API layer; keep Playwright page-objects in TS (e2e runs in node) |
| Fable build + CI leg | **M-S** | dotnet+Fable+Vite → static bundle; fits `STATIC_BUNDLE_FRAMEWORKS` |

**No IR change.** On the order of the Svelte/Angular additions. Not MVU.

### 3b. Real Elmish (MVU) — with named actions as a dependency

The reason HEEx forked `walkBody` is that LiveView must **discover anonymous
inline effectful lambdas during the markup walk and hoist them** into
`handle_event` (`heex-walker-core.ts:965` gensyms `event_${n}`). Elmish has
the identical requirement (hoist effects into `update`). Two consequences,
both dissolved by named actions:

1. **Synthesis → projection.** `ActionIR` already carries the name + typed
   param, so `Msg` cases and `update` arms are a direct emit, no gensym.
2. **Codegen-time hoisting → IR-time hoisting.** Because actions are named and
   pure *in the IR*, the hoist is already done before codegen. The view
   collapses to "dispatch `Msg.X`" (trivial — fits the shared walker), and the
   `update` function is emitted separately from the `ActionIR` list. The exact
   structural mismatch that forced HEEx's parallel engine moves out of
   per-target codegen and into the shared IR, *once*.

So with named actions, Elmish ≈ 3a's effort **plus** a mechanical
`update`/`Model`/`Msg` emitter driven by `ActionIR` — an increment, not a
mountain. Without named actions, it is the HEEx-class slog with `event_N`
output quality, and is **not recommended**.

## 4. The un-precedented risk: pack format

Every pack is Handlebars → markup strings, keyed by `format`
(`tsx|vue|svelte|heex|angular`). Feliz has **no markup layer**:
`Html.div [ prop.children [ … ] ]` is F# *code*, and F#'s offside (indentation)
rule makes code-shaped output far more whitespace-sensitive than HTML. Two
candidate formats:

- **(a) Handlebars emitting F# call-syntax** — works (it is just text) but
  brittle under the offside rule; nested `prop.children [ … ]` lists are
  indentation-fragile in a string template.
- **(b) procedural F# emission** — like the *backend* emitters already do via
  `lines(...)` (`src/util/code-builder.ts`). Likely cleaner for code-shaped
  output, but it is a pack mechanism the loader (`src/generator/_packs/`) does
  not have today.

No existing Loom pack target (Mantine/shadcn/MUI/Chakra) has Feliz bindings
except shadcn, so ≥1 pack is written from scratch against a Feliz-bindable
system (Feliz shadcn / Bulma / DaisyUI) regardless. **This decision (a vs b)
is the highest-uncertainty, least-precedented piece — bigger than the
walker.** Spike it first (§6).

## 5. What does not transfer from the TS frontends

| Piece | Why | Feliz action |
|---|---|---|
| React/TanStack Query hooks | data-fetch is language-bound | F# async/`Result` factories, or Elmish `Cmd`s |
| JSX/Svelte/Vue templates | framework markup | pack owns it; no reuse |
| react-hook-form | React lib | Feliz form binding via pack templates |
| Zod runtime validation | TS lib | Thoth.Json decoders (or emit F# validators) |
| Auth-gate components | JSX/Svelte/Vue | emit `AUTH_GATE_FELIZ` (Feliz `Html` + session) |
| Playwright page-objects | — | **keep in TS** — e2e runs in node against the bundle |

Framework-neutral and reusable: menu derivation, theme-token prep, the wire
shape itself (`wireShape`), the e2e harness/smoke-spec structure.

## 6. Recommended sequence

1. **Pack-format spike** (≈half a day): emit one or two Feliz primitives both
   ways (§4 a vs b) and a full `Model/Msg/update/view` for the named-actions
   checkout example; compile it against real Feliz + Elmish nugets. De-risks
   the largest unknown cheaply. *(Spike findings: §7.)*
2. **Prototype `felizTarget: WalkerTarget`** against `walkBody`, gated by the
   same byte-output discipline the repo used for prior walker extractions —
   confirms the "fits more cleanly than Angular" claim empirically.
3. **Ship Feliz-with-hooks** if the value (type-safe F# + CI gate +
   .NET-shop differentiation) justifies the pack cost. Honest, low-risk.
4. **Land named actions** on its own merits (its §6 wins stand without F#),
   then let real Elmish fall out as a mechanical `update`-emitter.

## 7. Spike findings

A throwaway spike (not committed) hand-emitted the F# a Feliz/Elmish generator
*would* produce for the named-actions checkout example —
`Model`/`Msg`/`update` + a Feliz `view` over the `match`-on-step body — and
compiled it against **real** packages (Feliz 2.8.0, Elmish 4.2.0,
Fable.Core 4.3.0; `net8.0`; `TreatWarningsAsErrors=true`).

**Result: clean build (0 warnings / 0 errors) and 5/5 pure `update`
assertions pass with no DOM.** Concretely validated:

- The **projection holds end-to-end**: `action setCustomer(c: CustomerRef)` →
  `Msg.SetCustomer of CustomerRef` → one `update` arm
  `{ model with Draft = … ; Step = 1 }, Cmd.none`. No synthesis, no gensym.
- **Reified effects type-check and are testable**: `submit`'s `placeOrder` →
  `Cmd.OfAsync.perform`, `navigate(...)` → an observable `Navigated route`
  message. The "generated tests are pure function assertions" claim
  (proposal §6) ran as `update (SetCustomer …) model0` equality checks — no
  browser, no React.
- **Markup is expression-valued**, like JSX: the `match { … }` body is an F#
  `match` returning `ReactElement`; no block-control-flow workaround
  (Angular/Vue/Svelte's `@if`/`{#if}`/`v-if`) is needed.

**The one concrete hazard found — and it is *not* the offside rule.** The
build first failed on `Html.label "Customer"`: in Feliz 2.8 not every `Html.*`
element carries the bare-string shorthand that `Html.h2`/`Html.p`/`Html.button`
do. A naive emitter mapping every text node to `Html.<tag> "<text>"` would
emit non-compiling F#. The robust form is the always-available
`Html.<tag> [ prop.text "<text>" ]`. Meanwhile F#'s **offside rule did *not*
bite** the hand-written nested `prop.children [ … ]` lists at all — bracket
delimiting tolerates the indentation.

This **re-weights the §4 risk**: the dominant pack-format hazard is *per-primitive
API-surface coverage* (which overloads / prop names exist for each element and
design-system binding), not template indentation. That argues for pack-format
option **(b) procedural emission backed by a typed primitive table** (the safe
`[ prop.text … ]` form, a known prop vocabulary per primitive) over **(a)**
free-form Handlebars string templating — the opposite of the intuition that
the offside rule would be the killer.

**Scope of the de-risk (what the spike did *not* prove):** it validates the F#
*type surface* and the MVU projection only. It did **not** run Fable
(`dotnet fable`) to emit JS, nor exercise the React runtime / Vite bundle /
Playwright path. So the projection and F# well-formedness are de-risked; the
full Fable→bundle→runtime pipeline (§3a's "Fable build + CI leg") is not.

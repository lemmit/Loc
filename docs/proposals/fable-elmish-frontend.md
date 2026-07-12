# Fable / Feliz / Elmish — an F# frontend target

> Status: **PROPOSED (gap analysis).** No Fable target is implemented — but its
> one hard dependency now **is**: [`named-actions-and-stores.md`](named-actions-and-stores.md)
> shipped its **Stage 1 (named sync `action`s) + Stage 5 (`store`)** across all
> five UI targets (2026-07, code-verified — `ActionIR`/`StoreIR` in
> `src/ir/types/loom-ir.ts:287,312`, per-target `named-actions.test.ts`). This
> note is the feasibility/distance companion to that proposal. It separates the
> *two* targets that hide under "Fable," estimates the distance to each against
> the real generator code, identifies the one genuinely un-precedented risk
> (pack format), and recommends a de-risking sequence. It deliberately does
> **not** claim the "structural isomorphism" the original external analysis led
> with — that claim was false against the *anonymous-lambda* IR and is now true
> **only for the named-action subset**; see §2. The last-maturing MVU axis is
> **async effect outcomes** (server data as `Cmd`) — but its core primitive
> `await` + `match await` has now **shipped on all five targets**, and the
> `await`-required flip shipped (`loom.missing-effect-marker` is now an error —
> every remote call is explicitly awaited); what remains
> ([`async-actions-and-effects.md`](async-actions-and-effects.md)) is additive:
> `spawn`/`onError`/`attempt`/`async`-composition sugar. See §2.1.

## TL;DR

There is no single "Fable target." There are two, and they are far apart:

1. **Feliz-with-hooks** (React-in-F#): a fifth `WalkerTarget` emitting F#
   instead of TSX. Weeks of work, low risk, **no IR change**. You get a
   type-safe F# frontend and another strict-compiler CI gate. You do **not**
   get MVU, `update`, or exhaustiveness payoff — it is React, spelled in F#.

2. **Real Elmish** (MVU): *was* a Phoenix/HEEx-class undertaking (parallel
   walker engine + `Msg`/`Model` *synthesis* from anonymous lambdas). Named
   actions + stores **shipped**, removing **both** hard parts — `Msg`/`update`/
   `Model` are now a direct projection off `ActionIR`/`StoreIR`, not a synthesis
   — turning Elmish from a research project into an incremental `update`-emitter
   on top of (1). The residual is the **anonymous-lambda page** (named actions
   are opt-in, not mandatory) — but a whole-corpus census (§8) finds it is ~4
   files, so the fix is to *eliminate the form* (migrate them + a global
   lambda-purity invariant), not to build a gate that tolerates it.

The largest *unknown* was independent of the MVU question: every Loom design
pack is Handlebars emitting **markup strings**, and Feliz has no markup layer
— its "markup" is F# code. ✅ **That gap is now spiked and closed** (§7.1): a
`dotnet fable` → vite → headless-browser run proved procedurally-emitted Feliz
code compiles, bundles, and runs the MVU loop end-to-end. The format decision is
**procedural F# emission**, and the "Fable build + CI leg" is a working recipe.

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

## 2. The isomorphism claim — false against lambdas, now true for named actions

The external analysis argued *"Loom already models named, typed actions, so
the Elmish `Msg` union is a projection."* When this note was first written that
was false: page handlers were **anonymous lambdas**
(`{ kind: "lambda"; body?; block?: StmtIR[] }`) and page state a flat list of
independent cells (`StateFieldIR[]`, `loom-ir.ts` `StateFieldIR`) — the React
`useState` shape, not an Elmish `Model` record — so a `Msg` union had to be
**synthesized** (gensym a case per handler, thread a model), not projected.

**[Named actions](named-actions-and-stores.md) shipped, and now make the claim
true for the named subset.** The IR carries first-class handlers:

```ts
// src/ir/types/loom-ir.ts:287
export interface ActionIR { name: string; params: ParamIR[]; body: StmtIR[]; }
// PageIR.actions / ComponentIR.actions (loom-ir.ts:2364, 2434); StoreIR (loom-ir.ts:312)
```

So the projection is now a direct emit, no gensym:

- `action setCustomer(c: CustomerRef)` → `Msg.SetCustomer of CustomerRef`
- the action's `body: StmtIR[]` (a **purity-enforced** `:=`/`+=`/`let`/call/
  `navigate` block) → one `update` arm
- `state {}` (`StateFieldIR[]`) → the `Model` record; `store {}` (`StoreIR`) →
  a second `Model`/`update`/`Msg` triple
- the view references the action by name (`renderNamedHandler`,
  `src/generator/_walker/target.ts:569`) → `dispatch Msg.SetCustomer c`

The codegen-time hoist that forced HEEx to fork `walkBody`
(`hoistLambdaToHandler`) is, for named actions, **already done at IR time** —
the button carries an action *reference*, so the view collapses to "dispatch
`Msg.X`" and fits the shared walker. That is the structural change that moves
Elmish from flavor-(2)-is-a-mountain to flavor-(2)-is-an-increment.

### 2.2 The residual: anonymous-lambda pages

Named actions are **opt-in**, not mandatory — a page may still write inline
`onClick: () => { count := count + 1 }`. For a JSX target that inlines
identically; for MVU there is no inline effect position, so an anonymous-lambda
page is exactly the synthesis case the projection avoids. Three ways to close
it, cheapest first:

1. **Gate it.** A `loom.mvu-requires-named-action` validator on MVU-targeted
   `ui`s: any effectful handler must be a named `action`. Honest, zero codegen
   risk, and it makes the projection total by construction. The purity
   machinery named actions already ship (`loom.action-payload-mismatch`, the
   effect-freedom check) is the same shape.
2. **Auto-name in lowering.** A lowering pass that lifts each anonymous
   effectful page lambda into a synthesized `ActionIR` (gensym `Action_N`,
   infer the payload param from the call-site primitive) *before* codegen — so
   every backend, not just MVU, sees only named actions and the walker's
   inline-lambda arms become dead. This is the `hoistLambdaToHandler` logic
   moved from Phoenix codegen into shared IR, done **once**. Higher value
   (simplifies HEEx too) but a real IR pass with its own tests.
3. **Synthesize in the MVU emitter only.** Port HEEx's `event_N` gensym into
   the MVU walker for the lambda case. Lowest shared value, `event_N`-quality
   `Msg` names, and it re-introduces the per-target hoist named actions
   removed — **not recommended** except as a fallback for (1).

Recommendation (developed with a corpus census in §8): because every `.ddd`
file lives in this repo, the residual is ~4 files — so **eliminate the form**
(migrate them + a global lambda-purity invariant) rather than build a per-target
gate to tolerate it. §8 expands the trade-off.

### 2.1 Distance-to-MVU scorecard (per axis)

What is accurate is **faithful one-way projection** Loom → MVU, not strict
(bidirectional) isomorphism. Measured per MVU part:

| MVU part | Loom today | Distance | Status |
|---|---|---|---|
| **Model** (one record) | `StateFieldIR[]`, flat typed cells | ≈0 (cosmetic regroup) | **ready** — emit one record, no DSL change |
| **view** (`Model → Html`) | `body:` already pure over render primitives | ≈0 | **ready** — handlers reference a named action |
| **init** (Model + Cmd) | `state { x = init }` + mount-time data binds | small | **ready** — map mount binds to init `Cmd` |
| **Msg** (named, exhaustive union) | `ActionIR.name` + typed `params` | **was large** | **✅ shipped** — named actions |
| **update** (`(Msg,Model)→(Model,Cmd)`) | `ActionIR.body`, purity-enforced | medium | **✅ shipped** — direct emit off the body |
| **Cmd** — sync (`navigate`/`call`/`emit`) | reified statement forms in `ActionIR.body` | medium | **✅ shipped** — purity rule reifies them |
| **Cmd** — async outcomes (server state) | `match await op() { Ok o => … Err e => … }` | **was the residual gap** | **⚙ partial** — core + `await`-required enforcement shipped; only additive sugar pending |

Six of seven axes are at zero or **shipped** today: named actions closed Msg /
update / sync-Cmd (verified — `named-actions.test.ts` per target), and Model /
view / init were already there. The seventh — async effect outcomes — is **no
longer "unstarted/gated"** (an earlier draft said so): its **core primitive
`await` + `match await` has shipped on all five targets** (React/Vue/Svelte/
Angular + HEEx — `AwaitExpr` in the grammar, `variant-match` IR, `renderVariantMatch`
seam; HEEx renders it as a socket-piped `then/2`, `heex-walker-core.ts:1382-1440`).
That `match await` discriminates a remote op's `Result` union into `Ok`/`Err`
arms — precisely the flow that projects to Elmish `Cmd.OfAsync.either` → a
success/error `Msg`. The design is *decided* in
[named-actions §2.3 / §8.7](named-actions-and-stores.md) (reads derive the
remote-data union from `QueryView`; writes reuse `then:` + optional `onError`,
projecting to a `Result<T, E>` outcome `Msg`).

**`await`-required enforcement shipped** (Stage 2b): a bare remote mutating call
in an action body is now an **error** (`loom.missing-effect-marker`, was
`loom.action-requires-await`) — every remote call is explicitly awaited and its
`Result` matched, so the async→Msg projection has no invisible boundary. What
**remains** is additive sugar/composition, per
[`async-actions-and-effects.md`](async-actions-and-effects.md): `spawn`
(fire-and-forget), `onError`, `attempt {}` railway, `async` action composition —
**no grammar surface yet**.

So a **sync MVU target is buildable against `main` today**, and an **async** one
is closer than "gated" implied — its load-bearing primitive (`match await`)
ships on every target; the remainder is enforcement + sugar, not the core
mechanism. (`store` persistence stays deferred out of v1.)

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

### 3b. Real Elmish (MVU) — its dependency has landed

The reason HEEx forked `walkBody` is that LiveView must **discover anonymous
inline effectful lambdas during the markup walk and hoist them** into
`handle_event` (`heex-walker-core.ts` gensyms `event_${n}`). Elmish has the
identical requirement (hoist effects into `update`). Two consequences, **both
now dissolved by the shipped named-actions feature**:

1. **Synthesis → projection.** `ActionIR` carries the name + typed param, so
   `Msg` cases and `update` arms are a direct emit, no gensym — for any handler
   written as a named `action`.
2. **Codegen-time hoisting → IR-time hoisting.** Because actions are named and
   purity-enforced *in the IR*, the hoist is already done before codegen. The
   view collapses to "dispatch `Msg.X`" (trivial — fits the shared walker), and
   the `update` function is emitted from the `ActionIR` list. The exact
   structural mismatch that forced HEEx's parallel engine has moved out of
   per-target codegen and into the shared IR.

So Elmish ≈ 3a's effort **plus** a mechanical `update`/`Model`/`Msg` emitter
driven by `ActionIR`/`StoreIR` — an increment, not a mountain. The one caveat
is the anonymous-lambda page (§2.2): close it with the `loom.mvu-requires-named-
action` gate (cheapest) or the shared auto-name lowering pass (higher value).
The `event_N`-synthesis path is now only a **fallback**, not the baseline it
would have been before named actions shipped.

**Buildable-today scope:** everything except async `Cmd`s. A sync MVU target —
`Model`/`Msg`/`update` + `Cmd.none`/`navigate`/sync-`emit`, over the
named-action subset — has every IR input it needs on `main`. Async server-data
`Cmd`s wait on [`async-actions-and-effects.md`](async-actions-and-effects.md),
so v1 renders remote reads the way the pre-async DSL already does (the mount-time
data binds init already carries) and defers `Cmd.OfAsync` outcomes to that
follow-up.

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
system (Feliz shadcn / Bulma / DaisyUI) regardless. **This decision (a vs b) was
the highest-uncertainty, least-precedented piece — bigger than the walker.**
✅ **Resolved in favour of (b), procedural emission** — the §7.1 spike ran the
full `dotnet fable` → vite → browser pipeline on procedurally-shaped Feliz code
and it compiled, bundled, and booted (MVU loop working, zero errors). The format
question underneath the pack is settled; what remains is the pack's *breadth*
(~80 primitives), not its *mechanism*.

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

1. **Pack-format spike** — ✅ **done** (§7 type-surface + §7.1 full
   `dotnet fable` → vite → browser). Resolved: procedural F# emission (b), and
   the Fable build+bundle+runtime pipeline works end-to-end. The largest unknown
   is retired; the format decision is settled.
2. **Prototype `felizTarget: WalkerTarget`** against `walkBody`, gated by the
   same byte-output discipline the repo used for prior walker extractions —
   confirms the "fits more cleanly than Angular" claim empirically.
3. **Ship Feliz-with-hooks** if the value (type-safe F# + CI gate +
   .NET-shop differentiation) justifies the pack cost. Honest, low-risk.
4. ~~Land named actions~~ **✅ done** (Stage 1 + Stage 5 shipped) — real Elmish
   now falls out as a mechanical `update`-emitter over `ActionIR`/`StoreIR`. To
   make the projection *total*, land the standalone language-cleanup PR of §8:
   migrate the ~4 residual inline-effect files + a **global** `loom.effect-in-lambda`
   purity invariant (not an MVU-only gate). It stands on its own merits (retires
   HEEx's `event_N` hoist; uniform testable handlers) and MVU inherits totality
   for free. Async `Cmd`s track
   [`async-actions-and-effects.md`](async-actions-and-effects.md) separately and
   are **not** on the sync-MVU critical path.

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

**Scope of the first de-risk:** it validated the F# *type surface* and the MVU
projection only — it did not run Fable, nor exercise the React runtime / Vite
bundle / Playwright path. That gap is now closed by a second spike (§7.1).

### 7.1 Second spike — the full Fable→bundle→runtime pipeline (2026-07)

The remaining unknown (§3a's "Fable build + CI leg") is now **de-risked
end-to-end**. A throwaway spike hand-emitted the F# a Loom Feliz/Elmish generator
would project from a `page Counter { state { count } action inc()/dec() … }`
— `Model` from `state {}`, `Msg`/`update` one-arm-per-action (a projection, no
gensym), `view` from `body:` as a Feliz `Html.div [ … ]` — and ran the whole
pipeline:

1. **`dotnet fable` compiles it** — Fable **4.29.0** against Feliz **2.8.0** +
   Fable.Elmish.React **4.0.0** (net8.0 SDK container) emitted clean ES-module
   JS. The Feliz *code* markup lowered exactly as expected: `Html.div [ … ]` →
   `createElement("div", …)`, `prop.onClick (fun _ -> dispatch Inc)` →
   `onClick: () => dispatch(new Msg(0, []))`. So "Feliz markup is F# code, not a
   template" compiles through Fable with no special handling.
2. **Vite bundles it** — 64 modules transformed → a 174 kB bundle, `react` /
   `react-dom` the only npm deps (Feliz/Elmish ship as Fable-compiled F# under
   `fable_modules/`).
3. **It boots and the MVU loop runs** — served the bundle, drove it in headless
   Chromium via Playwright: `count` rendered `0`, two `+` clicks → `2`, one `-`
   → `1`, **zero page errors**. The dispatch → `update` → re-render cycle works
   in a real browser.

**Verdict:** the pack-format-critical bet is **confirmed** — *procedural F#
emission* (the §4/§7-recommended mechanism over Handlebars string templates)
produces output that compiles via Fable, bundles via Vite, and runs correctly as
MVU. No template layer is needed or wanted; the Feliz view is code all the way
down. The "Fable build + CI leg" is a known, working recipe (SDK container +
`--network host` proxy + CA trust for nuget; `dotnet fable` → vite → Playwright)
— it can be an actual CI gate, not a hoped-for one.

**What this still does *not* cover:** it exercised the sync `Model`/`Msg`/
`update`/`view` counter only — not the API/`Cmd.OfAsync` data layer, the design
pack's full primitive set (~80), or the `WalkerTarget`-vs-parallel-engine
question for the `view`. Those are the *build*, now standing on a proven runtime
floor; the format decision underneath them is settled.

## 8. The anonymous-lambda page — the residual, quantified

§2.2 named the one case the shipped named-action projection doesn't cover:
a hand-authored page that writes state inline (`onClick: () => { count := count + 1 }`)
instead of through a named `action`. Before choosing how to handle it, split the
lambda population — because most of it is a non-problem.

### 8.1 Two kinds of lambda; only one is the MVU problem

- **Pure value lambdas** — `.map`/`.filter` bodies, `List` column accessors,
  `Card`/row renderers, comparators, projections. They are expression-valued
  and effect-free, so they land on the shared walker's JSX branch and map
  straight to F# `List.map (fun x -> …)`. **Not an MVU concern.** These are the
  *only* lambdas scaffolding emits (`scaffold/_body-builders.ts` — every
  `lambda(...)` there is a `columnAccessor`/row renderer; there is not a single
  `:=`/`navigate`/`emit` in the file).
- **Effectful handler lambdas** — inline `onClick`/`onChange` bodies containing
  `:=`/`+=`/`navigate`/`emit`/a sync call. These are the residual. They have no
  MVU view position, so each must become a `Msg` + `update` arm.

The consequence is decisive for cost: **scaffolded UIs already have zero
effectful lambdas** — they route every mutation through declarative primitives
(`CreateForm(of:)`, `OperationForm(of:, op:)`, `WorkflowForm(runs:)`, `Button`
with a declarative nav), which the walker already lowers to named API/nav
calls. So the residual is confined to *hand-written* inline effect handlers — a
minority, and precisely the pattern Elm-style authoring discourages anyway.

### 8.1a The residual is empty enough to delete, not tolerate

There is no external `.ddd` corpus — **every Loom source that exists is in this
repo** (`examples/` + `web/src/examples/`). That removes the backward-compat
constraint that would normally force a *tolerant* strategy, so the first move is
to census the actual residual rather than design machinery for a hypothetical
one. Grepping the whole corpus for the only shape that breaks the projection —
a lambda block containing a state write (`=> { … := … }`) or an inline
effectful handler prop — turns up the complete list:

| File | Handler |
|---|---|
| `examples/svelte-shop.ddd:83` | `Button { onClick: e => { count := count + 1 } }` |
| `web/src/examples/storybook-components.ddd:134` | `Button { onClick: e => { clickCount := clickCount + 1 } }` |
| `examples/sales-ui.ddd:102,107,111` | `onSubmit: () => step := 1` (×3) |

That is the entire population. Every *other* `:=` in the corpus is backend
domain logic (aggregate `operation`/`create`/`apply` bodies) or already inside a
named page/store `action` (`action bump() { count := count + 1 }`); every other
page-body `=>` is a pure value lambda. And the correct form already ships and
coexists in the same files (`Button { onClick: reserveNow }`,
`Button { onClick: addOne }`). So the residual is ~4 files, a handful of
handlers, each with an obvious name — a 20-minute mechanical migration, not a
compatibility surface.

### 8.2 Four dispositions, most-faithful to least

0. **Functional-update escape hatch.** Add one catch-all `Msg.Patch of (Model → Model)`
   and lower each anonymous effect lambda to `dispatch (Patch (fun m -> { m with … }))`.
   Zero synthesis, compiles today — but it **discards exhaustiveness and the
   testable-`update` payoff**, i.e. the entire reason to pick MVU. Keep it as a
   safety valve, never the default.
1. **Eliminate the form — a *global* purity invariant (`loom.effect-in-lambda`).**
   Not an MVU-only gate. Migrate the ~4 residual files to named actions (§8.1a),
   then make "a lambda body is pure; an effect (`:=`/`+=`/`navigate`/`emit`/a
   sync mutating call) must live in a named `action`" a validation error for
   **every** target. This is the strongest option precisely because we own the
   whole corpus: it does not *tolerate* the inline-effect lambda, it *removes* it
   from the language, so the projection is total for MVU **and** the language
   gets smaller and more uniform (one way to write an effect handler, everywhere).
   Two payoffs no per-target gate delivers: **HEEx's `event_N` hoist
   (`hoistLambdaToHandler`) becomes dead code** — nothing can reach it — and
   *every* frontend inherits named, unit-testable handlers. Reuses the purity
   machinery named actions already ship (`loom.action-payload-mismatch`, the
   effect-freedom check). **Recommended — SHIPPED** (`loom.effect-in-lambda`,
   §8.3). (Contrast the MVU-scoped variant `loom.mvu-requires-named-action`:
   same effect, but makes MVU stricter than its siblings — a per-target wart with
   no upside once the corpus is migrated.)
2. **Auto-name lowering pass.** An IR→IR normalization that lifts each effectful
   page/component lambda into a synthesized `ActionIR` before codegen: derive
   the `Msg` name from the single write target when the body is one assignment
   (`count := …` → `SetCount`), gensym `Action_N` for multi-statement bodies;
   infer the payload param from the call-site primitive (the walker already
   computes this via `positionalArgs`/`describeReceiver`); route genuinely-async
   bodies to the `loom.action-requires-await` gate. This is the
   `hoistLambdaToHandler` logic moved **out of Phoenix codegen and into shared
   IR, done once**. It was the recommended baseline when the residual looked
   large; with the census in §8.1a showing it is ~empty, its *bridge* value is
   gone (nothing to auto-name), and it survives only as **optional cleanup** if
   one later decides to keep inline-effect authoring legal after all — a
   deliberate reversal of (1), not a default. Keeps `.ddd` source unrewritten
   (`unfold` unaffected).
3. **Per-target `event_N` synthesis in the MVU walker.** Port HEEx's gensym into
   the MVU emitter for the lambda case. **Rejected** — it re-introduces the
   per-target hoist named actions just removed, and yields `event_N`-quality
   `Msg` names. Only reachable as option 0's uglier cousin.

### 8.3 Recommendation — ✅ SHIPPED

**Delete the form, don't tolerate it (option 1).** Because there is no external
corpus, the tolerant strategies (a per-target gate, an auto-name bridge) solve a
problem the census says is ~empty. The cheaper *and* cleaner move is to migrate
the ~4 residual files to named actions and make lambda purity a **global**
invariant. The projection becomes total for MVU as a side effect of a language
simplification that stands on its own merits — one effect-handler form
everywhere and uniform testable handlers across all frontends. (Retiring HEEx's
`event_N` hoist is a *further* step that the effect-only gate does **not** reach
— see §8.4.) This is a decision that is only available *because* all Loom code is
in-repo; spend that leverage here rather than banking machinery to preserve a
form nobody depends on.

**Landed** as a standalone language-cleanup ahead of any Fable work (2026-07,
code-verified): the four residual files (`svelte-shop.ddd`,
`storybook-components.ddd`, `sales-ui.ddd`) are migrated to named actions, and
the global `loom.effect-in-lambda` invariant is enforced in
`src/ir/validate/checks/ui-checks.ts` (`checkLambdaPurity`, fired from
`checkBody`'s `lambda` arm — an `action` body is walked via `checkActionBodies`
and never reaches it, so effects there are untouched). Tests in
`test/ir/named-action-refs.test.ts`. The walker keeps its inline-handler
rendering for now (exercised directly by the generator unit tests, which bypass
`validateLoomModel`); retiring that path + HEEx's `hoistLambdaToHandler` is the
optional follow-up **(2)**. **(0)** stays a documented escape hatch; **(3)**
stays rejected. MVU now inherits a total sync projection for free.

### 8.4 The shipped gate is effect-only — it does NOT strand HEEx's `event_N` (verified)

A common shorthand (including an earlier draft of §8.3) is that the cleanup
"retires HEEx's `event_N` hoist." A direct probe shows that is **not** true of
what shipped, and the distinction matters. `loom.effect-in-lambda` rejects only
*effectful* inline lambdas — a block containing `:=`/`+=`/`-=`/`emit`/`call`/
`variant-match`, or a single-expression `navigate`/`toast`. It does **not**
reject anonymous **call-shaped** handler lambdas, of which the idiomatic
api-hook form submit is the prime example:

```ddd
CreateForm { of: Order, onSubmit: v => create.mutateAsync(v) }   // still ALLOWED
```

(verified: `validateLoomModel` returns no `loom.effect-in-lambda` for it).
Because that lambda is anonymous, LiveView still needs a synthesized
`phx-submit` name, so it still routes through `hoistLambdaToHandler`
(`heex-walker-core.ts:1060 → :1199`) and still gets an `event_N`
(`heex-walker-core.ts:1209`). The block path stays live for pure/call-only block
handlers, and `renderStmt` is shared with the *named-action* hoist
(`heex-walker-core.ts:346-351`) regardless — so there is no separable dead arm
to trim. The walker branches on lambda **shape** (block vs single-expression),
not effect-vs-pure.

**Consequence:** retiring `event_N` needs the *stronger* rule — reject **every**
handler-slot lambda, forcing named actions even for the call-shaped case — i.e.
disposition **(2)** applied not just to effects but to all handler lambdas. That
change breaks the idiomatic `onSubmit: v => create.mutateAsync(v)` pattern
(hand-authored; scaffolds emit declarative forms, so they are unaffected), which
is real ergonomic cost. Left **not done** deliberately: the pure-view win that
MVU needs is already banked by the effect-only gate; `event_N` is a Phoenix
codegen detail whose removal isn't on the sync-MVU critical path.

### 8.5 Regression caught while auditing the retirement

The retirement audit surfaced (and fixed) an over-broad bug in the shipped gate:
`checkLambdaPurity` fired on *every* lambda in a body, including the effect
lambda a caller passes to a component's `action(Order)` param — the
extern-component Tier 2 behaviour callback
([`extern-component-escape-hatch.md`](extern-component-escape-hatch.md) §3),
which legitimately walks the caller's scope. The full suite missed it because
the generator tests bypass `validateLoomModel`. Fixed with a slot-scoped
exemption (`componentActionParams` → `exemptLambdas` in
`src/ir/validate/checks/ui-checks.ts`) + regression tests; the exemption is
slot-specific, so a stdlib `Button.onClick` in the same page is still gated.

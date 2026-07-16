# Extern components — an escape hatch for hand-written frontend code

> Status: **PARTIAL — Tiers 1 + 2 (React) implemented.** The `component …
> extern from "<path>"` surface, IR/lowering, validator, and the React
> generator (props-interface emit + re-export shim) shipped first (see §8
> "What shipped"); **Tier 2 (`action` behaviour params) shipped after**:
> the `action` / `action(Order)` param type (the token choice from §11 —
> mirrors bare `slot`), position validator (`loom.action-out-of-position`,
> `loom.action-nested-marker`), TypeIR/DddType variants, props emit
> (`(arg: OrderResponse) => void`, `action?` → optional), and the
> call-site lambda walked in the caller's scope (state writes hit the
> caller's setters; the lambda param stays bound and typed via
> `paramTypes`).  **Frontend fan-out SHIPPED (2026-07-16, code-verified):**
> `component extern` now emits a real binding on **all five frontends +
> HEEx** — Vue/Svelte re-export shims, Angular `ngComponentOutlet`, Feliz
> record invocation, and a genuine LiveView `<.live_component module={…}>`
> (`elixir/heex-walker-core.ts`).  The §6 `loom.extern-component-framework-mismatch`
> gate proved unnecessary and was **not** built — every framework got a real
> binding, not a rejection.  Still designed-not-built: Tier 2 `action`
> behaviour params (pulled by a concrete widget, §4 staging). This note designs a UI-side analogue of the backend's
> `operation … extern` escape hatch: a way to drop a **hand-written
> React/TSX (or HEEx) component** into a Loom page body, type-checked
> against the domain, wired into routing / state / data, without forking
> the generator. It catalogues the design space, recommends one shape,
> and sketches the pipeline work against the real code.

## TL;DR

The walker component library is **closed** (`src/generator/_walker/registry.ts`).
Page and component bodies may only use registered primitives, user
`component`s (which themselves compose only primitives), `slot` params, and
`import helper` (plain TS *functions*, not components). There is no way to
render a bespoke widget — a chart, a third-party calendar, a canvas, a
vendored design-system component — and still have Loom type-check it against
aggregate data and own its routing/state.

The backend already solved the structurally identical problem. `operation …
extern` emits a **typed seam** (a handler interface / registry) plus a
**fail-fast check**, and the user owns the implementation in a hand-written
file (`docs/extern.md`). We propose the same move for the frontend:

```ddd
ui WebApp {
  // declared like a component (typed params), but Loom emits no body —
  // it imports the user's file and renders <PriceChart .../> at call sites.
  component PriceChart(series: Order[], height: int) extern from "./widgets/price-chart"

  page Dashboard {
    route: "/dashboard"
    body: Stack {[
      Heading { "Revenue", level: 2 },
      PriceChart { series: Orders.all, height: 320 }   // ← hand-written TSX, typed call site
    ]}
  }
}
```

Loom generates **one thing** — a typed props interface derived from the
params' wire shape — and **imports the user's component from the declared
path**, a file Loom never writes (exactly like an `import helper` target). The
call site marshals domain data into the component; `tsc` against the generated
project is the fail-fast gate (a missing or mismatched component is a compile
error). The declared param list is the contract, exactly as the `extern`
operation's parameter list is the contract for its request DTO.

**No stub, no write-once, no first-run magic.** Loom's regen contract is
*"every file Loom generates is overwritten on every run"* (`docs/tools.md:96`),
and the companion principle is that there is deliberately no "written the first
time, skipped the second" mode (`docs/tools.md:119`). A write-once stub would
violate exactly that, so this design has none: the only generated artefact (the
props type) is *always* regenerated, and the user's component is *never*
generated — it is ordinary hand-written code Loom resolves by import. The
type-checker, not a seeded file, is what tells you the component is missing.

## 1. The defect — a closed library with three half-hatches

The walker stdlib is a fixed set (`WALKER_LAYOUT_PRIMITIVES` /
`WALKER_SUB_PRIMITIVES` / `WALKER_SCAFFOLD_PRIMITIVES`,
`src/language/walker-stdlib.ts:31–115`), mirrored by the dispatch registry
(`src/generator/_walker/registry.ts:196–367`) and pinned drift-tested
(`test/language/walker-stdlib-completeness.test.ts`). The page-metamodel RFC
states the intent plainly: *"The standard component library is closed in v0…
No user-extensible macros"* (`docs/page-metamodel.md:27–31`, §9 line 326).

That is the right default — it is what makes one page-set render to both TSX
and HEEx through `WalkerTarget` (`src/generator/_walker/target.ts:144–276`).
But it means **any UI need outside the library forks the generator in
TypeScript** — the exact pain the page metamodel was created to remove
(`docs/page-metamodel.md:13–18`). Today there are three partial workarounds,
none of which covers "render my own component":

| Hatch | Surface | What it admits | What it can't do |
|---|---|---|---|
| **`import helper X from "p"`** | `ddd.langium:298`, IR `UiHelperImportIR` (`loom-ir.ts:1208`) | a plain TS **function**, called in JSX as `{x(args)}` (`body-walker.ts:679`); import rendered per-framework (`tsx-target.ts:164–185`, `heex-target.ts:100–116`) | not a **component** — no JSX element, no children, no hooks, no props contract |
| **`slot` params** | `SlotType` (`ddd.langium:1138`), `TypeIR {kind:"slot"}` (`loom-ir.ts:99`) | caller passes any **walker expression** into a component, walked in the caller's scope | still confined to the **closed primitive set** — a slot can't be hand-written TSX |
| **user `component`** | `Component` (`ddd.langium:471`), `ComponentIR` (`loom-ir.ts:1351`), emitted to `src/components/<Name>.tsx` (`pages-emitter.ts`) | a reusable region tree with its own state | its body is **walked**, so it too may only compose primitives |

The gap is exactly the union these three miss: a **JSX/HEEx element, with a
typed props contract, whose body Loom does not generate.**

## 2. The pattern to mirror — `operation … extern`

The backend hatch is the template. Walking it (`docs/extern.md`, code anchors
below) reveals a four-part shape worth copying wholesale:

1. **A one-token modifier** on an otherwise-normal declaration —
   `(extern?='extern')` on `Operation` (`ddd.langium:1008`), surfaced as
   `OperationIR.extern: boolean` (`loom-ir.ts:245`), threaded in lowering
   (`lower.ts:1994`).
2. **A body constraint** enforcing "the framework owns the plumbing, the user
   owns the decision" — extern op bodies may contain **only** preconditions
   (`validate.ts:327–374`).
3. **A generated typed seam** — TS emits `domain/<agg>-extern.ts` with a
   per-op `Request` type, a `Handler` function type, a registry, a
   `register…Handler` helper, and a `verify…Registered()` gate
   (`src/generator/typescript/extern-builder.ts:1–120`); .NET emits an
   `I<Op><Agg>Handler` interface (`dotnet/cqrs-emit.ts:404–475`).
4. **A runtime fail-fast check** that screams on a missing impl — TS
   `verify…Registered()` called at startup, .NET a Scrutor scan + `Program.cs`
   resolution check (`dotnet/emit/program.ts:84–114`).

   Note what the backend does *not* do here: the `DevStub`/no-op handlers are
   **regenerated every run** into machine-owned locations, and **DI/registry
   indirection** (Scrutor picking the user's `[ExternHandler]` class; a
   `register…Handler` call overriding the no-op after import) selects the user's
   real implementation over the stub. The stub is not a write-once seed — it is
   an always-regenerated default that an indirection layer routes around.

The frontend analogue maps cleanly, with one deliberate simplification:
**(1)** an `extern` modifier on `component`; **(2)** the body constraint
becomes "an extern component declares *no* `body:`"; **(3)** the typed seam is
a generated props interface (from the params' wire shape). For **(4)** the
frontend has **no DI/registry indirection** — an `import` resolves to exactly
one file — so there is nothing for a regenerated stub to be routed around.
Rather than invent an indirection layer just to host a stub, we drop the stub:
the component is a compile-time import, and **the type-checker is the
fail-fast** (`tsc`/`mix` errors on a missing or mismatched component). This is
strictly simpler than the backend and avoids any first-run-magic file (§7).

## 3. The design space

Four candidate shapes, ordered by how much Loom knows about the foreign code.

### Option A — generalise `import helper` to components (thinnest)

Add `import component X(params) from "p"`. The walker dispatches `X { … }` as a
JSX element instead of a function call. The declared params give Loom a type
to check call sites against and to marshal data into. Loom **never** generates
or stubs the file; it only imports it.

- **Pros:** smallest surface; reuses the helper-import plumbing
  (`tsx-target.ts:164` already renders imports; `body-walker.ts` already routes
  user-component call sites to `emitUserComponent` in
  `walker/primitives/controls.ts:343`). No new file-emission path at all — Loom
  writes nothing.
- **Cons:** no generated props type, so the user hand-types the props interface
  and keeps it in sync with the domain manually — a domain change won't surface
  as a type error at the component boundary.

### Option B — `component … extern` with a generated props interface (the extern-op mirror, no stub) — **recommended**

Declare it like a component (so params type-check identically), mark it
`extern`, point it at a path:

```ddd
component PriceChart(series: Order[], height: int) extern from "./widgets/price-chart"
```

Loom owns and emits **exactly one** file, and writes nothing the user owns:

- `src/components/extern/PriceChart.props.ts` — `export interface
  PriceChartProps { series: OrderWire[]; height: number }`, **derived from the
  params' `wireShape`** and regenerated every run (machine-owned, like the
  extern-op `Request` type). This is the contract.
- the user's `./widgets/price-chart` is **never generated** — Loom imports it
  (`import { PriceChart } from "../extern/PriceChart.props"` for the type,
  `import { PriceChart } from "./widgets/price-chart"` for the component), and
  the user writes it as ordinary code: `export function PriceChart(props:
  PriceChartProps) { … }`.
- call sites render `<PriceChart series={…} height={…} />` with props typed by
  the generated interface.

- **Pros:** truest *spirit* of `operation extern` — a generated, regenerated,
  IR-tracking typed seam — without the stub. The props interface tracks
  `wireShape`, so a domain change surfaces as a `tsc` error in the user's
  component (fail-fast, type-safe). Respects the no-first-run-magic contract:
  one always-regenerated file, nothing user-owned ever written (§7).
- **Cons:** one real new emission path (the props file) per framework. No
  "boots empty" — but that's a feature, not a gap: a missing component is a
  compile error, which is precisely the fail-fast we want, and seeding a file to
  paper over it would reintroduce the first-run magic the user explicitly
  rejected.

Option B is **Option A plus the generated props file** — same grammar, same
call-site dispatch, same zero user-owned writes; the only delta is that Loom
emits the typed contract instead of asking the user to hand-maintain it.

### Option C — `raw tsx` / `raw heex` literal block (the trapdoor)

A verbatim template block with typed interpolation:

```ddd
body: Stack {[
  Heading { "Orders" },
  raw tsx """ <PriceChart series={${orders}} height={300} /> """
]}
```

- **Pros:** ultimate flexibility, zero ceremony.
- **Cons:** **rejected.** No type contract; framework-specific by construction
  (you'd need `raw heex` too, defeating the framework-neutral metamodel);
  bypasses the walker entirely so it cannot be page-object-tested or
  parity-checked; and it punches a hole in the byte-identical-output gates the
  walker refactor was built on (`CLAUDE.md` → the WalkerTarget seam history).
  Documented here only to be explicitly declined.

### Option D — interactive extern components (**required, in v0**)

A read-only widget is not enough — an escape hatch must let hand-written
components *drive domain interactions*, while Loom still owns dispatch (the user
never writes `fetch`, never re-derives a request shape, never hand-rolls the
load→check→mutate→assert→save lifecycle). So D is **not** an add-on layered on
B; it is part of the v0 design. It comes in two tiers, both built on machinery
that **already exists**.

**Tier 1 — `slot` props (fully specified; reuses slots verbatim).** The page
metamodel already lets a `slot` param receive *any* walker expression —
including a **fully-wired `Action { order.confirm, then: navigate(…) }`** — and
walks it in the **caller's** scope (`docs/page-metamodel.md:194–222`,
`loom-ir.ts:99`). The only gap for an *extern* component is the last inch:
instead of the walker rendering the slot inline, Loom emits the walked slot as a
`React.ReactNode` prop the hand-written component drops wherever it likes
(`{props.primaryAction}`). Because the slot is walked before it's handed over,
it arrives **already wired** — the mutation hook, the `then:` navigation, the
toast are all Loom's, inherited for free. This alone covers most interactivity:
"here is my custom card; put *this* confirmed-and-then-navigate button in it."

```ddd
component OrderCard(order: Order, primaryAction: slot, footer: slot?) extern from "./widgets/order-card"

page OrderDetail(order: Order) {
  route: "/orders/:id"
  body: OrderCard {
    order,
    primaryAction: Action { order.confirm, then: navigate(Home) },  // Loom-wired, passed as a node
  }
}
```
→ props gain `primaryAction: React.ReactNode; footer?: React.ReactNode`.

**Tier 2 — `action` props: pass a *behaviour* (the component fires it).** When
the *component* decides when and with what arguments to act — a custom canvas
where clicking a region confirms that order, a chart with selectable points, a
keyboard shortcut — a slot isn't enough: the component needs a **callable**, not
a rendered element. The temptation is an operation-bound param like `confirm:
action of Order.confirm`, but that invents a new, op-specific binding form that
nothing else in the language uses, and it only reaches operations (not
navigation, toasts, state writes, or a sequence of them).

The general primitive **already exists**: a **block-body lambda** — the very
`onSubmit: c => { draft.x := c.x; step := 1 }` form the page metamodel ships
(`docs/page-metamodel.md:290–304`, §8). Its body is the ordinary statement
grammar (`call`, `o.confirm()`, `navigate(…)`, `toast(…)`, `state := …`), walked
and **hoisted in the caller's scope** exactly as `onSubmit` is. So Tier 2 is not
a new binding syntax — it is just *"a lambda is a passable prop."* We add one
generic param type, `action` (the function-valued sibling of `slot`'s
element-valued), and the caller hands it any lambda:

```ddd
component OrderGrid(orders: Order[], onPick: action) extern from "./widgets/order-grid"

page Orders {
  body: OrderGrid {
    orders: Sales.Order.all,
    onPick: o => { o.confirm() }     // block-body lambda; Loom hoists confirm's mutation hook
  }
}
```
→ props gain `onPick: (order: OrderWire) => void`; the component calls
`props.onPick(o)` from its own handler. Whatever the lambda body contains —
an op call (lifecycle hoisted via `renderApiHoisting` / `buildHookUse`,
`target.ts:169–217`; `controls.ts:343`), a `navigate(…)` (`target.ts:244–267`),
a `toast(…)`, a `state :=`, or a sequence — resolves by the **same rules that
already type-check `onSubmit`**. Nothing op-specific, nothing new but the param
type and its argument-type spelling.

This is strictly more general than `action of …` *and* less new surface — it
reaches every behaviour the statement grammar can express, not just operations,
and reuses the block-body-lambda path verbatim. `slot` carries elements;
`action` carries behaviours; both are walker expressions marshalled across the
props boundary and walked in the caller's scope. That symmetry is the whole of
Tier 2.

Tier 1 is fully specified by existing slot semantics. Tier 2's only genuinely
new surface is **how the param declares the lambda's argument types** — and it
is declared **explicitly**, never inferred from call sites: Loom types
declarations and checks uses against them (lambda param types flow *forward*
from the expected type, `type-system.ts:417` — *"Lambda type is contextual;
without a target type it's unknown"*), so a component param's signature cannot
depend on its callers. The behaviour's arg types are therefore written on the
param, e.g. `onPick: action(Order)` (an `action` type constructor parameterised
by its args, paralleling bare `slot`) or the arrow `onPick: (Order) => action`.
That token choice is the only open question (§11); the *mechanism* is the
already-shipped block-body-lambda + action-hoisting path.

## 4. Recommended shape

The v0 design is **B + D**: the generated-props import hatch (B) **with
interactivity built in** (D) — extern components are wired controls from day
one, not read-only widgets. **A** (import-only, no generated props) is a useful
*first increment* on the way to B if we want to land the grammar and call-site
dispatch before the props emitter. **C is rejected.** Nothing in any shipped
step generates a user-owned file, so there is no stub and no first-run magic.

Concretely, v0 = B's grammar/props/dispatch **+ D Tier 1** (slot props →
`ReactNode`, fully specified by existing slot semantics, React only). **D Tier
2** (`action` behaviour params) is **designed here but deliberately deferred** —
see the staging subsection below for why; the short version is that it would add
the *first function type* to Loom's type system, a real investment that should
be pulled by a concrete widget rather than built speculatively.

Rationale: B reproduces the properties that make `operation extern` good that
*translate* to a compile-time import — a typed seam, a body constraint, and a
generated IR-tracking contract — while dropping the one that doesn't (a
regenerated stub behind DI indirection, which the frontend has no place to put;
see §2.4). Tier 1 is what makes the hatch *useful* on day one: a caller passes a
fully-wired `Action{…}` into a slot, so the hand-written component hosts a real,
clickable, domain-wired control with **zero new machinery**. That is genuine
interactivity, not a read-only widget. C loses type-safety and framework
neutrality, the two invariants the metamodel protects.

### Recommended delivery (staging)

The design above is the destination. The advice on *how to get there* — and what
to resist — is:

1. **Pressure-test on paper first.** Before any code, hand-write both the `.ddd`
   declaration and the hand-authored `.tsx` for **one real widget** (a revenue
   chart is the obvious candidate). This 20-minute exercise validates the props
   shape and, crucially, reveals whether **slot-only is already enough** — which
   is what decides how near or far Tier 2 really is.
2. **Ship Tier 1, React only, as the v0 PR.** `extern` on `component` + the
   `wireShape` props-interface emitter + the import redirect + slot pass-through.
   This reuses `slot`, block-body lambdas, and action hoisting wholesale; the
   only genuinely new code is the props emitter and the import wiring.
3. **Gate it on the right test.** The feature's whole value is *"rename
   `Order.placedAt` in `.ddd` ⇒ the user's `.tsx` fails to compile."* A
   `LOOM_REACT_BUILD=1` test asserting exactly that — a domain change breaks the
   build at the extern component's props boundary — is the gate that matters far
   more than the parse/validator tests. If that link is loose, the props type
   goes silently stale and the hatch degrades into a ceremonious `import helper`.
4. **Do not ship Option A as the end state.** A (no generated props, user
   hand-types the interface) discards the `wireShape` type — the type-safety that
   is the entire reason to do this inside a typed DSL. Use it only as a
   grammar-derisking step if needed; B-Tier-1 is close enough in effort to go to
   directly.
5. **Defer Tier 2 (`action`) until a widget demands it.** It introduces Loom's
   first function-typed value (rippling into the type system, validator, printer,
   lowering) and only buys the narrower "component fires it with computed args"
   case (chart hit-test, canvas, shortcut). Build it holding the real widget that
   needs it — that widget also settles the `action(Order)` vs `(Order) => action`
   token (lean `action(Order)`: Loom has no arrow *types*, and a void behaviour
   has no return slot to spell). Until then, leave the grammar designed but
   unimplemented and reject an `action` param with a clear "not yet" diagnostic.
6. **Defer LiveView (§6) the same way.** The per-framework binding is designed,
   but a second `<.live_component>` backend is a real implementation for a much
   smaller payoff. v0 is React-only; a `liveview`-reached extern is a clean
   validator error (`loom.extern-component-framework-mismatch`), not a
   half-emitted stub.

The meta-point: the spec is no longer where the risk lives — the cuts made
during review (no stub, no `action of`, no call-site inference) removed it. The
remaining risk is purely one of *scope discipline*: ship the cheap, high-value
80% (Tier 1, React) and let real usage pull the expensive 20% (Tier 2, LiveView)
rather than building all of it up front.

## 5. The data contract — props are `wireShape`-typed

The param list is the seam, and `wireShape` is what it lowers to. An aggregate
param (`series: Order[]`) becomes the same DTO type the React generator
already emits for that aggregate — Loom's enrichment pass computes
`agg.wireShape` precisely so *"cross-backend wire compatibility is structural,
not coincidental"* (`CLAUDE.md` → enrichments). The props-type emitter reuses
the existing wire-DTO TS emitter rather than inventing a parallel type. Param
kinds and their props types:

| Param type | Props type (TSX) | Marshalling at call site |
|---|---|---|
| primitive (`int`, `string`, `bool`, `decimal`) | `number` / `string` / `boolean` | literal or in-scope ref, `{expr}` |
| `T` / `T[]` (aggregate) | `TWire` / `TWire[]` (the wire DTO) | the loaded record / query result |
| `T id` | the id's wire type | route param / state field |
| value object | its wire shape | object literal |
| `slot` / `slot?` (D Tier 1) | `React.ReactNode` (`?` → optional) | an **element** — any walker expr, incl. a wired `Action{…}`, walked in caller scope (`loom-ir.ts:99` slot semantics) |
| `action` / `action?` (D Tier 2) | `(args) => void` | a **behaviour** — a (block-body) lambda; its statements (`o.confirm()` / `navigate` / `toast` / `state :=`) walked & hoisted in caller scope, exactly as `onSubmit` (`docs/page-metamodel.md:290`) |

The first four rows are pure *data in*; `slot` and `action` are *interaction
out* — and both lower through machinery that already exists (slots; block-body
lambdas; action hoisting), so the user's hand-written component receives
ordinary wire DTOs, ordinary `ReactNode`s, and ordinary typed callbacks. This
is exactly the discipline backends already follow — *"Backends never
re-resolve… read `agg.wireShape` directly"* (`CLAUDE.md`) — and the same
element-vs-behaviour split React's own props model uses.

## 6. Cross-framework — react vs liveview

A hand-written **React** component cannot be served by a `phoenixLiveView`
deployable, and vice-versa. Two consequences:

1. **The hatch is framework-shaped.** An extern component must resolve to a
   binding for the hosting `ui`'s framework. v0: it inherits the ui's
   framework (today derivable from the deployable platform; under
   `embedded-frontend-composition.md` it would be `ui { framework: … }`), and
   the validator rejects an extern component reached by a ui of a different
   framework.
2. **Optional per-framework variants** mirror the `WalkerTarget` fork that
   already exists for every primitive (`tsx-target.ts` vs `heex-target.ts`):

   ```ddd
   component PriceChart(series: Order[]) extern {
     react    from "./widgets/price-chart"
     liveview from "PriceChartLive"      // a LiveComponent module
   }
   ```

   React → `import { PriceChart } from "./widgets/price-chart"` +
   `<PriceChart .../>`; LiveView → `alias`/`import` + `<.live_component
   module={PriceChartLive} .../>` (the HEEx import path
   `heex-target.ts:100–116` already turns a path into an Elixir alias). This is
   why the "registration" is the compiler, not a runtime registry: each
   framework's native module system *is* the binding, and its type/compile
   check *is* the fail-fast gate.

This dovetails with `embedded-frontend-composition.md` (framework as a
first-class `ui` property): once framework lives on `ui`, the validator rule
becomes a one-line membership check against the ui's framework.

## 7. File ownership across regeneration

Loom's contract is *"every file Loom generates is overwritten on every run"*,
with a deliberate *"no seed / no first-run magic"* corollary
(`docs/tools.md:96, 119`). This design honours both by **never writing a
user-owned file at all** — the ownership split is total, not negotiated:

- **Machine-owned, always regenerated:** `…/extern/PriceChart.props.ts` — the
  props interface. It lives *inside* the generated tree and is overwritten
  every run, exactly as the contract demands. The user never edits it.
- **User-owned, never generated:** `…/widgets/price-chart.tsx` — Loom only
  *imports* this path; it is not in Loom's write set, so there is nothing to
  pin, nothing to skip, and no `write`-vs-`skip` decision to make. It is in
  precisely the same position as an `import helper` target today: a path the
  user owns and Loom references.

So `.loomignore` is **not needed for the component** (there is no generated
file to exempt). The only thing Loom writes is the always-regenerated props
type — which is correct to overwrite — so there is no first-run-magic file
anywhere in the design. If the import path points at nothing, `tsc`/`mix`
fails: the fail-fast, with zero seeded state.

> A starting template, if ever wanted, must come from a **deliberate** action —
> e.g. a `ddd scaffold-extern <Name>` CLI command the user runs on purpose
> (the `ddd snapshot` model: explicit, not a side effect of `generate`) — never
> from `generate` silently seeding a file on first run.

## 8. Implementation sketch (the `docs/technical.md` recipe)

Following the canonical "adding a language feature" recipe
(`CLAUDE.md` → Extending):

1. **Grammar** (`src/language/ddd.langium`): add `(extern?='extern' ('from'
   path=STRING)? )?` to `Component` (~`:471`), or the per-framework block of
   §6. `npm run langium:generate`. (Guarded by `langium-generated.yml`.)
2. **Validator mirror** (`src/language/walker-stdlib.ts` /
   `src/language/validators/ui.ts:48`): an extern component is **name-resolvable
   like a user component** in `isWalkableLayoutBody`
   (`body-walker.ts:240–267`) — it is admissible in source positions but is not
   a stdlib primitive. Add the rules in §9.
3. **IR** (`src/ir/types/loom-ir.ts`): `ComponentIR` (`:1351`) gains `extern?:
   boolean`, `externBindings?: { framework: string; path: string }[]`. Body
   becomes optional for extern. Params already carry `slot` (`TypeIR` `:99`);
   add one generic `action` (behaviour/lambda) param kind for D Tier 2 — not an
   op-specific binding.
4. **Lower** (`src/ir/lower/lower.ts` `lowerUi`/component lowering, ~`:1000`):
   thread the flag + bindings; type-check params via the existing param
   resolution (no expression lowering — extern has no body). `slot` args and
   `action` (lambda) args are lowered in the **caller's** scope exactly as slots
   and block-body lambdas already are — no new lowering path.
5. **React generator:**
   - `pages-emitter.ts`: when `component.extern`, **skip**
     `renderUserComponentFile` (`page-shell.ts:502`) — Loom emits no component
     body. Instead emit **only** the props interface from `wireShape` (plus the
     D Tier-1 `ReactNode` and D Tier-2 callback prop types) into
     `…/extern/<Name>.props.ts`. Nothing user-owned is written; there is no stub.
   - `body-walker.ts` (`:670–692`) + `controls.ts` `emitUserComponent`
     (`:343`): **already** emit `<Name .../>` JSX, register the import, walk slot
     args in caller scope, and hoist aggregate-op mutations — extern reuses this
     path verbatim, pointing the component import at the declared path instead of
     `src/components/<Name>`, adding the props-type import, and passing walked
     slots / hoisted callbacks as props instead of inlining them.
6. **Phoenix generator** (`src/generator/phoenix-live-view/`): emit
   `<.live_component>` for an extern with a `liveview` binding; the
   `heex-target` import seam (`:100`) handles the alias. **Reject** a
   React-only extern reached by a LiveView ui (validator, §9) rather than
   emit a placeholder.
7. **Tests** (`CLAUDE.md` test layout): one parsing test; negative validator
   tests (§9); one React generator test (component + props imports emitted,
   props file shape, **no user-owned file written** — assert the generator's
   output `Map` contains the props path and *not* the component path); a
   `LOOM_REACT_BUILD=1` run proving the generated project `tsc`s with a real
   hand-written component; a Phoenix variant gated on `LOOM_PHOENIX_BUILD=1`.

The heavy lifting (JSX call-site emission, import registration, per-framework
import rendering) **already exists** — this feature is mostly a new
*declaration shape* plus a *props-interface emitter*, not new walker
machinery and not a new file-protection path.

### What shipped (Tier 1, React)

The implementation took one deliberate simplification over the sketch above:
**instead of redirecting the call-site import** (which would thread an
`externComponents` map through every emitter signature), Loom emits a tiny
**re-export shim** at the component's normal `src/components/<Name>.tsx` slot:

```ts
// AUTO-GENERATED extern component shim.
export { default } from "../widgets/order-chart";   // ← the `from` path, src-relative
export type { OrderChartProps } from "./OrderChart.props";
```

Call sites (pages, components, layouts) therefore keep importing
`components/<Name>` **unchanged**, the walker stays **completely untouched**, and
the shim forwards to the hand-written module. This also decouples the stable
internal name (`components/<Name>`) from the user's file location. Loom owns the
shim **and** `<Name>.props.ts` (both always regenerated); the user owns the
target module (never written — a missing target is a `tsc` error, the
fail-fast). Concretely on the branch:

- **Grammar** — `(extern?='extern' 'from' externPath=STRING)?` on `Component`,
  with the whole `{ … }` block made optional (`src/language/ddd.langium`).
- **IR / lower** — `ComponentIR.{extern, externPath}`, `body` optional;
  `lowerComponent` returns early for extern (no body/state walk).
- **Validator** — `checkComponent` (`validators/ui.ts`): `loom.extern-component-has-body`
  + `loom.component-missing-body`; slot params admitted.
- **React** — `renderExternComponentShim` + `renderExternComponentProps`
  (`walker/page-shell.ts`), branched in `emitPagesForUi` (`pages-emitter.ts`).
- **Printer** — `printComponent` renders `extern from "<path>"` with no body.
- **Tests** — unit: `test/language/validation/extern-component.test.ts` +
  `test/generator/react/walker-extern-components.test.ts`; end-to-end (opt-in,
  `npm run test:tsc-react-extern`, `LOOM_REACT_BUILD=1`):
  `test/e2e/extern-component-build.test.ts` generates the project, drops in a
  hand-written widget, `npm install` + `tsc --noEmit`, and proves the contract
  **bites** — a correct widget type-checks; one reading a field absent from the
  wire DTO fails `tsc`. This is the gate the proposal called for.

Still open per §4 staging: Tier 2 (`action`), LiveView, and the
`loom.extern-component-framework-mismatch` framework guard.

## 9. Validation rules

- An `extern` component declares **no `body:`** (analogue of "extern op bodies
  are preconditions-only", `validate.ts:362`). Code: `loom.extern-component-has-body`.
- `slot` params **are supported** (D Tier 1) — the existing
  `loom.slot-out-of-position` / `loom.slot-member-access` rules
  (`docs/page-metamodel.md:224`) still apply unchanged: a slot is valid only as
  a component param, and member access on a slot ref stays forbidden.
- `action` (behaviour) params (D Tier 2) need **no new rule**: the lambda the
  caller supplies is type-checked by the existing block-body-lambda rules in the
  caller's scope — an `o.confirm()` / `navigate(P)` inside it resolves exactly as
  it does in an `onSubmit:` lambda today, including `targets`-chain reachability.
- An extern component reached by a `ui` whose framework has no binding is an
  error. Code: `loom.extern-component-framework-mismatch`.
- The declared `path` is preserved verbatim (like `UiHelperImportIR.path`,
  `loom.ts` lowering `:1007`) — no resolution at compile time; a wrong path is
  a `tsc`/`mix` error in the generated project, which is the intended fail-fast
  boundary.
- Name must not collide with a stdlib primitive (reuse the existing
  helper-shadowing check, `validators/ui.ts:58`).

## 10. Migration & non-goals (v0)

- **Purely additive.** No existing `.ddd` changes; the modifier is opt-in.
- **Non-goal: arbitrary JSX in bodies.** Option C stays rejected. The hatch is
  a *named, typed* component, not inline source.
- **Non-goal: Loom-authored component internals.** Loom never reads or
  type-checks the body of the foreign file — only its props boundary.
- **In scope (v0): interactivity via `slot` (Tier 1).** A caller passes a
  fully-wired `Action{…}` into a slot, so an extern component is a wired control
  on day one — not a read-only widget — with no new machinery.
- **Deferred (designed, not built): `action` behaviour params (Tier 2) and
  LiveView.** Tier 2 adds Loom's first function type and is pulled by a concrete
  widget, not built speculatively; LiveView is a second backend for a smaller
  payoff. Both are React-only-rejected in v0 with clear diagnostics. See §4
  "Recommended delivery" for the staging rationale. There is **no** op-specific
  binding form in either tier.

### Why not `extern page`

`extern` earns its place on **operations** and **components** because each is a
*leaf with a typed contract Loom otherwise generates a body for*. A `page` is
not a leaf — it is a composition point (*route + URL-bound params + `requires`
auth + `menu` entry + body*), and only the body half is foreign. An `extern
page` is therefore **coherent but redundant**: the render-handoff is already
covered two ways, with no new grammar.

| You want… | Use | Loom still owns |
|---|---|---|
| custom render, keep route/params/auth/menu declarative | `page { route, requires, menu, body: <extern component> }` (Tier 1, exists) | route registration, URL→param binding, auth guard, menu entry, page-object route metadata |
| custom render **and** skip Loom's (inert) page shell | a later thin-shell optimisation — emit a minimal wrapper when a page body is a *single* extern component — **not** a keyword | same as above |
| own the **entire route module** (own shell, data loading, outlet) | `.loomignore` the generated route/page file and hand-write it (`docs/tools.md:94`) | nothing — and at that point it is no longer a Loom page |

```ddd
// The "extern page" use case, expressed today — no new construct:
page OrderMap(id: Order id) {
  route:   "/orders/:id/map"
  requires currentUser.permissions.contains(sales.viewOrders)
  menu     { section: "Sales", label: "Map" }
  body:    OrderMapWidget { orderId: id }     // ← extern component owns the render
}
```

So `page … extern` is **explicitly declined**: a page's body already has an
escape hatch (an extern component), the only delta (`skip the shell`) is an
optimisation rather than a new surface, and owning the whole route module is
precisely what the file-level `.loomignore` hatch is for. Minting a third
spelling would be the speculative-surface trap §4 warns against.

## 11. Open questions

1. **`action` argument-type spelling (the one real open question).** The
   behaviour is just a passed lambda (no op-binding form), and its arg types are
   declared **explicitly on the param** — *not* inferred from call sites, which
   Loom does not do anywhere (declarations are typed, uses checked against them;
   lambda param types flow forward from the expected type, `type-system.ts:417`).
   So the only choice is the token shape: a parameterised `action` type
   constructor, `onPick: action(Order)` (mirrors bare `slot`), versus an arrow
   `onPick: (Order) => action`. Both are explicit; pick the one that reads best
   beside the existing `TypeRef` forms. The *mechanism* (walk the lambda + hoist
   whatever it does, in caller scope) is settled.
2. **Props-file location & import shape.** `…/extern/<Name>.props.ts`
   (sibling-of-`components`) keeps the one machine-owned file clearly inside
   Loom's write set, away from the user's path. Confirm the relative-import math
   from a page (`src/pages/…`) to both the props type and the user component
   resolves cleanly under the generated `tsconfig`'s path setup.
2. **Props nullability / optional params.** `T?` → `TWire | undefined`; does
   the marshalling pass `undefined` or omit the prop? Match the wire-DTO
   convention already used by `Form`/`Detail` emitters.
3. **Where extern components may live.** ui-scope only, or also top-level
   (component-library `.ddd` files, like ordinary components,
   `docs/page-metamodel.md:174–188`)? Top-level extern + import graph would let
   a shared widget library be declared once.
4. **Page-object testability.** With no stub, there's no Loom-emitted
   `data-testid`. Should the contract *require* the user component to render a
   known testid (and the validator/docs state the convention) so scaffolded
   Playwright page objects keep working? (`page-objects-builder.ts` is
   testid-driven.)
5. **`design`-pack interplay.** Should an extern component receive the active
   pack's theme tokens as props, or is it on its own? Probably on its own — it
   is, by definition, outside the pack.

## 12. Relationship to other proposals

- **`docs/extern.md`** — the backend hatch this note mirrors. Three of its four
  parts (modifier → body constraint → generated typed seam) are lifted directly;
  the fourth (regenerated dev stub behind DI indirection) is **deliberately
  dropped** — a compile-time import has no indirection layer to host a stub, so
  the type-checker alone is the fail-fast (§2.4).
- **`embedded-frontend-composition.md`** — moves `framework` onto `ui`. §6's
  framework-binding rule becomes a clean membership check once that lands; the
  two compose without conflict.
- **`docs/page-metamodel.md`** — establishes the closed library this note
  deliberately opens *at one controlled seam* (a named, typed import), without
  reopening the "no user-extensible primitives" decision: extern components are
  not primitives, they are typed leaves the walker renders but never descends
  into.
- **`loom-forms.md`** / **`capabilities.md`** — adjacent "user supplies the
  body, Loom owns the boundary" patterns; the `implements`/`stamp`/`filter`
  surface and the `extern` op both show the house preference for *typed seam +
  fail-fast* over *open-ended injection*, which is why Option C is declined.

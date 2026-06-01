# Extern components — an escape hatch for hand-written frontend code

> Status: **proposal / problem-framing.** Nothing here is implemented. This
> note designs a UI-side analogue of the backend's `operation … extern`
> escape hatch: a way to drop a **hand-written React/TSX (or HEEx) component**
> into a Loom page body, type-checked against the domain, wired into routing /
> state / data, without forking the generator. It catalogues the design space,
> recommends one shape, and sketches the pipeline work against the real code.

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

Loom generates a **typed props file** from the params' wire shape and a
**write-once stub** the user fills in; the call site marshals domain data into
the component; `tsc` against the generated project is the fail-fast gate. The
declared param list is the contract, exactly as the `extern` operation's
parameter list is the contract for its request DTO.

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
4. **A fail-fast check + a dev stub** so the project boots empty but screams
   on a missing impl — TS `verify…Registered()` called at startup, .NET a
   Scrutor scan + `Program.cs` resolution check
   (`dotnet/emit/program.ts:84–114`), each shipped with a `DevStub` so nothing
   is required to merely compile.

The frontend analogue maps cleanly: **(1)** an `extern` modifier on
`component`; **(2)** the body constraint becomes "an extern component declares
*no* `body:`"; **(3)** the typed seam is a generated props interface (from the
params' wire shape); **(4)** the fail-fast is `tsc` on the generated project
plus a write-once stub. The one structural difference — discussed in §6 — is
that a frontend component is a compile-time import, so the "registration
check" is the type-checker, not a runtime registry.

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
  `walker/primitives/controls.ts:343`). No new file-emission path.
- **Cons:** no generated props type, so the user hand-types the props
  interface and keeps it in sync manually; no stub, so a fresh project doesn't
  compile until the user writes the file (no "boots empty" story).

### Option B — `component … extern` with generated props + write-once stub (the extern-op mirror) — **recommended**

Declare it like a component (so params type-check identically), mark it
`extern`, point it at a path:

```ddd
component PriceChart(series: Order[], height: int) extern from "./widgets/price-chart"
```

Loom emits **three** things and owns two of them:

- `src/components/extern/PriceChart.props.ts` — `export interface
  PriceChartProps { series: OrderWire[]; height: number }`, **derived from the
  params' `wireShape`** and regenerated every run (machine-owned, like the
  extern-op `Request` type).
- `src/components/price-chart.tsx` — a **write-once stub** (emitted only if
  absent; pinned via `.loomignore`, see §7) — `export function
  PriceChart(props: PriceChartProps) { return <div data-testid="price-chart-todo" /> }`.
  This is the frontend `DevStub`: the project compiles and boots before the
  user writes a line.
- call sites render `<PriceChart series={…} height={…} />` with props typed by
  the generated interface.

- **Pros:** truest analogue to `operation extern`; the props interface tracks
  the IR/`wireShape` so a domain change surfaces as a `tsc` error in the user's
  component (fail-fast, type-safe); boots empty via the stub.
- **Cons:** a real new emission path (props file + stub-if-absent) per
  framework.

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

### Option D — interactive extern components (orthogonal add-on)

Independently of A/B/C: let an extern component accept **`slot` params** (for
JSX children) and **operation/navigation callbacks** so it can be interactive
while Loom still owns domain dispatch. The component calls `props.onConfirm()`;
Loom wires that prop to the aggregate-operation mutation hook using the
**existing action-hoisting machinery** (`controls.ts` `emitUserComponent`
already hoists aggregate-op mutations; `target.ts` `renderApiHoisting`). This
turns the hatch from "read-only widget" into "fully wired control" without the
user touching `fetch`. Best layered on top of B, not v0.

## 4. Recommended shape

Adopt **B** as the destination, ship **A as its first increment** (B minus the
generated props file and stub — i.e. import-only), and treat **D** as the
follow-on. **C is rejected.**

Rationale: B is the only option that reproduces all four properties that make
`operation extern` good (typed seam, body constraint, generated contract,
fail-fast + boots-empty), and A is literally B with two emission steps removed,
so shipping A first costs nothing that B then throws away — it's the same
grammar and the same call-site dispatch, just without the generated
props/stub. C loses type-safety and framework neutrality, the two invariants
the whole metamodel exists to protect.

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
| `slot` (Option D) | `React.ReactNode` | caller's walker expression, walked in caller scope (`loom-ir.ts:99` slot semantics) |

This is exactly the discipline backends already follow — *"Backends never
re-resolve… read `agg.wireShape` directly"* (`CLAUDE.md`). The user's
hand-written component receives ordinary, already-documented wire DTOs.

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

Loom's contract is *"every file Loom generates is overwritten on every run"*
(`docs/tools.md:96`). The user's extern component file must survive that. The
mechanism **already exists**: `.loomignore` (gitignore syntax, pinned at the
output root, `docs/tools.md:94–117`). The design splits ownership cleanly:

- **Machine-owned, always regenerated:** `…/extern/PriceChart.props.ts` (the
  contract — must track the IR).
- **User-owned, written once then pinned:** `…/price-chart.tsx`. The generator
  emits it **only if absent** (the `write`/`skip` plan already distinguishes
  these, `docs/tools.md:152`), and `ddd generate` adds the path to a suggested
  `.loomignore` line so the user's edits are never clobbered — the frontend
  twin of the `Program.cs` pin example (`docs/tools.md:135`).

This keeps the "no first-run magic" principle (`docs/tools.md:119`): the props
file is *always* generated, the component is *always* skip-if-present.

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
   becomes optional for extern.
4. **Lower** (`src/ir/lower/lower.ts` `lowerUi`/component lowering, ~`:1000`):
   thread the flag + bindings; type-check params via the existing param
   resolution (no expression lowering — extern has no body).
5. **React generator:**
   - `pages-emitter.ts`: when `component.extern`, **skip**
     `renderUserComponentFile` (`page-shell.ts:502`); instead emit the props
     file from `wireShape`, and the write-once stub.
   - `body-walker.ts` (`:670–692`) + `controls.ts` `emitUserComponent`
     (`:343`): **already** emit `<Name .../>` JSX and register the import for
     user components — extern reuses this path verbatim, pointing the import at
     the declared path instead of `src/components/<Name>`.
6. **Phoenix generator** (`src/generator/phoenix-live-view/`): emit
   `<.live_component>` for an extern with a `liveview` binding; the
   `heex-target` import seam (`:100`) handles the alias. Reject (or stub) a
   React-only extern under LiveView.
7. **Tests** (`CLAUDE.md` test layout): one parsing test; negative validator
   tests (§9); one React generator test (import emitted, props file shape, stub
   written-once / not overwritten); a `LOOM_REACT_BUILD=1` run proving the
   generated project `tsc`s with a real hand-written component; a Phoenix
   variant gated on `LOOM_PHOENIX_BUILD=1`.

The heavy lifting (JSX call-site emission, import registration, per-framework
import rendering) **already exists** — this feature is mostly a new
*declaration shape* plus a *props-file + stub emitter*, not new walker
machinery.

## 9. Validation rules

- An `extern` component declares **no `body:`** (analogue of "extern op bodies
  are preconditions-only", `validate.ts:362`). Code: `loom.extern-component-has-body`.
- `slot` params on a v0 (non-D) extern component are rejected until the
  callback-wiring of §D lands. Code: `loom.extern-component-slot-unsupported`.
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
- **Non-goal (v0): callbacks / interactivity (Option D).** Read-shaped props
  first; wired operations second.

## 11. Open questions

1. **Stub regeneration semantics.** Write-once-if-absent + `.loomignore`
   (§7), or always-regenerate-into-`extern/` and require the user to import
   *from* a sibling they own? The former matches `.loomignore`'s philosophy;
   the latter avoids ever touching a user path. Leaning former.
2. **Props nullability / optional params.** `T?` → `TWire | undefined`; does
   the marshalling pass `undefined` or omit the prop? Match the wire-DTO
   convention already used by `Form`/`Detail` emitters.
3. **Where extern components may live.** ui-scope only, or also top-level
   (component-library `.ddd` files, like ordinary components,
   `docs/page-metamodel.md:174–188`)? Top-level extern + import graph would let
   a shared widget library be declared once.
4. **Page-object testability.** A stub ships a `data-testid`; should the
   contract *require* the user component to render a known testid so scaffolded
   Playwright page objects keep working? (`page-objects-builder.ts` is
   testid-driven.)
5. **`design`-pack interplay.** Should an extern component receive the active
   pack's theme tokens as props, or is it on its own? Probably on its own — it
   is, by definition, outside the pack.

## 12. Relationship to other proposals

- **`docs/extern.md`** — the backend hatch this note mirrors; the four-part
  shape (modifier → body constraint → typed seam → fail-fast + stub) is lifted
  directly from it.
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

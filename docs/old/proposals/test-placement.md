# Test placement — subject anchoring and the `for` target

> Status: **PARTIAL** (2026-07-20). **Phase 1 shipped** — the `for` head +
> aggregate hoisting (grammar/IR/lowering/validation/print). **Phase 2 shipped on
> ALL FIVE backends** — `valueobject` / `domainService` unit-test anchors + hoisted
> `for <VO|Service>`; node (Hono), .NET, Java, Python, and Elixir (vanilla
> Phoenix) each emit colocated VO/service unit-test files. (Elixir's vanilla test
> `Env` was decoupled from its former required `AggregateIR` so a VO/service
> subject can host tests; a shape it can't lower degrades to `@tag :skip`, as the
> aggregate path already did.) **Remaining:** **Phase 3** (the `for <Context>`
> integration rung). Workflow anchors were folded into Phase 3 (a workflow test
> wants context wiring — OQ#3). This is the **placement** complement to
> [`test-authoring-language.md`](./test-authoring-language.md): that proposal is
> about a test's *body* (principals, fixtures, retry); this one is about *where a
> `test` may be declared* and *what it may target*.

## Problem

A Loom `test` can live in exactly **two** places today, and the choice is welded
to *containment*:

| Form | Grammar anchor | Sees | Runtime tier |
|---|---|---|---|
| `test "…" { }` (unit) | **`AggregateMember` only** | the enclosing aggregate + its context | behavioral *unit* (in-process domain layer) |
| `test e2e "…" against <deployable> { }` | **root `ModelMember` + `SystemMember` only** | the deployable's HTTP surface | behavioral *api* / conformance (booted deployable) |

Three problems fall out of that:

1. **The unit test is imprisoned inside its subject.** The only way to test
   `Order` is to write the `test` *inside* `aggregate Order { … }`. You cannot
   pull tests into a sibling block or a dedicated `tests/*.ddd` file the way every
   real codebase separates source from tests — because the unit `test` infers its
   subject purely from the braces it sits in. Contrast `test e2e`, which names its
   target explicitly (`against <deployable>`) and is therefore *free to live at
   root*. The unit form has no such escape.

2. **Behavior-bearing declarations that aren't aggregates have no test home.**
   `valueobject` (invariants / normalizers), `workflow` (orchestration), and
   `domainService` (stateless cross-aggregate calculators) all run domain logic,
   yet none can host a `test`. Testing a `domainService` calculation today means
   either borrowing an unrelated aggregate's `test` block (wrong owner) or routing
   through HTTP as a `test e2e` (wrong altitude — see #3).

3. **The middle rung of the tier ladder is missing.**
   [`docs/testing.md`](../../testing.md) describes a clean altitude ladder, but the
   *grammar* only exposes the top (deployable e2e) and bottom (aggregate unit)
   rungs. An **in-process, multi-aggregate, no-HTTP integration test** — the
   natural home for a workflow that spans two aggregates — has nowhere to live, so
   it has to masquerade as `test e2e against <node>`, dragging in a deployable and
   a wire hop to exercise a pure domain orchestration.

## Core insight — reachability is not a home

Two independent axes were conflated in the current design:

- **Anchor** — what a test can *name / see* (its resolution scope).
- **Location** — where it is *physically written*.

The unit `test` fuses them (anchor **is** location). `test e2e` already separates
them: `against` is the anchor, the location is root. **Generalise that separation
to the unit test** and every problem above dissolves.

The mechanism is a single optional head clause — `for <target>` — the in-process
twin of `against`:

```ddd
// 1. nested — target INFERRED from containment (today's form, kept as sugar)
aggregate Order {
  test "rejects empty cart" { expect(place({ items: [] })).toThrow() }
}

// 2. hoisted to a context sibling — target NAMED, still one scope away
context Ordering {
  aggregate Order { … }
  test "rejects empty cart" for Order { expect(Order.place({ items: [] })).toThrow() }
}

// 3. hoisted to its own file — fully-qualified target
// tests/ordering.ddd
import "../ordering.ddd"
test "rejects empty cart" for Ordering.Order {
  expect(Ordering.Order.place({ items: [] })).toThrow()
}
```

Same test, three locations, one rule: **a test can move as far out as its target
stays nameable.** Imports already share one global scope, so a dedicated
`tests/*.ddd` becomes viable the moment the reference-based form exists — nothing
else in the pipeline moves.

### Why `for` and not just fully-qualified names

A fully-qualified body already *resolves* — `Ordering.Order.place(...)` needs no
scope help. So FQNs deliver **reachability**. They do **not** deliver a **home**,
and the toolchain needs a home:

```ddd
test "placing reserves stock" {
  let o = Ordering.Order.place({ … })                          // subject? Ordering.Order…
  expect(Warehouse.Inventory.forSku(o.sku).reserved).toBe(1)   // …or Warehouse.Inventory?
}
```

Every name resolves; nothing tells the compiler **which one subject this test
belongs to** — and that identity drives three real decisions:

- **Where it lowers / what boots.** The behavioral tier boots *one* deployable's
  domain layer; a two-context body gives no answer.
- **Where the emitted file lands / how `npm test` groups it.** "Run the tests for
  `Order`" requires the test to *declare* it is an `Order` test.
- **What it counts toward** in the DoD rollup and `verifies` traceability.

Inferring the home by scanning the body for FQNs is a "first reference wins" /
"the one you mutate" heuristic that (a) is ambiguous the instant a test crosses
subjects — and crossing subjects is the entire reason to hoist — and (b) only
works on an already-fully-qualified body, so it buys nothing over just writing
`for`. This is settled precedent: `test e2e` does not reverse-engineer its
deployable from the body either (the body says `api.orders.create(...)`, the
target is declared). **`for` is the in-process `against`.**

## Proposed surface

### The placement gradient

The `for` target makes placement a *gradient*, not a fixed home. Each location
trades co-location + unqualified scope for separation:

| Location | Anchor | `for` | You get | You give up |
|---|---|---|---|---|
| inside the subject | containment (inferred) | **omitted** | unqualified scope, co-location | a cluttered domain decl |
| context sibling | `for <Agg>` | **required** | clean decl, still close | bare sibling access |
| own file / root | `for <Ctx>.<Agg>` | **required** | full separation, a test tree | all unqualified access |

The cost of hoisting is exactly one thing — **unqualified access.** Inside
`aggregate Order`, `place(...)` and sibling fields resolve bare; hoist the test
and you pay in qualification (`Order.place(...)`, `o.total`), because you have left
the aggregate's scope. That is the *same* rule the scope provider already enforces
for cross-aggregate refs (`loom.bare-aggregate-in-type`) — no new resolution
machinery, the hoisted body resolves like any other out-of-aggregate code.

### `for` is required exactly when there is nothing to infer from

| Where the `test` sits | `for` | Rule |
|---|---|---|
| inside `aggregate` / `valueobject` / `workflow` / `domainService` | **omitted** | home = the enclosing decl |
| context sibling / own file / root | **required** | home = the named target; nothing to infer |

One line: **a `test` resolves its subject from `for` if present, else from its
enclosing declaration; a `test` with neither is the error** (`loom.test-needs-target`
— "top-level `test` must name a subject with `for`"). That error is the principled
form of "a bare unit test at root is meaningless" — a healthy constraint, not a gap.

### New subject anchors — the anchor set the `for` target unlocks

With targeting decoupled from containment, the set of things a `test` may anchor to
expands to **every declaration that owns testable behavior**:

```ddd
valueobject Money {
  test "rejects negative" { expect(Money.of(-1)).toThrow() }     // nested, inferred
}

domainService Pricing {
  test "bulk discount kicks in at 10" { … }                      // nested, inferred
}

context Ordering {
  aggregate Order { … }
  aggregate Inventory { … }
  workflow PlaceOrder { … }

  // context-scoped INTEGRATION test — the missing middle rung.
  // `for Ordering` (the context itself) → sees every aggregate + workflow inside,
  // wired in-process, NO deployable, NO HTTP.
  test "placing an order reserves stock" for Ordering {
    let o = Order.place({ sku: "abc", qty: 1 })
    expect(Inventory.forSku(o.sku).reserved).toBe(1)
  }
}
```

The `for` target determines the runtime scope:

| `for` target | Anchor kind | Runtime | Emitted as |
|---|---|---|---|
| `valueobject` / `aggregate` / `workflow` / `domainService` | subject (unit) | in-process domain layer | colocated unit file (today's shape) |
| a `context` | container (integration) | in-process, wired context, **no HTTP** | new per-context integration file |
| — (only `test e2e … against <deployable>`) | container (e2e) | booted deployable | `e2e/*.e2e.test.ts` (unchanged) |

`test e2e … against` **stays at system/root only.** e2e is intrinsically a
deployment concern — it needs a `deployable` in scope to name after `against` —
so pushing it down into an aggregate/context would let a test name something it
cannot see. The `for`/`against` split is the whole point: `for` is the in-process
rung(s), `against` is the booted rung.

## Two examples (source → generated)

**Hoisted aggregate unit test (case 2 above)** re-lowers to the *identical*
colocated vitest file the nested form emits today (`renderTestsFile(agg, ctx)` in
`src/generator/typescript/emit/tests.ts`) — hoisting is a source-location change,
not an emission change:

```ts
// order.test.ts  — byte-identical whether the `test` was nested in `aggregate Order`
//                   or hoisted with `for Order`
import { describe, it, expect } from "vitest";
import { Order } from "./order";

describe("Order", () => {
  it("rejects empty cart", () => {
    expect(() => Order.place({ items: [] })).toThrow();
  });
});
```

**Context integration test** emits a new per-context file that boots the context's
domain layer in-process (reusing the PGlite / repository wiring the api tier
stands up — minus the HTTP surface). The runnable shape is **async over live
repositories** — see `Phase 3 — design` below for the runtime-accurate emission
(this early sketch predated the runtime audit and is superseded there):

```ddd
test "placing an order reserves stock" for Ordering {
  let o = Order.place({ sku: "abc", qty: 1 })
  expect(Inventory.forSku(o.sku).reserved).toBe(1)
}
```

## Grammar additions (sketch)

```
// `for <target>` head, optional; TestBlock admissible at more positions.
TestBlock:
    'test' name=STRING ('for' target=TestTarget)? ('verifies' verifies=[TestCase:TraceId])? '{'
        body+=TestStatement*
    '}';

// A test target is a qualified path: a bare subject in local scope, or
// `<Context>.<Subject>` / a bare `<Context>` when hoisted out.
TestTarget:
    segments+=ID ('.' segments+=ID)*;   // resolved in IR (see below), not the linker

// New anchor positions (union additions):
AggregateMember    += TestBlock   // already present
ValueObjectMember  += TestBlock   // NEW — VO invariant/normalizer units
WorkflowMember     += TestBlock   // NEW — orchestration units
// domainService: add a `test` member to DomainService's body
ContextMember      += TestBlock   // NEW — nested-with-`for` + integration tests
ModelMember        += TestBlock   // NEW — root/own-file, `for` REQUIRED
```

`TestTarget` is resolved by **name in IR validation** (not a Langium
cross-reference), mirroring how `policy` targets and macro-arg refs resolve — so an
unknown or non-testable target surfaces a controlled `loom.*` diagnostic rather
than a generic linker error, and the scope provider needs no new arm. The existing
nested `test "…" { … }` (no `for`) stays valid unchanged.

## Lowering & pipeline touchpoints

- **grammar** (`ddd.langium`) — the `for` head + the five union additions;
  regenerate the committed parser (`langium:generate`).
- **print** (`src/language/print/print-structural.ts`) — extend the `TestBlock`
  printer arm with the optional `for <target>` (so `unfold` / round-trip stays
  complete; `print-completeness.test.ts` gates it).
- **IR** (`loom-ir.ts`) — `TestIR` already models a unit test (`name`,
  `statements`, `verifiesTestCase`). Add:
  - an optional `target`/anchor descriptor consumed during placement, and
  - a **context-level `tests: TestIR[]`** list on `BoundedContextIR` for the
    integration rung (aggregate-anchored tests keep landing in
    `AggregateIR.tests`, so the existing five backend emitters are untouched for
    that case).
- **lowering** (`src/ir/lower/`) — resolve `for`/containment to the home subject,
  attach the `TestIR` to the resolved owner's list (aggregate vs context), and
  lower the body in the **target's** scope (unqualified inside the subject;
  qualified when hoisted, via the existing cross-aggregate resolution path).
- **validation** (`src/ir/validate/checks/test-checks.ts`) —
  `loom.test-needs-target` (hoisted with no `for`), `loom.test-bad-target`
  (unknown / non-testable target, e.g. a plain enum or payload),
  `loom.test-redundant-for` (nested *and* a `for` that just restates the enclosing
  subject — reject: one obvious way to write each test).
- **emission** — the four existing backend `emit/tests.ts` (+ Elixir
  `tests-emit.ts`) are **unchanged for aggregate-anchored tests**. The new work is
  one **context-integration emitter** per backend that boots the wired context
  in-process (reusing the behavioral-unit runtime), plus the VO/workflow/
  domainService anchors routing to the same unit emitter with a different owning
  decl.
- **five backends** — the aggregate-unit and VO/workflow/service-unit paths stay
  domain-layer only (no HTTP); the integration path reuses each backend's existing
  in-process domain wiring.

## Validation summary

| Code | Fires when |
|---|---|
| `loom.test-needs-target` | a `test` (non-e2e) at root/context-sibling has no `for` and no enclosing subject |
| `loom.test-bad-target` | `for <X>` names something unknown or not behavior-bearing (enum, payload, plain record) |
| `loom.test-redundant-for` | a nested `test` restates its enclosing subject via `for` |

## Open questions

1. **Own-file discovery** — is a `tests/*.ddd` file discovered purely via `import`
   (today's model, zero new machinery), or should the CLI auto-glob a `tests/`
   convention? Leaning: import-only for the first slice; a glob is sugar on top.
2. **Context-integration runtime seam** — ✅ **RESOLVED** (see `Phase 3 — design`).
   The PGlite+DDL boot is separable from the router, and the repository is an
   exported, HTTP-free persist seam; no domain-layer-only boot function exists
   today but it's reconstructable. Phase 3 reuses the boot + repo classes and adds
   a third renderer + harness run-path, not a new backend layer.
3. **`for` a workflow vs the enclosing context** — ✅ **DECIDED**: workflow
   orchestration folds into the `for <Context>` integration rung (a workflow test
   touches multiple aggregates and needs the wired context + in-process dispatcher).
   `for <Workflow>` is **not** a separate anchor in this design — dropped from the
   Phase-2 unit anchors for that reason.
4. **Cross-context targets** — should `for` ever name two contexts (a genuinely
   cross-context in-process test)? Leaning: no — that is the `test e2e against`
   rung's job. Keep `for` single-context to preserve an unambiguous boot.
5. **Relationship to `suite`** ([`test-authoring-language.md`](./test-authoring-language.md))
   — a `suite` groups e2e tests `against` a deployable. Do context-integration
   tests get an analogous `suite … for <Context>` grouping, or stay flat for the
   first slice? Leaning: flat first; grouping composes later.

## Phasing

- **Phase 1 — the `for` target + hoisting, aggregate-only.** Add `for <Subject>`,
  admit `TestBlock` at `ContextMember` and `ModelMember`, resolve/attach to
  `AggregateIR.tests`, and re-lower byte-compatibly. Unlocks "move tests out" and
  the `tests/*.ddd` file with **zero new emitter** (the colocated unit file is
  unchanged). Highest value, lowest risk.
- **Phase 2 — the extra unit anchors.** `valueobject` / `workflow` /
  `domainService` host `test`, routing to the existing unit emitters.
- **Phase 3 — the context-integration rung.** `for <Context>`, the
  `BoundedContextIR.tests` list, and the per-backend in-process integration
  emitter. This is the one with a genuinely new runtime entry; it lands last so the
  cheap wins ship first. Full design below (`Phase 3 — design`).

---

## Phase 3 — design (runtime-grounded, 2026-07-20)

Phases 1–2 shipped by *reusing* existing per-subject unit runtimes. Phase 3 is
different: a `test "…" for <Context>` runs cross-aggregate behaviour **in-process
against live repositories, no HTTP** — a genuinely new execution path. This
section resolves OQ#2 against the real behavioural runtime.

### The core finding — the persist seam already exists, HTTP-free

A context integration test's statements need **persistence** semantics that
neither existing renderer provides:

- the **unit** renderer (`renderTestExpr`, `typescript/emit/tests.ts`) makes
  `Order.create({…})` a *pure in-memory* factory call — no `db`, no repo, and the
  validator (`validateAggregateTestBodies`) even *rejects* mutating statements;
- the **api/e2e** renderer (`src/system/e2e-render.ts`) makes `api.orders.create({…})`
  an HTTP `fetch` — the wire boundary the whole rung exists to avoid.

But the persist boundary is a **standalone, exported seam** — there is no need for
a per-backend application-service layer:

```ts
// what the Hono route handler does internally (routes-builder.ts:594,631) —
// and what the integration renderer emits directly, minus the router:
const o = Order.create({ … });                 // pure domain factory (reused from the unit renderer)
await new OrderRepository(db, events).save(o);  // the persist seam — repository-save-builder.ts:218
const inv = await inventoryRepo.forSku(sku);    // a repo read — routes-builder.ts:736 pattern
```

`<Agg>Repository` is emitted per aggregate with `save` / `findById` / custom
finds (`repository-builder.ts:220`), constructed today only *inside* `createApp`
(`routes.ts:79`) but trivially reconstructable. And the PGlite + `synthDDL` +
drizzle boot (`test/behavioral/run.mjs:127-131`, `web/src/runtime/ddl.ts`) is a
self-contained block — only the `createApp(db)` router mount is HTTP-specific.

**So Phase 3 reuses:** the boot block + the repository classes. **And adds:** a
third renderer, a new emitted file category + run-path branch, `BoundedContextIR.tests`,
`TestSubject |= BoundedContext`, and one small "wire the context's repositories"
factory (so the harness doesn't hand-construct each repo).

### Two examples (source → generated) — corrected for the real runtime

The earlier sketch under "Two examples" showed a synchronous, DB-less body; the
real emission is async over live repositories:

```ddd
context Ordering {
  aggregate Order { … create place(sku: string, qty: int) { … emit OrderPlaced { … } } }
  aggregate Inventory { … }
  workflow ReserveOnPlace { on(OrderPlaced) { … reserve … } }

  test "placing an order reserves stock" for Ordering {
    let o = Order.place({ sku: "abc", qty: 1 })
    expect(Inventory.forSku(o.sku).reserved).toBe(1)
  }
}
```

```ts
// context/ordering.integration.test.ts — body only; the behavioural harness
// injects `repos` after booting PGlite + DDL (mirrors how the api tier injects `api`).
describe("Ordering (integration)", () => {
  it("placing an order reserves stock", async () => {
    const o = Order.place({ sku: "abc", qty: 1 });
    await repos.orders.save(o);                       // persist → dispatch OrderPlaced
    const inv = await repos.inventory.forSku(o.sku);  // repo read (post-cascade)
    expect(inv.reserved).toBe(1);
  });
});
```

### The three decisions

1. **Reuse, don't build a new backend layer.** The repository *is* the callable
   persist boundary — no application-service seam. New code is confined to the
   renderer + harness + IR/grammar, not the backend architecture.

2. **Workflow cascades ride the in-process dispatcher.** `repos` is wired with
   `createInProcessDispatcher(db)` (not `Noop`), so a `save` that emits
   `OrderPlaced` runs the `ReserveOnPlace` reactor **synchronously in-process** —
   delivering the motivating example without HTTP or an outbox drain. **Open
   sub-question:** if a reactor is outbox-async rather than synchronous, v1 either
   drains the outbox inline or defers workflow-cascade assertions to 3b. To
   confirm before building.

3. **Node-first for the runnable tier.** The per-PR behavioural tiers
   (unit/api/ui) are all node-only; cross-backend behaviour rides docker
   `conformance-full`. The integration tier follows suit: node runs it, other
   backends' repository seams exist but their in-process harness is a later slice.

### Pipeline touchpoints

- **grammar** — `TestSubject |= BoundedContext`; export context names in
  `ddd-scope.ts` so `for <Ctx>` resolves; `checkTestPlacement` already covers the
  placement rules (a context test is always hoisted → `for` required).
- **IR** — `BoundedContextIR.tests: TestIR[]` (mirrors the Phase 1/2 subjects);
  lower a context-level `test` under the **context env** (every aggregate / service
  in scope), routed like the hoisted subject tests but keyed on the context.
- **third renderer** (node) — `src/generator/typescript/emit/` (new
  `integration-tests.ts`): create/create-action → `repo.save(<Agg>.create({…}))`;
  operation → mutate + `repo.save`; a repository find → `await repo.<find>(…)`;
  reuse `renderCreateInput` / `renderTsExpr` for the domain expressions.
- **wire-repos factory** (node) — one emitted `createContextRepos(db, events)`
  returning `{ <agg>: new <Agg>Repository(db, events), … }`.
- **behavioural harness** — `test/behavioral/run.mjs`: a new `walk(...)` for the
  integration file + an `entrySource` branch reusing lines 127-129 (PGlite + DDL +
  drizzle) and injecting `repos` instead of `app.fetch`.

### Phasing 3

- **3a** — multi-aggregate persist + query + **synchronous** workflow cascades on
  **node**. The renderer, the wire-repos factory, the harness run-path, the IR +
  grammar. Delivers the motivating example.
- **3b** — outbox-async cascade draining (if 3a finds reactors are async), and the
  cross-backend integration harness (.NET/Java/Python/Elixir repository seams).

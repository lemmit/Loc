# Unfoldable page scaffolding — lift the ⑤c expander into the macro layer

**Status:** LANDED (sentinel removal) — 2026-06-19. The scaffold page-body
expansion now lives entirely in the macro layer (`_body-builders.ts`, AST→AST,
unfoldable). The `scaffold*(of:)` body sentinels and their IR-phase ⑤c expander
arms have been **removed**; the only ⑤c work that remains is expanding the three
singleton index-page sentinels (`Home` / `WorkflowsIndex` / `ViewsIndex`), which
the macro still emits as bare sentinel bodies. A hand-written `scaffold*` body
primitive is no longer admissible (fails validation). See
[D-NO-PAGE-ARCHETYPES](../../decisions.md#d-no-page-archetypes) for the dated
supersede note. The prose below is the original proposal, kept for context.

**Update — area-authoritative `emitPath` (slice 3a) — 2026-06-20.** The scaffold
now names an aggregate's pages by **role** (`page List` / `New` / `Detail`)
inside their per-aggregate `area` (decision 4), and `area` is **authoritative
for `emitPath`** — `applyPageOriginSideEffects` no longer overrides the
area-derived path (`src/pages/orders/list.tsx`), the prerequisite for dropping
`origin` later (3c). Page-name uniqueness + override-by-name are now **per
scope** (the ui top level and each `area`), and the macro splice merges
same-named areas recursively, so role names don't collapse across aggregates.
Generated output is **byte-identical**: the role name is the DSL/file identity
only — every emitted *target-code* identifier (React/Vue/Angular component,
Phoenix module/file, Playwright page-object, smoke title, router import) stays
the aggregate-qualified `OrderList` form via `pageEmitName`
(`src/ir/util/page-kind.ts`).

**Update — qualified `Area.Page` menu links (2026-06-20).** A `menu { link … }`
can now disambiguate role-named scaffold pages by area: `link Orders.List`
resolves to the `List` page inside `area Orders`, distinct from `Items.List`.
The grammar accepts a dotted `QualifiedPageName`; `DddScopeProvider.getScope`
resolves a page-link by both its bare name (unique top-level pages — `link Home`)
and its area-qualified dotted path (built at link time, since the scaffold
synthesises the area+page nodes after global indexing); lowering carries the
resolved page's `route` so the menu emitter keys on it (not the shared role
name). A bare `link List` still resolves nearest-match for back-compat.

**Update — `origin` removed (slice 3c) — 2026-06-20.** `PageIR.origin` and its
two inference passes (`inferPageOrigin` + `resourceScaffoldOrigins` /
`classifyScaffoldPageByName`) are **gone**. A page's kind — aggregate
list/new/detail, workflow form/instances, view, the singleton indexes, or
`custom` — is now **derived on demand** from its role-scoped `name` + `area`
against the served decls, via `classifyPage(page, ctx)` in
`src/ir/util/page-kind.ts` (the new home of `pageEmitName` too). The single
source of truth is the page itself; nothing is stamped. Every consumer
(lowering side-effects, the React app-shell scaffolded-set + presence flags,
the shared menu emitter, all frontends' page-object dispatch, the Phoenix
LiveView module/file naming) threads a tiny `PageNameCtx` (served aggregate /
workflow / view name arrays) instead of reading a cached field. Generated
output is **byte-identical** (full fast suite + baseline fixtures unchanged).
Gotcha worth recording: `PageNameCtx` holds **arrays, not bare `Iterable`** — a
`Map.keys()` iterator is single-use and `classifyPage` runs once per page, so an
iterator ctx silently misclassifies every page after the first.
· **Created:** 2026-06-18

> One-line thesis: the scaffold **page-body expansion**
> (`scaffoldList` / `scaffoldDetails` / `scaffoldNewForm` / … → the
> `Stack`/`Breadcrumbs`/`QueryView`/`Table` tree) must be a **macro-layer
> (AST→AST) transform that is unfoldable to literal `.ddd` source** — not an
> IR-phase ⑤c rewrite. Scaffolds are macros; macros are unfoldable; this one
> isn't, and that is a layering defect, not a cosmetic gap. UI-side twin of
> [`unfoldable-api-derivation.md`](./unfoldable-api-derivation.md).

> **Context.** This doc began as "implement the `List`/`Detail`/`MasterDetail`
> archetypes." Those turned out to be **inert duplicates** of the
> `scaffoldList`/`scaffoldDetails` sentinels and were **removed**
> ([D-NO-PAGE-ARCHETYPES](../../decisions.md#d-no-page-archetypes)). What remains
> — and what this rewrite is about — is the real defect the investigation
> surfaced: the sentinels themselves expand as opaque IR magic.

## The defect

`with scaffold(…)` is a real macro and unfolds one level at a time
(subdomain → context → aggregate → pages) through the structural printer
(`src/language/lsp/unfold-macro.ts` + `src/language/print/`). But the **page
bodies** it emits are sentinel calls — `callExpr("scaffoldList", { of })`
(`src/macros/stdlib/scaffold/_pages.ts`) — and the actual ~100-line body tree
is produced by `expandScaffoldList` / `expandScaffoldDetails` / … in
`src/ir/lower/walker-primitive-expander.ts`, called as the **last step of
`lowerSystem` (phase ⑤c)**. That step is **IR → IR**, so it:

- has **no printer arm** (the printer is AST→source; this runs in IR-space),
- has **no unfold** (unfold targets `with X(…)` clauses at the AST layer),
- and produces a tree that exists only transiently as IR, then as generated
  TSX — **never** as `.ddd` source the user can see, edit, or eject.

The transparency chain — Loom's stated value (everything scaffolded is
ejectable to literal source) — dead-ends exactly at the page body. It is also
a one-directional-layering smell: a language-surface construct (`scaffoldList`)
carries its semantics as a hardcoded IR transform in the lowering pass.

## Design — move the expansion to phase ② (AST→AST)

Relocate the body-builders from `src/ir/lower/walker-primitive-expander.ts`
(IR→IR, ⑤c) into the scaffold macro family (`src/macros/stdlib/scaffold/`) as
**AST→AST builders** that read the AST and emit AST builder-calls
(`callExpr`/`nameRefExpr`/`stringLit`/`intLit`/lambda — the `_pages.ts`-style
factories, extended). One shared module serves three consumers:

1. **The compile path** — the scaffold macro (or a phase-② pass right after
   macro expansion, before scope/link ③) expands the sentinel into the full
   body AST. Downstream just lowers a normal page body; the ⑤c scaffold pass
   is **deleted** (~1k LOC of IR magic gone). A correctness bonus: the expanded
   body now flows through scope/link (③) and AST-validate (④), which the ⑤c
   output bypasses today.
2. **Unfold (eject)** — the LSP code action runs the *same* builder on a
   selected sentinel, prints the result, and splices it in. `scaffoldList
   { of: Order }` → the literal `Stack { Breadcrumbs … QueryView … Table … }`,
   editable.
3. **Hand-written sentinels** — `extern-showcase.ddd`'s embedded `scaffoldList
   { of: Order }` expands by the same pass, so emitted and hand-written
   sentinels behave (and unfold) identically.

Optionally the builder can emit a **named `component` + a page reference**
instead of an inline body (the monomorphized `<Agg>ListView` discussed
below) — a reusable, embeddable artifact. That is a refinement on top of the
relocation, not a prerequisite.

### The data is AST-derivable (this is why it can leave ⑤c)

The only reason body-building was deferred to ⑤c is that it read *enriched* IR.
Every input has an AST-layer equivalent:

| ⑤c reads (IR) | AST/macro-layer equivalent |
|---|---|
| `agg.fields` (typed; skip VO/array) | the aggregate's `Property` members + type AST |
| repo `finds` (filter bar) | the `repository`'s `find` members (string params, array return) |
| `findApiHandleFor` | the `ui`'s api params + the system's `api` decls (all AST) |
| auto-`findAll` → `api.X.all` | **convention** (`.all`) — no enrichment needed |
| wireShape order / containments / derived | declared field order + containment/derived/`X id[]` members |

The tree *shape* is reused verbatim — same named-primitive calls, expressed as
`callExpr(...)` instead of `call(...)`. The work is re-reading these from the
AST; it is **larger for Detail** (containments / derived / associations /
operation fan-out) than for List.

## The key coupling: `origin` is inferred from the sentinel

The one genuinely hard part — but it dissolves rather than needing a stamp.
`inferPageOrigin` (`src/ir/lower/lower-ui.ts`) classifies a page
(`aggregate-list` / `aggregate-detail` / `aggregate-new` / `view-list` /
`home` / …) by **pattern-matching the body sentinel** during lowering — there
is **no** separate origin slot (`scaffoldOrigin` is only a validator
predicate). `applyPageOriginSideEffects` then uses `origin` to set the
`emitPath` (`pages/orders/list.tsx`), synthesise the detail `:id` param, and
route page-object emission. (Menu metadata is already emitted explicitly by the
macro.)

So once the body expands to full source *before* lowering, the sentinel — and
thus the inferred origin — is gone. Each thing `origin` drove is handled
*without* re-introducing a classification:

- **File placement → `area`** (next section): a structural, declared grouping,
  not an emitPath reverse-engineered from the body. This is the substantive
  replacement.
- **The detail `:id` param** is emitted **explicitly** by the macro
  (`page Detail(id: Order id)`), not synthesised from origin — cleaner, and
  visible in the unfolded source.
- **Page-objects** derive from the complete page body (the `custom`-page path
  already does this), so the scaffold/custom split collapses to one path.

Net: `origin` and `inferPageOrigin` are **removed**, not stamped. The one
grammar/IR addition the refactor needs is `area` — which buys file grouping
*and* (later) route prefixing + shared config, far more than emitPath did.

## Areas — structural page grouping (`area { }`)

`area <Name> { … }` is a first-class `ui` member that **contains** pages (and,
recursively, sub-areas). Grouping is *containment*, not a stringly per-page
label — so there are no typo'd/dangling group names, no repetition, and file
placement is a structural fact:

```ddd
ui Admin {
  page Home { route: "/" body: … }          // top-level → pages/home.tsx

  area Sales {                                // → pages/sales/…
    area Orders {                             // → pages/sales/orders/…
      page List   { route: "" body: scaffoldList   { of: Order } }
      page Detail(id: Order id) { route: "/:id" body: scaffoldDetails { of: Order } }
      page New    { route: "/new" body: scaffoldNewForm { of: Order } }
    }
  }
}
```

- **Placement from containment** — `pages/<area-path>/<page>.tsx`; the path
  joins down the nesting. Replaces `origin`'s emitPath as a *declared* fact.
- **The scaffold returns `area` blocks** — `scaffoldAggregate` returns an
  `area` node containing its complete list/detail/new pages; unfolding the
  scaffold reveals exactly that block (readable, editable). The scaffold can
  mirror the domain hierarchy `subdomain → context → aggregate` as nested
  areas, so the page tree reflects the bounded contexts it came from — *richer*
  structure than today's flat-or-per-aggregate layout, not a loss.
- **Nesting is free** — recursive grammar (`Area` members = `Page | Area`).
- **Growth path (later, not v1):** an area **base `route:`** that its pages'
  *relative* routes compose under (React-Router nested routes / ASP.NET area
  prefixes — file tree and route tree then agree, both from one containment);
  and area-level `layout` / `requires` / `label` that **cascade** to
  descendants (declare a guard once for a whole area). A per-page `area:` string
  could carry none of this — which is why it's a block, not a prop.
- **Naming:** `area` chosen over `group` (collides with the `Group` primitive),
  `module` (domain unit), `section` (taken by `menu`, and a different axis);
  `feature` is the runner-up (rhymes with the `byFeature` layout axis).

Grammar sketch:

```
UiMember: … | Page | Area | …;
Area: 'area' name=ID '{' members+=(Page | Area)* '}';   // + later: route?/layout?/requires?/label?
```

## Phased implementation (with gates)

1. **Foundation (this slice).** Add the missing AST expression factories
   (`intLit`, …) and a shared `src/macros/stdlib/scaffold/_body-builders.ts`
   that builds page-body AST from the AST aggregate, starting with the
   data-light `scaffoldNewForm` shape. Test: build → print → re-parse → assert
   valid source + expected structure. *Additive; zero change to the compile
   path; proves AST-derivability + printability.*
2. **`area` block (v1).** Grammar (`Area` as a `ui` member containing
   `Page | Area`) + regen + printer + validator; lowering derives `emitPath`
   from area containment. The scaffold emits **per-aggregate leaf areas** named
   plural (`area Orders` → `pages/orders/…`), preserving today's paths; nesting
   is grammar-supported but not yet emitted (decision 4). Replaces `origin`'s
   emitPath role structurally. Area `route:`/`layout`/`requires`/`label` deferred.
3. **Relocate List + New + drop `origin`.** Build the
   `scaffoldList`/`scaffoldNewForm` body AST at phase ②; emit params/menu
   explicitly; delete those ⑤c arms and `inferPageOrigin`; page-objects derive
   from the complete page. **Gate: equivalent generated output** across all
   frontends (UI identical; files now under their `area` path).
4. **Relocate Detail + the rest.** `scaffoldDetails`/`scaffoldOperations`/
   `scaffoldViewList`/`scaffoldInstance*`/`scaffoldWorkflowForm` + the index
   singletons; delete the remainder of `walker-primitive-expander.ts`.
5. **Unfold wiring.** Extend the LSP code action to eject a body sentinel via
   the shared builder.
6. **(Optional) component emission.** Switch the builders to emit
   `component <Agg>ListView` + a page reference, for reuse/embedding.
7. **(Later) area growth.** Base `route:` prefix (relative page routes),
   cascading `layout`/`requires`/`label`.

## `List` (archetype) vs `<Agg>ListView` (if we emit components)

Kept for the component-emission option (phase 6): `List { of: X }` could not be
one shared component — columns are baked per-aggregate at build time (no
runtime reflection) — so the macro **monomorphizes** it into a concrete
`<Agg>ListView` (distinct from the scaffold *page* name `OrderList`). The
indirection *is* the scaffold step.

## Sealed decisions (v1)

1. **Name = `area`** (over `feature` runner-up; `group`/`module`/`section` collide).
2. **`area <Name> { (Page | Area)* }`** — a `ui` member only (pages live in uis),
   nestable via the recursive rule. v1 grammar carries **name + members only**;
   `route:` / `layout:` / `requires:` / `label:` are added when those features
   land, not reserved now.
3. **v1 scope = file placement only.** `area` sets `emitPath`
   (`pages/<area-path>/<page>.tsx`; folder = `snake(name)`, joined down the
   nesting); area-less pages stay flat at `pages/<name>.tsx`. **Routes stay
   absolute and unchanged; nav stays on `menu` metadata, unchanged.** The base
   `route:` prefix (+ relative page routes) and cascading
   `layout`/`requires`/`label` are the documented growth path — *not* v1.
4. **Scaffold v1 emits per-aggregate leaf areas**, named plural (`area Orders`
   → `pages/orders/…`), so **today's paths are preserved exactly**. The grammar
   supports domain-hierarchy nesting (`area Sales { area Orders { … } }` →
   `pages/sales/orders/…`); the scaffold MAY adopt it as an immediate
   follow-up, but v1 keeps paths stable to minimise the flip's diff.
5. **`origin` / `inferPageOrigin` are removed**, not stamped: placement → `area`;
   detail `:id` param emitted explicitly; page-objects derive from the complete
   page; the scaffold/custom emitter split collapses to one path. **Flip gate =
   equivalent generated output across all frontends** (react/vue/svelte/elixir)
   — UI identical, files now under their area path.
6. **Areas are optional & additive** — existing area-less UIs behave exactly as
   today (flat pages).
7. **Validator:** area + page names unique within their `ui`; containment makes
   cycles structurally impossible.
8. **Decision tags to pin** (in `decisions.md` once building starts):
   **`D-PAGE-AREAS`** — page grouping is a containment-based `area { }` block;
   file placement derives from containment; routes/nav stay independent in v1.
   **`D-UNFOLDABLE-SCAFFOLD`** — the scaffold body expansion is a macro-layer
   AST→AST transform (`src/macros/stdlib/scaffold/`); `walker-primitive-expander.ts`
   (⑤c) and `origin`/`inferPageOrigin` are removed.

Nothing else is open: the component-emission (phase 6) and the filter-bar /
per-type-formatter tail are **deferred-but-specified**, not unresolved. The
only judgment call left for *later* is the phase-6 component name
(`<Agg>ListView` vs `OrdersList`), decided when/if phase 6 is taken.

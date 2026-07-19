# M-T1.5 — Region-level customization / UI unfold (design)

> **Status: design-in-progress (draft PR claim).** Resolves the mission's
> unsettled fork by committing to **both** rungs (named override slots +
> per-page unfold), sequenced as two independent slices. Design-first: no
> implementation code in this PR.
> Sources: `docs/audits/architecture-weak-spots-2026-07.md` §1 (the
> customization-cliff), `docs/page-metamodel.md` §10 (override-by-name) /
> §5.2 + §9 (`slot` / `Slot`) / §14 (open questions),
> `src/language/lsp/unfold-macro.ts`, `src/macros/stdlib/scaffold/`.

## Problem

The scaffolded UI is excellent right up to the edge of the closed primitive
set — then customization is **all-or-nothing**. The weak-spot review names this
the product's #1 gap. Today there are exactly three rungs, and the jump between
them is a cliff:

| Rung | Mechanism | Granularity | What you give up |
|---|---|---|---|
| Whole `ui` block | `unfold` the `with scaffold(...)` clause | **every** page at once | you now own the entire UI surface |
| Whole page | override-by-name — declare `page <Name>` (§10) | one page | the generated body: you hand-write from a **blank** page |
| Whole component | `extern component` | one component | the component is yours; no model wiring inside it |

The missing middle is *region-level* and *body-preserving* customization:

- **Per-page unfold** — the model already emits a full, hand-writable body for
  every scaffolded page (`_body-builders.ts`), and `unfold` already ejects
  **all** of them. There is no way to eject **one** page's body to `.ddd`
  source and leave its siblings scaffolded. Override-by-name gets you a single
  page but starts you at a blank body — you throw away the generated starting
  point.
- **Named override slots** — no way to keep a page model-owned and
  regenerable while injecting custom markup into one declared spot. The
  component library already has a `slot` element param + `Slot {}` primitive
  (§5.2, grammar `ddd.langium:1890`/`2278`), but scaffolded **pages** expose
  none.

### Correction to the mission text

The mission says "`unfold` explicitly excludes `ui` hosts." That is imprecise
and should not be carried forward: the only hard `ui` guard is in
`unfoldCapability` (`unfold-macro.ts:192`) — correct, because capabilities are
pure *domain* mixins. The `scaffold` **macro** targets `ui`
(`scaffold.macro.ts:30`) and **does** unfold (`unfold-macro.ts:77` matches
`macro.target === hostKind === "ui"`), ejecting real `.ddd` page source. The
gap is *granularity*, not a blanket exclusion.

## Direction — two independent rungs

Both slices are additive and can land in either order; slot injection is the
cliff-*softener* (you never fall off), per-page unfold is the finer *escape
hatch* (a smaller cliff). We build both so the gradient is continuous.

### Slice A — Per-page unfold (cheaper; extends existing machinery)

A code action on a scaffolded page (or on the `with scaffold(...)` clause,
scoped to one produced page) that ejects **that page's** walker-stdlib body as
`.ddd` source and narrows the scaffold directive so it no longer produces that
name.

```ddd
// before — Order pages are all scaffolded
ui SalesAdmin with scaffold(aggregates: [Order, Customer]) { }
```

Invoking *Unfold page 'OrderDetail'* rewrites to:

```ddd
ui SalesAdmin with scaffold(aggregates: [Order, Customer]) {
  page OrderDetail {                 // ← ejected, byte-identical to the scaffold body
    // Breadcrumbs · heading · QueryView { of: api.Order.byId(id), single: true } …
    // (the full _body-builders.ts body, printed via printStructural)
  }
}
```

`Customer`'s pages and `Order`'s other two pages stay scaffolded. This reuses
the exact override-by-name contract already in §10 ("`scaffold` it but declare
a `page <Name>` with the matching name") — the *only* new work is producing the
ejected **body** instead of a blank page. Mechanically:

- The scaffold macro already builds every page's full AST body
  (`_body-builders.ts`); a per-page unfold runs the macro, selects the one
  produced `page` node whose classified name matches the target, and prints its
  body through the existing structural printer (`printStructural`) — the same
  printer the whole-`ui` unfold already uses.
- The `with scaffold(...)` clause is **not** removed (siblings still need it);
  instead the ejected page name is recorded so the validator's
  double-scaffold/duplicate-name obligations (§10 "Validator obligations") pass
  — this is already exactly the override-by-name rule (explicit `page <Name>`
  overrides exactly one scaffold source). No new validator; the existing one
  must simply treat the ejected page as the override it structurally is.

**Open question A1 (resolve before code):** granularity of the trigger — per
individual page (`OrderDetail`), or per aggregate/archetype (all three `Order`
pages)? Recommendation: per individual page (finest useful grain; the user can
invoke it three times), with the code action offered on each classified page.

### Slice B — Named override slots (the true cliff-softener)

Let a scaffolded page stay model-owned while a `.ddd` author fills a declared
slot with custom markup — no ejection, page keeps regenerating.

Two sub-decisions, both reusing existing surface rather than inventing:

1. **Where slots live.** The scaffold body-builders gain a small, *fixed* set
   of named slots at stable positions (e.g. `Detail` page: `header`,
   `beforeOperations`, `afterOperations`, `footer`). Closed set, like the
   primitive library — not user-declarable slot names, so the contract stays
   pinned and the walker can emit them unconditionally.
2. **How an author fills one.** A page-level `override <slot> { … }` block whose
   body is ordinary walker-stdlib markup, dispatched through the existing
   `Slot`/`slot` element mechanism. Sketch:

```ddd
ui SalesAdmin with scaffold(aggregates: [Order]) {
  override OrderDetail.afterOperations {
    Card { title: "Audit trail" QueryView { of: api.Order.history(id) } … }
  }
}
```

The scaffolded `OrderDetail` still regenerates from the model; only the named
region carries user content. This is the invariant-preserving path — the model
stays the single source of truth.

**Open question B1:** grammar for the override handle — `override Page.slot { }`
(new soft keyword `override`) vs. reusing `page Page { fill slot { } }`.
Recommendation: `override <Page>.<slot> { }` as a top-level `ui` member; check
`override` for corpus identifier collisions the way M-T2.1 checked `rename`
(likely far rarer, but must verify before claiming the keyword).

**Open question B2:** the closed slot set per page archetype — enumerate it in
this doc before code, gate additions behind a `heex-parity`-style freeze test so
a slot added to the TSX body-builders can't silently skip HEEx.

## Decisions honored

- **Invariant #7 (no primitive-local-state seam):** slots carry markup, not
  new state channels — page-level `state {}` remains the only state surface,
  same as M-T1.1's decision (A).
- **Macros emit final AST (CLAUDE.md conventions):** per-page unfold prints the
  macro's real produced body; no sentinel/placeholder — consistent with the
  "unfold ejects real `.ddd` source" guarantee.
- **Closed primitive set:** slot names are a closed set, freeze-tested across
  targets — no user-extensible component library (§14 non-goal upheld).

## Cross-target scope

- **Slice A (unfold)** is toolchain-only (LSP code action + structural printer)
  — framework-agnostic, no per-backend emitter work. Lands once.
- **Slice B (slots)** touches the body-builders + every walker target's markup
  seam (React/Vue/Svelte/Angular/Feliz + HEEx). HEEx pinned in `heex-parity`
  with a reason if the LiveView topology can't carry a slot cleanly, per the
  standing walker-parity discipline.

## Acceptance

- **A:** a scaffolded example with 2 aggregates; unfolding one page yields a
  `page <Name>` whose body re-parses and generates byte-identically to the
  scaffold output for that page; siblings unchanged. Round-trip gated like the
  existing `print-structural-roundtrip` test.
- **B:** a scaffolded page with a filled `override <Page>.<slot>` renders the
  custom region while the rest stays generated; all `generated-*-build` gates
  green on the JSX targets; HEEx renders or is pinned.

## Sequencing

Slice A first (self-contained, no emitter fan-out, immediate DX win), Slice B
second (design questions B1/B2 resolved in a follow-up revision of this doc
before its code). Neither blocks the other.

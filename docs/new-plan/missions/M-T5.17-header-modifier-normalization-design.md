# M-T5.17 — Surface normalization: aggregate-header modifiers + `httpStatus` clause (design)

> **Status: design-in-progress (draft PR claim).**
> Sources: language-surface review 2026-07-14 (finding #1 "aggregate-header modifier
> zoo" + finding #3 "`httpStatus X N` space-triple"); `src/language/ddd.langium`
> (`Aggregate` header, `ApiStatus`); [`docs/decisions.md`](../../decisions.md)
> D-DOCUMENT-AXIS §4 (all aggregate config on the header), D-RENAME.

## Problem

Two clauses spell the same *kind* of thing in a syntax the rest of the language
doesn't use anywhere else. Both are cosmetic — no semantics change — but both are
read on nearly every aggregate / api the surface exposes, so the inconsistency is
high-visibility.

### (1) The aggregate-header modifier zoo

The `Aggregate` header carries **four different modifier syntaxes** in a rigid
fixed order (`ddd.langium`, the `Aggregate` rule):

```
abstract aggregate Invoice extends Party crossTenant
  persistedAs(eventLog) shape(document) inheritanceUsing(ownTable) with auditable { }
```

- `abstract`, `crossTenant` — bare adjective flags, but `abstract` sits **before**
  `aggregate` while `crossTenant` sits **after** the name.
- `extends Party` — keyword + cross-reference.
- `persistedAs(eventLog)` / `shape(document)` / `inheritanceUsing(ownTable)` —
  **call-style paren modifiers**. This is the *only* place in Loom that spells
  "pick one value from a closed enum" as `f(x)`. Everywhere else — `type: postgres`,
  `kind: state`, `platform: node`, `persistence:` — that shape is a **colon clause**.
- `with auditable` — mixin application.

The modifiers are also **order-dependent** (the rule is a fixed sequence), so
`shape(document) persistedAs(eventLog)` is a silent parse failure.

### (2) `httpStatus <Error> <Code>` — the space-delimited triple

```
api SalesApi from Sales {
  httpStatus OrderClosed 409      // no colon, no arrow — reads like a shell command
}
```

`ApiStatus: 'httpStatus' error=ID code=INT;` — a bare space-separated triple, the
only config-ish clause in the language that isn't colon-keyed or arrow-bound.
**PR #1918** (structural-409 conflict names) makes this clause load-bearing:
`httpStatus UniquenessConflict 422` moves from a rarely-used override to something
the built-in conflict names make common. If it is ever reshaped, before it is
widely used is the cheap moment.

## Direction — one spelling per *category*, matching the rest of the language

Do **not** flatten every modifier to one syntax. They are genuinely different
kinds of thing and should stay visibly different; the fix is to make the
kind→syntax map consistent, so each category is spelled the way Loom already
spells that category elsewhere.

| Category | Members | Spelling | Precedent it matches |
|---|---|---|---|
| **Boolean adjective** | `abstract`, `crossTenant` | bare leading word | `private`, `eventSourced`, `transactional`, `raw`, `provenanced` |
| **Inheritance** | `extends Party` | keyword + ref (unchanged) | every language's `extends`; it's a relation, not config |
| **Enum-axis config** | `persistedAs`, `shape`, `inheritanceUsing` | **colon clause** `axis: value` | `type:`, `kind:`, `platform:`, `persistence:` |
| **Mixins** | `with auditable` | `with` clause (unchanged) | already consistent |

Two concrete moves:

1. **Hoist `crossTenant` to lead** alongside `abstract` (both adjectives before
   `aggregate`), so adjective position is uniform.
2. **Paren modifiers → colon clauses**, made **order-independent** (an interleaving
   `(…)*` group, the same shape the `deployable` block already uses in `ddd.langium`)
   — which also removes the silent reorder-is-a-parse-error papercut.

Before → after:

```
// before
abstract aggregate Invoice extends Party crossTenant
  persistedAs(eventLog) shape(document) inheritanceUsing(ownTable) with auditable { }

// after
abstract crossTenant aggregate Invoice extends Party
  persistedAs: eventLog, shape: document, inheritanceUsing: ownTable
  with auditable { }
```

And the api clause:

```
// before
httpStatus OrderClosed 409
httpStatus UniquenessConflict 422

// after — `->` reads as "maps to", matching route / link / migration-rename
httpStatus OrderClosed -> 409
httpStatus UniquenessConflict -> 422
```

### Why these choices (and the ones rejected)

- **Why keep the adjectives bare rather than `abstract: true`?** Boolean-as-presence
  is *already* the Loom idiom (`private`, `raw`, `transactional`). Bare adjectives
  are the consistent choice, not the exception.
- **Why colon for the axes, not bare words** (`eventSourced document ownTable`)? You
  lose the axis name — a reader can't tell `document` is a *shape* and `ownTable` a
  *layout* without memorizing three value sets, and it stays order-fragile. `axis:
  value` is self-documenting. Colon earns its keep exactly where the enum has a
  *name*; a bare word earns its keep where the flag *is* its own name.
- **Why keep `extends` a keyword, not `extends: Party`?** It's a cross-reference to
  another declaration, not a value-from-enum. `extends` / `with` are the two
  "relate to another decl" clauses and should stay keyword-led, distinct from the
  config colons.
- **Why not move the axes into the body?** Explicitly rejected by D-DOCUMENT-AXIS §4
  (all aggregate config on the header). Colon-on-header respects that decision — it
  only drops the parens.
- **Why `->` for `httpStatus`, not `status:`?** The grammar comment already notes
  `status:` was avoided to keep the ubiquitous `status:` field name free — correct.
  `->` sidesteps that collision entirely and matches the three existing "maps to"
  uses (`route … -> Handler`, `link "x" -> url`, `migration Agg.old -> new`).

## Grammar sketch

`Aggregate` header (colon axes, order-independent, both adjectives leading):

```langium
Aggregate:
    (isAbstract?='abstract')? (crossTenant?='crossTenant')?
    'aggregate' name=ID ('extends' superType=[Aggregate:ID])?
    (
        ('persistedAs' ':' persistedAs=TruthKind ','?)
      | ('shape' ':' shape=SavingShape ','?)
      | ('inheritanceUsing' ':' inheritanceUsing=InheritanceLayout ','?)
    )*
    withClause=WithClause? '{'
        members+=AggregateMember*
    '}';
```

`ApiStatus`:

```langium
ApiStatus:
    'httpStatus' error=ID '->' code=INT;
```

**Soft-keyword note.** `persistedAs` / `inheritanceUsing` are already header-only
tokens; as colon clauses they still lead a clause, so no new `LooseName` entries are
needed. `shape` is already soft (it's a common field name) — it stays hard **only**
in the header clause-lead position, exactly as today. `crossTenant` moving ahead of
`aggregate` is inside the same rule, no lexer change. Net: **no growth in the
soft-keyword lists** — this change does not touch the six identifier rules.

The `AST → .ddd` printers (`src/language/print/print-structural.ts`) and the
`unfold` code action must emit the new spelling; `print-completeness.test.ts` and
`print-structural-roundtrip.test.ts` gate that.

## Rollout — phase the breaking half; don't wait for a lull

`main` moves continuously under parallel agents, so "wait for fewer PRs" is not a
usable strategy. Split the change so only the piece that actually collides needs
timing:

- **Phase 1 — additive, accept-both (land anytime).** Grammar accepts the new
  syntax *and* keeps the old paren / space-triple forms parsing. Lowering treats them
  identically. **Zero fixture re-baseline, conflicts with nothing.** Ships a
  `loom.deprecated-header-modifier` / `loom.deprecated-httpstatus` info diagnostic +
  LSP fix-it that rewrites old → new in place. PR volume is irrelevant to this phase.
- **Phase 2 — codemod + remove old forms (time this one).** A `scripts/`
  codemod rewrites the whole corpus (`persistedAs(X)` → `persistedAs: X`, hoist
  `crossTenant`, `httpStatus E N` → `httpStatus E -> N`), then the grammar drops the
  old alternatives and fixtures re-baseline. This is the only fixture-churning piece,
  so land it in a gap between the big fixture PRs — **coordinate specifically against
  #1904 (paged-by-default), #1922 (handler params), #1920 (wireShape)**, not against a
  headcount. Precedent for the codemod shape: `scripts/migrate-workflows-to-create.mjs`.

Migration scope (corpus grep, 2026-07-14): ~27 `persistedAs(`, ~19
`inheritanceUsing(`, a subset of 68 `shape(` matches (many are doc comments /
`.shape()` method calls), 2 `crossTenant`, plus the `httpStatus` sites. All pure
regex rewrites.

## Open questions

1. **`httpStatus` scope creep.** Should Phase 1 also accept a block form
   (`httpStatus { OrderClosed -> 409, … }`) for apis overriding several statuses, or
   is the one-per-line clause enough? Lean: one-per-line only — a block is premature.
2. **Deprecation window.** Keep accept-both for one release then remove (Phase 2), or
   keep the old paren form indefinitely as an accepted alias? Lean: remove — a
   long-lived dual surface reintroduces the "two ways to spell it" cost this mission
   exists to kill. The codemod makes removal cheap.
3. **Split or combined PR.** The header change and the `httpStatus` change are
   independent surfaces. Lean: two PRs (header first — it's on every aggregate;
   `httpStatus` as the quick follow-up), one shared design doc (this file).

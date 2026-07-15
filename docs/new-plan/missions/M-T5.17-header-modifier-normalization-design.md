# M-T5.17 — Surface normalization: aggregate-header modifiers + `httpStatus` clause (design)

> **Status: DONE.** Phase 1 (accept-both colon, #1934) + Phase 2 cutover (paren
> removed, `crossTenant` hoisted, order-independent, corpus codemodded) both
> landed; `httpStatus` was hard-cut in #1918. The whole finding #1 is resolved.
> See §"Rollout".
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

> **DONE in #1918 (hard cutover).** The load-bearing PR reshaped this clause
> directly to arrow-only (`ApiStatus: 'httpStatus' error=ID '->' code=INT;`) and
> migrated the whole corpus in one commit, rather than the phased accept-both
> below. The httpStatus half of this mission is complete; the phased rollout
> plan applies only to item (1), the aggregate-header modifiers. The section
> below is retained as the design rationale.

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

- **Phase 1 — additive, accept-both. ✅ LANDED (enum-axis modifiers).** The
  `Aggregate` grammar now accepts the COLON form (`persistedAs: eventLog`,
  `shape: document`, `inheritanceUsing: ownTable`) alongside the legacy paren form,
  which stays accepted — both lower to the same field, so **every existing `.ddd`
  parses unchanged and no fixture re-baselines**. The structural printer emits the
  canonical colon form (roundtrip is structural, so the flip is safe); the two
  canonical examples (`event-sourcing.ddd`, `document.ddd`) are migrated to dogfood
  it; a parsing test pins colon≡paren AST-equality. **Scoping note:** the
  `crossTenant`-hoist half (move the flag to lead beside `abstract`) was **deferred
  to Phase 2** — carrying it in Phase 1 needs the flag assigned in two grammar
  positions, which trips Langium's `?=` duplicate-assignment warning; it is a low-
  value change (one `.ddd` fixture actually uses post-name `crossTenant`) best done
  in the cutover. The `loom.deprecated-*` info diagnostic + LSP fix-it are likewise
  deferred (optional polish).
- **Phase 2 — codemod + remove old forms. ✅ LANDED.** Timed to land *after* the two
  in-flight corpus churners (#1904 paged-by-default, #1933 versioning-default-on)
  merged, so the codemod swept up their occurrences too and nothing had to rebase. A
  codemod rewrote the whole corpus — **129 files / 408 edits** (`persistedAs(X)` →
  `persistedAs: X`, `shape`/`inheritanceUsing` likewise, `aggregate N crossTenant` →
  `crossTenant aggregate N`) across all `.ddd` + embedded-`.ddd` test strings — then
  the grammar dropped the paren alternatives + the post-name `crossTenant` position
  and made the three colon modifiers **order-independent** (interleaving `(…)*`, each
  led by a distinct keyword — no ambiguity, and the old silent reorder-parse-error is
  gone). **No fixture re-baseline** — colon and paren lower to the same field, so
  generated output is byte-identical; only `.ddd` inputs + grammar + printer changed.
  (`httpStatus` needed no Phase 2 — #1918 already hard-cut it to `->`.)

Migration scope (corpus grep, 2026-07-14): ~27 `persistedAs(`, ~19
`inheritanceUsing(`, a subset of 68 `shape(` matches (many are doc comments /
`.shape()` method calls), ~19 post-name `crossTenant` (1 `.ddd` + embedded test
strings). All pure regex rewrites.

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

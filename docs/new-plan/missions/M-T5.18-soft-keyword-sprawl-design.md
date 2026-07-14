# M-T5.18 — Soft-keyword sprawl: dedup, gate, and root-cause reduction (design)

> **Status: design-in-progress (draft PR claim).**
> Sources: language-surface review 2026-07-14 (finding #5 "soft-keyword sprawl");
> `src/language/ddd.langium` (`LooseName`, `NameRefIdent`, `MemberName`,
> `Property.name`, `StateFieldName`, `LValueIdent`); sibling missions M-T5.9
> (surface hygiene), M-T5.16 (compiler-internal fragility guards), M-T5.15 (BUG-004).

## Problem

The grammar carries **six parallel identifier rules**, each hand-maintaining a
large, heavily-overlapping list of soft keywords:

| Rule | Position | Approx size |
|---|---|---|
| `LooseName` | param / object-field / call-arg / menu-key names | ~60 |
| `NameRefIdent` | bare identifier in expression position | ~55 |
| `MemberName` | identifier after `.` | ~40 |
| `Property.name` | aggregate / VO / event field names | ~45 |
| `StateFieldName` | page / component `state {}` field names | ~25 |
| `LValueIdent` | assignment / bare-call statement targets | ~30 |

The lists are ~80% the same content, repeated six times. **Every new keyword the
grammar introduces must be threaded into the right subset of all six**, or user
code that used that word as a domain identifier silently stops parsing. The grammar
comments are a changelog of exactly this regression class:

- *"adding `money` (#498) silently broke any file that named a field `money` (e.g.
  `pokemon-world.ddd`)"*
- *"`state { kind: string }` stopped parsing the moment `'kind'` appeared as a
  literal in the `DataSource` rule"*
- BUG-004 (M-T5.15): *`resource`-keyword field-name collision* — the same failure,
  still open.

This is invisible to CI: **no test asserts that a keyword stays admissible as an
identifier.** The break surfaces only when a user (or an example) happens to name a
field the new keyword — which is precisely how the regressions above shipped.

## Root cause

Loom's design principle — **never steal a domain word** — is correct and worth
keeping. DDD models legitimately name fields `status`, `state`, `kind`, `filter`,
`query`, `error`, `type`, `title`, `body`, `order`, `action`, … So every keyword
Loom mints for its own structural syntax must remain usable as an identifier
wherever a user would naturally write a domain name.

Langium (chevrotain) tokenizes each grammar keyword literal as its **own token
type**. The moment `'kind'` appears as a literal anywhere in the grammar, the lexer
emits a `kind` keyword token, not an `ID` — so every position that expected `ID`
must be *manually re-widened* to also accept the `kind` token. The six lists are
that manual re-widening, done position-by-position, by hand, forever.

So the sprawl is not a design mistake — it is the *unmanaged* consequence of a good
principle meeting Langium's tokenizer. The fix is to **manage** it: dedup the
mechanism, gate it in CI, and stop minting keywords that don't need to exist.

## Direction — three tracks

### Track A — collapse the six lists to `ID | CommonSoftKeywords | <extras>`

Define one datatype rule holding the keywords that are soft **everywhere** (the
purely-defensive ones — payload family, storage/dataSource keys, page-metadata,
tenancy, retrieval, capability, generic carriers — that carry no structural meaning
in any identifier position). Each of the six rules becomes that shared rule plus its
small position-specific delta:

```langium
// The ~40 keywords admitted as identifiers in EVERY name position.
CommonSoftKeywords returns string:
      'payload' | 'command' | 'query' | 'response' | 'error'
    | 'paged' | 'envelope' | 'option'
    | 'kind' | 'schema' | 'tablePrefix' | 'keyPrefix' | 'ttl' | 'every'
    | 'retain' | 'isolationLevel' | 'readonly' | 'use'
    | 'instance' | 'connection' | 'service' | 'env' | 'literal'
    | 'tenancy' | 'crossTenant' | 'filter' | 'stamp' | 'implements'
    | 'retrieval' | 'sort' | 'loads' | 'asc' | 'desc'
    | 'description' | 'ogImage' | 'canonical' | 'favicon' | 'migration' | /* … */;

LooseName returns string:
    ID | CommonSoftKeywords | 'of' | 'id' | 'permissions' | 'contains' | /* LooseName-only extras */;

NameRefIdent returns string:
    ID | CommonSoftKeywords | 'ui' | 'api' | 'page' | /* NameRef-only extras */;
// …and likewise MemberName / Property.name / StateFieldName / LValueIdent.
```

**This works in Loom's Langium today** — datatype-rule composition is already in the
grammar: `QualifiedName returns string: LooseName ('.' LooseName)*` references the
`LooseName` datatype rule. A `returns string` rule may call another, so factoring
the common core out is a pure refactor.

**Byte-identical acceptance.** Track A does not change the language the grammar
accepts — only how the same acceptance is expressed. It is verifiable three ways
that already exist: (1) `langium-generated.yml` fails on any serialized-grammar
drift; (2) the parsing-test corpus pins behavior; (3) Track B (below) becomes the
exhaustive proof. Payoff: a new purely-defensive keyword is added in **one** place
and flows to all positions automatically — the "forgot to thread it into rule N"
regression class disappears for that (large) category of keyword.

### Track B — the completeness gate (the durable win)

The real prize is a **CI gate that fails when a keyword is added without keeping it
admissible as an identifier** — turning today's silent-user-breakage into a red
build. This is the exact pattern `print-completeness.test.ts` and
`walker-stdlib-completeness.test.ts` already use (enumerate from Langium reflection,
probe, assert), applied to keywords:

1. Enumerate every keyword literal in the grammar from the generated grammar AST
   (`src/language/generated/grammar.ts` / reflection) — the same reflection source
   the printer-completeness test reads.
2. For each keyword, attempt to parse a minimal `.ddd` that places it as an
   **identifier** in each canonical position (aggregate field name, parameter name,
   member access `x.<kw>`, bare name-ref, l-value target, `state {}` field).
3. Assert it parses — **unless** the keyword is in an explicit
   `INTENTIONALLY_HARD[position]` allowlist carrying a one-line reason (e.g.
   `contains` is hard as a containment-member lead; `create`/`destroy` are hard as
   lifecycle members; `state` is hard as the page block lead).

The day someone adds a keyword and forgets a position, CI names the keyword and the
position instead of a user finding it months later. The allowlist makes every
intentional hard-keyword a **reviewed, documented decision** rather than an
accident. This gate is valuable *independently* of Track A and should land first.

### Track C — root-cause reduction: stop minting config-key keywords

Many entries exist only because a config block spells its keys as literal keyword
tokens (`'kind' ':'`, `'schema' ':'`, `'every' ':'`, … in `Storage` / `Resource`).
The grammar already demonstrates the alternative — a validated `key=ID` prop-bag —
in `ThemeProp`, `RequirementProp`, `MenuMetaEntry`, and comments on it directly:

> *"Promoting these to grammar-level keywords would pollute the lexer and break user
> fields named `order` / `label` / `hidden`."* (`PageMenuMeta`)

Converting the keyword-keyed infra blocks (audit: `Storage`, `Resource`, and any
other `'<key>' ':'` block) to `ConfigEntry: key=ID ':' value` prop-bags, with the
key set enforced in the validator, means those ~15 keys **never become tokens** — so
they need zero soft-keyword entries in any of the six lists, and BUG-004
(`resource`-collision) stops being possible by construction. This is the only track
that shrinks the *actual keyword set* rather than managing it; it is per-block,
additive, and can be drained opportunistically.

Trade-off: prop-bags move key-name validation from parse-time to a `loom.*`
validator check (friendlier diagnostics, slightly later). That is already the
accepted pattern for `theme` / `requirement`, so it is consistent, not novel.

## Plan alignment

This sits between two existing missions and should cross-link, not duplicate them:

- **M-T5.9 (surface hygiene)** — `reserved-surface-signposting` + `with-implements`
  keyword-kind split. Sibling *theme* ("keep the surface honest") but different
  mechanism: M-T5.9 is about surface that *parses-but-emits-nothing*; M-T5.18 is
  about keyword literals *forcing manual ID re-widening*. Keep separate.
- **M-T5.16 (compiler-internal fragility guards)** — Track B is squarely a fragility
  guard, same spirit as M-T5.16's "exhaustiveness-check the parallel type-system
  walkers." Track B could land *as* an M-T5.16 sub-item; recommendation below keeps
  it here for cohesion but cross-references M-T5.16.
- **M-T5.15 (BUG-004, `resource`-keyword collision)** — a direct symptom; Track C
  resolves it. Note BUG-004 as "subsumed by M-T5.18 Track C" on the next refresh.

**Recommendation:** register as **M-T5.18**, sequence **B → A → C**. B (the gate) is
highest-value and de-risks everything after it; A (dedup) is a mechanical refactor
the gate then proves byte-identical; C (reduction) is an opportunistic drain of the
actual keyword count. All three are **P3, non-user-visible** (no `.ddd` a user
writes today changes meaning) — so they land anytime, independent of PR volume, with
near-zero merge-conflict surface (grammar-internal + one new test file).

## Rollout

1. **Track B first** — new `test/language/keyword-identifier-completeness.test.ts` +
   the `INTENTIONALLY_HARD` allowlist seeded from the current hard positions.
   Additive, zero grammar change. Immediately documents the true hard-keyword set.
2. **Track A** — factor `CommonSoftKeywords`; re-run `langium:generate`; Track B +
   the parsing corpus prove no acceptance drift. One grammar PR.
3. **Track C** — per-block prop-bag conversions, each its own small PR with a
   validator check + negative test; drains keyword entries and closes BUG-004.

## Open questions

1. **Gate strictness.** Should Track B probe *all six* positions for every keyword,
   or only the positions where the keyword could plausibly be a domain name? Lean:
   all six — the cost is a few ms of parsing and the allowlist documents the
   exceptions cleanly.
2. **`CommonSoftKeywords` boundary.** A keyword soft in five of six positions but
   hard in one (e.g. `create`) — put it in `CommonSoftKeywords` and mark the one
   hard position in that rule's extras, or keep it out of the shared core? Lean:
   shared core holds only the *soft-everywhere* set; anything with a hard position
   stays an explicit per-rule extra so the hard case is visible at the rule.
3. **Track C scope.** Which blocks convert? Audit needed — `Storage` / `Resource`
   are clear wins; `deployable` axis keys and the `auth {}` config keys need a
   case-by-case call (some carry closed enums that benefit from parser-level
   rejection). Not all keyword-keyed blocks *should* become prop-bags.

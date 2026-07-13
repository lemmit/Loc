# Architecture invariants — what "compatible with Loom" means

A feature is *compatible with Loom* when it respects the constraints below. The
feature-reviewer checks the design against this list before any code is written;
the feature-developer keeps to it; the final review re-checks it. Each invariant
has a *why* — when a proposal pushes against one, the question is whether the
design can be reframed to fit, not whether the rule can be bent.

## 1. The pipeline is one-directional
`language → ir → generator → system`. `language/` knows nothing about `ir/`;
`ir/` nothing about `generator/`; `generator/<platform>/` nothing about other
platforms; `system/` composes generator outputs and never emits domain code.
Enforced at runtime by `pipeline-layering.test.ts`. *Why:* the direction is what
lets a backend be added by writing emitters alone — no layer can reach back and
re-resolve something an earlier layer owns. A feature that "needs the generator
to influence lowering" is almost always mis-factored; move the decision up to
the IR.

## 2. There is no target-backend IR
Every backend consumes the single platform-neutral `LoomModel`
(`src/ir/types/loom-ir.ts`) directly. The only secondary IR is `MigrationsIR`,
derived once in phase ⑨ and shared by every database backend. *Why:* a
per-backend IR would re-introduce N copies of name resolution. If a feature
seems to want a backend-specific intermediate form, the resolved facts it needs
belong on `LoomModel` (carried for *all* backends), not in a private structure.

## 3. The IR is fully resolved — backends never re-resolve
Every name carries a `refKind`, every member access a `receiverType` /
`memberType`, every call a `callKind`, every find filter a typed `ExprIR`. *Why:*
this is the payoff for phase ⑤'s complexity. A new expression/statement must
carry *all* the resolution a backend would otherwise have to redo — if an
emitter would need to look up what a name refers to, lowering didn't finish its
job.

## 4. Derive, don't stamp
If a value is a pure function of facts already on an IR node, compute it on
demand — don't denormalize it into a stored field. Page *kind* is the canonical
example: classified from the role-scoped name + `area` via `classifyPage`
(`src/ir/util/page-kind.ts`), never stamped. *Why:* a stamped classification is
a cache with no invalidation story — the construction site that forgets to set
it is the bug. Store a fact only when it's a genuine input the pipeline can't
re-derive.

## 5. Macros emit final AST, not sentinels
A macro builds its complete expansion up front (so `unfold` ejects real `.ddd`
source) — never a placeholder that a later lowering pass rewrites. *Why:* the
split between "macro stamps a marker" and "pass X interprets the marker" is
almost always accidental; the later pass rarely has information the macro lacks.
There is deliberately no phase ⑤c and no `source`/`origin` tag.

## 6. Enrichment is one pure pass
Everything derived from the lowered model (`wireShape`, auto-`findAll`,
associations, react target inheritance, `migrationsOwner`) is computed in the
single pass in `src/ir/enrich/enrichments.ts`, producing the branded
`EnrichedLoomModel`. *Why:* one pass, one place to look; the brand makes an
un-enriched IR a type error downstream rather than a silent `wireShape!` cast.

## 7. The shared seams carry cross-backend features
- **Expressions:** `ExprTarget` (`src/generator/_expr/target.ts`) owns the
  17-arm `ExprIR.kind` dispatch + recursion *once*; each backend supplies only a
  leaf table. A new domain-logic backend writes one target, not a new
  dispatcher.
- **JSX-family pages:** `WalkerTarget` (`src/generator/_walker/target.ts`) over
  the shared `walkBody` (`walker-core.ts`), consumed by React/Vue/Svelte
  targets. Phoenix HEEx runs a *parallel* engine on purpose (LiveView's output
  topology — hoisted `handle_event`, `for`-comprehensions, `if`-block children —
  diverges from inline JSX).
*Why:* adding to a seam reaches every consumer at once and is byte-identical-gated.
A feature that bypasses the seam (hand-rolls one backend's expression rendering)
will silently skip the others.

## 8. Procedural emission only, with the shared vocabulary
Backend emitters build source with `lines(...)` from
`src/util/code-builder.ts` — no template engine. (Handlebars is alive, but only
in the design-pack layer.) Casing/pluralisation flows through
`src/util/naming.ts` (`pascal`/`camel`/`snake`/`plural`). The `STRING` terminal
strips its delimiters — re-quote on emission (`JSON.stringify`). *Why:*
consistency across ten targets comes from one set of primitives, not ten
hand-cased conventions.

## 9. Cross-aggregate references are `X id`
The scope provider restricts bare type/part references to entity parts in the
*same* aggregate; a cross-aggregate link must spell out `X id`
(`loom.bare-aggregate-in-type`). *Why:* aggregate boundaries are the DDD
consistency boundary — a bare cross-aggregate reference would imply a hard
object link Loom deliberately doesn't model.

## 10. Completeness gates are part of the contract
A new grammar node needs a printer arm (`print-completeness`); a new UI
primitive needs both walker mirrors (`walker-stdlib-completeness`) and a HEEx
renderer or a pinned reason (`heex-parity`); a new IR diagnostic needs a stable
`loom.*` code (`diagnostic-codes-completeness`). *Why:* these gates turn "I
forgot to update the other half" into a CI failure instead of a silently
degraded target.

## Reviewer's compatibility questions
When reviewing a proposal against the above, answer concretely:
1. **Does it fit the pipeline direction**, or does it ask an earlier phase to
   know about a later one?
2. **Where do the resolved facts live** — on `LoomModel` for all backends, or
   smuggled into one backend?
3. **Is anything stamped that could be derived?**
4. **Does it ride the shared seams**, so all relevant targets get it — or does it
   risk implementing one backend and orphaning the rest?
5. **Which completeness gates does it trip**, and does the design account for the
   mirror updates?
6. **Does it overlap something already shipped or in flight** (check fresh `main`
   + open PRs)? Loom's `main` moves fast and features are sometimes already
   partially landed.
7. **Does the surface syntax fit the grammar conventions** (discriminator fields,
   flat lists, soft keywords) and the existing DSL feel?

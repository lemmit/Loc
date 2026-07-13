# Concept-removal checklist (Mode B)

The sweep to run after a concept is **renamed or removed**, so its references don't
outlive it. This is the #1441/#1438/#1443 arc distilled, and the binding lesson is
`experience_gathered.md` §15: *"deleting a concept isn't done when the code compiles."*

## Why a removal needs a sweep at all

When you delete or rename a concept, the compiler removes the *symbol* for you — that's
the easy 20%. What it can't touch is everything that mentions the concept by **name** in
prose: header comments describing the old machinery, doc-comments on *adjacent* fields
that name the dead one, test names and framing, and `docs/` + `CLAUDE.md` text. Removing
`origin` / `source` / phase `⑤c` (#1408) took **five follow-up PRs** — #1416 the code,
#1431 the docs, #1438 + #1441 the comment/test drift — because *each scrub claimed "all
done" and the next grep found more*. The cost is real and it's recurring; this checklist
front-loads it into one pass.

## The sweep — grep the NAME of the concept, not just the symbol

The mistake that caused the five-PR tail was grepping only the removed *symbol*. Grep the
**name of the concept** — including human-readable variants, the phase number, the old
file/test names — across every surface, in one pass:

```
# Replace CONCEPT with every spelling: the symbol, the prose name, the phase tag,
# the old file/dir name. e.g. for the origin/source removal:
#   "origin", "source", "⑤c", "phase 5c", "expandInlineScaffoldPrimitiveCalls",
#   "walker-primitive-expander", "sentinel", "scaffold stamp"
rg -n "CONCEPT" src/ test/ docs/ CLAUDE.md experience_gathered.md
```

Run it across **all five surfaces** — missing one is how the tail re-accretes:

1. **`src/` — code comments.** Header comments and doc-comments are the worst offenders
   because the compiler never flags them. The live example: a `computeExports` comment
   at `src/language/ddd-scope.ts:100` survived the Langium 4 rename to
   `collectExportedSymbols` because it's prose, not a symbol. Watch especially for
   comments on *adjacent* surviving fields (e.g. `route`/`emitPath` comments that
   mentioned the dead `origin`).
2. **`test/` — test names and framing.** Test *titles* and `describe` blocks encode the
   old model even after the assertions are correct (the `walker-primitive-expander.test.ts`
   → `scaffold-page-bodies.test.ts` rename). A green test with a stale name still teaches
   the wrong concept.
3. **`docs/` — reference docs + proposals.** The proposal that introduced the concept,
   any reference doc that documented it, and the `docs/old/proposals/README.md` /
   `global-implementation-plan.md` status rows.
4. **`CLAUDE.md`.** The architecture summary names phases and concepts directly (it
   describes the ten-phase pipeline, `classifyPage`, the lack of a phase ⑤c) — a removal
   that touched the pipeline shape almost certainly has a CLAUDE.md line to update.
5. **`experience_gathered.md`.** The gotcha log may describe the old model in a retro; and
   if the removal established a new *rule* (derive-don't-stamp), this is where the
   guardrail belongs so the debt class doesn't re-accrete (§15 is exactly that).

## Telling residual doc-drift from a real code leftover

Each grep hit is one of two things — and they're handled oppositely, which is the whole
docs-only boundary:

- **Residual doc-drift (the common case).** The hit is a comment, doc, test name, or prose
  mention of a concept the code no longer has. **Fix the prose** to the current model.
  This is in-scope, docs-only, even when the file is a `.ts` (a code *comment* is prose).
  The `computeExports` comment is this case.

- **A real code leftover.** The hit is *live code* that still references the removed
  concept — a field still read, a function still called, a branch still taken. That means
  the removal was **incomplete**, not that the docs are stale. This is a code change, and
  it's **outside this skill** — flag it ("`X:NN` still references the removed `CONCEPT` in
  live code; the removal looks incomplete — that's a code fix, not a docs refresh") and
  hand it to the removal's owner or `language-feature-developer`. Do **not** quietly patch
  it under a docs banner.

The tell: is the hit *describing* the concept (prose/comment/test-name → docs-only, fix
it) or *using* it (live `import`/call/field-read → code, flag and stop)? When unsure,
read enough context to decide; never guess and edit.

## Order of operations

1. **Confirm the removal actually landed on fresh `main`** — `git fetch`, then grep for
   the removed *symbol* in live code. If it's still imported/called, the code half isn't
   done; stop and surface that (a stale base will show you a removal that hasn't happened).
2. **Sweep all five surfaces** for the concept *name* (above).
3. **Triage each hit** into residual-doc-drift (fix) vs real-leftover (flag).
4. **Fix the doc-drift hits**, docs-only.
5. **Re-grep** — each historical scrub claimed done prematurely; the second pass routinely
   finds more (renamed variants, the phase tag you didn't think to search). Treat one clean
   re-grep across all five surfaces as the done bar.
6. If the removal established a new rule, **record the guardrail** in
   `experience_gathered.md` so the class doesn't re-accrete (the #1443 move).

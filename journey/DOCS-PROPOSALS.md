# Docs updates & fixes — harvested from the build journey

Everything below is grounded in the five-stage journey (`journey/*.ddd`,
`FINDINGS.md`): the places a real user *got lost*, and the good features that
work today but aren't taught where you'd look for them. Each item says what's
wrong or missing, where it lives, the fix, and status.

**Status: all items shipped.** DR1 + DC1 landed in `b0bc9ca`; DR2, DC2, DC3,
DC4, WF1, PC1, and META landed in the follow-up docs pass on this branch. This
file is kept as the rationale record.

---

## Tier 1 — doc-rot (factually wrong; fix directly)

### DR1 — `crudish` "create/delete deferred" — **DONE** (`b0bc9ca`)
`docs/scaffold-macros.md` claimed *"`create` and `delete` are deferred… `crudish`
only emits `update`."* Verified false: `crudish` emits `create(...)`,
`update(...)`, and `destroy {}` today. Fixed: prose, the source-equivalent block
(which also carried a no-longer-parsing `this.` update lvalue), the per-surface
field rule, the `updateOnly` flag, and the summary bullet.

### DR2 — `auth-capabilities.ddd` header: "Hono doesn't compile query filters"
`web/src/examples/auth-capabilities.ddd:3-6` says *"Hono/Phoenix carry the IR but
don't yet compile the query filters."* Stage 4 verified the **node/Hono** backend
emits the per-request tenant filter *and* the soft-delete filter today
(`where(and(…, eq(projects.tenantId, requireCurrentUser().tenantId), not(eq(isDeleted, true))))`).
**Fix:** re-verify Phoenix on fresh `main`, then correct the header — at minimum
drop "Hono" from the exclusion; scope the caveat to whichever backends are still
actually IR-only. Cross-check the same claim in `docs/capabilities.md` (the
header points readers there).

**Why it matters:** this is the exact "docs move slower than code" trap CLAUDE.md
warns about — a stale header tells a user a shipped feature doesn't exist.

---

## Tier 2 — discoverability (features that work but aren't taught where you look)

### DC1 — Overriding a scaffolded page — **DONE** (`b0bc9ca`)
Override-by-name (write your own `page Detail` in the matching `area`; it replaces
the scaffolded one, siblings stay scaffolded) now has its own section in
`docs/scaffold-macros.md`, with override-vs-unfold guidance. This is the single
most important "graduate from no-code" mechanism, and the doc had never described
it — the whole reason the journey's Stage 5 nuked the scaffold instead of poking
one hole in it.

### DC2 — Aggregate construction asymmetry (`X { }` vs `X.create({ })`)
The first off-happy-path surprise (Friction #1): value objects/entity parts are
built with `X { … }`, aggregate roots with `X.create({ … })`. #2005 now catches
the mistake with a targeted diagnostic, **but no doc teaches the rule or the
why** (an aggregate has identity + invariants the factory enforces; a value
object is a plain literal). `docs/language.md` covers the `create` factory
*mechanics* but never contrasts the two construction forms.
**Fix:** a short "Constructing values vs. aggregates" note in `docs/language.md`
(near the create-factory section ~L348) and/or `docs/actions.md`, with both
forms side by side. Pairs naturally with the diagnostic.

### DC3 — One place for "which fields land in which payload"
Frictions #4 (managed field rejected from `.create()`) and #5 (scaffold rendered
`internal`/`secret` fields the api-read DTO omits) are the same missing knowledge:
the access-modifier → payload projection matrix. It exists today but **scattered**
— `docs/capabilities.md` (`forCreateInput`), `docs/generators.md` (the factory),
`docs/tenancy.md` (`internal` off create inputs). No single table answers "does
field X appear in create-input / update / api-read / full wire?"
**Fix:** one canonical table (in `docs/payloads.md` or the `docs/language.md`
access-modifier section) with a row per modifier
(`editable`/`immutable`/`managed`/`token`/`internal`/`secret`) × column per
surface (create · update · api-read · wire), and every other mention links to it.
This table alone would have pre-empted the two most expensive journey findings.

### DC4 — "Pit of success" advisories should be advertised
Two lovely nudges surfaced only by hitting them: the **index-suggestion**
advisory (`'Task.status' is read on a query filter but has no index. Consider
'index: Task.status'`) and the **bespoke-finder nudge** (steering a raw
`find byX(): T[]` toward a `criterion` + `Repo.run` / `retrieval`). Neither is
documented, so users don't know to expect or trust them.
**Fix:** a short "Advisories the compiler gives you" subsection in
`docs/criterion.md` / `docs/tools.md` listing the taste-enforcing warnings and
what each steers you toward.

---

## Tier 3 — workflow mental-model

### WF1 — `parse` ≠ `generate` (the late IR gate)
Friction #2: `ddd parse` reported 0 errors on an un-queryable retrieval; only
`ddd generate` caught it (the check lives in phase ⑦ IR-validate, which `parse`
doesn't run). `docs/tools.md:147` says *"`ddd parse` exits non-zero if the source
has errors"* — technically true but misleading: **parse runs AST validation only;
cross-aggregate / queryability / wire checks run at generate.** So parse-green ≠
model-valid.
**Fix:** one clarifying paragraph in `docs/tools.md` — parse = phases ①–④,
generate adds ⑤–⑨, so `generate` (or a `tsc` on the output) is the real gate in
an edit loop. Reinforces the "compile the emitted target" discipline the journey
proved essential.

---

## Tier 4 — papercuts

### PC1 — Field-separator convention (comma vs newline)
Hit three times: `event E { a: T, b: U }` uses commas; `aggregate A { a: T \n b: U }`
rejects them; a `deployable` flips to newline-only once a field uses the
`ui: Board { Work: api }` brace binding. **Fix:** document the actual rule per
construct in `docs/language.md` (a small table), or — better — link to the
grammar-reconciliation item already tracked as **P3** in `journey/PROPOSALS.md`
and fix it at the source instead of documenting the wart.

---

## Tier 5 — the meta-doc that ties it together

### META — "Graduating from no-code: the customization gradient"
The journey's central proof has no home in the docs: the smooth path from
`with scaffold(…)` (everything) → **override-by-name** (one bespoke page, rest
scaffolded) → **unfold** (materialise a scaffolded body and edit it) → fully
hand-written pages → the *same* `ui` served to multiple frontend frameworks. Each
piece is now documented in isolation; nothing walks the whole gradient end to end,
which is exactly the promise ("start no-code, end with no excuses") a new user is
evaluating.
**Fix:** a new short guide (e.g. `docs/customization-gradient.md`, linked from
`docs/README.md` and `docs/page-metamodel.md`) that walks the four rungs with a
running example, and states the "compile the emitted target is the real gate"
discipline. The journey files + `FINDINGS.md` are a ready-made worked example to
link as the long-form companion.

---

## What shipped (final)

- **DR1** — `docs/scaffold-macros.md` crudish create/update/destroy (`b0bc9ca`).
- **DR2** — `web/src/examples/auth-capabilities.ddd` header corrected: all five
  backends compile the capability query filters today.
- **DC1** — `docs/scaffold-macros.md` "Overriding a scaffolded page" (`b0bc9ca`).
- **DC2** — `docs/language.md` "Constructing values vs. aggregates" (`X { }` vs
  `X.create({ })`).
- **DC3** — refined the existing access-modifier matrix in `docs/language.md`:
  precise `token`-on-update cell, tied each column to its `wire-projection.ts`
  function, added the managed/internal/secret gotcha callout. (The table already
  existed — the proposal over-scoped this as "no table"; the real gap was
  precision + a findable gotcha, now fixed.)
- **DC4** — `docs/criterion.md` "Advisories" section (`loom.repository-find-deprecated`,
  `loom.index-suggestion`).
- **WF1** — `docs/tools.md` "parse green ≠ model valid" clarification.
- **PC1** — `docs/language.md` lexical-structure separator note (aggregate
  newline-only, event both, deployable brace-binding flip).
- **META** — new `docs/customization-gradient.md`, cross-linked from
  `README.md`, `page-metamodel.md`, `scaffold-macros.md`.

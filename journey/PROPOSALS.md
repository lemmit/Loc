# Proposed improvements

Drawn from the `01→05` build journey ([FINDINGS.md](FINDINGS.md)). Two of the
codegen bugs are already fixed in this branch; the rest are proposals, ordered by
value-to-cost. Each names the friction it closes, a concrete implementation
surface, and the CI gate that would prove it.

The unifying theme: **`generate` should never emit a project that fails its own
`tsc`/`vitest`.** Today it can, silently, and only compiling the output reveals
it. Every P0/P1 below is an instance of closing that gap.

---

## P0 — Type-check *every* generated web deployable in CI (systemic; cheap)

**Closes:** the blind spot that let Friction #5 ship in `examples/showcase.ddd`.

**Problem.** `react-build-cases.ts` type-checks exactly **one** web deployable
per example (`reactDir`, e.g. `console_web`). A system with a second frontend
(`admin_web`, a scaffold) is generated but never compiled — so a scaffold that
emits uncompilable TSX passes CI. This is *why* the internal-field bug (#5) was
invisible: showcase's `admin_web` has failed `tsc` on `row.isDeleted` for as long
as the scaffold+softDeletable combo existed.

**Proposal.** Change the react/vue/svelte/angular build gates to iterate **all**
emitted frontend project dirs, not just the first. Either type-check each, or (to
bound matrix cost) add one dedicated example that pairs a hand-written UI with a
scaffold-over-capability UI and compile both.

**Size/risk.** Small (harness loop + one example). Pure gate-strengthening — it
can only surface latent bugs, never introduce them.

**Gate.** `generated-react-build.yml` (+ vue/svelte/angular siblings).

---

## P1 — Validate `managed`/`internal`/`token` fields at aggregate-factory call sites

**Closes:** Friction #4 (`.create({ createdAt: now() })` → green DSL, red `tsc`).

**Problem.** The emitted `<Agg>.create(input)` type excludes server-owned
(`managed`/`internal`/`token`) fields, but a `.create({...})` in a domain `test`
or `operation`/`workflow` body may pass them with no diagnostic — the emitted
`*.test.ts` then fails `tsc`. The knowledge exists (`createInputFields` already
computes the exclusion); it just isn't enforced at the *call* site.

**Proposal.** In IR-validate (phase ⑦), for every aggregate-factory construction
(`X.create({...})`), reject keys that aren't in the factory input set, mirroring
the existing `loom.unknown-construction-field` gate for record constructions. New
code e.g. `loom.factory-field-not-constructible` (managed/internal/token) and
`loom.unknown-factory-field`.

**Size/risk.** Small–medium. Additive validator; the projection logic is reused,
so behaviour is defined by an existing single source of truth.

**Gate.** `test.yml` (new negative validator tests).

---

## P1 — Make a zero-argument `criterion` queryable inside a `retrieval`

**Closes:** Friction #3.

**Problem.** `criterion StillOpen() of Task = this.status != Done` used as
`retrieval … { where: StillOpen() }` is rejected as "call to `<expr>` (free)",
while a *parameterised* criterion in the same position works. The
queryable-subset classifier resolves a criterion **call** to its body only when
it carries arguments; a zero-arg call falls through to the free-function arm.

**Proposal.** In the queryable-subset walk (`src/ir/validate/checks/query-checks`
and the retrieval lowering), resolve a call whose callee is a `criterion` to its
inlined body **regardless of arity**, before the free-call rejection. A zero-arg
criterion is just a named predicate constant — it should inline like any other.

**Size/risk.** Small, but touches the queryability classifier — pair it with a
byte-identical-output check on an existing parameterised-criterion retrieval to
prove no regression.

**Gate.** `test.yml` (retrieval-generation + a new zero-arg criterion case).

---

## P2 — Teach the `Aggregate { }` construction diagnostic

**Closes:** Friction #1.

**Problem.** Writing `Task { title: … }` (mirroring value-object syntax) for an
aggregate yields `Unknown builder type 'Task'. Expected a ValueObject,
EntityPart, … (e.g., Stack, CreateForm, Card)` — a page-walker error that never
mentions the actual rule.

**Proposal.** When a bare `<Name> { … }` resolves to an `Aggregate`, special-case
the message: *"Aggregates are constructed through their factory —
`Task.create({ … })`, not `Task { … }`. The `{ }` literal is for value objects
and entity parts."* Purely a diagnostic improvement.

**Size/risk.** Small, validator-local.

**Gate.** `test.yml`.

---

## P2 — Close the `parse` ≠ `generate` gap

**Closes:** Friction #2 (queryability + other IR-level gates run only at generate,
so `ddd parse` reports 0 errors on an invalid model).

**Problem.** `ddd parse` runs phases ①–④ (through AST-validate) but not ⑤–⑦
(lower/enrich/IR-validate), so IR-level errors (un-queryable retrievals,
cross-aggregate checks) are invisible until `generate`. In an edit loop `parse`
green misleads.

**Proposal.** Two options — either is fine, pick one:
1. Add `ddd check <file>` that runs the full pipeline through phase ⑦ (no
   emission) and gates the exit code — the honest "is my model valid?" command.
2. Give `ddd parse` a `--deep`/`--ir` flag that runs through IR-validate.

Document it as the real pre-generate gate.

**Size/risk.** Small (the pipeline already runs to ⑦ inside `generate`; this
stops before ⑧-emit). Additive CLI surface.

**Gate.** `test/cli`.

---

## P3 — A generate-time "output references resolve" self-check

**Closes:** the whole *class* of #4/#5/#6 at once (defence in depth).

**Problem.** Bugs #4, #5, #6 were all "emitted code references something that
isn't there" — a column not on the projection, an import never registered. Each
was fixed point-wise; a structural guard would catch the next one before target
`tsc` does.

**Proposal (frontend).** After walking a page body, assert every field access on
a fetched record (`row.<f>`, `data.<f>`) resolves to a member of that query's
wire shape, and every identifier the emitted module references has a registered
import. Emit a `loom.*` diagnostic instead of silently writing broken TSX. This
is a lighter, generator-side echo of what the target `tsc` proves — but at
`generate` time, on every backend, without an `npm install`.

**Size/risk.** Medium–large (needs an import/scope model in the walker). Highest
value-per-bug over time, lowest certainty of clean landing — do it after the P0/P1
point fixes.

**Gate.** `test.yml` + the existing per-frontend build gates as the backstop.

---

## P3 — Grammar: reconcile the field-separator inconsistency

**Closes:** the comma-vs-newline papercut (three instances in the journey).

**Problem.** `event { a: T, b: U }` and most `deployable` bodies take commas;
`aggregate { a: T \n b: U }` and the `ui: X { … }` brace-binding deployable form
take newlines and reject commas. Nothing signals which context you're in until
the parser errors.

**Proposal.** Accept an **optional** separator (comma *or* newline) uniformly
across member lists — a small grammar change (`(',' | /\n/)?` between members).
Lower-priority (cosmetic, and a grammar change ripples through the committed
Langium output), but it removes a recurring stumble.

**Size/risk.** Medium (grammar + regenerate + `langium-generated.yml`); cosmetic
payoff. Weigh before doing.

**Gate.** `langium-generated.yml` + `test/language` parsing tests.

---

### Suggested order

1. **P0** (CI-every-webapp) — cheap, and it's the meta-fix that would have caught
   #5 without a human noticing. Do first.
2. **P1** validator (#4) and **P1** zero-arg criterion (#3) — small, self-contained,
   each closes a concrete silent failure.
3. **P2** diagnostics (#1) and `ddd check` (#2) — DX polish.
4. **P3** generate-time self-check and separator grammar — larger, do deliberately.

# From simple todo to full system — a Loom build journal

An experiment: build one app in Loom, growing it slice by slice from a
no-code-feeling scaffolded todo into a fully-customized multi-context system.
The question under test is Loom's promise — *start fast and easy like no-code,
then have a full app with no excuses*. Each stage is a runnable `.ddd` file in
this folder; this log records what was easy, what was missing, and what was hard
to customize when moving off the scaffolds.

Toolchain state: fresh `main` (post #1979). Every stage below `parse`s clean and
`generate system`s a full tree unless noted.

---

## Stage 1 — `01-todo.ddd`: the no-code start

**35 lines → 68 files.** One `aggregate Task with crudish`, one
`ui WebApp with scaffold(...)`, a node backend + a react frontend. Output is a
real full-stack tree: Hono API with a domain layer + http routes + migrations,
a React/Mantine SPA with home/list/detail/new pages, and a `docker compose up`
that wires postgres + api + web together with healthchecks and CORS.

What "free" actually buys at this stage:
- `with crudish` → create/update/destroy operations + `findAll` on the repo.
- `with scaffold(subdomains: [Core])` → the entire UI: a home dashboard, a
  per-aggregate list page, a detail page, and a new-item form — no page bodies
  written by hand.
- The compose file, Dockerfiles, DB init, health/ready endpoints, an obs
  envelope, and TLS certs are all emitted. Nothing to configure to boot.

**Friction at Stage 1: essentially none.** This is the strongest part of the
promise. `ddd new --template crud` even starts you one notch richer than this
(two aggregates + a cross-aggregate `find`). The no-code feel is real: you
describe shape, you get an app.

Notes for later stages: the scaffold is opaque here — you don't see the page
bodies until you either `unfold` a macro or hand-write pages. The interesting
question is Stage 5: how cleanly can you drop out of the scaffold into a fully
custom page without rewriting everything?

---

## Stage 2 — `02-domain.ddd`: real domain on top of the scaffold

Grew `Task` into an aggregate with a lifecycle: `Status`/`Priority` enums,
optional `due`/`notes` (`T?`), a server-stamped `createdAt: datetime managed`,
invariants, derived fields, three guarded operations (`start`/`complete`/
`reopen`), domain events, and inline `test` blocks. `with crudish` still applies
— free CRUD **composes** with hand-written operations, which is exactly the
"keep the easy parts, add the hard parts" story.

The generated domain is not a stub. `task.ts` has private `_status`, getters
only, and each operation compiles its precondition to
`if (!(...)) throw new DomainError("Precondition failed: status == Open")`,
mutates state, then emits. The migration picked up `status TEXT NOT NULL`, the
nullable `due`/`completed_at` columns, and the `tasks_status_idx` index.

### Friction #1 — aggregate construction syntax is asymmetric (real papercut)

My first instinct in a `test` block was `Task { title: ..., status: Open }`,
mirroring how value objects are built (`Money { amount: 1 }`). That fails with a
**confusing error**:

```
error: Unknown builder type 'Task'. Expected a ValueObject, EntityPart,
user-defined component, or stdlib walker primitive (e.g., Stack, CreateForm, Card).
```

The `X { }` literal is reserved for value objects / entity parts; an aggregate
root is constructed through its crudish factory, `Task.create({ ... })`. Two
issues here:
- The **rule is invisible from the error** — it talks about "builder types" and
  UI primitives (`Stack`, `CreateForm`), because the parser fell through to the
  page-walker grammar. Nothing points you at `.create({...})`.
- The **asymmetry itself** is a thing to learn: value objects use `{ }`,
  aggregates use `.create({ })`. Sensible once you know it (an aggregate has
  identity + invariants that the factory enforces), but it's the first "off the
  happy path" surprise and the diagnostic doesn't teach it.

*Wishlist:* when a bare `AggregateName { }` appears in an expression position,
special-case the diagnostic to "aggregates are constructed with
`Task.create({ ... })`, not `Task { ... }`".

### Nice touch — the indexing suggestion

Adding `find byStatus(...)` produced an advisory:
`'Task.status' is read on a query filter but has no index. Consider
'index: Task.status' on resource 'appState'.` Applying `index: [Task.status]`
cleared it and the column showed up in the migration. Good "pit of success"
nudge — the compiler noticing a performance smell in a DDD model is unusual and
welcome.

---

## Stage 3 — `03-projects.ddd`: a system, not a table

Added a `Project` aggregate that owns `Task` (cross-aggregate `project: Project id`),
repository `find`s, a `criterion`, a `retrieval` with sort, a `view`, and a
`workflow` that pages a query and mutates each row. **87 files.** Verified for
real this time — not just "generation succeeded":

- **Backend**: `npm install` + `tsc --noEmit` → **clean**. `npx vitest run domain`
  → **passing**. The workflow compiled to a genuine `for (const t of open) { t.complete(); }`
  then `getById` + `project.archive()`. The cross-aggregate ref became
  `FOREIGN KEY ("project") REFERENCES "work"."projects" ON DELETE RESTRICT` + an index.
- **Frontend**: React/Mantine `npm install` + `tsc --noEmit` → **clean**.

The multi-aggregate step is where Loom starts feeling like it's earning the "full
app" claim — real FKs, real orchestration, real query methods. But this stage
surfaced the two most important findings of the journey, both **silent failures**:

### Friction #4 (the big one) — `.create()` with a `managed` field: green DSL, red `tsc`

`createdAt: datetime managed` is server-stamped, so it is correctly **excluded**
from the generated `Task.create(input)` type. But my inline `test` wrote
`Task.create({ ..., createdAt: now() })`, and **nothing rejected it**:
`ddd parse` = 0 errors, `ddd generate system` = 87 files written, exit 0. The
break only showed up when I actually compiled the emitted project:

```
domain/task.test.ts(9,157): error TS2353: Object literal may only specify known
properties, and 'createdAt' does not exist in type '{ project: ProjectId; title:
string; status: Status; priority: Priority; due?: ...; notes?: ...; completedAt?: ... }'.
```

This is the "compiler ate it without error but the output is broken" case. The
DSL type-checker knows `createdAt` is `managed` (it drops it from the factory
input) yet doesn't flag passing it *into* that factory from a test body. **The
DSL's own test blocks aren't checked against the very factory signatures the DSL
generates.** A `.ddd` that parses clean and generates clean should not emit a
project that fails its own `tsc`/`vitest`. This is the single most valuable thing
the "actually compile it" discipline caught — every earlier stage that passed a
managed field into `.create()` was silently emitting a non-compiling test file,
and plain generation never told me.

*Fix in the model:* omit managed fields from `.create()`. *Fix Loom should make:*
validate `.create({...})` / record-construction call sites in domain test bodies
against the managed-exclusion rule (there's already `loom.unknown-construction-field`
for record constructions — the aggregate factory input needs the same gate).

### Friction #3 — zero-arg `criterion` isn't queryable (but one-arg is)

`criterion StillOpen() of Task = this.status != Done`, used as
`retrieval ... { where: StillOpen() }`, fails generation:

```
retrieval 'OpenA': where-clause is not queryable (call to '<expr>' (free)).
```

A **parameterised** criterion in the same position works
(`criterion Named(n) ...; where: Named(n)` generates fine — and `sales.ddd` ships
exactly that). So the queryable-subset classifier mis-reads a *zero-argument*
criterion call as a free-function call and rejects it. Workaround: give the
criterion a parameter, or inline the predicate. It's a real inconsistency —
zero-arg criteria are legal to declare but silently un-composable into retrievals.

### Friction #2 — `parse` is not `generate`: the queryability gate runs late

Related to #3: `ddd parse` reported **0 errors** on the un-queryable retrieval;
only `ddd generate` caught it (the check lives in phase ⑦ IR-validate, which
`parse` doesn't run). So `parse` green ≠ model valid. In an edit loop you learn
to run `generate` (or a `tsc` on the output) as the real gate, not `parse`.

### Small one — field-separator asymmetry

`event E { a: T, b: U }` uses commas; `aggregate A { a: T \n b: U }` uses
newlines and **rejects** commas (`Expecting token of type '}' but found ','`).
Minor, but it's a second small inconsistency (after the `{}` vs `.create()` one)
that you just have to memorise.

---

## Stage 4 — `04-saas.ddd`: the SaaS turn (capabilities + auth + tenancy)

The domain from Stage 3 didn't change. What changed is all *mixed in by name*:
`with tenantOwned, auditable, softDeletable, softDelete, versioned` on the
aggregates, a `user {}` claim shape, one line of `tenancy by user.tenantId of
Organization`, a `permissions {}` catalogue, `requires` gates, and
`auth: required` / `auth: ui`. **92 files.**

This is the most impressive part of the language. The **backend** (`tsc` clean,
domain test passing) genuinely emits, with zero hand-threading:

- **Per-request tenant read filter** on every query:
  `where(and(..., eq(schema.projects.tenantId, requireCurrentUser().tenantId), ...))`.
- **Soft-delete filter** folded into the same `where`: `not(eq(isDeleted, true))`.
- **Optimistic concurrency**: `update(...).where(and(eq(id,...), eq(version, expected)))`
  with `version: expected + 1` and a 409 path.
- **Registry self-scoping**: `Organization` reads scope to
  `eq(organizations.id, requireCurrentUser().tenantId)` — derived purely from the
  `tenancy by` line, no marker on the aggregate.
- **`requires` → `ForbiddenError` (403)**, distinct from `precondition` → 400.
- Auth JWT-decode middleware, audit-stamp interceptors, `currentUser` plumbing.

Doc-rot note: the shipped `auth-capabilities.ddd` header says Hono "doesn't yet
compile the query filters" (only .NET). **Stale** — the node/Hono backend
compiles the tenant + soft-delete filters today. (Confirmed the docs move slower
than the code, exactly as CLAUDE.md warns.)

### Friction #5 (the headline) — the scaffold UI breaks at the SaaS turn — FOUND **and FIXED**

This is the single most important finding, and it's a **silent codegen bug**:
the moment you add `tenantOwned`/`softDeletable` to a **scaffolded** aggregate,
the generated **React app stops compiling**. Parse ✅, `generate system` ✅ (92
files), but `tsc` on the frontend:

```
src/pages/projects/list.tsx(65,42): error TS2339:
  Property 'tenantId' does not exist on type '{ id; name; archived; ... }'.
src/pages/projects/detail.tsx(225,112): Property 'isDeleted' does not exist ...
  (also dataKey, on tasks/* as well)
```

**Root cause.** The scaffold's list/detail builders enumerate *every* aggregate
property (`propertiesOf(agg.members)`), but the API-read wire DTO
(`forApiRead`, `src/ir/enrich/wire-projection.ts`) correctly **excludes
`internal`/`secret`-access fields**. The capability mixins inject exactly those:
`tenantOwned` → `tenantId`/`dataKey` (`internal`), `softDeletable` → `isDeleted`
(`internal`). So the scaffold renders `row.tenantId` / `row.isDeleted`, the
client type omits them, and `tsc` fails. Managed fields (`createdBy`,
`deletedAt`) and `token` (`version`) are on the wire and render fine — it's
specifically `internal`/`secret` that break.

**It ships today.** `examples/showcase.ddd` already triggers this: its
`ui Admin with scaffold(subdomains: [Accounts])` scaffolds `Squad with ...
softDeletable`, and the emitted `admin_web/src/pages/squads/list.tsx` references
`row.isDeleted` even though `SquadResponse` omits it. CI never catches it because
the React build gate (`react-build-cases.ts`) only type-checks **one** web
deployable per example (`console_web`, the hand-written one) — `admin_web` (the
scaffold) is generated but never compiled. A latent, shipped, uncompilable
frontend hiding behind a single-deployable gate.

**Fix applied** (`src/macros/stdlib/scaffold/_body-builders.ts`): a new
`apiVisibleProperties()` helper drops `internal`/`secret` fields, used at the two
aggregate-root display sites — `scalarColumnsForAggregate` (list columns) and
`buildDataCardParts` (detail rows). Views (`viewColumnFields`) and containment
parts are deliberately left wider — an admin view response may legitimately
include `internal`. After the fix: Stage 4's frontend `tsc`s clean, and
showcase's `admin_web` no longer references `isDeleted`. Added a regression test
(`scaffold list/detail — internal & secret fields stay off the page`) and the
full macro + react/vue/svelte/system suites stay green (655 + 540 tests).

**Why this matters for the promise.** "Start no-code, end with no excuses" has a
gap precisely at the no-code→real-app inflection: the built-in SaaS capabilities
and the built-in scaffold UI didn't compose. You'd hit it the first time you made
your scaffolded app multi-tenant — the most common possible second step — and the
only signal was a `tsc` error in generated code you didn't write. Two built-ins
that every "graduate from no-code" path crosses need to compose cleanly, and now
they do.

---

## Stage 5 — `05-custom.ddd`: "no excuses" (fully hand-written UI × two frameworks)

The finale: **no `with scaffold`**. Every page (`Home`, `Board`, `TaskNew`,
`TaskConsole`, `ProjectList`) is hand-written from the closed page-primitive
library — `Stack` / `Toolbar` / `Breadcrumbs` / `QueryView` / `Table` / `Column`
/ `EnumBadge` / `Paper` / `Card` / `KeyValueRow` / `CreateForm` / `OperationForm`
/ a reusable `component TaskActions(task: Task)` with instance-qualified
`Action { task.start }` buttons. And the **same `ui Board` is served to two
frontend frameworks** — a React/Mantine deployable and a Vue/Vuetify deployable —
off one node backend. **115 files.**

Verified hard: **React `tsc` clean**, **Vue `vue-tsc` clean**, **backend `tsc`
clean**. One custom UI spec → two framework implementations that both
type-check. When it works, this is the most convincing evidence for the whole
pitch: the page primitives really are framework-neutral, and "no excuses"
extends to "and pick your framework."

But getting here surfaced the second silent codegen bug — again only visible by
actually compiling the output.

### Friction #6 — a bare `OperationForm { inst.op }` emits un-imported code — FOUND **and FIXED**

Hand-writing a detail console, I put operation forms straight into the page:

```
data: t => Card { Stack {
  OperationForm { t.start }, OperationForm { t.complete }, OperationForm { t.reopen }
}}
```

Parse ✅, generate ✅ (115 files) — then React `tsc` explodes with ~30 errors:

```
task_console.tsx: Cannot find name 'modals'.  Cannot find name 'notifications'.
Cannot find name 'applyServerErrors'.  Cannot find name 'Group'.  Cannot find name 'Button'.
```

**Root cause.** An instance-qualified `OperationForm` renders as a module-scope
modal component (`openStartModal` + `StartForm`) that references the pack's modal
shell — `modals`, `notifications`, `applyServerErrors`, `Button`, `Group`. But
`emitFormOfOperation` **deliberately skipped registering those imports**, on the
assumption it's always wrapped in `Modal { OperationForm {…} }` (the shape the
*scaffold* emits), letting `emitModal` register them. A **bare** op-form in a
hand-written body has no enclosing Modal, so the page shell emits the component
but its imports never land. No diagnostic — the compiler happily wrote a file
that can't compile.

This is the same failure *class* as Friction #4/#5: the DSL accepts input its own
codegen can't honour, and only a real `tsc` on the output reveals it. And it bites
exactly on the "no excuses" path — the moment you stop using the scaffold and
compose primitives yourself, which is the whole point of Stage 5.

**Fix applied** (`src/generator/_walker/primitives/forms.ts`): `emitFormOfOperation`
now calls `addImportsForPrimitive(ctx, "primitive-modal")` itself. The op-form's
module component is *always* emitted from recorded state (Modal-wrapped or not),
so it must own its imports; `addImportsForPrimitive` no-ops for packs without the
key and is idempotent when a Modal also registered it. It's pack-agnostic — the
same shared walker feeds React/Vue/Svelte/Angular/Feliz. After the fix, Stage 5's
React *and* Vue apps both type-check. Added a regression test (`bare op-form (no
enclosing Modal) in a hand-written page`); the full generator suite stays green
(2400+ tests across all frontends).

### Small ones

- **Deployable field separators flip with the api-binding brace form.** The
  comma-separated deployable style (`platform: node,` …) that worked in Stages
  1–4 **breaks** when a field uses the `ui: Board { Work: api }` brace binding —
  `Expecting '}' but found ','`. You must switch that deployable to
  newline-separated fields. Third instance of the comma-vs-newline separator
  inconsistency in the journey (after events-vs-aggregates and this).
- **Bespoke list finders are nudged, at parse time.** Adding `find
  byProject(...): Task[]` produced a *warning* steering me to a `criterion` +
  `Repo.run` or a `retrieval` instead. Good taste-enforcement — but note it's one
  of the few validations that DOES fire at `parse` (Friction #2 is that most
  don't).

---

## Retrospective — does the promise hold?

**Yes, with two caveats that this journey both found and fixed.**

The arc worked end to end. Five stages, each a runnable `.ddd`, each verified by
actually compiling the emitted target (not just "generation succeeded"):

| Stage | What it adds | Backend | Frontend |
|---|---|---|---|
| 1 `01-todo` | scaffolded CRUD todo | — | — |
| 2 `02-domain` | enums, invariants, operations, events, tests | `tsc` ✓ · `vitest` ✓ | `tsc` ✓ |
| 3 `03-projects` | 2nd aggregate, FK, criterion, retrieval, view, workflow | `tsc` ✓ · `vitest` ✓ | `tsc` ✓ |
| 4 `04-saas` | tenancy, auth, capabilities, versioning, permissions | `tsc` ✓ · `vitest` ✓ | `tsc` ✓ (after fix) |
| 5 `05-custom` | fully hand-written UI × React + Vue | `tsc` ✓ | React `tsc` ✓ · Vue `vue-tsc` ✓ (after fix) |

### The "start fast" half is genuinely excellent

Stages 1–4 add enormous capability for almost no code. The standouts:
- **Composition of built-ins.** `with crudish, tenantOwned, auditable,
  softDeletable, versioned` stacks cleanly; free CRUD coexists with hand-written
  operations. You bolt on multi-tenancy, audit trails, soft-delete, and
  optimistic concurrency by *naming* them — the backend reifies per-request
  tenant filters, 409 version guards, and registry self-scoping with zero
  hand-threading. This is the most impressive part of the language.
- **The domain code is real**, not a stub — private state, precondition guards
  throwing `DomainError`, emitted events, real FKs with `ON DELETE RESTRICT`,
  real indexes, and inline `test` blocks that actually run.
- **Nice pit-of-success touches**: the index-suggestion advisory, the
  bespoke-finder nudge toward criteria/retrievals.

### The "no excuses" half works — but the seams between built-ins and custom leaked

Every hard finding clustered at one fault line: **the DSL accepts input its own
codegen can't compile, with no diagnostic.** Plain `parse`/`generate` stays green;
only compiling the emitted target reveals it. Three instances, escalating in
importance:

1. **#4 — managed field in `.create()`**: an inline `test` passes a `managed`
   field to the factory that (correctly) excludes it → emitted `*.test.ts` fails
   `tsc`. The DSL's own test blocks aren't checked against the factory signatures
   the DSL itself generates.
2. **#5 (headline) — scaffold + capabilities don't compose**: the moment you make
   a scaffolded aggregate `tenantOwned`/`softDeletable`, the scaffold renders
   `internal` fields the wire DTO omits → the whole React app fails `tsc`. This
   ships **today** in `examples/showcase.ddd`'s `admin_web`, invisible because the
   CI React gate only compiles one web deployable per example. **Fixed** — the
   scaffold now honours the API-read projection.
3. **#6 — bare `OperationForm` in a custom page**: the primitive assumes a
   surrounding `Modal` for its imports; used standalone it emits un-imported code.
   **Fixed** — the op-form self-registers its modal-shell imports.

The through-line: **two built-ins that both sit on the no-code→custom path (the
SaaS capabilities and the scaffold UI; the scaffold and the raw primitives)
didn't compose, and the only signal was a `tsc` error in generated code.** The
promise isn't "every feature works" — each does, in isolation and in the shipped
examples. It's that the *combinations a user hits when graduating from no-code to
real* weren't all gated. Fixing #5 and #6 closed the two a first real app crosses.

### What would most raise the floor

**Make `generate` verify its own output shape.** A cheap validator pass — "does
every field a scaffold/primitive references exist on the projection it fetches;
does every emitted component's identifiers resolve to a registered import" —
would have caught #4, #5, and #6 at compile time instead of at target-`tsc` time.
Better still, extend the CI React gate to type-check **every** web deployable,
not just the first: that alone would have caught #5 before it shipped.

### Papercuts (documented inline above)

- Aggregate construction asymmetry: `X { }` for value objects, `X.create({ })`
  for aggregates — with a misleading "Unknown builder type" error (#1).
- `parse` ≠ `generate`: queryability and other IR-level gates run only at
  generate, so `parse` green ≠ valid model (#2).
- Zero-arg `criterion` isn't queryable in a retrieval, though one-arg is (#3).
- Field-separator inconsistency: commas in `event {}` and most deployable bodies,
  newlines in `aggregate {}` and the `ui: X { … }` brace-binding deployable form.

# Plan — drive `examples/showcase.ddd` to 100% feature coverage

> **DONE (2026-06-30).** All 161 instantiable AST kinds + all 48 walker
> primitives covered; `HARD_GATE = true`. `MacroArgString`/`MacroArgInt`/
> `ImportStmt` allowlisted (unreachable from a single-file `.ddd` fixture).
> Bugs found are logged in [`../audits/showcase-coverage-bugs.md`](../../audits/showcase-coverage-bugs.md).


Tracking PR: #1623 · branch `claude/showcase-parity-ci-0qtvxc` · bug log:
[`docs/audits/showcase-coverage-bugs.md`](../../audits/showcase-coverage-bugs.md).

## Goal & rule

Make the showcase exercise **every instantiable AST kind, every walker
primitive**, each paired with a `test`/`test e2e` so the feature is *behaved*,
not merely emitted — so both `conformance-parity` (structural) and
`conformance-full` (behavioural, cross-backend) become meaningful gates. When
extending surfaces a bug, **log it in the bug report and keep going** — do not
fix it here.

Per-slice loop:
1. Add the feature + a test to `showcase.ddd`.
2. `node bin/cli.js parse` → 0 errors.
3. completeness test → lower+IR-validate clean (the generation gate).
4. `node bin/cli.js generate system … -o /tmp/x` → no throw on any backend.
5. Any crash / honest-gap / divergence → new BUG-NNN entry; revert just the
   offending bit if it blocks the gate, keep the rest.
6. Commit. Periodically request the `run-conformance` label for the behavioural
   cross-backend confirmation.

## Coverage baseline (honest, post BUG-001/002 fixes)

- AST kinds: **64/164 instantiable uncovered**.
- Walker primitives: **12/48 uncovered** — `Bold, CodeBlock, DestroyForm,
  Icon, InlineCode, Italic, MultilineField, OperationForm, Section,
  SelectField, Sticky, WorkflowForm`.

## Slices (ordered: backend/parity value first, then UI, then config)

Grammar lines refer to `src/language/ddd.langium`. ☐ = todo.

### S3 — Literals & domain-logic statements (backend, parity-relevant)
☐ `MoneyLit` `money("10.50")`, `ListLit` `[3,2,1]`, `PrimitiveConversion`
`string(age)`, `TypeAtom` (union return arm). ☐ `ReturnStmt` (return-typed
op/function), `ForStmt` (loop over a retrieval), `IfLetStmt` (`if let x = …`).
Tests: unit `test` asserting each computed result. *Risk: ForStmt/IfLetStmt
render-stmt support varies per backend → likely bug source.*

### S4 — Payloads & unions (backend)
☐ `PayloadDecl` record form (`command`/`query`/`response`/`error`), named-union
form (`payload R = A | B`), `VariantArm` (`match` arm), `TypeAtom` (`A or B`
op return). docs/payloads.md, inheritance.md. e2e asserting the response shape.

### S5 — Query cluster (backend)
☐ `Criterion` (`criterion Active of X = …`), `Retrieval` (`retrieval … of X =
…`), `SortItem` (`sort: [total desc]`), `LoadPath`/`LoadSegment` (`loads:
[lines[].product]`), `RetrievalLiteral` (`Repo.run(retrieval { … })`).
docs/criterion.md + retrieval proposal. e2e driving the retrieval.

### S6 — Capabilities (backend)
☐ `Capability` + `FilterDecl` + `StampDecl`, `ImplementsDecl` (explicit
`implements`), `SensitivityClause` (`sensitive(pii)`), `SelfType` (`parent:
Self id`). docs/capabilities.md.

### S7 — Domain services (backend)
☐ `DomainService` + `DomainServiceOperation`. docs/old/proposals/domain-services.md.
*Risk: maybe node-only → honest gap on other backends.*

### S8 — Workflow event handlers (backend)
☐ `HandleDecl` (`handle confirm(id) { … }`), `OnDecl` (`on(e: Evt) { … }`),
workflow `Apply`. docs/workflow.md.

### S9 — Seeds
☐ `Seed` + `SeedRow` (`seed default { X { … } }`). docs/old/proposals/database-seeding.md.
*Risk: per-backend seed emission.*

### S10 — Auth config
☐ `AuthBlock` + `OidcConfig` + `ClaimsMap` + `ClaimEntry` + `LiteralAuthValue`
+ `EnvAuthValue`. docs/auth.md. (No shipped example uses these — highest-value
gap.)

### S11 — Connection / config sources
☐ Four resources each with a different `connection:` source —
`ServiceConnectionSource`/`EnvConnectionSource`/`SecretConnectionSource`/
`LiteralConnectionSource` — plus a `config: { … }` map with `ConfigEntry`
covering `StringConfigValue`/`IntConfigValue`/`BoolConfigValue`.

### S12 — Layout & page metadata (UI)
☐ `Layout` + `LayoutMainSlot` + `LayoutNamedSlot`, a page with `LayoutProp`
(`layout:`) + `DescriptionProp`/`OgImageProp`/`CanonicalProp`.

### S13 — UI primitives (12) + stores/channels/notifications
☐ Slot the 12 missing primitives into pages: `Bold, CodeBlock, DestroyForm,
Icon, InlineCode, Italic, MultilineField, OperationForm, Section, SelectField,
Sticky, WorkflowForm`. ☐ `Store` + `ActionDecl`, `Channel` + `ChannelSource`,
`UiChannelParam` + `UiNotification`.

### S14 — UI param types & api contract
☐ `SlotType` (`component X(h: slot)`), `ActionType` (`component X(on:
action(Order))`), `UiFunction` (extern ui function), `ApiStatus` (`httpStatus
NotFound 404` in an api block).

### S15 — Macro scalar args
☐ `MacroArgString`/`MacroArgBool`/`MacroArgInt`/`MacroArgRef` — needs a macro
that accepts scalar params (only the ref-list arg is exercised today). *May be
unexercisable without a suitable stdlib macro → investigate / allowlist.*

### S16 — Imports / multifile
☐ `ImportStmt` — requires a companion `.ddd` the harness will resolve; the
single-file fixture may need a sibling. *Investigate harness handling before
adding; may stay allowlisted with a reason.*

### Finalize
☐ Allowlist anything genuinely unexercisable (with reasons). ☐ Flip
`HARD_GATE = true`. ☐ Roll the bug report into follow-up issues.

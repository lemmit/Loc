# Typed capabilities — implementation plan

> Implements [`../proposals/typed-capabilities.md`](../proposals/typed-capabilities.md):
> promote the stringly-typed capability surface (`implements "X"` /
> `filter for "X"` / `stamp for "X"`) to a first-class **pure-mixin**
> `capability { fields + filter + stamp }` declaration. Each step is a
> **byte-identical-IR migration** (regenerate every `.ddd` × backend, sha256
> before == after — the gate used for the `ExprTarget`/`WalkerTarget` work).
>
> The downstream payoff is [`../proposals/capability-emission-dedup.md`](../proposals/capability-emission-dedup.md)
> (typed-capabilities OQ#1), which needs a stable capability identity this work
> provides.

## Key architectural decision — capabilities expand like macros, resolved by name

A typed `capability` is the **declared, in-language successor to the
field/filter/stamp macros** (`audit`/`softDelete`). It is **not** a new IR
construct and **not** a Langium cross-reference. Concretely:

- The `capability` body holds the same AST member nodes a macro emits today —
  `Property` / `FilterDecl` / `StampDecl`.
- A reference (`with auditable` / `implements auditable`) is **resolved by the
  macro expander's document-wide inventory** — the same mechanism macro names
  and macro-arg refs already use (`ddd.langium:864-875`), with diagnostics
  pointing at the call site. It is **not** a `[Capability:ID]` linker cross-ref.
- At expansion (phase ②, the `IndexedContent` listener in
  `src/macros/expander.ts`) the capability's members are **spliced into the host
  aggregate's `members[]`**, indistinguishable from user-written ones — exactly
  what the macros do now (`expander.ts:58-62`). Everything downstream (scope,
  linking, lowering, enrichment, validation, codegen) is **unchanged**: fields,
  filters, and stamps flow through the established paths.

**Why name-resolution, not Langium cross-refs.** Macro expansion runs *before*
linking (phase ② → ③); a true `[Capability:ID]` cross-ref couldn't be resolved
in time to drive expansion. Name-resolution against the expander inventory
sidesteps the phase-ordering problem and matches the proposal's framing
("unfoldable … as the field-adding macros do today"). The typed-capabilities
*wins* — existence-checking (no silent `implements "auditabl"` no-match),
find-implementors, go-to-definition — are delivered by a real validator + a
custom LSP `DefinitionProvider` (phase 5), not by routing through the linker.

**Why lowering is safe to leave untouched in early phases.** Top-level / system
members are dispatched in `lower.ts` by `.filter(isType)` passes, *not* an
exhaustive switch (`lower.ts:263-318`, `:506-530`). A new `Capability`
declaration that no pass picks up is simply ignored — so the grammar can land
before any behavior wires up.

## Phases

### Phase 1 — grammar + AST (byte-identical; this PR)

- Add `Capability` (`'capability' name=ID '{' (members+=CapabilityMember ','?)* '}'`)
  and `CapabilityMember = Property | FilterDecl | StampDecl` to `ddd.langium`;
  add `Capability` to the `SystemMember` union (top-level declarable).
- `npm run langium:generate`; commit the regenerated `src/language/generated/*`
  (gated by `langium-generated.yml`).
- Parsing test: a `capability { field; filter; stamp }` declaration parses;
  members populate. No lowering, no behavior — the decl is inert (ignored by the
  filter-based lowering dispatch).
- `'capability'` is a new hard keyword; verified unused as an identifier in any
  `.ddd` (all current occurrences are comments).

### Phase 2 — expander resolves + splices (the behavior slice) ✅

- `src/macros/expander.ts`: `Capability` added to the per-document inventory;
  when a `with <name>` clause names no macro but a declared capability, the
  capability's `Property`/`FilterDecl`/`StampDecl` members are **deep-cloned**
  (Langium `AstUtils.copyAstNode` + the language `Linker.buildReference`, so each
  clone's cross-references re-link in the Linked phase) and spliced into the host
  aggregate's `members[]` — one independent clone per implementor.
- **Precedence (intentional, additive):** a macro wins on a name collision, so
  the stdlib `audit`/`softDelete`/… macros still resolve to the macro until they
  migrate in Phase 3. New (non-macro-named) capabilities resolve to the
  capability. The unknown-name diagnostic is now "Unknown macro or capability".
- **Existence-checking** (the proposal's core motivation) falls out of the
  expander: a `with X` that is neither macro nor capability is an error.
- **Scope guard:** a capability applied to a `context` errors (aggregate-scope
  only in Phase 2; context-level `with` is Phase 4).
- Tests: `test/ir/capabilities/typed-capability-equivalence.test.ts` proves
  capability-via-`with` == hand-written filter/stamp/field IR, reuse across many
  aggregates clones independently, the capability decl body itself raises no
  validation error, and both error paths fire.
- **Cross-file note:** Phase 2 assumes the `capability` decl and its `with` use
  are reachable in the same workspace build (the inventory is workspace-aware);
  the deferred cross-file re-check that macro *ref-args* get
  (`collectUnresolvedMacroRefs`) is a Phase 4 refinement alongside context-level
  application.

### Phase 3 — built-in capability prelude + stdlib migration

**Delivery mechanism (the prelude):** macros are delivered by code; a capability
is delivered by source.  `src/macros/prelude.ts` ships canonical built-in
capabilities (built with the same AST factories the macros used, so their nodes
— crucially the `User` cross-references — match the macro output: plain
`{ $refText }` refs that resolve leniently, no "could not resolve" diagnostic).
`expander.ts` merges them into the per-document capability inventory; a
user-declared capability of the same name wins.

- **`audit`/`auditable`/`auditedByDefault` → built-in `capability auditable`** ✅
  Collapses the former state/behavior split into one co-located declaration
  (fields + create/update stamps).  The three macros were removed; `with
  auditable` (aggregate) and `with auditable` at context (the `auditedByDefault`
  replacement) now resolve to the capability.  Examples (`auth-capabilities.ddd`,
  `erp/hr.ddd`) migrated: the context `audit` clause is dropped (the per-aggregate
  capability self-stamps).  Equivalent generated output (stamps move from
  context-propagated to aggregate-co-located; same `contextStamps` IR;
  `implementsCapabilities` no longer carries `"auditable"`, which no backend
  consumes).
- **`softDelete` family → built-in `capability softDeletable` + `softDelete` ops
  macro** ✅  The capability supplies `isDeleted` (internal) + `deletedAt`
  (managed) + `filter !this.isDeleted`; the `softDelete` macro (repurposed from
  the old *context filter* macro to an *aggregate ops* macro) supplies
  `softDelete()`/`restore()`.  `softDeleteByDefault` (kept) emits a context-level
  typed `implements softDeletable` (fans the capability to every aggregate) +
  per-aggregate `softDelete`.  Usage: `aggregate Order with softDeletable,
  softDelete`.  The old `softDeletable` (state) + `softDelete` (context filter)
  macros were removed; the e2e build fixtures were already hand-written (legacy
  `filter for`/`implements` string forms), so the slow backend legs are
  unaffected.
- `crudish` / `scaffold*` **stay macros** (operations / structure).

## End state — the stringly forms are removed, not kept as sugar

**Decision (owner):** the stringly-typed surface (`implements "X"` / `filter for
"X"` / `stamp for "X"`) is a **temporary migration bridge, not a permanent
deprecation path.** The endgame removes it entirely and ports every
`examples/*.ddd`, `web/src/examples/*.ddd`, fixture, and test to the typed
`capability` form. Each phase below keeps the string form working *only* so the
migration can proceed incrementally; Phase 6 deletes it.

This raises the stakes on Phase 3 (stdlib migration): the `audit`/`softDelete`
macros currently *emit* `implements "string"` / `filter for "string"` nodes, so
they must move to typed capabilities before the string grammar can be deleted.

### Phase 4 — typed `implements` + context-level application ✅

- **4a — context-level `with`** (`0c24089`): `context C with <Cap>` splices an
  independent clone of the capability into every aggregate in the context (the
  `*ByDefault` replacement); override-by-name lets an aggregate's explicit member
  win; a capability on a `ui` errors.
- **4b — typed `implements`**: `ImplementsDecl` now accepts `implements <Cap>`
  (bare id, resolved via the expander inventory) as a **synonym of `with <Cap>`**
  — a pure capability application (splice), at aggregate or context scope. The
  legacy `implements "string"` group-opt-in form keeps parsing as a transitional
  bridge (removal in Phase 6). `collectImplements` / `collectContextLevelCapabilities`
  skip name-less (typed) `ImplementsDecl`s so they never pollute the string
  `implementsCapabilities` group. Printer updated for both forms.
- **Decision:** `implements <Cap>` is a **body member** (consistent with the
  legacy `implements "X"` position), not an aggregate-*header* clause. The
  proposal's header sugar (`aggregate Org implements tenantRegistry { … }`) is a
  separate, optional ergonomic addition — `with` already covers the header case —
  deferred unless desired. No deprecation *warning* on the string form yet (it
  would fire across every existing example/test); warnings land with the Phase 6
  migration so the suite stays clean meanwhile.

### Phase 5 — `Self` type, tooling, marker emission (feeds dedup)

- **`Self` type** ✅ (proposal OQ#3) — `Self id` is a self-referential anchored
  type valid only inside a `capability` body (Eiffel `like Current` / Swift–Rust
  `Self`).  Grammar adds a `SelfType` base; the expander rewrites `Self id` →
  `<Host> id` at splice time (per implementor), so lowering and the backends only
  ever see a concrete `X id` — **zero backend work**.  `lowerField` now threads
  the env so the rewritten FK recovers the host's `idKind` (not default guid).
  A validator rejects `Self id` outside a capability; `parent` is now a soft
  field-name keyword so the canonical `parent: Self id?` parses.  **Generics
  stay deferred** — `Self` is an anchored type, not parametric polymorphism, and
  the existing `paged`/`envelope` carriers are a closed, emission-gated set that
  wouldn't shortcut user generics (see the discussion in the PR thread).
- **Remaining:** LSP (go-to-capability / find-implementors / completion) and
  marker-interface emission (`I<Capability>`) — the seam
  [`capability-emission-dedup.md`](../proposals/capability-emission-dedup.md)
  consumes.

### Phase 6 — remove the stringly forms (the cleanup the owner asked for) ✅

- **6a** — migrated every real (non-test) usage to the typed form: `tenantScoped`
  → a user-declared `capability tenantScoped { filter … }` + `with tenantScoped`
  (auth-capabilities.ddd, erp/hr.ddd); e2e java-build fixtures moved to
  aggregate-level `filter` / dropped functionless `implements "auditable"`.
- **6b** — removed the grammar forms: `FilterDecl`/`StampDecl` lost the
  `for "<name>"` qualifier, `ImplementsDecl` is now `'implements' cap=ID` only.
  Lowering dropped the qualified-filter/stamp matching and `collectImplements`;
  the vestigial `AggregateIR.implementsCapabilities` field (no backend reader)
  and the `implementsCapability` (string) / `capability:`-option factories were
  removed; printer simplified. Deleted the tests that existed only to exercise
  the string mechanism.

## Soft-delete migration — capability + `softDelete` ops macro (decided)

The `softDeletable` macro adds `isDeleted`/`deletedAt` + filter **and** the
`softDelete()`/`restore()` **operations**.  A `capability` is a pure mixin
(fields + filter + stamp) — operations stay macros (proposal guardrail).  Split:

- **`capability softDeletable { isDeleted + deletedAt + filter !this.isDeleted }`**
  — built-in (state + filter, co-located).  Replaces the old `softDeletable`
  (aggregate fields) + `softDelete` (context filter) macro pair.
- **`softDelete` macro (aggregate)** — just the `softDelete()`/`restore()`
  operations.  (Owner's call: `with softDelete` reads better than an
  `*Ops`-suffixed name; `softDeletable` is now the capability.)
- Usage: `aggregate Order with softDeletable, softDelete`.
- `softDeleteByDefault` (context) → fans the capability (state + filter) + the
  `softDelete` ops macro to every aggregate.

Migration note: `softDelete` flips from a *context* macro (old: filter) to an
*aggregate* macro (new: ops), so every `context … with softDelete` clause is
dropped (the per-aggregate capability co-locates the filter) and every
`aggregate … with softDeletable` gains `, softDelete` where the ops are wanted.
IR-equivalent; ~18 source/fixture/test files affected.

## Deferred (proposal scope guardrails)

Capability parameters (`searchable(on: name)`, OQ#2), capability-implements-
capability, provided operations, default-method overridability — all out of
scope until a concrete case appears.

## Status

- [x] Phase 1 — grammar + AST + parse test.
- [x] Phase 2 — expander splice + existence checking + scope guard + equivalence tests.
- [x] Phase 3 — built-in prelude; **audit** → `capability auditable`; **softDelete** → `capability softDeletable` + `softDelete` ops macro.
- [x] Phase 4 — typed `implements` (synonym of `with`) + context-level `with`.
- [ ] Phase 5 — `Self`, tooling, marker emission.
- [x] Phase 6 — **removed** the stringly forms; migrated all examples/fixtures/tests to typed.
- [ ] Phase 5 — `Self` type, tooling, marker emission (only remaining work).

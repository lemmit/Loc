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

### Phase 2 — expander resolves + splices (the behavior slice)

- Extend `src/macros/expander.ts`: build a per-document inventory of `Capability`
  declarations; when a `WithClause` `MacroCall` (or a typed `implements`, phase
  4) names a capability rather than a macro, splice the capability's
  `Property`/`FilterDecl`/`StampDecl` members into the host aggregate's
  `members[]` (origin-tagged for unfold). Unknown name that is neither macro nor
  capability → the existing "unknown macro" diagnostic, now capability-aware.
- Validator: an `implements`/`with` naming no declared capability is an **error**
  (resolves the proposal's core "silent no-match" motivation); a capability with
  no implementors is allowed (armed-but-inactive, matching today's string rule).
- Gate: author one `.ddd` two ways (string form vs `capability` + `with`) →
  identical IR; full byte-identical regen.

### Phase 3 — migrate the stdlib (one capability per PR, each byte-identical)

- `softDelete`/`softDeletable`/`softDeleteByDefault` → `capability softDeletable`.
- `audit`/`auditable`/`auditedByDefault` → `capability auditable`.
- `crudish` / `scaffold*` **stay macros** (operations / structure). Each
  migration sha256-gated across all backends.

### Phase 4 — typed `implements` + context-level application

- `ImplementsDecl`: accept `name=[Capability:ID]`-style typed ref **with the
  STRING form kept as back-compat sugar** (`'implements' (cap=… | name=STRING)`).
  Resolution still via the expander inventory; STRING stays a deprecation path.
- Context-level application — `context Sales with auditable` applies the
  capability to every aggregate in the context (the `*ByDefault` replacement);
  grammar + propagation in `lower-capabilities.ts`.

### Phase 5 — `Self` type, tooling, marker emission (feeds dedup)

- `Self` type resolution for self-referential provided fields (`parent: Self id?`
  → `Org id?` on `Org`) — grammar + scope/type-system (proposal OQ#3).
- LSP: custom `DefinitionProvider` (go-to-capability), find-implementors,
  completion. Marker-interface emission (`I<Capability>`) — the seam
  [`capability-emission-dedup.md`](../proposals/capability-emission-dedup.md)
  consumes.

## Deferred (proposal scope guardrails)

Capability parameters (`searchable(on: name)`, OQ#2), capability-implements-
capability, provided operations, default-method overridability — all out of
scope until a concrete case appears.

## Status

- [x] Phase 1 — grammar + AST + parse test.
- [ ] Phase 2 — expander splice + existence validator.
- [ ] Phase 3 — stdlib migration (softDelete, audit).
- [ ] Phase 4 — typed `implements` + context-level `with`.
- [ ] Phase 5 — `Self`, tooling, marker emission.

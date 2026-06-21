# Multi-file `.ddd` source — implementation plan

> **Scope of this document.** Splitting a Loom project across multiple
> `.ddd` source files (one `system` per project, contexts in their own
> files, shared value-objects / enums at the root level).  This is
> *source-file packaging* and is unrelated to `packaging-split.md`,
> which is about distributing the toolchain as installable npm packages.

> **Update.** Stage A (below) shipped only the *shared-types* half (root-
> level value objects / enums / components).  The "contexts in their own
> files" goal is now delivered by
> [`../proposals/implicit-system-composition.md`](../proposals/implicit-system-composition.md):
> any top-level `subdomain` (and the whole deployment shape) composes into
> the project's single `system`.  See that proposal for the current surface.

## Goal & non-goals

**Goal.** Let a Loom project be split across multiple `.ddd` files,
with a single conventional entry (`main.ddd`) and per-file path-based
`import`s.  Currently-supported reference semantics stay identical;
only file organisation changes.

**Non-goals (this plan).** Cross-context commands, event
subscriptions, traits, derived / templated aggregates, package
distribution.  Future stages, sketched at the end.

**Acceptance principle.** Every existing single-file example, when
split into N files, must generate **byte-identical output** to its
single-file form.  This is the regression check the whole effort is
held against.

---

## Stages

### Stage A — file splitting (active)

Pure mechanical.  Zero new domain capabilities.  Just `import`,
multi-file workspace, and root-level value-objects / enums (the only
new visibility).

### Stage B — cross-context `X id` (deferred)

Identity-only references across contexts via `uses` + `export`.  No
behaviour crosses the boundary (no commands, no events, no
subscriptions).

### Stage C+ — deferred indefinitely

- **Stage C** — cross-context commands.  Runtime mediator/bus per backend.
- **Stage D** — events as published language: `export event` +
  `workflow … on Ctx.Event as e`.  Per-backend event bus / outbox.
- **Stage E** — `trait` / `with`.  AST-level expansion pass.

---

## Stage A — work items

### 1. Grammar (`src/language/ddd.langium`)

- Add `imports+=ImportStmt*` to the top of `Model`.
- New rule:
  ```
  ImportStmt: 'import' path=STRING ';'?;
  ```
- Promote `ValueObject` and `EnumDecl` to `ModelMember` alternatives
  (today they only appear as `ContextMember`).
- Run `npm run langium:generate` to refresh the generated parser/AST.

### 2. Workspace loading

- New `loadProjectFromEntry(entryUri, services)` helper in
  `src/language/` that:
  1. parses the entry document,
  2. walks its `imports` transitively, resolving each `path` relative
     to the importing file,
  3. registers every reachable document with
     `shared.workspace.LangiumDocuments`,
  4. calls `DocumentBuilder.build([...all])` once with validation
     enabled,
  5. returns the entry document + a flat list of all loaded documents.
- Error on missing import targets, circular imports, and (later) on
  duplicate root-level VO / enum names.

### 3. CLI (`src/cli/main.ts`)

- A new `parseProject(entryFile)` alongside `parseFile`.  Uses the
  workspace loader.
- `generate system <file>` always uses `parseProject`.
- `generate ts <file>` and `generate dotnet <file>` (legacy
  single-deployable modes) stay on `parseFile` for now to preserve
  their semantics — they don't compose multi-file output anyway.
- The merged `Model` that the rest of the pipeline consumes contains
  the union of every loaded document's `members`.

### 4. Scope (`src/language/ddd-scope.ts`)

- `DddScopeComputation.collectExportedSymbols` already exports
  aggregates / entity parts / value objects / enums under their bare
  name via `streamAllContents` — that machinery covers root-level VOs
  and enums automatically once the grammar admits them.
- No change to `DddScopeProvider` — Langium's default global-scope
  fallback resolves cross-document references once every document is
  registered.

### 5. Validator (`src/language/ddd-validator.ts`)

- Import path resolves (file exists, is `.ddd`).
- No circular imports.
- No duplicate root-level VO / enum names across the workspace.
- No duplicate context names across the workspace.
- Warn on imported-but-unused files (optional, easy to add).

### 6. IR (`src/ir/loom-ir.ts` + `src/ir/lower.ts`)

- Extend `LoomModel`:
  ```ts
  /** Root-level value objects, defined at the top of any .ddd file
   *  (outside any context).  Visible from every context in the
   *  workspace — the implicit shared kernel for data types. */
  rootValueObjects: ValueObjectIR[];
  /** Root-level enums.  Same visibility rules as rootValueObjects. */
  rootEnums: EnumIR[];
  ```
- `lowerModel` collects these from the merged `Model.members`.
- `lower-expr.ts` type resolution for `NamedType` already resolves via
  the linker's reference (which now spans documents).  The local
  type-lookup table needs to fall back to `model.rootValueObjects` /
  `model.rootEnums` when not found in the current context.

### 7. Generators

Each backend emits root VOs / enums to a shared location:

| Backend | Location |
|---|---|
| TS / Hono | `src/shared/` (re-exported per service) |
| .NET | `Shared` namespace, dedicated `Shared.csproj` |
| React | `src/shared/types/` |
| Phoenix | `lib/shared/` |

Backend orchestrators read `model.rootValueObjects` and
`model.rootEnums` and emit them once into the shared location.
Per-context emitters import from there.

The system orchestrator (`src/system/`) copies the shared module
into each deployable that needs it.

### 8. Tests

- Parsing: happy multi-file, missing import, circular import,
  duplicate-symbol diagnostics.
- Scope: root VO / enum visible from contexts in other files; a
  cross-context aggregate ref **still errors** (Stage A preserves
  today's restriction).
- IR: root VO / enum lowering and placement.
- Regression: pick 2–3 existing examples
  (`examples/acme.ddd`, one from `web/src/examples/`); split each
  into multi-file form; diff against single-file baseline.  **Gating
  test.**
- One `LOOM_TS_BUILD=1` run on a multi-file example.
- One walker fixture run on a multi-file example with React.

### 9. Docs

- `docs/tools.md` — CLI accepts main.ddd; transitive imports.
- `docs/language.md` — `import` + root-level VO / enum surface.
- `experience_gathered.md` — append the lessons.

---

## Stage A — sequencing

1. Grammar + `langium:generate`.
2. Workspace loader + CLI changes.
3. Scope + validator (mostly already covered; small adjustments).
4. IR / lowering for root VOs / enums.
5. One backend (TS) emitting the shared module — prove end-to-end.
6. Roll out shared-module emission to .NET / React / Phoenix.
7. Regression-test every example in multi-file form.
8. Docs + `experience_gathered.md`.

Each step ends with a clean test pass.  Order is dependency-driven;
skipping forward without earlier steps doesn't compile.

Rough budget: ~4–5 focused days for Stage A.

---

## Stage B — deferred plan

### Grammar
- `export` modifier on `Aggregate` (Stage B exports identity only —
  the aggregate's name becomes referenceable, not its members).
- `UsesDecl: 'uses' ctx=[BoundedContext] ('.' (single=[NamedDecl] | '{' multi+=[NamedDecl] (',' multi+=[NamedDecl])* '}'))? ';'?` at context top.

### Scope
- `DddScopeProvider.getScope` for `IdType.target`: when not found in
  local context, walk the enclosing context's `uses` declarations,
  look the target up among the source context's `export`ed
  aggregates.

### Validator
- Unknown context in `uses`.
- Reference to a non-exported aggregate.
- Cross-context `X id` without matching `uses`.

### IR / lowering
- Extend `findEntityByName` in `lower-expr.ts`: fall back to
  cross-context lookup via the `uses` allowlist.
- No IR shape changes — `X id` is already a typed reference;
  resolution just spans contexts now.

### Generators
- No runtime change (Stage B is identity only; an `X id` is just a
  guid / int either way).
- Wire-spec & DTO emission: a field of type `Id<OtherCtx.Order>`
  serialises identically to `LocalOrder id`.

### Tests
- Validator coverage of all four error cases.
- One multi-context example with cross-context Id ref; assert
  generated TS + .NET compile.

Budget: ~1–2 days on top of Stage A.

---

## Decisions captured

| Decision | Captured value |
|---|---|
| Import style | Per-file path imports |
| Project discovery | Transitive imports from `main.ddd`; no manifest, no autodiscovery |
| Visibility boundary | Bounded context (not file, not module) |
| Root-level decls | Only VOs / enums; ambient by import |
| Files per context | One (convention; grammar tolerates more) |
| `system` | Exactly one per project |
| Aggregate sharing across contexts | Not in Stage A; identity-only via `export` + `uses` in Stage B |
| Cross-context behaviour (commands / events) | Deferred to C / D |
| Inheritance / traits / derivations | Deferred to E or dropped |

## Risks

- **Generator drift.** Root VO / enum placement differs per backend.
  Mitigated by the Stage A regression test diffing every example
  against its single-file baseline.
- **Scope leakage.** Langium's default global scope could leak
  symbols across documents in ways we don't want.  Mitigated by
  explicit unit tests for visibility (root VOs visible everywhere;
  cross-context aggregate refs still errored in Stage A).
- **CLI legacy paths.** `generate ts` / `generate dotnet` were
  single-doc; multi-file might break them.  Mitigated by keeping them
  single-doc; only `generate system` does workspace loading.
- **Playground (browser).** The web playground uses `EmptyFileSystem`
  and a single in-memory document today.  Stage A's multi-file CLI
  path does not affect the playground; the playground will need its
  own VFS-backed equivalent if/when it grows multi-document support.
  Out of scope for Stage A.

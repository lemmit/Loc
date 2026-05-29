# Plan — Restoring cross-backend OpenAPI parity

> Status: in-flight design note. Captures the review of the failing
> `conformance-parity` gate and the staged plan to make Hono / .NET /
> Phoenix agree on one contract again.

## 1. What failed

`test/e2e/e2e.test.ts > cross-check (3-way): Hono / .NET / Phoenix
OpenAPI parity` fails in strict mode (`LOOM_E2E_STRICT_PARITY=1`, set by
`.github/workflows/conformance-parity.yml`). The first hard assertion to
trip is `onlySchemasRef` on the **hono ↔ dotnet** pair:

```
schemas only on hono: [
  BuildListResponse, BuildState, EngineerListResponse, ErrorResponse,
  ProjectListResponse, ProjectSummaryResponse, ProvenanceLineage, Visibility
]
```

`expect(...).toEqual([])` aborts the test there, so the remaining
divergences (`requiredDiffs`, `paramTypeDiffs`, `responseBodyDiffs`,
`operationIdDiffs`) and the **hono ↔ phoenix** / **dotnet ↔ phoenix**
pairs never get evaluated. They are still real and will surface as the
earlier ones are fixed — this plan addresses all of them.

The diff machinery is in `test/_helpers/openapi-normalize.ts`; the
doctrine ("one DSL source → one contract; all three backends agree") is
in `docs/conformance.md`. Hono uses `@hono/zod-openapi`, .NET uses
Swashbuckle reflecting over controllers at runtime, Phoenix uses
OpenApiSpex.

## 2. Review — root cause of every reported divergence

Generated from `examples/showcase.ddd` via
`node bin/cli.js generate system examples/showcase.ddd -o <out>` and
inspected directly. Findings grouped by where the fix belongs.

### Group A — genuine .NET gaps (Phoenix already matches Hono)

| # | Divergence | Evidence | Fix lands in |
|---|---|---|---|
| A1 | **Named list-response schemas missing** (`ProjectListResponse`, `BuildListResponse`, `EngineerListResponse`, `ProjectSummaryResponse`). Drives `onlySchemasRef` for these 4 **and** all six `responseBodyDiffs` (`hono=ProjectListResponse` vs `dotnet=array<ProjectResponse>`). | .NET controllers return `Task<ActionResult<IReadOnlyList<ProjectResponse>>>` → Swashbuckle emits an inline `{type: array, items: $ref}`. Hono does `z.array(ProjectResponse).openapi("ProjectListResponse")`; Phoenix has `schemas/project_list_response.ex` (`type: :array` named component). | .NET generator |
| A2 | **No `required` on any schema** (`requiredDiffs`: every request/response schema shows `required-only-hono=[…] required-only-dotnet=[]`). | `AddSwaggerGen` (`src/generator/dotnet/emit/program.ts:282`) is bare — no `SupportNonNullableReferenceTypes`. Hono marks non-`.nullish()` zod fields required; Phoenix emits explicit `required: [...]`. | .NET generator |
| A3 | **No `operationId` on any op** (`operationIdDiffs`: `hono=createProject, dotnet=(none)` ×22). | Controller actions carry no `[EndpointName]`; Swashbuckle isn't configured with `CustomOperationIds`. | .NET generator (+ see B1 for the *value*) |

Phoenix already emits A1 (named list schemas) and A2 (`required: […]`),
so .NET is the lone outlier on those two. A3 is missing on .NET only,
but the *value* is a three-way problem — see B1.

### Group B — three-way contract disagreements (no backend is canonical yet)

| # | Divergence | Current state per backend | Decision needed |
|---|---|---|---|
| B1 | **operationId convention** | Hono camelCase: `createProject`, `getProjectById`, `allProject`, `renameProject`, `byNameProject`, `registerProjectWorkflow`, `activeProjectsView`. Phoenix snake_case with different stems: `create_project`, `get_project_by_id`, `list_project`, `rename_project`, `by_name_project`, `run_register_project`, `query_active_projects`. .NET: none. | Pick **one** canonical convention and derive it from a single shared helper consumed by all three. Even once .NET emits ids, hono ↔ phoenix would still fail (`createProject` ≠ `create_project`, `allProject` ≠ `list_project`). |
| B2 | **Enum schemas** (`Visibility`, `BuildState`) | Hono: named enum component (`z.enum([...]).openapi("Visibility")`), referenced by request + response fields. Phoenix: inline `type: :string` (no enum constraint, no named schema). .NET: DTOs carry `string Visibility`, enum type never reaches the wire → no schema. | Promote to named, value-constrained enum schemas in **.NET + Phoenix** (recommended — strongest contract, clients see allowed values), or demote in Hono (weakest). |
| B3 | **Path-param type** `string` vs `string:uuid` | Hono: `z.string()` → `string`. **Phoenix: `type: :string, format: :uuid`. .NET: `Guid` → `string:uuid`.** So Hono is the **minority** here. | Make **Hono** emit `z.string().uuid()` for id path params to match the other two (ids *are* uuids — the cleaner direction). |

### Group C — Hono-only wire extensions that the diff should *filter*, not force onto others

| # | Schema | Why it is legitimately Hono-only | Fix |
|---|---|---|---|
| C1 | `ProvenanceLineage` | Co-located provenance (`<field>_provenance`) is documented in `openapi-normalize.ts:fieldSet` as "a TS/Hono-only wire extension — only the TS backend persists lineage". The provenance *fields* are already excluded from `fieldSet`/`requiredSet`, but the `ProvenanceLineage` *component schema* is not excluded from `schemaNames`, so it trips `onlySchemasRef`. | Extend the `schemaNames` filter (test helper) to drop provenance-only schemas, consistent with the existing field-level exclusion. |
| C2 | `ErrorResponse` | Hono names a `{ error: string }` envelope and `$ref`s it from 400/404 responses. .NET returns `ProblemDetails` (already in the `FRAMEWORK_SCHEMAS` filter); Phoenix declares `404 => description: "Not found"` with no body schema. | Either (a) standardize a shared error envelope across all three backends' declared error responses, or (b) add `ErrorResponse` to the framework/error-envelope filter alongside `ProblemDetails`. (b) is the low-risk parity fix; (a) is the better long-term contract. |

## 3. Recommended decisions

- **B1 operationId** → adopt **camelCase** (Hono's current scheme) as canonical; it is already correct in one backend and is the OpenAPI-idiomatic style most client generators expect. Phoenix changes its emitter; .NET adopts it.
- **B2 enums** → **promote** to named enum schemas in .NET and Phoenix. Strongest, most useful contract.
- **B3 path-param** → make **Hono** emit `format: uuid`. Two of three already do, and ids are uuids.
- **C1** → filter `ProvenanceLineage` in the test helper (provenance is a deliberate TS-only extension).
- **C2** → start with the filter (b) to get green, track (a) as a follow-up if a shared error contract is wanted.

These keep the *strongest* contract wherever feasible and only relax the
gate (C1/C2) where a divergence is by-design rather than a defect.

## 4. Staged implementation plan

Each phase is independently shippable and leaves the gate strictly
no-worse. Run order is chosen so the cheap, decision-light wins land
first.

### Phase 0 — shared operationId helper (prereq for B1)
- Add `src/ir/util/openapi-ids.ts` (or `src/util/`) exporting pure
  functions: `opIdForCreate(agg)`, `opIdForGetById(agg)`,
  `opIdForList(agg)`, `opIdForOp(agg, op)`, `opIdForFind(agg, find)`,
  `opIdForWorkflow(wf)`, `opIdForView(view)` — all camelCase.
- Unit test pinning every shape against the showcase aggregates.

### Phase 1 — Hono path-param uuid (B3)
- `src/platform/hono/v4/routes-builder.ts`: id path params →
  `z.string().uuid()`. Touches getById, operation, find param schemas.
- No DTO change. Smallest diff; clears all 8 `paramTypeDiffs`.

### Phase 2 — test-helper filters (C1, C2-b)
- `test/_helpers/openapi-normalize.ts`: add `ProvenanceLineage` (and any
  `*_provenance`-only schema) + `ErrorResponse` to the `schemaNames`
  exclusion set, with comments mirroring the existing `fieldSet`
  rationale. Add unit coverage in `openapi-normalize.test.ts`.

### Phase 3 — .NET named list schemas (A1)
- Emit a named list type per collection response so Swashbuckle surfaces
  `ProjectListResponse` as a component and refs it from the action.
  Options: (a) generate `public sealed record ProjectListResponse(...)`
  wrapper — but Hono/Phoenix model the list as a bare `type: array`
  component, so a wrapper object would *introduce* a new field diff;
  prefer (b) register a named array schema via a Swashbuckle
  `ISchemaFilter` / `MapType`-style hook, or return a typed alias the
  schema generator names. Match Phoenix's `type: array, items: $ref`
  exactly. Clears the 4 list `onlySchemasRef` + 6 `responseBodyDiffs`.

### Phase 4 — .NET required + operationIds (A2, A3, B1 for .NET)
- `program.ts` `AddSwaggerGen`: enable `c.SupportNonNullableReferenceTypes()`
  and `c.CustomOperationIds(...)` wired to the Phase-0 helper values
  (or emit `[EndpointName("createProject")]` per action from the
  generator). Confirm value-type params (`bool`, `long`, `decimal`,
  `Guid`) land in `required`. Clears `requiredDiffs` + `operationIdDiffs`
  for .NET.

### Phase 5 — Phoenix operationId convention (B1 for Phoenix)
- `src/generator/phoenix-live-view/openapi-emit.ts`: replace the
  snake_case ids (`create_${snake}`, `list_${snake}`, `run_${slug}`,
  `query_${slug}`, …) with the Phase-0 camelCase helper. Clears the
  latent hono ↔ phoenix `operationIdDiffs`.

### Phase 6 — enum named schemas in .NET + Phoenix (B2)
- **Phoenix**: emit a `Visibility` / `BuildState` enum schema module
  (`type: :string, enum: [...]`) and `$ref` it from the request/response
  field instead of inline `type: :string`.
- **.NET**: carry the enum type (or a `[JsonConverter(typeof(JsonStringEnumConverter))]`
  string enum) on the DTOs so Swashbuckle emits the named enum schema and
  refs it. This touches request parsing (`Enum.Parse<Visibility>`)
  — the largest blast radius, hence last. Clears the `Visibility` /
  `BuildState` `onlySchemasRef`.

### Phase 7 — (optional) shared error envelope (C2-a)
- If we prefer a real contract over a filter: emit a consistent
  `ErrorResponse` schema + ref it from declared error responses in .NET
  and Phoenix; then back out the C2-b filter.

## 5. Verification per phase

- Fast loop: regenerate showcase, fetch nothing — diff the *generated
  source* against the table above. The pure `diffSpecs` is unit-tested in
  the fast suite; add cases there as dimensions are closed.
- Gate loop: `LOOM_E2E=1 LOOM_E2E_STRICT_PARITY=1 LOOM_E2E_PARITY_ONLY=1
  npm run test:e2e` (boots only the three backends + db, runs only the
  parity diff — the per-PR tier). Per-backend build gates
  (`hono-build`, `dotnet-build`, `phoenix-build`) must stay green
  through Phases 4–6 since those touch real emitted code.

## 6. Scope summary

| Phase | Backend(s) touched | Risk | Clears |
|---|---|---|---|
| 0 | shared util | low | (prereq) |
| 1 | Hono | low | paramTypeDiffs (8) |
| 2 | test helper | low | ProvenanceLineage, ErrorResponse onlySchemasRef |
| 3 | .NET | med | 4 list onlySchemasRef + 6 responseBodyDiffs |
| 4 | .NET | med | requiredDiffs (~16) + operationIdDiffs (.NET) |
| 5 | Phoenix | low | operationIdDiffs (hono↔phoenix, latent) |
| 6 | .NET + Phoenix | high | Visibility/BuildState onlySchemasRef |
| 7 | .NET + Phoenix | med | ErrorResponse (replaces Phase-2 filter) |

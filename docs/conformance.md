# Loom — Cross-Generator Conformance

The conformance harness is the cross-backend gate that catches generator
drift across backends. Five backends boot (Hono / .NET / Phoenix /
Python / Java) and **all five are diffed** — the parity check compares
every pair (10 pairs = 5 choose 2). One DSL source describes one contract; the backends emit
OpenAPI specs whose **wire surface is structurally identical** — same
operations, operationIds, component
schema names, field names, required sets, enum value-sets, response
cardinality, and path-param types.

The guarantee is **drop-in replacement**: a client generated from one
backend's spec (NSwag, openapi-generator, Heyapi, …) must bind unmodified
against any other backend. That makes the published contract a
*structural* equality, not a looser behavioral equivalence — an
operationId casing difference or a renamed list-response schema is a real
break, even if the two specs "describe the same behavior."

What stays idiomatic per backend is the **internal generated code**, never
the spec a client consumes: Swashbuckle vs `@hono/zod-openapi` vs
OpenApiSpex as the emitter, C# PascalCase controller-method names, the
framework plumbing. Error bodies follow API best practice — RFC 7807
`application/problem+json` — produced through each backend's idiomatic
mechanism (.NET `AddProblemDetails`, a Hono problem responder, Phoenix's
equivalent) but converging on the same 7807 wire shape.

This doc describes the dimensions the harness diffs, how to read a
divergence report, and how to extend it.

This harness owns the **structural** contract (the spec a client binds
against) and is deliberately casing-tolerant. The **runtime-value**
contract — the JSON a booted backend actually sends/accepts (camelCase
keys, enum casing, no leaked timestamps, absence-match, association
round-trip) — is its companion: [`conformance-semantics.md`](conformance-semantics.md).
A spec-diff is blind to those (see #1620), so they live as named RS-rules.

For the runner workflow (CLI, docker, env vars) see
[`tools.md`](tools.md#cross-platform-openapi-parity-check). For the
list of architectural decisions that led to the current design see the
"Cross-generator conformance harness (parity follow-ups)" section in
[`../experience_gathered.md`](../experience_gathered.md).

---

## Architecture

| Component | Path | Role |
|---|---|---|
| Pure diff helpers | `test/_helpers/openapi-normalize.ts` | `diffSpecs(ref, other) → ParityDiff` plus per-dimension extractors |
| Helper unit tests | `test/_helpers/openapi-normalize.test.ts` | One describe block per dimension; fast-suite covered |
| E2E runner | `test/e2e/e2e.test.ts` (parity test) | Boots docker compose, fetches each backend's `openapi.json`, calls `diffSpecs` for each pair |
| CI workflow | `.github/workflows/conformance-parity.yml` | Per-PR job that runs the e2e parity check in **strict mode** (`LOOM_E2E_STRICT_PARITY=1`) |

The diff is one pure function plus a small e2e wrapper. Every dimension
has unit-test coverage in the fast suite; the e2e wrapper only owns
the docker-compose fetch.

### All-pairs diff

The harness compares **every pair** of the five diffed backends
(`hono ↔ dotnet`, `hono ↔ phoenix`, `dotnet ↔ phoenix`, `hono ↔ python`,
`dotnet ↔ python`, `phoenix ↔ python`, `hono ↔ java`, `dotnet ↔ java`,
`python ↔ java`, `phoenix ↔ java` — ten pairs) rather than only
checking each against a single reference. The non-Hono pairs catch
symmetric drift — two non-Hono backends shipping a contract change in
lockstep, leaving Hono behind. Without them, the reference-diffs would
each report "X drifts from Hono" without making the joint relationship
explicit.

Java's spec is springdoc-inferred and is brought to structural parity by a
data-driven `OpenApiContractCustomizer` (`src/generator/java/emit/openapi-customizer.ts`)
that edits the document to match the other four backends — named array
wrappers, RFC 7807 error responses, named enum components, empty
request-body schemas for param-less ops, per-component `required` sets,
and the `Workflow`/`View` operationId suffixes. Each diff dimension is
strict-asserted for Java like every other backend.

---

## The dimensions

| Dimension | Helper | What it catches |
|---|---|---|
| Ops set | `collectOps(spec)` | Operations declared on one side but not the other (added / removed routes) |
| Response cardinality | `collectResponseShapes(spec)` | Per-op `array` vs `object` vs `nullable` drift on 2xx responses |
| Schemas set | `schemaNames(spec)` | Component schemas declared on one side but not the other (new / removed DTOs) |
| Per-schema fields | `fieldSet(spec, name)` | Property-name drift on a shared schema (e.g. `created_at` vs `createdAt`) |
| Per-schema required | `requiredSet(spec, name)` | A field flipping `required → optional` on one side |
| Per-property type | `propertyTypeDiffs` | Same-name field with a different JSON type on each side (e.g. `string` vs `integer`) |
| Per-property format | `propertyFormatDiffs` | Same field/type, different `format:` (e.g. `date-time` vs none) |
| Path-param types | `pathParamSignatures(spec)` | Same URL shape, different `{id}` schema (e.g. `string` vs `string:uuid`) |
| Query params | `queryParamDiffs` | Query-parameter set / type drift on a shared op |
| Request-body refs | `requestBodySchemas(spec)` | An op pointing its body at a different component schema (e.g. `CreateProductRequest` vs `UpdateProductRequest`) |
| Response-body refs | `responseBodySchemas(spec)` | Same cardinality, different element schema (e.g. `array<ProjectResponse>` vs `array<ProjectListItem>`) |
| OperationIds | `operationIds(spec)` | Same op declares a different `operationId` per backend — breaks codegen consumers (NSwag, openapi-generator) |
| Enum value-sets | `enumValueDiffs` | A shared enum schema with a different value-set per backend |
| Error responses | `errorResponseDiffs` | Per-op 4xx/5xx error-response drift |

Each dimension follows the same shape in `ParityDiff`:

- Set-style dimensions return `onlyRef` / `onlyOther` arrays
  (`onlySchemasRef` / `onlySchemasOther`, `onlyRef` / `onlyOther` for ops).
- Per-op / per-schema dimensions return a single
  `<dim>Diffs: string[]` of human-readable lines on the intersection
  (`fieldDiffs`, `requiredDiffs`, `cardMismatches`, `paramTypeDiffs`,
  `requestBodyDiffs`, `responseBodyDiffs`, `operationIdDiffs`).

`isCleanDiff(diff): boolean` returns true iff every dimension is empty.

---

## Filtering

### Infrastructure paths

`isInfraPath(p)` in `openapi-normalize.ts` excludes endpoints from the
diff that aren't part of the public contract:

```ts
return p === "/health" || p === "/ready" || p === "/openapi.json" || p.startsWith("/swagger");
```

Why each is excluded:

- **`/health` + `/ready`**: k8s probes. .NET's `app.MapGet` auto-registers
  them in the OpenAPI document; Hono uses raw `app.get(...)` and skips
  registration; Phoenix's OpenApiSpex emitter doesn't surface them.
  Same runtime behaviour, different doc surface — not a real divergence.
- **`/openapi.json`, `/swagger/*`**: spec-serving endpoints. Each backend
  exposes its spec at a different framework-canonical path; the harness
  fetches them by path anyway.

### Framework-noise schemas

`schemaNames(spec)` filters Swashbuckle's auto-emitted error envelopes
(`ProblemDetails`, `ValidationProblemDetails`,
`HttpValidationProblemDetails`) — these surface in the .NET spec even
when the application never references them. Filtering keeps the parity
diff focused on app-authored contracts.

### Provenance fields

`fieldSet(spec, schemaName)` filters keys ending in `_provenance` — a
TS/Hono-only wire extension (only the TS backend persists lineage).
Without the filter, every provenanced field on the showcase would read
as a Hono-only divergence.

### Temporary drop-in tolerances (tracked)

Two relaxations in `schemaNames` / `schemaRefName` are **interim** — they
let the gate stay green while the generators are brought up to the full
drop-in surface. Each is annotated in `test/_helpers/openapi-normalize.ts`
with the tracking issue and removed once the generator work lands:

- **#705 — named list-response wrapper.** Hono/Phoenix emit a named
  `<Agg>ListResponse` component; .NET inlines `array<element>`. Until .NET
  emits the wrapper, `isListWrapperSchema` filters it from `schemaNames`
  and `schemaRefName` resolves the named wrapper down to `array<element>`.
- **#706 — shared RFC 7807 `ProblemDetails` error body.** .NET is 7807-
  native; Hono emits an `ErrorResponse` envelope and Phoenix emits no
  error body. Until both emit `ProblemDetails`, the error-body schema is
  filtered. (Note: the `.NET`-only `ValidationProblemDetails` /
  `HttpValidationProblemDetails` validation envelopes stay filtered even
  after #706 — they have no cross-backend counterpart.)

### Strict gating

All ten pairs over the five diffed backends (`hono↔dotnet`, `hono↔phoenix`,
`dotnet↔phoenix`, `hono↔python`, `dotnet↔python`, `phoenix↔python`,
`hono↔java`, `dotnet↔java`, `python↔java`, `phoenix↔java`) hard-fail
under `LOOM_E2E_STRICT_PARITY=1` (the `conformance-parity.yml` job). #707
brought .NET byte-identical with Hono; #716 brought Phoenix in line (named
enum schemas, `{id}` create response, bare-array views, request-bool
optionality); #1618 added Java to the diff and closed its spec gaps via the
`OpenApiContractCustomizer` (response cardinality, RFC 7807 errors, enum
components, required sets, operationId suffixes), so the gate is strict for
every pair.

---

## Report-only vs strict mode

```bash
# Default (local): diffs log as console.warn, test passes either way
LOOM_E2E=1 npm run test:e2e

# CI default (`conformance-parity.yml`): each diff is a hard assertion
LOOM_E2E=1 LOOM_E2E_STRICT_PARITY=1 npm run test:e2e
```

The flag's role in `e2e.test.ts`:

```ts
if (STRICT_PARITY) {
  expect(diff.onlyRef,        `ops only on ${refName}`).toEqual([]);
  expect(diff.onlyOther,      `ops only on ${otherName}`).toEqual([]);
  expect(diff.cardMismatches, `cardinality drift`).toEqual([]);
  // ... one assertion per dimension
}
```

Local devs running `npm run test:e2e` see the divergence list as warnings;
CI fails the PR. This split is intentional — gradual rollout of a new
dimension can ship in REPORT mode first (no PRs blocked) and flip to
strict once the showcase divergences are closed.

---

## Reading a divergence report

A typical report-mode failure (or strict-mode test message) looks like:

```
[parity] hono ↔ phoenix divergence (finding):
  ops only on phoenix: [ 'GET /builds/:id', 'GET /projects/:id' ]
  ops missing on phoenix: [ 'GET /builds/{id}', 'GET /projects/{id}' ]
  fields: [
    'ProjectResponse: only-hono=[createdAt,externalId] only-phoenix=[created_at,external_id]'
  ]
  path-param types: [
    'GET /builds/{id}: hono=[string:uuid], phoenix=[string]'
  ]
```

How to triage:

1. **Read the pair header.** `hono ↔ phoenix` means Phoenix differs from
   Hono. Each pair runs independently — a clean `hono ↔ dotnet` plus a
   dirty `hono ↔ phoenix` localises the bug to Phoenix.
2. **Look at the dimension.** Each label corresponds to one
   `ParityDiff` field. Mismatched paths (`:id` vs `{id}`) are usually
   spec-syntax bugs in the emitter. `fields:` drift is usually a casing
   issue. `path-param types:` is a missing `format:` on the schema.
3. **Check the experience log.** `experience_gathered.md` documents the
   common categories from past divergences (snake_case vs camelCase
   wire keys, `:id` vs `{id}` path-template syntax, protocol-collision
   class).

The harness gives you the divergence shape; the emitter (the relevant
`src/generator/<platform>/*` file) is where the fix lives.

---

## Adding a new dimension

Checklist:

1. **Helper.** Add an extractor in `openapi-normalize.ts`. Pure
   function, `Map<key, value>` shape, takes an `OpenApiSpec` and
   returns the per-op or per-schema slice you want to diff. Filter
   infra paths via the existing `isInfraPath` guard.

2. **`ParityDiff` field.** Add the diff slot to the interface. Use a
   string-array carrying human-readable lines (`"<key>:
   <ref>=<refValue>, <other>=<otherValue>"`), consistent with the
   other dimensions.

3. **`diffSpecs` body.** Compute the new dimension on the
   **intersection** of keys present on both sides. Don't double-count
   — if a key is missing on one side, it belongs in
   `onlyRef`/`onlyOther`/`onlySchemas*`, not in your new diff.

4. **`isCleanDiff` conjunction.** Add `&& diff.<newDim>.length === 0`.

5. **`e2e.test.ts` logging + strict assertion.** Inside the pair loop:

   ```ts
   if (diff.<newDim>.length) console.warn("  <label>:", diff.<newDim>);
   // and
   if (STRICT_PARITY) {
     expect(diff.<newDim>, `<dim> drift (${pair})`).toEqual([]);
   }
   ```

6. **Unit tests.** Add a describe block in
   `test/_helpers/openapi-normalize.test.ts` covering:
   - Extraction on the happy path
   - Extraction on the empty / missing-clause path
   - `diffSpecs` flags drift between two synthetic specs
   - `diffSpecs` stays clean when the dimension agrees

7. **Update the all-clean `diffSpecs` test** to assert the new field
   is `[]` when specs agree.

8. **Update this doc's dimensions table** with the new entry.

Run `npx vitest run test/_helpers/openapi-normalize.test.ts` to verify
the unit tests pass before opening a PR; the e2e job will exercise the
new dimension on real specs once docker-compose boots.

---

## What the harness can't catch

The diff operates on the **emitted OpenAPI documents**, not on the
actual runtime behaviour. Things that slip through:

- **Wire-shape vs spec mismatch within one backend.** If Phoenix's
  `defimpl Jason.Encoder` outputs `createdAt` but its OpenApiSpex spec
  declares `created_at`, the harness sees no divergence (it only
  compares spec to spec). Caught instead by the per-backend wire
  contract: `<outdir>/.loom/wire-spec.json` from
  `src/system/wire-spec.ts`, diffed by the existing wire-spec tests.

- **Header / query parameter drift.** The current `pathParamSignatures`
  helper filters to `in: "path"` parameters. Query / header parameters
  ARE part of the contract but currently invisible. A future dimension
  could add them.

- **Error response shapes (4xx / 5xx).** `collectResponseShapes` /
  `responseBodySchemas` only consider 2xx. Error-envelope drift is a
  real contract divergence; not yet covered.

- **Auth / security scheme declarations.** `components.securitySchemes`
  is ignored.

- **OpenAPI `tags`.** Not currently compared.

If you spot a real backend drift the harness misses, the fix is
usually: add a dimension (per the checklist above), let it land in
REPORT mode, fix any divergences it surfaces, then flip strict.

---

## Related docs

- [`tools.md#cross-platform-openapi-parity-check`](tools.md#cross-platform-openapi-parity-check)
  — runner workflow, docker-compose orchestration, env vars
- [`generators.md`](generators.md) — per-platform feature reference
  (what each backend actually emits)
- [`../experience_gathered.md`](../experience_gathered.md) — the
  "Cross-generator conformance harness (parity follow-ups)" section
  documents the layered failures the harness surfaced and why each
  dimension exists

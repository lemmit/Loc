# Showcase coverage campaign — bug report

Running list of bugs surfaced while driving `examples/showcase.ddd` to 100%
language-feature coverage (see PR #1623 / branch `claude/showcase-parity-ci-0qtvxc`).

**Policy for this campaign:** when extending the showcase surfaces a bug
(a backend that crashes, throws, `# TODO`s, or diverges on valid `.ddd`),
we **record it here and keep going** — we do *not* fix it in this branch.
Each entry is a separate follow-up. Bugs are confirmed by either the local
`generate system` / lower+IR-validate gate, or by the `conformance-full`
behavioural leg (triggered via the `run-conformance` label).

Severity legend: **S1** crash/codegen-throw on valid input · **S2** silent
cross-backend divergence (parity break) · **S3** honest gap (validator
rejects a feature on some target) · **S4** test-infra / measurement.

---

## Confirmed

### BUG-001 — walker-primitive coverage detector measured the wrong AST field — **S4 (fixed in this PR)**

`test/conformance/showcase-completeness.test.ts → invokedNames()` collected
`node.name`, but a UI primitive invocation (`Avatar { "P" }`) parses as a
`BuilderCall` whose name lives on **`type`**, not `name`. So every primitive
was reported uncovered even when used: the guard showed **20/48** covered when
the true figure was **36/48**. Without this fix "100% primitive coverage" is
unmeasurable. Fixed here (the detector now reads `BuilderCall.type`) because
it's the measurement the campaign depends on; logged for the record.

### BUG-002 — coverage guard's union-exclusion list was incomplete → HARD_GATE unreachable — **S4 (fixed in this PR)**

`UNION_SUPERTYPES` (the set of abstract grammar unions excluded from the
"every kind appears" check) was hand-maintained and had rotted: it was missing
**11** real abstract unions — `ConfigValue, ConnectionSource, AuthConfigValue,
MacroArgValue, StoreDecl, AreaMember, CapabilityMember, WorkflowMember,
LayoutSlot, ViewSource, PostfixSuffix`. These can never appear as a concrete
`$type`, so they were permanently "uncovered" — meaning `HARD_GATE = true`
could **never** pass no matter how complete the showcase got. Fixed by deriving
the abstract set from `reflection.getAllSubTypes` (auto-catches future unions)
plus a 2-entry residual (`LValue`, `NamedType`). The honest target is now
**64/164** instantiable AST kinds uncovered (was reported 75/175).

---

### BUG-003 — scalar return-typed operation diverges 3 ways across backends — **S2**

Slice S3. Added `operation describe(): string { return name + " #" + string(sequence) }`
to `Catalog.Project`. `generate system` succeeds on all 5 backends, but the
emitted HTTP contract for a **scalar** (non-union) return-typed operation splits:

| Backend | Status | Returns the value? | OpenAPI response |
|---|---|---|---|
| Hono (node) | **200** | yes (`c.json(result)`) | **mistyped as `ProjectResponse`** — it returns a bare `string` |
| Phoenix (elixir) | **200** | yes (`json(conn, success)`) | success schema |
| .NET | **204** | no — `await _mediator.Send(cmd); return NoContent();` | 204 |
| Python | **204** | no — `found.describe()` result discarded | 204 |
| Java | **204** | no — `void describeProject(...)`, `@ResponseStatus(NO_CONTENT)` | 204 |

Two defects in one: (a) **3-way parity divergence** — only 2/5 honor a scalar
operation return (200+body) while 3/5 discard it (204); the strict
`conformance-parity` gate will fail on this op. (b) **Hono mistypes** its 200
response schema as the aggregate's `ProjectResponse` when the value is a
`string`. (.NET's exception-less-returns work, `operation-return-dotnet.ddd`,
only covers the *union* return form `X or NotFound` → 200; the scalar-return
form was apparently never reconciled across backends.)

Fix direction (for later): pick one contract for scalar returns (likely
200 + a typed scalar/wrapper response) and make all 5 emit it, or gate the
scalar-return form if 204-discard is intended. Until fixed, `describe()` keeps
the showcase's `conformance-parity` red — kept deliberately as the ReturnStmt
coverage vehicle.

### BUG-004 — union-find absence error mandates field `resource`, which is a reserved keyword → unreadable — **S3**

Slice S4. A union-returning find (`find locate(name): Project or ProjectNotFound`)
**requires** its error payload to carry exactly `resource: string` (validator:
"an absence-mapped error may only carry `resource: string`"). But `resource` is
a reserved keyword (the `resource <name> { for:… }` datasource decl), so a
postfix access `e.resource` inside a `match` arm fails to **parse**
(`Expecting one of [by, handle, id, …]`). Net effect: the mandated field is
*write-only* — the framework fills it, but domain code (a `VariantArm` match)
can never read it. Either the mandated field should be renamable, or keyword
field names must be accessible via postfix (LooseName in member position).
Worked around in the showcase by not binding the field (`ProjectNotFound =>
"not found"`).

### BUG-005 — union-returning find: OpenAPI response typed only on .NET + Hono — **S2**

Slice S4. `find locate(...): Project or ProjectNotFound` generates on all 5
backends (no crash), but the success response is typed inconsistently:

| Backend | `/projects/locate` 200 response |
|---|---|
| .NET | `ProducesResponseType(typeof(ProjectOrProjectNotFound), 200)` ✓ |
| Hono | `200 … schema: ProjectOrProjectNotFound` ✓ |
| Python | `@router.get(..., response_model=None)` — **untyped**, no union schema |
| Java | `Route("get", ".../locate", null, {500}, null)` — **no 200 success schema**, only 500 |
| Phoenix | route + controller emitted; spec response TBD |

The discriminated-union wire shape is a .NET/Hono feature
(`union-dotnet.ddd`); Python and Java emit the route but drop the typed union
response → the strict `conformance-parity` response/schema diff fails. Kept as
the union-find / TypeAtom coverage vehicle.

---

## Pending verification (need `conformance-full` / per-backend boot)

- The behavioural backfill (operation + find routes) is being exercised
  cross-backend by the `run-conformance` run on PR #1623. Any divergence it
  reports lands here.

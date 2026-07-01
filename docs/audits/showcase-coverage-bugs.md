# Showcase coverage campaign — bug report

> **Status: COMPLETE.** `examples/showcase.ddd` now exercises **all 161
> instantiable AST kinds + all 48 walker primitives**; the completeness guard
> runs with `HARD_GATE = true`. Three kinds are allowlisted as unreachable from
> a `.ddd` fixture (`MacroArgString`, `MacroArgInt` — no stdlib macro declares
> string/int params; `ImportStmt` — single-file fixture, covered by
> `multifile-*.ddd`). Bugs below are surfaced-not-fixed per campaign policy.
> **Product bugs to fix: BUG-003, BUG-004, BUG-005** (BUG-006 already in flight
> as #1622; BUG-001/002 were test-infra and fixed here).


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

**FIXED (gated).** Scalar-return aggregate operations are not part of any
shipped design — the exception-less surface is `or`-unions only (docs say plain
operations are 204), and the *only* scalar-return aggregate op in the whole
corpus was the showcase's synthetic `describe()`. So rather than invent a wire
contract, the divergence is closed the same way `validateUnionFindShapes` gates
unsupported find shapes: a new IR-validate gate
(`loom.operation-return-scalar-unsupported`, `structural-checks.ts`) rejects a
non-`or`-union operation return type, pointing authors to a
`function`/`domainService`/query or an `or`-union. `describe()` was removed from
the showcase (ReturnStmt stays covered by the S7 domain-service op; the
`string(...)` PrimitiveConversion stays covered by the `seqLabel` derived).
Negative tests in `test/ir/operation-returns.test.ts`. If a 200+typed-body
contract is wanted later, that's an additive feature (un-gate + emit).

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

## Verified via `conformance-full` (run #71, commit c8900c6)

That run (the behavioural-backfill state) boots all 5 backends. Results:

- ✅ **all 5 backends build + boot + serve `/health`**.
- ✅ **5-way OpenAPI parity passes** ("all five backends agree across all ten
  pairs: ops / cardinality / schemas / fields / required").
- ✅ Playwright UI suite passes; ✅ runtime-403 authz passes.
- ❌ behavioural DSL e2e: **7 failures, all on `phoenix_api` only** — every
  one a `422 "is invalid"` on an **enum** field (`POST /api/projects` →
  `/visibility`, `POST /api/builds` → `/buildState`).

### BUG-006 (pre-existing, already in flight as PR #1622) — Phoenix rejects declared-case enum values — **S2**

This is **not a campaign regression** — it's the known vanilla-Phoenix enum
casing bug: `Ecto.Enum` snake-cases its values so the wire value `"Public"` /
`"Passed"` can't `cast`, returning 422. PR **#1622** ("fix(elixir): emit enum
values in declared casing so wire values cast") fixes exactly these two
pointers. My behavioural backfill (and the pre-existing happy-path creates,
which conformance-full replays against *every* backend) just hit the same
broken path on Phoenix. No action here — tracked by #1622.

> Note: this run predates the S3–S9 features. The **current** milestone
> additionally fails `conformance-parity` on BUG-003 (scalar return op) and
> BUG-005 (union-find response typing) — both deliberate coverage vehicles.

## Pending verification

- A fresh `conformance-full` on the S3–S9 milestone would re-confirm the above
  plus BUG-003/005 (parity) — i.e. only known issues. Worth re-running after
  those are fixed, not before.

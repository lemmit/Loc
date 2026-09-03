# Wave 1 — packet 1b (dotnet-adapters) hand-off

*Branch: `claude/wave-1-dotnet-adapters` (last code commit `b21ca9d`). Base: `claude/wave-1` @ `ca37863`.*

> **Branch-name deviation.** The packet brief asked for `claude/wave-1/dotnet-adapters`;
> git refuses it because the ref `refs/heads/claude/wave-1` already exists (a ref cannot
> be both a file and a directory). Followed the convention the validator-cli packet
> already used: a dash, `claude/wave-1-dotnet-adapters`.

## Rows

| row | outcome | proof: test file + assertion that fails when reverted | notes |
|---|---|---|---|
| `F2-ADP-1` (P0, security) | **already-done-verified** | `test/generator/dotnet/policy-deny-ignoring.test.ts` — mutating BOTH adapters (`dapper.ts:1167` `bypassable: !isDenyFilter(p)` → `true`; `efcore.ts:756` `hasNonBypassableFilter` → `return false`) fails 5 of its 7: "`find … ignoring *` KEEPS the always-false deny conjunct" (`expected … to contain '1 = 0'`), "a retrieval's runtime FilterBypass cannot drop the deny conjunct either", "`ignoring *` never emits the parameterless IgnoreQueryFilters()", plus both bypassable-enumeration assertions | Closed by #2668 on both adapters (`emit/dapper.ts` `keptFilterParts`, `find-emit.ts` `ignoreFiltersClause`, `emit/repository.ts` `allBypassNames`, and the EF/dapper query-projection arms, which drop only capability-ORIGIN filters). The ledger's `open` entry is stale. |
| `F2-ADP-4` (P1) | **already-done-verified** | `test/generator/dotnet/repository-port-implemented.test.ts` — forcing `const writeScopeMethod = false` in the event-sourced emitters (`emit/repository.ts:1022`, `emit/dapper.ts:2201`) fails its `Es` case on both adapters: `expected [ 'GetByIdAsync', …(3) ] to include 'GetByIdForWriteAsync'` | Closed by #2668, with exactly the port-walking invariant test the ledger's `fix` asked for (all four shapes × both adapters). |
| `F2-ADP-2` (P1) | **already-done-verified** | `test/generator/dotnet/dotnet-seed.test.ts` — deleting `if (usingDapper) return undefined;` from the `schemaFor` callback (`src/generator/dotnet/index.ts` ~1023) fails "dapper: every raw seed INSERT targets a table the emitted DDL creates": `expected [ 'customers', '__loom_seed' ] to include 'sales.customers'` | Closed by #2668 with the ledger's option (b). Re-confirmed empirically on the shipped corpus fixture: `seeding.ddd` under `persistence: dapper` now emits `INSERT INTO ""widgets""` against `CREATE TABLE IF NOT EXISTS widgets`. |
| `G2667-D3` (P2, dotnet arm) | **fixed** (`b75ce2c`) | `test/generator/dotnet/query-projection-join-missing.test.ts` (both adapters) — restoring the indexer (`projectToResponse(\`${map}[${key}].${Member}\`, …)`) fails "never indexes the join dictionary directly" (`expected … not to match /customerById\[/`), "reads every joined field through TryGetValue, defaulting when absent" (`expected [] to have a length of 3`) and "keeps the wire projection INSIDE the guarded branch" | LEFT-JOIN semantics — see the ruling below. `test/ir/projection-comprehension.test.ts`'s .NET arm pinned the old shape and is retargeted (`b21ca9d`); its java/node arms are untouched. |
| `M-T3.9-dotnet-audit-masked-snapshot` (P2, VF) | **already-done-verified** | `test/generator/dotnet/audit-snapshot-unmasked.test.ts` — flipping the two `{ maskNames, unmasked: true }` audit sites in `cqrs/commands.ts` (:484, :492) to `unmasked: false` fails "the operation's before/after pair records the real value" (`expected … to contain 'new OrderResponse(aggregate.Id.Value,…'`) | Closed by #2708 at four sites (`cqrs/commands.ts:181,298,484,492` + `workflow-emit.ts:1710,1712`); the read path and the history query still mask. |
| `G2667-D4-dotnet-explicit-route-id-coercion` (P2, VF) | **already-done-verified** | `test/generator/dotnet/id-clr-type-single-source.test.ts` (passes; pins the shared derivation structurally) | Closed by #2708: `explicit-handlers-emit.ts:624,640` call `csIdValueClrType(t.valueType)`; the local `guid\|long\|string` switch is gone, and the comment records the `int`→`long` CS1503 it caused. |
| `dapper-no-schema-evolution` (P2, L) | **handed off** (decision below) | — | The premise is partly STALE and the honest gate cannot live in this packet's tree. New empirical finding below. |
| `F2-W-14` (P3) | **not-reached** (analysis below) | — | Confirmed present; deliberately not landed blind. |
| `F2-EXPR-7` (P3) | **handed off** (ruling below) | — | Under the recommended ruling the .NET leaf is already conformant; no in-fence change either way unless "optional" wins. |

## Ruling recorded for `G2667-D3` (needs a cross-backend RS rule)

A `join <Agg> as c on <idRef>` bulk-loads the target THROUGH its repository, so the
joined aggregate's own capability filters apply to that load: a soft-deleted target, an
out-of-tenant target, or an ordinary dangling reference is simply ABSENT from the map.
All five backends index it unguarded today —
.NET `customerById[d.CustomerId].Name` (`KeyNotFoundException`),
node `customerById.get(...)!.name` (undefined deref),
python `customer_by_id[str(...)].name` (`KeyError`)
— so every one of them 500s on data the model permits. Nobody has a working answer, so
the choice was free.

**Chosen for .NET: LEFT JOIN.** The source row survives; the joined field carries the wire
type's empty value (`default!` — null for a reference-typed field, the type default for a
value-typed one), which is the same `default!` the row constructor already emits for a wire
field no `select` covers. The whole wire projection sits INSIDE the guarded branch, so the
`.ToString("F4")` / canonical-instant / decimal-narrowing wraps never run on an absent row.

Rejected: dropping the source row. It would let a FOREIGN aggregate's filters change this
projection's row count while the source aggregate's own list still shows the row — one
silent failure traded for another.

**For the coordinator:** the rule belongs in `docs/conformance-semantics.md` as a new
RS-rule, and the node / python / java / elixir arms need the same treatment (node's is
packet 1c's row). Flipping the ruling is a one-line change in
`src/generator/dotnet/query-projection-emit.ts` (the `joinAliasRead` branch), so if a
later packet argues for skip-row, .NET follows cheaply.

## Decision recorded for `dapper-no-schema-evolution`

**The row's "silently unapplied" framing does not survive contact with the code.** Verified
on this base with two `generate system` runs into ONE output tree (`Thing { name }` →
`Thing { name, size: int? }`, a non-destructive nullable add):

* `persistence: dapper` — the FIRST run writes `.loom/snapshots/S.snapshot.json` recording
  migration version `20260101000000`, while the dotnet emitter suppresses the migration
  FILES (`src/generator/dotnet/index.ts:991`, `hasMigrations = !usingDapper && …`). The
  SECOND run therefore exits 1 with the M-T2.2 baseline guard: *"migration file(s) for
  version(s) 20260101000000 are recorded in the snapshot history but absent from the output
  tree … restore both from version control together, or re-baseline deliberately."* The
  message blames the operator for a state the toolchain creates by design, and there is no
  correct operator action.
* `platform: dotnet` (efcore), same two sources, same tree — exit 0, and
  `d/Migrations/20260101500001_S_AddSizeToThings.cs` appears. So the divergence is the
  ADAPTER's, exactly as the row says, but the observable symptom is a hard failure with a
  misdirected message, not silence.

The genuinely silent half remains, and is the runtime one: `renderDapperSchema` is
CREATE-only (`grep -c 'ALTER TABLE' src/generator/dotnet/emit/dapper.ts` = 0), so a fresh
generation against an EXISTING database never applies the change — add a field and the app
500s on the missing column.

**Decision: hand off, do not half-fix in-tree.** Both honest fixes are outside
`src/generator/dotnet/**`:

1. **The gate.** Its condition is only knowable in phase ⑨: "a module whose
   `migrationsOwner` deployable uses a SELF-PROVISIONING adapter has a non-empty derived
   diff against an EXISTING snapshot". Phase ⑦'s `validateMigrationAdapterSupport`
   (`src/ir/validate/checks/migration-checks.ts`) cannot see it — the diff is computed by
   `buildMigrations` in `src/system/migrations-builder.ts`, from the snapshot store the CLI
   threads in (`fsSnapshotStore(outDir)`, `src/cli/main.ts:516`). Suggested home: beside the
   existing `MigrationBaselineError` / `MigrationDestructiveError` throws in
   `src/system/`, reusing the SAME diagnostic codes the declared-intent gate already owns —
   `loom.dapper-unsupported#migrations` / `loom.mikroorm-unsupported#migrations` — since the
   remedy sentence is identical (switch the deployable to `persistence: efcore` / the
   migration-chain adapter). If a new message slug is preferred, it must be added to
   `src/diagnostics/messages.ts` with a string-literal `code:` at the call site, per
   `diagnostic-catalog.test.ts`.
2. **The misdirected baseline error.** Either stop writing a migration snapshot for a module
   no deployable emits migration files for, or make the baseline guard skip a module whose
   `migrationsOwner` is self-provisioning. Also `src/system/`.

Inside this packet's fence the only available lever is a generated-side marker, which the
sentinel gate forbids and which would in any case be a runtime string rather than a
compile-time refusal. The "Real (L)" option (render the MigrationsIR chain for dapper as an
ordered `.sql` set + a `__loom_migrations` ledger applied by `DbSchema.EnsureAsync`, then
flip `hasMigrations` at `index.ts:991`) is a wave-2-sized mission and would need a
`test:migration-evolution-dapper` leg to be believable.

## `F2-W-14` — why it is not-reached rather than fixed

Confirmed on this base: `src/generator/dotnet/emit/program.ts:843` configures `AddSwaggerGen`
with six filters and NO `UseOneOfForPolymorphism()` / `SelectSubTypesUsing`, while
`emitUnionDtos` emits the union as a property-less `[JsonPolymorphic("type")]` abstract
record — so the published component for a union-returning operation's 200 body is very
likely an empty object where the other four backends publish a two-arm `oneOf`.

Not landed because it cannot be verified from emitted strings: the component is produced by
Swashbuckle's REFLECTION at runtime, so the only real proof is booting the app and reading
`/openapi.json`, and `UseOneOfForPolymorphism()` is a GLOBAL switch that would also reshape
every TPH abstract base's component — a spec change whose blast radius only the runtime
openapi-parity gate can see. Landing it blind is the half-fix this wave is meant to avoid.
It also needs a union-shape dimension in `openapi-normalize` (outside this fence), because
`fieldSet`/`requiredSet`/`propertyTypes` read `properties`, which is empty both for an
unresolved abstract base and for a `oneOf` wrapper — the two compare equal today.

## `F2-EXPR-7` — ruling proposed, no in-fence change

`src/util/collection-ops.ts:23` declares `first` as returning `T`, non-optional. The honest
reading of that declaration is **`.first` on an empty collection throws** — which is what
.NET (`.First()`), java (`.get(0)`) and python (`[0]`) already do; node (`[0]` → undefined)
and elixir (`List.first/1` → nil, literally the same snippet as `firstOrNull`) are the two
that silently degrade a non-optional value. Recommendation: pin "throws" in
`src/util/collection-ops.ts` the way `src/util/intrinsics.ts` pins scalar edge behaviour,
then fix node (explicit guard) and elixir (`hd/1`). Under that ruling the .NET leaf needs no
change; only a flip to "first is optional" would touch this fence (`.First()` →
`.FirstOrDefault()`), so the ruling is the coordinator's to make, not a dotnet edit.

## Files outside the fence (handed off)

* `src/system/migrations-builder.ts` (or a sibling) + `src/cli/main.ts` wiring — the
  self-provisioning schema-evolution gate and the misdirected baseline error, above.
* `src/diagnostics/messages.ts` — only if that gate wants a new message slug rather than
  reusing `loom.{dapper,mikroorm}-unsupported#migrations`.
* `docs/conformance-semantics.md` — the new RS-rule for the join-lookup semantics.
* `src/platform/hono/**`, `src/generator/{python,java,elixir}/**` — the other four arms of
  `G2667-D3` (node is packet 1c's row); `test/ir/projection-comprehension.test.ts` still
  pins their unguarded shapes, so each arm's fix retargets its own assertion in that file.
* `src/generator/{typescript,elixir}/render-expr.ts` + `src/util/collection-ops.ts` —
  `F2-EXPR-7`, if the "throws" ruling is accepted.

## Local gates run + results

* `npx tsc -b` — clean.
* `npx vitest run test/generator/dotnet` — 106 files / 695 tests, all pass (includes the new
  `query-projection-join-missing.test.ts`).
* `npx vitest run test/system/diagnostic-catalog.test.ts test/system/generated-output-sentinels.test.ts
  test/platform/backend-parity-gates.test.ts test/generator/projection-groupby-datekey-backends.test.ts
  test/generator/projection-aggregate-money-scale.test.ts test/generator/projection-groupby-dotnet.test.ts
  test/generator/projection-aggregation-backends.test.ts test/ir/projection-comprehension.test.ts`
  — 177 tests; the only failure was `projection-comprehension`'s .NET arm pinning the old
  unguarded shape, retargeted in `b21ca9d`; green after.
* **.NET compile leg**, `mcr.microsoft.com/dotnet/sdk:10.0`, `dotnet build /warnaserror`
  (the host has no SDK, so `test:dotnet-corpus` cannot run there directly — the container is
  the documented substitute; a `loom-nuget` docker volume keeps the package cache between the
  `restore` and `build` containers):
  * corpus `projection-join.ddd` — efcore: 0 warnings, 0 errors; dapper: 0 warnings, 0 errors.
  * a datetime + decimal + money joined variant (three joined selects → three `out var`s in
    one lambda scope, the CS0128 shape) — efcore and dapper: 0 warnings, 0 errors.
* `npx biome ci` on every changed file — clean.

## Open questions for the coordinator

1. **Branch name** is `claude/wave-1-dotnet-adapters`, not `claude/wave-1/dotnet-adapters`
   (git ref conflict with `claude/wave-1` itself). Every packet hits this.
2. **Four of seven rows were already closed by #2668/#2708.** The ledger's `open` array is
   the stale part, not the code — packet 0.2 should move `F2-ADP-1`, `F2-ADP-2`, `F2-ADP-4`,
   `M-T3.9-dotnet-audit-masked-snapshot` and `G2667-D4-dotnet-explicit-route-id-coercion` to
   `done`, each with the gate named in the table above.
3. **Who owns the `G2667-D3` RS-rule** and the remaining four arms? The .NET arm is landed
   with the LEFT-JOIN ruling; a different ruling is a one-line change here.
4. **`dapper-no-schema-evolution` needs a `src/system/` owner** — nobody's fence in this wave
   covers it, and the misdirected baseline error (finding above) is arguably a higher-value,
   smaller fix than the gate itself.

## Ledger closes (ids)

`F2-ADP-1`, `F2-ADP-2`, `F2-ADP-4`, `M-T3.9-dotnet-audit-masked-snapshot`,
`G2667-D4-dotnet-explicit-route-id-coercion` (all already-done-verified, evidence above);
`G2667-D3-projection-join-unguarded-index` — **dotnet arm only**, the row stays open for
node/python/java/elixir.

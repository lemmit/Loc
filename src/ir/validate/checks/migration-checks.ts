import { diagMessage } from "../../../diagnostics/messages.js";
import type { AggregateIR, EnrichedLoomModel, ExprIR, TypeIR } from "../../types/loom-ir.js";
import { allContexts } from "../../types/loom-ir.js";
import { sqlRenderableExpr } from "../../util/sql-renderable-expr.js";
import type { LoomDiagnostic } from "./diagnostic.js";

// ---------------------------------------------------------------------------
// Migration-block data-step checks (M-T2.3) — phase ⑦, over the lowered IR.
//
// The AST-level checks (validators/migration.ts) cover the structural shapes
// (live field, per-block duplicates, empty sql).  Here, with the fully-typed
// ExprIR in hand, we gate what the phase-⑨ builder can actually render:
//
//   - `loom.migration-expr-unsupported`   — backfill expression outside the
//     SQL-renderable subset (`sqlRenderableExpr`, ir/util).
//   - `loom.backfill-target-invalid`  — the target field has no single
//     scalar column: value-object / collection / entity fields, and
//     `shape: document` / `persistedAs: eventLog` aggregates (no row columns
//     to backfill — use a raw `sql` step over the document payload instead).
//   - `loom.backfill-type-mismatch`       — the expression's inferred type
//     doesn't fit the field's declared type.  Best-effort: an unknown side
//     never diagnoses (no false positives on partially-typed IR).
// ---------------------------------------------------------------------------

export function validateMigrationDataSteps(loom: EnrichedLoomModel, diags: LoomDiagnostic[]): void {
  const aggByContext = new Map<string, Map<string, AggregateIR>>();
  for (const ctx of allContexts(loom)) {
    const m = aggByContext.get(ctx.name) ?? new Map<string, AggregateIR>();
    for (const a of ctx.aggregates) m.set(a.name, a);
    aggByContext.set(ctx.name, m);
  }

  for (const intent of loom.backfillIntents) {
    const source = `migration/${intent.migration}`;
    const agg = aggByContext.get(intent.context)?.get(intent.aggregate);
    // An unresolvable aggregate is a linking error the AST layer already
    // reported; stay quiet here.
    if (!agg) continue;

    if ((agg.savingShape ?? "relational") === "document" || agg.persistedAs === "eventLog") {
      diags.push({
        severity: "error",
        code: "loom.backfill-target-invalid",
        message: diagMessage("loom.backfill-target-invalid#backfill-a-aggregate-stores", {
          aggregate: intent.aggregate,
          field: intent.field,
          persistedAs: agg.persistedAs === "eventLog" ? "persistedAs: eventLog" : "shape: document",
        }),
        source,
      });
      continue;
    }

    const field = agg.fields.find((f) => f.name === intent.field);
    // Unknown field is the AST-level `loom.backfill-unknown-field`.
    if (!field) continue;
    if (!isScalarColumnType(field.type)) {
      diags.push({
        severity: "error",
        code: "loom.backfill-target-invalid",
        message: diagMessage("loom.backfill-target-invalid#backfill-the-field-is-not", {
          aggregate: intent.aggregate,
          field: intent.field,
        }),
        source,
      });
      continue;
    }

    const renderable = sqlRenderableExpr(intent.value);
    if (renderable !== true) {
      diags.push({
        severity: "error",
        code: "loom.migration-expr-unsupported",
        message: diagMessage("loom.migration-expr-unsupported", {
          aggregate: intent.aggregate,
          field: intent.field,
          reason: renderable.reason,
        }),
        source,
      });
      continue;
    }

    const fit = backfillTypeFits(field.type, intent.value);
    if (fit !== true) {
      diags.push({
        severity: "error",
        code: "loom.backfill-type-mismatch",
        message: diagMessage("loom.backfill-type-mismatch", {
          aggregate: intent.aggregate,
          field: intent.field,
          got: fit.got,
          expected: fit.expected,
        }),
        source,
      });
    }
  }
}

/** Does the field map to exactly one scalar column?  Mirrors the migration
 *  builder's column derivation: primitives, enums and `X id` refs are single
 *  columns; value objects flatten to several; arrays/entities are child
 *  tables. */
function isScalarColumnType(t: TypeIR): boolean {
  switch (t.kind) {
    case "primitive":
    case "enum":
    case "id":
      return true;
    case "optional":
      return isScalarColumnType(t.inner);
    default:
      return false;
  }
}

/** Best-effort inferred "SQL family" of a backfill expression — one of the
 *  primitive names, an `enum:<Name>`, `"null"`, or undefined (unknown). */
function sqlExprFamily(e: ExprIR): string | undefined {
  switch (e.kind) {
    case "literal":
      switch (e.lit) {
        case "string":
          return "string";
        case "int":
          return "int";
        case "long":
          return "long";
        case "decimal":
          return "decimal";
        case "money":
          return "money";
        case "bool":
          return "bool";
        case "null":
          return "null";
        case "now":
          return "datetime";
      }
      return undefined;
    case "ref":
      if (e.refKind === "enum-value") return e.enumName ? `enum:${e.enumName}` : undefined;
      return e.type ? typeFamily(e.type) : undefined;
    case "paren":
      return sqlExprFamily(e.inner);
    case "unary":
      return e.op === "!" ? "bool" : sqlExprFamily(e.operand);
    case "binary": {
      if (e.resultType) return typeFamily(e.resultType);
      if (["<", "<=", ">", ">=", "==", "!=", "&&", "||"].includes(e.op)) return "bool";
      return e.leftType ? typeFamily(e.leftType) : sqlExprFamily(e.left);
    }
    case "ternary":
      return sqlExprFamily(e.then) ?? sqlExprFamily(e.otherwise);
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Migration chain vs. persistence adapter (the SELF-PROVISIONING adapters).
//
// Two adapters opt OUT of the phase-⑨ `MigrationsIR` chain entirely and
// provision their schema themselves at boot:
//
//   - `persistence: dapper`   — `hasMigrations = !usingDapper`
//     (`src/generator/dotnet/index.ts`); schema comes from the
//     `CREATE TABLE IF NOT EXISTS` block `DbSchema.EnsureAsync` runs.
//   - `persistence: mikroorm` — `hasMigrations = !usingMikro`
//     (`src/platform/hono/v4/emit.ts`, shared by v5); schema comes from
//     `orm.schema.updateSchema()`.
//
// Both are fine for a FIRST boot.  Neither can carry a declared `migration`
// block, and the failure is SILENT in the worst way:
//
//   - dapper: `CREATE TABLE IF NOT EXISTS` sees the table already there and
//     does nothing, so a declared `rename` / backfill / raw `sql` step never
//     runs.  The column keeps its old name and the app 500s on a column that
//     "should" exist — or worse, quietly reads a NULL the backfill was meant
//     to populate.
//   - mikroorm: `updateSchema()` has no rename intent to consult, so it sees
//     a dropped column and an added one — it DROPS the old column and ADDS
//     the new one, i.e. it deletes the very data the rename existed to keep.
//
// The declared intents are exactly the migration surface that lives on the IR
// at phase ⑦ (`renameIntents` / `tableRenameIntents` / `backfillIntents` /
// `sqlMigrationSteps`) — the derived `MigrationsIR` itself only exists in
// phase ⑨.  So the gate is here, and it makes the gap HONEST: a declared
// migration on a self-provisioning adapter is now a compile error naming the
// adapter to switch to, instead of a silent no-op (dapper) or silent data loss
// (mikroorm).
// ---------------------------------------------------------------------------

/** The self-provisioning persistence adapters.  Both consequences of "I run
 *  `CREATE TABLE IF NOT EXISTS` at boot instead of applying a chain" are gated
 *  against this one set: no migration steps (below) and no schema qualifier
 *  (`validateSelfProvisioningSchemaSupport`, further down).
 *
 *  The message KEYS stay as string literals at the `diagMessage(...)` call
 *  sites — `diagnostic-catalog.test.ts` reads them syntactically, so a key
 *  routed through a lookup table reads as an orphan entry. */
const SELF_PROVISIONING_ADAPTERS = new Set(["dapper", "mikroorm"]);

export function validateMigrationAdapterSupport(
  loom: EnrichedLoomModel,
  diags: LoomDiagnostic[],
): void {
  // Declared migration steps, indexed by the context they name.  A raw
  // `sql "…"` step names no context (it is a system-wide statement), so it is
  // collected separately and charged to every self-provisioning deployable.
  const byContext = new Map<string, { migration: string; step: string }[]>();
  const add = (context: string, migration: string, step: string): void => {
    const list = byContext.get(context) ?? [];
    list.push({ migration, step });
    byContext.set(context, list);
  };
  for (const r of loom.renameIntents)
    add(r.context, r.migration, `rename ${r.aggregate}.${r.from}`);
  for (const t of loom.tableRenameIntents)
    add(t.context, t.migration, `rename ${t.fromAggregate} -> ${t.toAggregate}`);
  for (const b of loom.backfillIntents)
    add(b.context, b.migration, `backfill ${b.aggregate}.${b.field}`);
  const sqlSteps = loom.sqlMigrationSteps.map((s) => ({
    migration: s.migration,
    step: `sql step #${s.index}`,
  }));
  if (byContext.size === 0 && sqlSteps.length === 0) return;

  for (const sys of loom.systems) {
    for (const dep of sys.deployables) {
      if (!dep.persistence || !SELF_PROVISIONING_ADAPTERS.has(dep.persistence)) continue;
      const hits = [...dep.contextNames.flatMap((c) => byContext.get(c) ?? []), ...sqlSteps];
      if (hits.length === 0) continue;
      // One diagnostic per deployable, naming the first offending step — the
      // fix (switch the adapter, or move the migration off this deployable) is
      // the same for every step, so N of them would be noise.
      const first = hits[0]!;
      const params = {
        name: dep.name,
        migration: first.migration,
        step: first.step,
        count: hits.length,
      };
      const source = `${sys.name}/${dep.name}`;
      if (dep.persistence === "dapper") {
        diags.push({
          severity: "error",
          code: "loom.dapper-unsupported",
          message: diagMessage("loom.dapper-unsupported#migrations", params),
          source,
        });
      } else {
        diags.push({
          severity: "error",
          code: "loom.mikroorm-unsupported",
          message: diagMessage("loom.mikroorm-unsupported#migrations", params),
          source,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The OTHER consequence of self-provisioning: no schema concept (F2-ADP-3).
//
// A self-provisioning adapter emits its DDL as `CREATE TABLE IF NOT EXISTS` at
// boot and names every table UNQUALIFIED — dapper's `DbSchema.EnsureAsync`
// (`CREATE TABLE IF NOT EXISTS "as"`), mikroorm's `@Entity({ tableName: "as" })`.
// Every migration-chain adapter instead routes the table into the binding's
// Postgres schema, which `resolveDataSourceConfig` DEFAULTS to
// `snake(<context>)` when the DSL omits `schema:` — so EF Core emits
// `builder.ToTable("as", "alpha")` and Drizzle `pgSchema("alpha").table("as")`
// for a context named `Alpha` that declares nothing at all.
//
// Two silent failures follow, and neither needs an explicit `schema:` to
// appear:
//
//   SPLIT-BRAIN — one context served by BOTH kinds of adapter provisions TWO
//   physical tables (`public.as` and `alpha.as`).  Both deployables start, both
//   answer, and each sees an empty database the other is writing to.  This is
//   the shape #2668 deferred: the fix cannot live in the dotnet emitter,
//   because the disagreement is between two deployables.
//
//   DROPPED REQUEST — an EXPLICIT `schema:` / `tablePrefix:` on the binding is
//   simply ignored by the self-provisioning adapter, so a model that asks for
//   `schema: "legacy"` silently gets `public`.
//
// ONE EXEMPTION, and it is the case both messages above describe as impossible:
// `schema: "public"` with no `tablePrefix:`.  There the two namings CONVERGE —
// the migration chain emits `CREATE TABLE "public"."as"` / `ToTable("as",
// "public")`, and the self-provisioning adapter's UNQUALIFIED `CREATE TABLE
// "as"` resolves through Postgres's default `search_path` (`"$user", public`;
// no emitted connection string overrides it) to that same `public.as`.  So the
// split-brain arm's "would start against DIFFERENT physical tables" is untrue,
// and the dropped-request arm's own words give the game away: it says the
// tables "land in 'public'", which is exactly what was asked for.  A request an
// adapter happens to satisfy is not a request it dropped.
//
// `tablePrefix:` is NOT exempt even alongside `schema: "public"` — that one is
// genuinely dropped, and it renames the table rather than placing it.
//
// Both are gated here rather than in an emitter for the same reason the
// migration gate above is: the offending fact is a property of the SYSTEM's
// deployable/binding graph, which no single backend emitter can see.  Scoped to
// the ADAPTER, not the platform — `persistence: efcore` on the same `platform:
// dotnet` deployable is fine, and that is the fix the message names.
// ---------------------------------------------------------------------------
/** The one Postgres schema an UNQUALIFIED table name resolves to, so naming it
 *  explicitly asks for the placement a self-provisioning adapter already gives.
 *  Postgres's default `search_path` is `"$user", public` and no emitted
 *  connection string overrides it, so an unqualified `CREATE TABLE "as"` lands
 *  in `public` unless a schema named after the connecting role exists. */
const UNQUALIFIED_SCHEMA = "public";

/** Does this binding ask for a table PLACEMENT the self-provisioning adapter
 *  cannot give?  An explicit `schema: "public"` does not (see the exemption in
 *  the block comment above); a `tablePrefix:` always does, on its own or
 *  alongside one. */
function asksUnhonourablePlacement(d: { schema?: string; tablePrefix?: string }): boolean {
  if (d.tablePrefix !== undefined) return true;
  return d.schema !== undefined && d.schema !== UNQUALIFIED_SCHEMA;
}

export function validateSelfProvisioningSchemaSupport(
  loom: EnrichedLoomModel,
  diags: LoomDiagnostic[],
): void {
  for (const sys of loom.systems) {
    // Bindings that put tables on disk.  `cache` / `replica` bindings carry no
    // aggregate tables, so a schema on one is not a table-placement decision.
    const tableBindings = sys.dataSources.filter(
      (d) => d.kind === "state" || d.kind === "eventLog",
    );
    if (tableBindings.length === 0) continue;
    const boundContexts = new Set(tableBindings.map((d) => d.contextName));

    /** Deployables that actually provision tables for `ctx`: they host it AND
     *  wire at least one of its table bindings.  A deployable that hosts a
     *  context without wiring its dataSource emits no schema for it. */
    const provisioners = (ctxName: string) =>
      sys.deployables.filter(
        (dep) =>
          dep.contextNames.includes(ctxName) &&
          tableBindings.some(
            (d) => d.contextName === ctxName && dep.dataSourceNames.includes(d.name),
          ),
      );

    for (const ctxName of boundContexts) {
      const hosts = provisioners(ctxName);
      const selfProv = hosts.filter(
        (d) => d.persistence && SELF_PROVISIONING_ADAPTERS.has(d.persistence),
      );
      if (selfProv.length === 0) continue;
      const qualifying = hosts.filter(
        (d) => !d.persistence || !SELF_PROVISIONING_ADAPTERS.has(d.persistence),
      );

      for (const dep of selfProv) {
        const source = `${sys.name}/${dep.name}`;
        const isDapper = dep.persistence === "dapper";
        // The bindings this deployable actually wires for `ctxName`.  When
        // EVERY one of them places its tables where an unqualified name already
        // resolves, the two adapters name the SAME physical table and neither
        // arm below has anything to report (see the exemption in the block
        // comment above).  `.every` over a non-empty list: `selfProv`
        // membership came from `provisioners`, which required at least one.
        const wired = tableBindings.filter(
          (d) => d.contextName === ctxName && dep.dataSourceNames.includes(d.name),
        );
        const converges = wired.every(
          (d) => d.schema === UNQUALIFIED_SCHEMA && d.tablePrefix === undefined,
        );
        // (1) split-brain — a sibling adapter qualifies the same context.
        if (qualifying.length > 0 && !converges) {
          const params = {
            name: dep.name,
            adapter: dep.persistence,
            ctxName,
            other: qualifying[0]!.name,
            otherAdapter: qualifying[0]!.persistence ?? qualifying[0]!.platform,
          };
          // One push per adapter, each with a STRING-LITERAL `code:` — a
          // computed `loom.${…}-unsupported` is invisible to the catalog
          // ratchet (`diagnostic-catalog.test.ts`), which is the whole reason
          // the sibling migration gate above spells both arms out too.
          if (isDapper) {
            diags.push({
              severity: "error",
              code: "loom.dapper-unsupported",
              message: diagMessage("loom.dapper-unsupported#schema-split", params),
              source,
            });
          } else {
            diags.push({
              severity: "error",
              code: "loom.mikroorm-unsupported",
              message: diagMessage("loom.mikroorm-unsupported#schema-split", params),
              source,
            });
          }
          continue;
        }
        // (2) no sibling, but the binding ASKS for a placement this adapter
        // cannot honour.  Only an EXPLICIT `schema:` / `tablePrefix:` is a
        // request — the `snake(ctx)` default is what a lone self-provisioning
        // deployable already lives with consistently.
        const asking = tableBindings.find(
          (d) =>
            d.contextName === ctxName &&
            dep.dataSourceNames.includes(d.name) &&
            asksUnhonourablePlacement(d),
        );
        if (!asking) continue;
        const params = {
          name: dep.name,
          adapter: dep.persistence,
          binding: asking.name,
          // Name the clause that is actually unhonourable, not merely the
          // first one present: `schema: "public"` alongside a `tablePrefix:`
          // is satisfied (see the exemption above), so quoting it here would
          // point the author at the one clause they may keep.
          asked:
            asking.schema !== undefined && asking.schema !== UNQUALIFIED_SCHEMA
              ? `schema: "${asking.schema}"`
              : `tablePrefix: "${asking.tablePrefix}"`,
        };
        if (isDapper) {
          diags.push({
            severity: "error",
            code: "loom.dapper-unsupported",
            message: diagMessage("loom.dapper-unsupported#schema-ignored", params),
            source,
          });
        } else {
          diags.push({
            severity: "error",
            code: "loom.mikroorm-unsupported",
            message: diagMessage("loom.mikroorm-unsupported#schema-ignored", params),
            source,
          });
        }
      }
    }
  }
}

function typeFamily(t: TypeIR): string | undefined {
  switch (t.kind) {
    case "primitive":
      return t.name;
    case "enum":
      return `enum:${t.name}`;
    case "id":
      return "id";
    case "optional":
      return typeFamily(t.inner);
    default:
      return undefined;
  }
}

const NUMERIC = new Set(["int", "long", "decimal", "money"]);

/** Does the expression's inferred family fit the field's declared type?
 *  Tolerant: unknown on either side never diagnoses; the numeric family is
 *  interchangeable (columns are wider than the literal); a string fits an
 *  enum column (enums store their text). */
function backfillTypeFits(
  fieldType: TypeIR,
  expr: ExprIR,
): true | { expected: string; got: string } {
  const got = sqlExprFamily(expr);
  if (got === undefined) return true;
  const optional = fieldType.kind === "optional";
  const expected = typeFamily(fieldType);
  if (expected === undefined) return true;
  if (got === "null") return optional ? true : { expected, got: "null" };
  if (got === expected) return true;
  if (NUMERIC.has(got) && NUMERIC.has(expected)) return true;
  if (expected.startsWith("enum:") && got === "string") return true;
  if (expected === "id" && got === "string") return true;
  return { expected, got };
}

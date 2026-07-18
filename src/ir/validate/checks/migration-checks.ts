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
//   - `loom.backfill-target-unsupported`  — the target field has no single
//     scalar column: value-object / collection / entity fields, and
//     `shape(document)` / `persistedAs(eventLog)` aggregates (no row columns
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
        code: "loom.backfill-target-unsupported",
        message: `backfill '${intent.aggregate}.${intent.field}': a ${
          agg.persistedAs === "eventLog" ? "persistedAs(eventLog)" : "shape(document)"
        } aggregate stores no scalar columns to backfill — use a raw sql step over its payload instead.`,
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
        code: "loom.backfill-target-unsupported",
        message: `backfill '${intent.aggregate}.${intent.field}': the field is not a single scalar column (value-object, collection and entity fields cannot be backfilled — Phoenix stores a value object as one map column, so a leaf UPDATE would not be portable).`,
        source,
      });
      continue;
    }

    const renderable = sqlRenderableExpr(intent.value);
    if (renderable !== true) {
      diags.push({
        severity: "error",
        code: "loom.migration-expr-unsupported",
        message: `backfill '${intent.aggregate}.${intent.field}': ${renderable.reason}.`,
        source,
      });
      continue;
    }

    const fit = backfillTypeFits(field.type, intent.value);
    if (fit !== true) {
      diags.push({
        severity: "error",
        code: "loom.backfill-type-mismatch",
        message: `backfill '${intent.aggregate}.${intent.field}': expression type '${fit.got}' does not fit the field's type '${fit.expected}'.`,
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

// ---------------------------------------------------------------------------
// TEMPORARY honest gate (S2 of the M-T2.3 slice plan) — the surface exists
// (grammar/IR/validators/print) but the phase-⑨ builder does not consume the
// intents yet, so admitting them would silently no-op.  Lifted by S3, which
// wires `buildMigrations` to the intents.  Mirrors the read-path
// `loom.projection-query-time-unsupported` honest-gate pattern.
// ---------------------------------------------------------------------------

export function validateMigrationDataStepsUnsupported(
  loom: EnrichedLoomModel,
  diags: LoomDiagnostic[],
): void {
  const flag = (migration: string, what: string) =>
    diags.push({
      severity: "error",
      code: "loom.migration-data-steps-unsupported",
      message: `${what} steps are not applied by the migration builder yet (M-T2.3 S3) — remove the step or wait for the next slice.`,
      source: `migration/${migration}`,
    });
  for (const b of loom.backfillIntents) flag(b.migration, "backfill");
  for (const s of loom.sqlMigrationSteps) flag(s.migration, "sql");
}

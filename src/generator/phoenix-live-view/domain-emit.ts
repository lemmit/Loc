import { classifyForWire, singleFieldShape } from "../../ir/invariant-classify.js";
import type {
  AggregateIR,
  AssociationIR,
  BoundedContextIR,
  ContainmentIR,
  DerivedIR,
  EntityPartIR,
  FieldIR,
  InvariantIR,
  OperationIR,
  TypeIR,
} from "../../ir/loom-ir.js";
import { snake, upperFirst } from "../../util/naming.js";
import { joinEntityName } from "./join-resource-emit.js";
import { type RenderCtx, relationshipNameFor, renderAshType, renderExpr } from "./render-expr.js";
import { renderElixirStatements } from "./render-stmt.js";

/** True for a field type that is a collection of references
 * (`Id<T>[]`) — persisted via a join table, not a column. */
function isRefCollection(t: TypeIR): boolean {
  return t.kind === "array" && t.element.kind === "id";
}

// ---------------------------------------------------------------------------
// Ash domain emitter — per `AggregateIR` produce one `Ash.Resource` module.
//
// Output path:  lib/<app>/<ctx_snake>/<agg_snake>.ex
// Module name:  <AppModule>.<CtxModule>.<AggModule>
// ---------------------------------------------------------------------------

export function emitAggregateResources(
  ctx: BoundedContextIR,
  appModule: string,
  appSnake: string,
): Map<string, string> {
  const out = new Map<string, string>();
  const ctxModule = `${appModule}.${upperFirst(ctx.name)}`;
  const ctxSnake = snake(ctx.name);

  for (const agg of ctx.aggregates) {
    const path = `lib/${appSnake}/${ctxSnake}/${snake(agg.name)}.ex`;
    out.set(path, renderAggregateResource(agg, ctx, appModule, ctxModule));
    // Also emit entity-part resources (contained entities become
    // Ash.Resource embedded/joined resources).
    for (const part of agg.parts) {
      const partPath = `lib/${appSnake}/${ctxSnake}/${snake(part.name)}.ex`;
      out.set(partPath, renderEntityPartResource(part, agg, ctx, appModule, ctxModule));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Aggregate → Ash.Resource
// ---------------------------------------------------------------------------

function renderAggregateResource(
  agg: AggregateIR,
  ctx: BoundedContextIR,
  appModule: string,
  ctxModule: string,
): string {
  const moduleName = `${ctxModule}.${upperFirst(agg.name)}`;
  const tableSnake = snake(plural(agg.name));
  const repoModule = `${appModule}.Repo`;

  const renderCtx: RenderCtx = { thisName: "record", contextModule: ctxModule, agg };

  // Reference-collection fields (`Id<T>[]`) are persisted via a separate
  // join table (see join-resource-emit.ts), not as a column on this row.
  // Skip them in the attribute list and the @derive Jason list (Jason
  // serialises attributes / loaded calculations; the calculation we
  // emit below is unloaded by default and would surface as nil — so
  // it's intentionally absent from the wire shape until the caller
  // explicitly loads it).
  const associations = agg.associations ?? [];
  const persistedFields = agg.fields.filter((f) => !isRefCollection(f.type));

  // Build the @derive field list: :id, persisted fields only, timestamps.
  const deriveFields = [
    ":id",
    ...persistedFields.map((f) => `:${snake(f.name)}`),
    ":inserted_at",
    ":updated_at",
  ].join(", ");

  // Inspect protocol implementation: delegates to the resource's
  // `:inspect` calculation when one is declared.  Gives a useful debug
  // form in IEx, Logger, and exceptions — the Phoenix/Elixir equivalent
  // of the TS `util.inspect.custom` / C# `ToString()` hook.  See plan
  // `/root/.claude/plans/i-think-we-have-glittery-lecun.md`.
  const inspectImpl = agg.derived.some((d) => d.name === "inspect")
    ? `
defimpl Inspect, for: ${moduleName} do
  def inspect(record, _opts) do
    case Ash.load(record, :inspect) do
      {:ok, loaded} -> loaded.inspect
      _ -> "#${moduleName}<id=" <> to_string(record.id) <> ">"
    end
  end
end
`
    : "";

  return `defmodule ${moduleName} do
  @derive {Jason.Encoder, only: [${deriveFields}]}
  use Ash.Resource,
    domain: ${ctxModule},
    data_layer: AshPostgres.DataLayer

  postgres do
    table "${tableSnake}"
    repo ${repoModule}
  end

  attributes do
    ${renderPrimaryKey(agg.idValueType)}
    ${persistedFields.map((f) => renderAttribute(f, ctxModule)).join("\n    ")}
    timestamps()
  end
${renderRelationships(agg.contains, associations, ctxModule, agg)}${renderCalculations(agg.derived, associations, renderCtx, agg)}${renderPreparations(associations, agg)}${renderValidations(agg.invariants, renderCtx, new Set(agg.fields.map((f) => f.name)))}${renderActions(agg, ctx, renderCtx, ctxModule)}
end
${inspectImpl}`;
}

// ---------------------------------------------------------------------------
// Entity part → Ash.Resource (embedded)
// ---------------------------------------------------------------------------

function renderEntityPartResource(
  part: EntityPartIR,
  agg: AggregateIR,
  _ctx: BoundedContextIR,
  appModule: string,
  ctxModule: string,
): string {
  const moduleName = `${ctxModule}.${upperFirst(part.name)}`;
  const tableSnake = snake(plural(part.name));
  const repoModule = `${appModule}.Repo`;
  const parentFk = `${snake(part.parentName)}_id`;

  const renderCtx: RenderCtx = { thisName: "record", contextModule: ctxModule };

  return `defmodule ${moduleName} do
  use Ash.Resource,
    domain: ${ctxModule},
    data_layer: AshPostgres.DataLayer

  postgres do
    table "${tableSnake}"
    repo ${repoModule}
  end

  attributes do
    uuid_primary_key :id
    attribute :${parentFk}, :uuid, allow_nil?: false
    ${part.fields.map((f) => renderAttribute(f, ctxModule)).join("\n    ")}
    timestamps()
  end

  relationships do
    belongs_to :${snake(part.parentName)}, ${ctxModule}.${upperFirst(agg.name)}
  end
${renderValidations(part.invariants, renderCtx, new Set(part.fields.map((f) => f.name)))}
  actions do
    defaults [:read, :destroy]

    create :create do
      primary? true
      accept [${part.fields.map((f) => `:${snake(f.name)}`).join(", ")}]
    end
  end
end
`;
}

// ---------------------------------------------------------------------------
// Primary key
// ---------------------------------------------------------------------------

function renderPrimaryKey(idValueType: string): string {
  switch (idValueType) {
    case "int":
      return "integer_primary_key :id";
    case "long":
      return "integer_primary_key :id";
    case "string":
      return "attribute :id, :string, primary_key?: true, allow_nil?: false";
    default:
      return "uuid_primary_key :id";
  }
}

// ---------------------------------------------------------------------------
// Attributes
// ---------------------------------------------------------------------------

function renderAttribute(f: FieldIR, ctxModule: string): string {
  const ashType = renderAshType(f.type, ctxModule);
  const allowNil = f.optional ? "true" : "false";
  return `attribute :${snake(f.name)}, ${ashType}, allow_nil?: ${allowNil}`;
}

// ---------------------------------------------------------------------------
// Relationships
// ---------------------------------------------------------------------------

function renderRelationships(
  contains: ContainmentIR[],
  associations: AssociationIR[],
  ctxModule: string,
  agg: AggregateIR,
): string {
  if (contains.length === 0 && associations.length === 0) return "";
  const containLines = contains.map((c) => {
    const relName = snake(c.name);
    const destModule = `${ctxModule}.${upperFirst(c.partName)}`;
    if (c.collection) {
      return `    has_many :${relName}, ${destModule}`;
    }
    return `    has_one :${relName}, ${destModule}`;
  });
  const m2mLines = associations.flatMap((a) => {
    const rel = relationshipNameFor(agg, a.fieldName);
    const target = `${ctxModule}.${upperFirst(a.targetAgg)}`;
    const join = `${ctxModule}.${joinEntityName(a)}`;
    return [
      `    many_to_many :${rel}, ${target} do`,
      `      through ${join}`,
      `      source_attribute_on_join_resource :${snake(a.ownerFk)}`,
      `      destination_attribute_on_join_resource :${snake(a.targetFk)}`,
      `    end`,
    ];
  });
  const lines = [...containLines, ...m2mLines];
  return `\n  relationships do\n${lines.join("\n")}\n  end\n`;
}

// ---------------------------------------------------------------------------
// Calculations (derived properties)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Preparations (global read preparations)
// ---------------------------------------------------------------------------

/** When the aggregate has reference-collection fields, the calculations
 *  that re-expose them as `{:array, :uuid}` (see renderCalculations) need
 *  to be loaded on every read for the wire shape to materialise — Ash
 *  calculations are opt-in by default.  Emit a `preparations do prepare
 *  build(load: […]) end` block that applies to every read action on the
 *  resource (default `:read` + each custom `find`). */
function renderPreparations(associations: AssociationIR[], _agg: AggregateIR): string {
  if (associations.length === 0) return "";
  const fieldNames = associations.map((a) => `:${snake(a.fieldName)}`).join(", ");
  return `\n  preparations do\n    prepare build(load: [${fieldNames}])\n  end\n`;
}

function renderCalculations(
  derived: DerivedIR[],
  associations: AssociationIR[],
  ctx: RenderCtx,
  agg: AggregateIR,
): string {
  if (derived.length === 0 && associations.length === 0) return "";
  const derivedLines = derived.map((d) => {
    const ashType = renderAshType(d.type, ctx.contextModule);
    const exprStr = renderExpr(d.expr, ctx);
    return `    calculate :${snake(d.name)}, ${ashType}, expr(${exprStr})`;
  });
  // Re-expose each reference collection as a calculation that maps the
  // m2m relationship to a list of target ids — same wire shape as the
  // TS/Hono `party: string[]` and .NET `List<TargetId> Party`.  Loaded
  // explicitly on demand (callers add `load: [:party, :caught]`); not
  // auto-derived into JSON to avoid an N+1 on every read.
  const assocLines = associations.map((a) => {
    const fieldName = snake(a.fieldName);
    const rel = relationshipNameFor(agg, a.fieldName);
    return `    calculate :${fieldName}, {:array, :uuid}, expr(${rel}.id)`;
  });
  const lines = [...derivedLines, ...assocLines];
  return `\n  calculations do\n${lines.join("\n")}\n  end\n`;
}

// ---------------------------------------------------------------------------
// Validations (invariants)
// ---------------------------------------------------------------------------

function renderValidations(
  invariants: InvariantIR[],
  ctx: RenderCtx,
  /** Field names available on the resource — used for single-field
   *  pattern detection.  Pass an empty set to skip idiom detection. */
  fieldNames: ReadonlySet<string> = new Set(),
): string {
  if (invariants.length === 0) return "";
  const lines = invariants.map((inv) => {
    // Try to emit an idiomatic built-in Ash validator for single-field shapes
    // recognised by the invariant classifier.  These shapes are safe to run
    // at the domain layer regardless of the wire-boundary scope flag.
    const single = singleFieldShape(inv);
    if (single && fieldNames.has(single.field)) {
      const ashVal = ashBuiltinValidate(single.field, single.pattern);
      if (ashVal) {
        const msg = JSON.stringify(`Invariant violated: ${inv.source}`);
        return `    ${ashVal}, message: ${msg}`;
      }
    }

    // Function form — covers guarded, cross-field, and anything the
    // classifier doesn't reduce to a single-field pattern.
    const condStr = renderExpr(inv.expr, ctx);
    const msg = JSON.stringify(`Invariant violated: ${inv.source}`);
    if (inv.guard) {
      const guardStr = renderExpr(inv.guard, ctx);
      // Guard-first: when the guard is false the invariant doesn't apply
      // (not an error).  Emit as `not guard or cond` — matches the
      // logical-implication semantics of the source `guard => cond`.
      return `    validate fn changeset, _opts ->\n      if not (${guardStr}) or (${condStr}), do: :ok, else: {:error, ${msg}}\n    end`;
    }
    return `    validate fn changeset, _opts ->\n      if ${condStr}, do: :ok, else: {:error, ${msg}}\n    end`;
  });
  return `\n  validations do\n${lines.join("\n")}\n  end\n`;
}

// ---------------------------------------------------------------------------
// Actions (operations)
// ---------------------------------------------------------------------------

function renderActions(
  agg: AggregateIR,
  _ctx: BoundedContextIR,
  renderCtx: RenderCtx,
  ctxModule: string,
): string {
  const ops = agg.operations;
  // Ref-collection fields (`Id<T>[]`) aren't attributes on the
  // resource (they live in a join table); the create action can't
  // `accept` them without a `change manage_relationship` block, which
  // we defer.  Callers seed reference collections via the operations
  // that mutate them (`addToParty`, etc.).
  const fieldNames = agg.fields
    .filter((f) => !isRefCollection(f.type))
    .map((f) => `:${snake(f.name)}`);

  const defaultCreate = `    create :create do
      primary? true
      accept [${fieldNames.join(", ")}]
    end`;

  const opActions = ops.map((op) => renderOperationAction(op, renderCtx, ctxModule));

  return `\n  actions do
    defaults [:read, :update, :destroy]

${defaultCreate}
${opActions.join("\n")}
  end\n`;
}

function renderOperationAction(op: OperationIR, ctx: RenderCtx, _ctxModule: string): string {
  const args = op.params
    .map((p) => `      argument :${snake(p.name)}, ${renderAshType(p.type, ctx.contextModule)}`)
    .join("\n");

  // Collect precondition statements and lower them to Ash validate clauses.
  const available = new Set(op.params.map((p) => p.name));
  const validateLines = renderOperationValidates(op, ctx, available);

  // Filter out precondition statements before rendering change block —
  // preconditions are emitted as validate clauses above, not in the change fn.
  const nonPrecondStmts = op.statements.filter((s) => s.kind !== "precondition");
  const stmts = renderElixirStatements(nonPrecondStmts, ctx, "changeset");

  const argsBlock = op.params.length > 0 ? `\n${args}` : "";
  const validateBlock = validateLines.length > 0 ? `\n${validateLines.join("\n")}` : "";
  const changeBlock =
    nonPrecondStmts.length > 0
      ? `\n      change fn changeset, _context ->\n${stmts}\n        changeset\n      end`
      : "";

  return `    update :${snake(op.name)} do${argsBlock}${validateBlock}${changeBlock}
    end`;
}

// ---------------------------------------------------------------------------
// Operation argument validation — lower precondition StmtIRs to
// Ash `validate` clauses inside the action block.
//
// Recognised single-field shapes (min/max/between/regex/len-*) emit the
// idiomatic Ash built-in validator; everything else emits a function form:
//
//   validate fn changeset, _opts ->
//     if <expr>, do: :ok, else: {:error, "<message>"}
//   end
// ---------------------------------------------------------------------------

function renderOperationValidates(
  op: OperationIR,
  ctx: RenderCtx,
  available: ReadonlySet<string>,
): string[] {
  const lines: string[] = [];

  for (const stmt of op.statements) {
    if (stmt.kind !== "precondition") continue;

    const inv = { expr: stmt.expr, source: stmt.source };
    // Use a changeset-oriented renderCtx for the predicate expression.
    const valCtx: RenderCtx = { thisName: "changeset", contextModule: ctx.contextModule };

    // Check if this is a single-field shape we can lower idiomatically.
    if (classifyForWire(inv, { available })) {
      const single = singleFieldShape(inv);
      if (single) {
        const ashValidate = ashBuiltinValidate(single.field, single.pattern);
        if (ashValidate) {
          lines.push(
            `      ${ashValidate}, message: ${JSON.stringify(`Precondition failed: ${stmt.source}`)}`,
          );
          continue;
        }
      }
    }

    // Fall back to the function form.
    const exprStr = renderExpr(stmt.expr, valCtx);
    lines.push(
      `      validate fn changeset, _opts ->\n        if ${exprStr}, do: :ok, else: {:error, ${JSON.stringify(`Precondition failed: ${stmt.source}`)}}\n      end`,
    );
  }

  return lines;
}

/** Map a recognised single-field pattern to an idiomatic Ash built-in
 *  validate call string (without trailing message), or null when no
 *  built-in covers the shape. */
function ashBuiltinValidate(
  field: string,
  pattern: import("../../ir/invariant-classify.js").SingleFieldPattern,
): string | null {
  const attr = `:${snake(field)}`;
  switch (pattern.kind) {
    case "min":
      return `validate compare(${attr}, greater_than_or_equal_to: ${pattern.n})`;
    case "max":
      return `validate compare(${attr}, less_than_or_equal_to: ${pattern.n})`;
    case "between":
      return `validate compare(${attr}, greater_than_or_equal_to: ${pattern.lo}, less_than_or_equal_to: ${pattern.hi})`;
    case "len-min":
      return `validate string_length(${attr}, min: ${pattern.n})`;
    case "len-max":
      return `validate string_length(${attr}, max: ${pattern.n})`;
    case "len-eq":
      return `validate string_length(${attr}, min: ${pattern.n}, max: ${pattern.n})`;
    case "len-range":
      return `validate string_length(${attr}, min: ${pattern.lo}, max: ${pattern.hi})`;
    case "regex":
      return `validate match(${attr}, ~r/${pattern.pattern}/)`;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function plural(name: string): string {
  if (name.endsWith("y") && !/[aeiou]y$/i.test(name)) {
    return name.slice(0, -1) + "ies";
  }
  if (/(s|x|z|ch|sh)$/i.test(name)) return name + "es";
  return name + "s";
}

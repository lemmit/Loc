import type {
  AggregateIR,
  BoundedContextIR,
  ContainmentIR,
  DerivedIR,
  EntityPartIR,
  FieldIR,
  InvariantIR,
  OperationIR,
} from "../../ir/loom-ir.js";
import { snake, pascal } from "../../util/naming.js";
import { renderExpr, renderAshType, type RenderCtx } from "./render-expr.js";
import { renderElixirStatements } from "./render-stmt.js";

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
  const ctxModule = `${appModule}.${pascal(ctx.name)}`;
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
  const moduleName = `${ctxModule}.${pascal(agg.name)}`;
  const tableSnake = snake(plural(agg.name));
  const repoModule = `${appModule}.Repo`;

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
    ${renderPrimaryKey(agg.idValueType)}
    ${agg.fields.map((f) => renderAttribute(f, ctxModule)).join("\n    ")}
    timestamps()
  end
${renderRelationships(agg.contains, ctxModule)}${renderCalculations(agg.derived, renderCtx)}${renderValidations(agg.invariants, renderCtx)}${renderActions(agg, ctx, renderCtx, ctxModule)}
end
`;
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
  const moduleName = `${ctxModule}.${pascal(part.name)}`;
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
    belongs_to :${snake(part.parentName)}, ${ctxModule}.${pascal(agg.name)}
  end
${renderValidations(part.invariants, renderCtx)}
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
  ctxModule: string,
): string {
  if (contains.length === 0) return "";
  const lines = contains.map((c) => {
    const relName = snake(c.name);
    const destModule = `${ctxModule}.${pascal(c.partName)}`;
    if (c.collection) {
      return `    has_many :${relName}, ${destModule}`;
    }
    return `    has_one :${relName}, ${destModule}`;
  });
  return `\n  relationships do\n${lines.join("\n")}\n  end\n`;
}

// ---------------------------------------------------------------------------
// Calculations (derived properties)
// ---------------------------------------------------------------------------

function renderCalculations(
  derived: DerivedIR[],
  ctx: RenderCtx,
): string {
  if (derived.length === 0) return "";
  const lines = derived.map((d) => {
    const ashType = renderAshType(d.type, ctx.contextModule);
    const exprStr = renderExpr(d.expr, ctx);
    return `    calculate :${snake(d.name)}, ${ashType}, expr(${exprStr})`;
  });
  return `\n  calculations do\n${lines.join("\n")}\n  end\n`;
}

// ---------------------------------------------------------------------------
// Validations (invariants)
// ---------------------------------------------------------------------------

function renderValidations(
  invariants: InvariantIR[],
  ctx: RenderCtx,
): string {
  if (invariants.length === 0) return "";
  const lines = invariants.map((inv) => {
    const cond = renderExpr(inv.expr, ctx);
    if (inv.guard) {
      const guardStr = renderExpr(inv.guard, ctx);
      return `    validate compare(:__expression__, less_than: true),\n      message: ${JSON.stringify(`Invariant violated: ${inv.source}`)},\n      where: [${guardStr}]`;
    }
    return `    validate attribute_does_not_match(:__expression__, ${JSON.stringify(cond)}),\n      message: ${JSON.stringify(`Invariant violated: ${inv.source}`)}`;
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
  const fieldNames = agg.fields.map((f) => `:${snake(f.name)}`);

  const defaultCreate = `    create :create do
      primary? true
      accept [${fieldNames.join(", ")}]
    end`;

  const opActions = ops.map((op) =>
    renderOperationAction(op, renderCtx, ctxModule),
  );

  return `\n  actions do
    defaults [:read, :destroy]

${defaultCreate}
${opActions.join("\n")}
  end\n`;
}

function renderOperationAction(
  op: OperationIR,
  ctx: RenderCtx,
  _ctxModule: string,
): string {
  const args = op.params
    .map((p) => `      argument :${snake(p.name)}, ${renderAshType(p.type, ctx.contextModule)}`)
    .join("\n");

  const stmts = renderElixirStatements(op.statements, ctx, "changeset");

  const argsBlock = op.params.length > 0 ? `\n${args}` : "";
  const changeBlock =
    op.statements.length > 0
      ? `\n      change fn changeset, _context ->\n${stmts}\n        changeset\n      end`
      : "";

  return `    update :${snake(op.name)} do${argsBlock}${changeBlock}
    end`;
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

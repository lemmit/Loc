import type { BoundedContextIR, ValueObjectIR, FieldIR } from "../../ir/loom-ir.js";
import { snake, pascal } from "../../util/naming.js";
import { renderAshType, renderExpr, type RenderCtx } from "./render-expr.js";

// ---------------------------------------------------------------------------
// Value-object emitter.
//
// Simple value objects (single primitive field) → `Ash.Type.NewType`.
// Composite value objects (multiple fields) → embedded `Ash.Resource`.
//
// Output path: lib/<app>/<ctx_snake>/<vo_snake>.ex
// ---------------------------------------------------------------------------

export function emitValueObjects(
  ctx: BoundedContextIR,
  appModule: string,
  appSnake: string,
): Map<string, string> {
  const out = new Map<string, string>();
  const ctxModule = `${appModule}.${pascal(ctx.name)}`;
  const ctxSnake = snake(ctx.name);

  for (const vo of ctx.valueObjects) {
    const path = `lib/${appSnake}/${ctxSnake}/${snake(vo.name)}.ex`;
    out.set(path, renderValueObject(vo, appModule, ctxModule));
  }
  return out;
}

function renderValueObject(
  vo: ValueObjectIR,
  _appModule: string,
  ctxModule: string,
): string {
  const moduleName = `${ctxModule}.${pascal(vo.name)}`;
  const renderCtx: RenderCtx = { thisName: "value", contextModule: ctxModule };

  if (isSimplePrimitive(vo)) {
    // Single-field primitive → NewType wrapping the underlying Ash type.
    const f = vo.fields[0]!;
    const ashType = renderAshType(f.type, ctxModule);
    return renderNewType(moduleName, ashType);
  }

  // Composite → embedded Ash.Resource.
  return renderEmbeddedResource(vo, moduleName, ctxModule, renderCtx);
}

// ---------------------------------------------------------------------------
// Ash.Type.NewType (simple wrapper)
// ---------------------------------------------------------------------------

function renderNewType(moduleName: string, baseType: string): string {
  return `defmodule ${moduleName} do
  use Ash.Type.NewType, subtype_of: ${baseType}
end
`;
}

// ---------------------------------------------------------------------------
// Embedded Ash.Resource (composite)
// ---------------------------------------------------------------------------

function renderEmbeddedResource(
  vo: ValueObjectIR,
  moduleName: string,
  ctxModule: string,
  renderCtx: RenderCtx,
): string {
  const attrs = vo.fields
    .map((f) => renderAttribute(f, ctxModule))
    .join("\n    ");

  const calcs =
    vo.derived.length > 0
      ? `\n  calculations do\n${vo.derived
          .map(
            (d) =>
              `    calculate :${snake(d.name)}, ${renderAshType(d.type, ctxModule)}, expr(${renderExpr(d.expr, renderCtx)})`,
          )
          .join("\n")}\n  end\n`
      : "";

  const validations =
    vo.invariants.length > 0
      ? `\n  validations do\n${vo.invariants
          .map(
            (inv) =>
              `    validate compare(:__expression__, less_than: true),\n      message: ${JSON.stringify(`Invariant violated: ${inv.source}`)}`,
          )
          .join("\n")}\n  end\n`
      : "";

  return `defmodule ${moduleName} do
  use Ash.Resource,
    data_layer: :embedded

  attributes do
    ${attrs}
  end
${calcs}${validations}
  actions do
    defaults [:read, :create, :update, :destroy]
  end
end
`;
}

function renderAttribute(f: FieldIR, ctxModule: string): string {
  const ashType = renderAshType(f.type, ctxModule);
  const allowNil = f.optional ? "true" : "false";
  return `attribute :${snake(f.name)}, ${ashType}, allow_nil?: ${allowNil}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A value object is "simple" when it has exactly one field and no
 * derived properties, invariants, or functions — just a type alias. */
function isSimplePrimitive(vo: ValueObjectIR): boolean {
  return (
    vo.fields.length === 1 &&
    vo.derived.length === 0 &&
    vo.invariants.length === 0 &&
    vo.functions.length === 0
  );
}

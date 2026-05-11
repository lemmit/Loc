import type { BoundedContextIR, EnumIR } from "../../ir/loom-ir.js";
import { snake, pascal } from "../../util/naming.js";

// ---------------------------------------------------------------------------
// Domain module emitter — per `BoundedContextIR` produce:
//
//   1. lib/<app>/<ctx_snake>.ex         — `use Ash.Domain` with resource list
//   2. lib/<app>/<ctx_snake>/<enum>.ex  — per-enum Ash.Type.Enum modules
//
// The domain module declares all resources in the context so Ash can
// resolve cross-resource relationships and code-interface dispatching.
// ---------------------------------------------------------------------------

export function emitDomainModule(
  ctx: BoundedContextIR,
  appModule: string,
  appSnake: string,
): Map<string, string> {
  const out = new Map<string, string>();
  const ctxModule = `${appModule}.${pascal(ctx.name)}`;
  const ctxSnake = snake(ctx.name);

  // Ash.Domain module.
  out.set(
    `lib/${appSnake}/${ctxSnake}.ex`,
    renderDomainModule(ctx, ctxModule),
  );

  // Enum modules.
  for (const en of ctx.enums) {
    out.set(
      `lib/${appSnake}/${ctxSnake}/${snake(en.name)}.ex`,
      renderEnumModule(en, ctxModule),
    );
  }

  return out;
}

// ---------------------------------------------------------------------------
// Ash.Domain
// ---------------------------------------------------------------------------

function renderDomainModule(
  ctx: BoundedContextIR,
  ctxModule: string,
): string {
  // Collect all resource module names: aggregates + their entity parts +
  // value objects.
  const resourceLines: string[] = [];

  for (const agg of ctx.aggregates) {
    resourceLines.push(`    resource ${ctxModule}.${pascal(agg.name)}`);
    for (const part of agg.parts) {
      resourceLines.push(`    resource ${ctxModule}.${pascal(part.name)}`);
    }
  }

  for (const vo of ctx.valueObjects) {
    resourceLines.push(`    resource ${ctxModule}.${pascal(vo.name)}`);
  }

  return `defmodule ${ctxModule} do
  use Ash.Domain

  resources do
${resourceLines.join("\n")}
  end
end
`;
}

// ---------------------------------------------------------------------------
// Ash.Type.Enum
// ---------------------------------------------------------------------------

function renderEnumModule(en: EnumIR, ctxModule: string): string {
  const moduleName = `${ctxModule}.${pascal(en.name)}`;
  const values = en.values.map((v) => `:${snake(v)}`).join(", ");

  return `defmodule ${moduleName} do
  use Ash.Type.Enum, values: [${values}]
end
`;
}

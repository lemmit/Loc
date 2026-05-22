import type { BoundedContextIR, EnumIR } from "../../ir/loom-ir.js";
import { snake, upperFirst } from "../../util/naming.js";

// ---------------------------------------------------------------------------
// Domain module emitter — per `BoundedContextIR` produce:
//
//   1. lib/<app>/<ctx_snake>.ex         — `use Ash.Domain` with resource list
//   2. lib/<app>/<ctx_snake>/<enum>.ex  — per-enum Ash.Type.Enum modules
//
// The domain module declares all resources in the context so Ash can
// resolve cross-resource relationships and code-interface dispatching.
//
// Ash 3.x code_interface shape:
//
//   resources do
//     resource MyApp.Sales.Customer do
//       define :create_customer, action: :create
//       define :get_customer,    action: :read, get_by: [:id]
//       define :list_customers,  action: :read
//       define :update_customer, action: :update
//       define :destroy_customer, action: :destroy
//     end
//   end
//
// `define` MUST live inside the `resource ... do` block — NOT in a
// separate top-level `code_interface do` block (that was the Ash 2.x
// pattern; Ash 3.0 removed it).
// ---------------------------------------------------------------------------

export function emitDomainModule(
  ctx: BoundedContextIR,
  appModule: string,
  appSnake: string,
): Map<string, string> {
  const out = new Map<string, string>();
  const ctxModule = `${appModule}.${upperFirst(ctx.name)}`;
  const ctxSnake = snake(ctx.name);

  // Ash.Domain module.
  out.set(`lib/${appSnake}/${ctxSnake}.ex`, renderDomainModule(ctx, ctxModule));

  // Enum modules.
  for (const en of ctx.enums) {
    out.set(`lib/${appSnake}/${ctxSnake}/${snake(en.name)}.ex`, renderEnumModule(en, ctxModule));
  }

  return out;
}

// ---------------------------------------------------------------------------
// Ash.Domain
// ---------------------------------------------------------------------------

function renderDomainModule(ctx: BoundedContextIR, ctxModule: string): string {
  // Build `resource <Module> do ... end` blocks for each aggregate (and its
  // entity parts) plus value objects.  Each block nests the Ash 3.x
  // `define` entries that expose code-interface functions on the domain.
  const resourceBlocks: string[] = [];

  for (const agg of ctx.aggregates) {
    const aggSnake = snake(agg.name);
    const aggModule = `${ctxModule}.${upperFirst(agg.name)}`;

    // Standard CRUD defines.  `get_by: [:id]` makes the read action a
    // singular get that raises `Ash.Error.Query.NotFound` when missing
    // (and generates a `!`-bang variant automatically).
    const defines: string[] = [
      `      define :create_${aggSnake}, action: :create`,
      `      define :get_${aggSnake},    action: :read, get_by: [:id]`,
      `      define :list_${aggSnake}s,  action: :read`,
      `      define :update_${aggSnake}, action: :update`,
      `      define :destroy_${aggSnake}, action: :destroy`,
    ];

    // Custom find actions from the repository.
    const repo = ctx.repositories.find((r) => r.aggregateName === agg.name);
    if (repo) {
      for (const find of repo.finds) {
        // Multi-param finds pass all params as positional args.
        if (find.params.length > 0) {
          const argList = find.params.map((p) => `:${snake(p.name)}`).join(", ");
          defines.push(
            `      define :${snake(find.name)}, action: :${snake(find.name)}, args: [${argList}]`,
          );
        } else {
          defines.push(`      define :${snake(find.name)}, action: :${snake(find.name)}`);
        }
      }
    }

    resourceBlocks.push(`    resource ${aggModule} do\n${defines.join("\n")}\n    end`);

    // Entity parts — simpler: only CRUD, no custom finds.
    for (const part of agg.parts) {
      const partSnake = snake(part.name);
      const partModule = `${ctxModule}.${upperFirst(part.name)}`;
      const partDefines = [
        `      define :create_${partSnake}, action: :create`,
        `      define :get_${partSnake},    action: :read, get_by: [:id]`,
        `      define :list_${partSnake}s,  action: :read`,
        `      define :update_${partSnake}, action: :update`,
        `      define :destroy_${partSnake}, action: :destroy`,
      ].join("\n");
      resourceBlocks.push(`    resource ${partModule} do\n${partDefines}\n    end`);
    }
  }

  // Value objects — embedded resources; no code-interface functions needed
  // (they are never loaded independently, only as part of an aggregate).
  for (const vo of ctx.valueObjects) {
    resourceBlocks.push(`    resource ${ctxModule}.${upperFirst(vo.name)}`);
  }

  return `defmodule ${ctxModule} do
  use Ash.Domain

  resources do
${resourceBlocks.join("\n\n")}
  end
end
`;
}

// ---------------------------------------------------------------------------
// Ash.Type.Enum
// ---------------------------------------------------------------------------

function renderEnumModule(en: EnumIR, ctxModule: string): string {
  const moduleName = `${ctxModule}.${upperFirst(en.name)}`;
  const values = en.values.map((v) => `:${snake(v)}`).join(", ");

  return `defmodule ${moduleName} do
  use Ash.Type.Enum, values: [${values}]
end
`;
}

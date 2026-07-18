import type {
  EnrichedBoundedContextIR,
  EnumIR,
  ProjectionIR,
  SystemIR,
} from "../../../ir/types/loom-ir.js";
import { resolveContextSchema } from "../../../ir/util/resolve-datasource.js";
import { plural, snake, upperFirst } from "../../../util/naming.js";
import type { ApiRoute } from "../api-emit.js";
import { ectoIdType, projectionRowModule } from "../dispatch-emit.js";
import { mapTypeToEcto } from "./schema-emit.js";

// ---------------------------------------------------------------------------
// Vanilla foundation — projection read models (projection.md), the read half.
//
// A projection folds foreign events into a read-model row.  The fold + dispatch
// wiring lives in `dispatch-emit.ts` (a pure `<Proj>.On<Event>` handler joined
// into the context Dispatcher); THIS module emits the two pieces the read side
// needs:
//
//   - `<App>.<Ctx>.Projections.<Proj>Row` — a plain `Ecto.Schema` over the
//     read-model table the shared `MigrationsIR` already derives (PK = the
//     `keyed by` correlation column, non-key columns nullable).  Enum fields
//     map to `Ecto.Enum` exactly like the aggregate schema, so the fold's
//     `%{state | status: :Placed}` atom round-trips to the declared string.
//   - `<App>Web.ProjectionsController` — ONE project-wide controller (mirrors
//     `ViewsController`) exposing `GET /api/projections/<slug>` (list) +
//     `/<slug>/:key` (one by correlation id, RFC-7807 404 if absent), reading
//     the row via `<App>.Repo` and projecting the projection `wireShape`.
//
// A context with no projections emits nothing here (byte-identical additivity).
// ---------------------------------------------------------------------------

export interface VanillaProjectionRef {
  ctx: EnrichedBoundedContextIR;
  proj: ProjectionIR;
}

/** Emit the read-model `<Proj>Row` Ecto schema for every projection in a
 *  context, and collect the `{ ctx, proj }` refs the project-wide controller is
 *  built from.  The fold handler + dispatcher wiring is emitted separately by
 *  `emitDispatch`. */
export function emitVanillaProjectionSchemas(
  appName: string,
  appModule: string,
  ctx: EnrichedBoundedContextIR,
  out: Map<string, string>,
  sys?: SystemIR,
): VanillaProjectionRef[] {
  if (ctx.projections.length === 0) return [];
  const ctxSnake = snake(ctx.name);
  const contextModule = `${appModule}.${upperFirst(ctx.name)}`;
  const schema = sys ? resolveContextSchema(ctx, sys) : undefined;
  const enumsByName = new Map<string, EnumIR>(ctx.enums.map((e) => [e.name, e]));
  const refs: VanillaProjectionRef[] = [];
  for (const proj of ctx.projections) {
    out.set(
      `lib/${appName}/${ctxSnake}/projections/${snake(proj.name)}_row.ex`,
      renderProjectionRowSchema(contextModule, proj, enumsByName, schema),
    );
    refs.push({ ctx, proj });
  }
  return refs;
}

/** The read-model row `Ecto.Schema`.  PK = the correlation column (matching the
 *  migration + saga state PK type); non-key fields map through `mapTypeToEcto`
 *  (so enums are `Ecto.Enum`, ids `:binary_id`, etc.). */
function renderProjectionRowSchema(
  contextModule: string,
  proj: ProjectionIR,
  enumsByName: Map<string, EnumIR>,
  schema?: string,
): string {
  const corr = proj.correlationField as string;
  const corrField = proj.stateFields.find((f) => f.name === corr);
  const pkType =
    corrField && corrField.type.kind === "id" ? ectoIdType(corrField.type.valueType) : ":string";
  const table = plural(snake(proj.name));
  const fieldLines = proj.stateFields
    .filter((f) => f.name !== corr)
    .map((f) => {
      const ecto = mapTypeToEcto(f.type, enumsByName);
      if (!ecto) {
        throw new Error(
          `elixir projection: unsupported read-model field '${f.name}' on '${proj.name}' (${f.type.kind}).`,
        );
      }
      return `    field :${snake(f.name)}, ${ecto}`;
    });
  const prefixLine = schema ? `  @schema_prefix ${JSON.stringify(schema)}\n` : "";
  return `# Auto-generated.
defmodule ${projectionRowModule(contextModule, proj)} do
  @moduledoc "Read model folded from foreign events for the ${upperFirst(proj.name)} projection."

  use Ecto.Schema

${prefixLine}  @primary_key {:${snake(corr)}, ${pkType}, autogenerate: false}
  schema "${table}" do
${fieldLines.length > 0 ? fieldLines.join("\n") + "\n" : ""}    timestamps()
  end
end
`;
}

/** The single project-wide `ProjectionsController` over every hosted context's
 *  projections (mirrors `emitVanillaViewsController`), plus the read routes.
 *  Returns `[]` (and emits no controller) when there are no projections. */
export function emitVanillaProjectionsController(
  appName: string,
  appModule: string,
  projections: VanillaProjectionRef[],
  out: Map<string, string>,
): ApiRoute[] {
  if (projections.length === 0) return [];
  const webModule = `${appModule}Web`;
  const actions = projections
    .map(({ ctx, proj }) =>
      renderProjectionActions(`${appModule}.${upperFirst(ctx.name)}`, appModule, proj),
    )
    .join("\n\n");

  out.set(
    `lib/${appName}_web/controllers/projections_controller.ex`,
    `# Auto-generated.
defmodule ${webModule}.ProjectionsController do
  use ${webModule}, :controller
  alias ${webModule}.ProblemDetails

  @moduledoc """
  Read-only HTTP entry points for projection read models (projection.md).
  Each action reads the projection's read-model Ecto schema via the app Repo
  and encodes the projection wire shape.
  """

${actions}
end
`,
  );

  const routes: ApiRoute[] = [];
  for (const { proj } of projections) {
    const slug = snake(proj.name);
    routes.push({
      method: "get",
      path: `/projections/${slug}`,
      controller: "ProjectionsController",
      action: `:${slug}_index`,
    });
    routes.push({
      method: "get",
      path: `/projections/${slug}/:key`,
      controller: "ProjectionsController",
      action: `:${slug}_show`,
    });
  }
  return routes;
}

/** The list + by-key actions for one projection.  Each row projects through the
 *  projection `wireShape` (`f.name: row.<snake>`), 404 via `ProblemDetails`. */
function renderProjectionActions(
  contextModule: string,
  appModule: string,
  proj: ProjectionIR,
): string {
  const slug = snake(proj.name);
  const rowMod = projectionRowModule(contextModule, proj);
  const mapFields = (proj.wireShape ?? []).map((f) => `${f.name}: row.${snake(f.name)}`).join(", ");
  return `  @doc "GET /api/projections/${slug}"
  def ${slug}_index(conn, _params) do
    data = Enum.map(${appModule}.Repo.all(${rowMod}), fn row -> %{${mapFields}} end)
    json(conn, %{data: data})
  end

  @doc "GET /api/projections/${slug}/:key"
  def ${slug}_show(conn, %{"key" => key}) do
    case ${appModule}.Repo.get(${rowMod}, key) do
      nil ->
        ProblemDetails.not_found_response(conn, "${upperFirst(proj.name)}", key)

      row ->
        json(conn, %{${mapFields}})
    end
  end`;
}

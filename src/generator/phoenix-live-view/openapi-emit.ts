import type {
  AggregateIR,
  BoundedContextIR,
  DeployableIR,
  EntityPartIR,
  FieldIR,
  ParamIR,
  SystemIR,
  TypeIR,
  ValueObjectIR,
  WireField,
} from "../../ir/loom-ir.js";
import { wireShapeFor } from "../../ir/enrichments.js";
import { pascal, snake, plural } from "../../util/naming.js";
import type { ApiRoute } from "./api-emit.js";

// ---------------------------------------------------------------------------
// OpenApiSpex emission for Phoenix LiveView / Ash.
//
// Emits:
//   lib/<app>_web/api/<api>_spec.ex          — per-Api OpenApiSpex spec module
//   lib/<app>_web/api/schemas/<name>.ex      — per request/response schema module
//   lib/<app>_web/controllers/openapi_controller.ex — JSON spec controller
//
// Schema naming convention (mirrors wire-spec.json for D3 parity test):
//   Aggregate response:        <Agg>Response
//   Aggregate list response:   <Agg>ListResponse
//   Entity part response:      <Part>Response
//   Value object:              <Vo>
//   Create request:            Create<Agg>Request
//   Operation request:         <Op>Request   (Pascal-cased op name)
//   Workflow request:          <Wf>Request   (Pascal-cased workflow name)
//   View response:             <View>Response
// ---------------------------------------------------------------------------

export interface OpenApiEmitArgs {
  contexts: BoundedContextIR[];
  deployable: DeployableIR;
  sys: SystemIR;
  /** snake_case application name, e.g. "phoenix_app" */
  appName: string;
  /** PascalCase module prefix, e.g. "PhoenixApp" */
  appModule: string;
}

export interface OpenApiEmitResult {
  files: Map<string, string>;
  /** New api routes to splice into the router under the existing /api scope. */
  routes: ApiRoute[];
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function emitOpenApiSpec(args: OpenApiEmitArgs): OpenApiEmitResult {
  const { contexts, deployable, appName, appModule } = args;
  const files = new Map<string, string>();
  const routes: ApiRoute[] = [];

  if (deployable.serves.length === 0) {
    return { files, routes };
  }

  const webModule = `${appModule}Web`;

  // Collect all aggregates, workflows, views across all contexts.
  const allAggregates: Array<{ ctx: BoundedContextIR; agg: AggregateIR }> = [];
  const allWorkflows: Array<{ ctx: BoundedContextIR; wf: import("../../ir/loom-ir.js").WorkflowIR }> = [];
  const allViews: Array<{ ctx: BoundedContextIR; view: import("../../ir/loom-ir.js").ViewIR }> = [];

  for (const ctx of contexts) {
    for (const agg of ctx.aggregates) allAggregates.push({ ctx, agg });
    for (const wf of ctx.workflows) allWorkflows.push({ ctx, wf });
    for (const view of ctx.views) allViews.push({ ctx, view });
  }

  // --- Per-Api spec module ---------------------------------------------------
  // In Loom v0, there is one spec module per deployable (one api per deployable).
  // Use the first serves entry as the spec name.
  const apiName = deployable.serves[0]!;
  const apiSnake = snake(apiName);
  const apiPascal = pascal(apiName);

  const specPath = `lib/${appName}_web/api/${apiSnake}_spec.ex`;
  files.set(
    specPath,
    renderApiSpec(appModule, webModule, apiSnake, apiPascal, allAggregates, allWorkflows, allViews),
  );

  // --- Schema modules -------------------------------------------------------
  // Collect schemas: value objects, aggregate parts, aggregate response/request,
  // workflow request, view response.
  const schemaDir = `lib/${appName}_web/api/schemas`;

  // Value objects (referenced in multiple contexts — deduplicate by name)
  const emittedVOs = new Set<string>();
  for (const ctx of contexts) {
    for (const vo of ctx.valueObjects) {
      if (emittedVOs.has(vo.name)) continue;
      emittedVOs.add(vo.name);
      files.set(
        `${schemaDir}/${snake(vo.name)}.ex`,
        renderValueObjectSchema(vo, webModule),
      );
    }
  }

  // Entity parts (deduplication by name)
  const emittedParts = new Set<string>();
  for (const { agg } of allAggregates) {
    for (const part of agg.parts) {
      if (emittedParts.has(part.name)) continue;
      emittedParts.add(part.name);
      files.set(
        `${schemaDir}/${snake(part.name)}_response.ex`,
        renderPartResponseSchema(part, webModule),
      );
    }
  }

  // Aggregate response + list response + create request + operation requests
  for (const { ctx, agg } of allAggregates) {
    // Response
    files.set(
      `${schemaDir}/${snake(agg.name)}_response.ex`,
      renderAggregateResponseSchema(agg, webModule),
    );
    // List response
    files.set(
      `${schemaDir}/${snake(agg.name)}_list_response.ex`,
      renderAggregateListResponseSchema(agg, webModule),
    );
    // Create request
    files.set(
      `${schemaDir}/create_${snake(agg.name)}_request.ex`,
      renderCreateRequestSchema(agg, webModule),
    );
    // Per-operation request schemas
    for (const op of agg.operations.filter((o) => o.visibility === "public")) {
      files.set(
        `${schemaDir}/${snake(op.name)}_request.ex`,
        renderOperationRequestSchema(agg, op, webModule),
      );
    }
    void ctx;
  }

  // Workflow request schemas
  for (const { wf } of allWorkflows) {
    files.set(
      `${schemaDir}/${snake(wf.name)}_request.ex`,
      renderWorkflowRequestSchema(wf, webModule),
    );
  }

  // View response schemas
  for (const { ctx, view } of allViews) {
    files.set(
      `${schemaDir}/${snake(view.name)}_response.ex`,
      renderViewResponseSchema(view, ctx, webModule),
    );
  }

  // --- OpenAPI controller ---------------------------------------------------
  const controllerPath = `lib/${appName}_web/controllers/openapi_controller.ex`;
  files.set(controllerPath, renderOpenapiController(appModule, webModule, apiPascal));

  // --- Route entry ----------------------------------------------------------
  routes.push({
    method: "get",
    path: "/openapi.json",
    controller: "OpenapiController",
    action: ":index",
  });

  return { files, routes };
}

// ---------------------------------------------------------------------------
// Spec module renderer
// ---------------------------------------------------------------------------

function renderApiSpec(
  _appModule: string,
  webModule: string,
  _apiSnake: string,
  apiPascal: string,
  allAggregates: Array<{ ctx: BoundedContextIR; agg: AggregateIR }>,
  allWorkflows: Array<{ ctx: BoundedContextIR; wf: import("../../ir/loom-ir.js").WorkflowIR }>,
  allViews: Array<{ ctx: BoundedContextIR; view: import("../../ir/loom-ir.js").ViewIR }>,
): string {
  const specModule = `${webModule}.Api.${apiPascal}Spec`;
  const schemasModule = `${webModule}.Api.Schemas`;

  // Build paths map entries
  const pathEntries: string[] = [];

  // Workflow paths: POST /workflows/<slug>
  for (const { wf } of allWorkflows) {
    const slug = snake(wf.name);
    const reqMod = `${schemasModule}.${pascal(wf.name)}Request`;
    pathEntries.push(`      "/workflows/${slug}" => %OpenApiSpex.PathItem{
        post: %OpenApiSpex.Operation{
          summary: "Run ${wf.name} workflow",
          operationId: "run_${slug}",
          tags: ["workflows"],
          requestBody: %OpenApiSpex.RequestBody{
            required: true,
            content: %{
              "application/json" => %OpenApiSpex.MediaType{schema: ${reqMod}}
            }
          },
          responses: %{
            200 => %OpenApiSpex.Response{
              description: "Success",
              content: %{"application/json" => %OpenApiSpex.MediaType{schema: %OpenApiSpex.Schema{type: :object}}}
            }
          }
        }
      }`);
  }

  // View paths: GET /views/<slug>
  for (const { view } of allViews) {
    const slug = snake(view.name);
    const respMod = `${schemasModule}.${pascal(view.name)}Response`;
    pathEntries.push(`      "/views/${slug}" => %OpenApiSpex.PathItem{
        get: %OpenApiSpex.Operation{
          summary: "Query ${view.name} view",
          operationId: "query_${slug}",
          tags: ["views"],
          responses: %{
            200 => %OpenApiSpex.Response{
              description: "Success",
              content: %{"application/json" => %OpenApiSpex.MediaType{schema: ${respMod}}}
            }
          }
        }
      }`);
  }

  // Aggregate CRUD paths: GET /aggregates/<plural>, GET /aggregates/<plural>/:id, POST /aggregates/<plural>
  for (const { agg } of allAggregates) {
    const aggSlug = snake(plural(agg.name));
    const respMod = `${schemasModule}.${agg.name}Response`;
    const listRespMod = `${schemasModule}.${agg.name}ListResponse`;
    const createReqMod = `${schemasModule}.Create${agg.name}Request`;
    pathEntries.push(`      "/aggregates/${aggSlug}" => %OpenApiSpex.PathItem{
        get: %OpenApiSpex.Operation{
          summary: "List ${agg.name}",
          operationId: "list_${snake(agg.name)}",
          tags: ["${aggSlug}"],
          responses: %{
            200 => %OpenApiSpex.Response{
              description: "OK",
              content: %{"application/json" => %OpenApiSpex.MediaType{schema: ${listRespMod}}}
            }
          }
        },
        post: %OpenApiSpex.Operation{
          summary: "Create ${agg.name}",
          operationId: "create_${snake(agg.name)}",
          tags: ["${aggSlug}"],
          requestBody: %OpenApiSpex.RequestBody{
            required: true,
            content: %{
              "application/json" => %OpenApiSpex.MediaType{schema: ${createReqMod}}
            }
          },
          responses: %{
            201 => %OpenApiSpex.Response{
              description: "Created",
              content: %{"application/json" => %OpenApiSpex.MediaType{schema: ${respMod}}}
            }
          }
        }
      }`,
      `      "/aggregates/${aggSlug}/:id" => %OpenApiSpex.PathItem{
        get: %OpenApiSpex.Operation{
          summary: "Get ${agg.name} by id",
          operationId: "get_${snake(agg.name)}_by_id",
          tags: ["${aggSlug}"],
          parameters: [
            %OpenApiSpex.Parameter{name: :id, in: :path, required: true, schema: %OpenApiSpex.Schema{type: :string}}
          ],
          responses: %{
            200 => %OpenApiSpex.Response{
              description: "OK",
              content: %{"application/json" => %OpenApiSpex.MediaType{schema: ${respMod}}}
            },
            404 => %OpenApiSpex.Response{description: "Not found"}
          }
        }
      }`);
  }

  const pathsBlock = pathEntries.length > 0
    ? pathEntries.join(",\n")
    : "      # No paths — no aggregates, workflows, or views";

  return `# Auto-generated.
defmodule ${specModule} do
  @moduledoc """
  OpenApiSpex-based API spec for this deployable.

  Serves the full contract: workflow endpoints, view endpoints, and
  per-aggregate CRUD endpoints (list, get-by-id, create).

  Consumed by OpenapiController to serve GET /api/openapi.json.
  """

  alias OpenApiSpex.{Info, OpenApi, Server}

  @behaviour OpenApi

  @impl OpenApi
  def spec do
    %OpenApi{
      info: %Info{
        title: "${_appModule}",
        version: "1.0.0"
      },
      servers: [%Server{url: "/api"}],
      paths: %{
${pathsBlock}
      }
    }
    |> OpenApiSpex.resolve_schema_modules()
  end
end
`;
}

// ---------------------------------------------------------------------------
// Schema module renderers
// ---------------------------------------------------------------------------

/** Map a TypeIR to an OpenApiSpex %Schema{} literal snippet. */
function openApiType(t: TypeIR): string {
  switch (t.kind) {
    case "primitive":
      switch (t.name) {
        case "int":
        case "long":
          return "%OpenApiSpex.Schema{type: :integer}";
        case "decimal":
          return "%OpenApiSpex.Schema{type: :number, format: :float}";
        case "string":
          return "%OpenApiSpex.Schema{type: :string}";
        case "guid":
          return "%OpenApiSpex.Schema{type: :string, format: :uuid}";
        case "bool":
          return "%OpenApiSpex.Schema{type: :boolean}";
        case "datetime":
          return "%OpenApiSpex.Schema{type: :string, format: :'date-time'}";
      }
    // eslint-disable-next-line no-fallthrough
    case "id":
      switch (t.valueType) {
        case "guid":
          return "%OpenApiSpex.Schema{type: :string, format: :uuid}";
        case "int":
        case "long":
          return "%OpenApiSpex.Schema{type: :integer}";
        case "string":
          return "%OpenApiSpex.Schema{type: :string}";
      }
    // eslint-disable-next-line no-fallthrough
    case "enum":
      // Enums travel as strings on the wire
      return "%OpenApiSpex.Schema{type: :string}";
    case "valueobject":
      // Reference the VO schema module
      return `%OpenApiSpex.Reference{"$ref": "#/components/schemas/${t.name}"}`;
    case "entity":
      // Reference the entity part schema module
      return `%OpenApiSpex.Reference{"$ref": "#/components/schemas/${t.name}Response"}`;
    case "array":
      return `%OpenApiSpex.Schema{type: :array, items: ${openApiType(t.element)}}`;
    case "optional":
      // OpenAPI optionality is expressed at the parent property level (not in required[])
      return openApiType(t.inner);
  }
}

/** Render a list of fields into OpenApiSpex properties + required list. */
function renderProperties(fields: Array<{ name: string; type: TypeIR; optional: boolean }>): {
  propsLines: string[];
  requiredAtoms: string[];
} {
  const propsLines: string[] = [];
  const requiredAtoms: string[] = [];

  for (const f of fields) {
    const key = snake(f.name);
    const schema = openApiType(f.type);
    propsLines.push(`      ${key}: ${schema}`);
    if (!f.optional) requiredAtoms.push(`:${key}`);
  }

  return { propsLines, requiredAtoms };
}

/** Convert WireField[] to the uniform shape renderProperties expects. */
function wireFieldsToProps(fields: WireField[]): Array<{ name: string; type: TypeIR; optional: boolean }> {
  return fields.map((f) => ({ name: f.name, type: f.type, optional: f.optional }));
}

function renderSchemaModule(
  moduleName: string,
  schemaTitle: string,
  fields: Array<{ name: string; type: TypeIR; optional: boolean }>,
): string {
  const { propsLines, requiredAtoms } = renderProperties(fields);
  const propsBlock = propsLines.length > 0
    ? propsLines.join(",\n")
    : "      # no properties";
  const requiredBlock = requiredAtoms.length > 0
    ? `[${requiredAtoms.join(", ")}]`
    : "[]";

  return `# Auto-generated.
defmodule ${moduleName} do
  @moduledoc "OpenApiSpex schema for #{__MODULE__}."

  require OpenApiSpex

  OpenApiSpex.schema(%{
    title: "${schemaTitle}",
    type: :object,
    properties: %{
${propsBlock}
    },
    required: ${requiredBlock}
  })
end
`;
}

function renderValueObjectSchema(vo: ValueObjectIR, webModule: string): string {
  const moduleName = `${webModule}.Api.Schemas.${vo.name}`;
  const fields: Array<{ name: string; type: TypeIR; optional: boolean }> = vo.fields.map((f: FieldIR) => ({
    name: f.name,
    type: f.type,
    optional: f.optional,
  }));
  return renderSchemaModule(moduleName, vo.name, fields);
}

function renderPartResponseSchema(part: EntityPartIR, webModule: string): string {
  const moduleName = `${webModule}.Api.Schemas.${part.name}Response`;
  const wireFields = wireShapeFor(part);
  return renderSchemaModule(moduleName, `${part.name}Response`, wireFieldsToProps(wireFields));
}

function renderAggregateResponseSchema(agg: AggregateIR, webModule: string): string {
  const moduleName = `${webModule}.Api.Schemas.${agg.name}Response`;
  const wireFields = wireShapeFor(agg);
  return renderSchemaModule(moduleName, `${agg.name}Response`, wireFieldsToProps(wireFields));
}

function renderAggregateListResponseSchema(agg: AggregateIR, webModule: string): string {
  const moduleName = `${webModule}.Api.Schemas.${agg.name}ListResponse`;
  // Array-type schema — wraps the item schema reference
  return `# Auto-generated.
defmodule ${moduleName} do
  @moduledoc "OpenApiSpex schema for #{__MODULE__}."

  require OpenApiSpex

  OpenApiSpex.schema(%{
    title: "${agg.name}ListResponse",
    type: :array,
    items: %OpenApiSpex.Reference{"$ref": "#/components/schemas/${agg.name}Response"}
  })
end
`;
}

function renderCreateRequestSchema(agg: AggregateIR, webModule: string): string {
  const moduleName = `${webModule}.Api.Schemas.Create${agg.name}Request`;
  // Create request carries required (non-optional) fields only, matching Hono
  const fields: Array<{ name: string; type: TypeIR; optional: boolean }> = agg.fields
    .filter((f: FieldIR) => !f.optional)
    .map((f: FieldIR) => ({ name: f.name, type: f.type, optional: false }));
  return renderSchemaModule(moduleName, `Create${agg.name}Request`, fields);
}

function renderOperationRequestSchema(
  agg: AggregateIR,
  op: import("../../ir/loom-ir.js").OperationIR,
  webModule: string,
): string {
  const schemaName = `${pascal(op.name)}Request`;
  const moduleName = `${webModule}.Api.Schemas.${schemaName}`;
  const fields: Array<{ name: string; type: TypeIR; optional: boolean }> = op.params.map((p: ParamIR) => ({
    name: p.name,
    type: p.type,
    optional: false,
  }));
  void agg;
  return renderSchemaModule(moduleName, schemaName, fields);
}

function renderWorkflowRequestSchema(
  wf: import("../../ir/loom-ir.js").WorkflowIR,
  webModule: string,
): string {
  const schemaName = `${pascal(wf.name)}Request`;
  const moduleName = `${webModule}.Api.Schemas.${schemaName}`;
  const fields: Array<{ name: string; type: TypeIR; optional: boolean }> = wf.params.map((p: ParamIR) => ({
    name: p.name,
    type: p.type,
    optional: false,
  }));
  return renderSchemaModule(moduleName, schemaName, fields);
}

function renderViewResponseSchema(
  view: import("../../ir/loom-ir.js").ViewIR,
  ctx: BoundedContextIR,
  webModule: string,
): string {
  const schemaName = `${pascal(view.name)}Response`;
  const moduleName = `${webModule}.Api.Schemas.${schemaName}`;

  let fields: Array<{ name: string; type: TypeIR; optional: boolean }>;

  if (view.output) {
    // Full-form view: use declared output fields
    fields = view.output.fields.map((f: FieldIR) => ({
      name: f.name,
      type: f.type,
      optional: f.optional,
    }));
  } else {
    // Shorthand view: use source aggregate's wire shape
    const sourceAgg = ctx.aggregates.find((a) => a.name === view.aggregateName);
    if (sourceAgg) {
      const wireFields = wireShapeFor(sourceAgg);
      fields = wireFieldsToProps(wireFields);
    } else {
      fields = [];
    }
  }

  // View responses are arrays (list queries)
  const itemSchemaLines = renderProperties(fields);
  const propsBlock = itemSchemaLines.propsLines.length > 0
    ? itemSchemaLines.propsLines.join(",\n")
    : "      # no properties";
  const requiredBlock = itemSchemaLines.requiredAtoms.length > 0
    ? `[${itemSchemaLines.requiredAtoms.join(", ")}]`
    : "[]";

  return `# Auto-generated.
defmodule ${moduleName} do
  @moduledoc "OpenApiSpex schema for #{__MODULE__}."

  require OpenApiSpex

  OpenApiSpex.schema(%{
    title: "${schemaName}",
    type: :array,
    items: %{
      type: :object,
      properties: %{
${propsBlock}
      },
      required: ${requiredBlock}
    }
  })
end
`;
}

// ---------------------------------------------------------------------------
// OpenAPI controller renderer
// ---------------------------------------------------------------------------

function renderOpenapiController(appModule: string, webModule: string, apiPascal: string): string {
  const specModule = `${webModule}.Api.${apiPascal}Spec`;
  return `# Auto-generated.
defmodule ${webModule}.OpenapiController do
  use ${webModule}, :controller

  @moduledoc """
  Serves the OpenAPI spec as JSON.

  GET /api/openapi.json → returns the full spec generated by #{${specModule}}.
  """

  @doc "GET /api/openapi.json"
  def index(conn, _params) do
    spec = ${specModule}.spec()
    conn
    |> put_resp_content_type("application/json")
    |> send_resp(200, Jason.encode!(spec))
  end
end
`;
}

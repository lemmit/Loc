import {
  createInputFields,
  forApiRead,
  wireCreateDefault,
  wireFieldsFor,
} from "../../../ir/enrich/wire-projection.js";
import { unionInstanceName } from "../../../ir/stdlib/unions.js";
import type {
  AggregateIR,
  DeployableIR,
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  EnrichedEntityPartIR,
  EnumIR,
  FieldIR,
  ParamIR,
  PayloadIR,
  SystemIR,
  TypeIR,
  ValueObjectIR,
  WireField,
} from "../../../ir/types/loom-ir.js";
import {
  operationIsGuarded,
  workflowEmitsCommandRoute,
  workflowIsGuarded,
} from "../../../ir/types/loom-ir.js";
import {
  peelCollection,
  peelNullable,
  type WirePrimitive,
  wireTypeInfo,
} from "../../../ir/types/wire-types.js";
import {
  errorStatuses,
  type OpErrorKind,
  PROBLEM_JSON,
  problemTitle,
} from "../../../ir/util/openapi-errors.js";
import {
  camelId,
  opCreate,
  opDestroy,
  opFind,
  opGetById,
  opList,
  opOperation,
  opView,
  opWorkflow,
  opWorkflowInstanceById,
  opWorkflowInstances,
} from "../../../ir/util/openapi-ids.js";
import { aggregateIsVersioned } from "../../../ir/util/versioned-capability.js";
import { defaultErrorStatus } from "../../../util/error-defaults.js";
import { plural, snake, upperFirst } from "../../../util/naming.js";
import { findUnionSpec, unionMembers } from "../../_payload/union-wire.js";
import type { ApiRoute } from "../api-emit.js";
import { emitsRestCreate } from "./api-emit.js";

// ---------------------------------------------------------------------------
// OpenApiSpex emission for Phoenix LiveView / Ash.
//
// Emits:
//   lib/<app>_web/api/<api>_spec.ex          — per-Api OpenApiSpex spec module
//   lib/<app>_web/api/schemas/<name>.ex      — per request/response schema module
//   lib/<app>_web/controllers/openapi_controller.ex — JSON spec controller
//
// Schema naming convention (mirrors wire-spec.json for the parity test):
//   Aggregate response:        <Agg>Response
//   Aggregate list response:   <Agg>ListResponse
//   Entity part response:      <Part>Response
//   Value object:              <Vo>
//   Create request:            Create<Agg>Request
//   Operation request:         <Op><Agg>Request  (aggregate-qualified — an
//                              op name like `update` is shared across
//                              aggregates, e.g. via crudish, so the DTO must
//                              be qualified to avoid a schema-id collision)
//   Workflow request:          <Wf>Request   (Pascal-cased workflow name)
//   View response:             <View>Response
// ---------------------------------------------------------------------------

export interface OpenApiEmitArgs {
  contexts: EnrichedBoundedContextIR[];
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

  // No served Api → no spec.  `serves` can be absent on a hand-built /
  // under-shaped deployable (some unit fixtures omit it), so guard the access.
  if (!deployable.serves || deployable.serves.length === 0) {
    return { files, routes };
  }

  const webModule = `${appModule}Web`;

  // Collect all aggregates, workflows, views across all contexts.
  const allAggregates: Array<{ ctx: EnrichedBoundedContextIR; agg: EnrichedAggregateIR }> = [];
  const allWorkflows: Array<{
    ctx: EnrichedBoundedContextIR;
    wf: import("../../../ir/types/loom-ir.js").WorkflowIR;
  }> = [];
  const allViews: Array<{
    ctx: EnrichedBoundedContextIR;
    view: import("../../../ir/types/loom-ir.js").ViewIR;
  }> = [];

  // Observable workflows (instanceWireShape) expose the two read-only
  // instance routes + the `<Wf>Instance[List]Response` schemas — independent
  // of the command surface (an event-triggered saga has no POST route but
  // is still observable).
  const observableWorkflows: Array<import("../../../ir/types/loom-ir.js").WorkflowIR> = [];

  for (const ctx of contexts) {
    for (const agg of ctx.aggregates) allAggregates.push({ ctx, agg });
    // Event-triggered-only workflows expose no HTTP route (dispatch-only).
    for (const wf of ctx.workflows.filter(workflowEmitsCommandRoute))
      allWorkflows.push({ ctx, wf });
    for (const wf of ctx.workflows) if (wf.instanceWireShape) observableWorkflows.push(wf);
    // Workflow-sourced (workflow-instance-views.md) and projection-sourced
    // (projection.md v1.1) views are served at runtime by the ViewsController but
    // not yet described in this OpenAPI surface (a later slice); gathering only
    // aggregate sources keeps the aggregate-view spec byte-identical.
    for (const view of ctx.views)
      if (view.source.kind === "aggregate") allViews.push({ ctx, view });
  }

  // --- Per-Api spec module ---------------------------------------------------
  // In Loom v0, there is one spec module per deployable (one api per deployable).
  // Use the first serves entry as the spec name.
  const apiName = deployable.serves[0]!;
  const apiSnake = snake(apiName);
  const apiPascal = upperFirst(apiName);

  const specPath = `lib/${appName}_web/api/${apiSnake}_spec.ex`;
  files.set(
    specPath,
    renderApiSpec(
      appModule,
      webModule,
      apiSnake,
      apiPascal,
      allAggregates,
      allWorkflows,
      allViews,
      observableWorkflows,
    ),
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
      files.set(`${schemaDir}/${snake(vo.name)}.ex`, renderValueObjectSchema(vo, webModule));
    }
  }

  // Shared RFC 7807 error body — referenced by every operation's declared
  // 4xx/5xx responses (see errorResponseEntries).
  files.set(`${schemaDir}/problem_details.ex`, renderProblemDetailsSchema(webModule));

  // Enum schemas — a named string schema carrying the allowed value-set,
  // referenced by `$ref` from any enum-typed property.  De-duplicated by
  // name (a root-level enum is folded into every context's enum list by
  // the enrich pass, so the same enum can appear more than once).
  const emittedEnums = new Set<string>();
  for (const ctx of contexts) {
    for (const en of ctx.enums) {
      if (emittedEnums.has(en.name)) continue;
      emittedEnums.add(en.name);
      files.set(`${schemaDir}/${snake(en.name)}.ex`, renderEnumSchema(en, webModule));
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
      renderAggregateResponseSchema(agg, webModule, ctx.payloads),
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
    // Create response — `{ id }`, matching Hono/.NET's Create<Agg>Response
    files.set(
      `${schemaDir}/create_${snake(agg.name)}_response.ex`,
      renderCreateResponseSchema(agg, webModule),
    );
    // Per-operation request schemas
    for (const op of agg.operations.filter((o) => o.visibility === "public")) {
      files.set(
        `${schemaDir}/${snake(op.name)}_${snake(agg.name)}_request.ex`,
        renderOperationRequestSchema(agg, op, webModule),
      );
    }
    void ctx;
  }

  // Operation-return union DTOs (`operation reserve(): Project or
  // ProjectNotFound`) — the tagged wire union the op's 200 carries,
  // matching Hono's discriminatedUnion / .NET's Application union DTO.
  // De-duplicated by instance name (one union can back several ops).
  const emittedOpUnions = new Set<string>();
  for (const { ctx, agg } of allAggregates) {
    for (const op of agg.operations.filter((o) => o.visibility === "public")) {
      if (op.returnType?.kind !== "union") continue;
      const unionName = unionInstanceName(op.returnType.variants);
      if (emittedOpUnions.has(unionName)) continue;
      emittedOpUnions.add(unionName);
      files.set(
        `${schemaDir}/${snake(unionName)}.ex`,
        renderOperationUnionSchema(unionName, op.returnType.variants, ctx, webModule),
      );
    }
  }

  // CanResponse `{ allowed }` — the side-effect-free `can_<op>` companion of a
  // `when`-gated operation (criterion.md, use site 2).  One shared schema,
  // emitted when any served op carries a `when` gate.
  if (
    allAggregates.some(({ agg }) => agg.operations.some((o) => o.visibility === "public" && o.when))
  ) {
    files.set(`${schemaDir}/can_response.ex`, renderCanResponseSchema(webModule));
  }

  // Workflow request schemas
  for (const { wf } of allWorkflows) {
    files.set(
      `${schemaDir}/${snake(wf.name)}_request.ex`,
      renderWorkflowRequestSchema(wf, webModule),
    );
  }

  // Observable-workflow instance schemas — `<Wf>InstanceResponse` (the
  // instanceWireShape projection) + its named `<Wf>InstanceListResponse`
  // array carrier, matching Hono / .NET / Python / Java.
  for (const wf of observableWorkflows) {
    files.set(
      `${schemaDir}/${snake(wf.name)}_instance_response.ex`,
      renderWorkflowInstanceResponseSchema(wf, webModule),
    );
    files.set(
      `${schemaDir}/${snake(wf.name)}_instance_list_response.ex`,
      renderWorkflowInstanceListResponseSchema(wf, webModule),
    );
  }

  // View response schemas: full-form views get a named element row
  // (`<View>Row`) + the `<View>Response` wrapper.  Shorthand views reuse the
  // source aggregate's `<Agg>ListResponse` (emitted with the aggregate
  // above) — matching Hono/.NET — so they emit no per-view schema.
  for (const { ctx, view } of allViews) {
    if (view.output) {
      files.set(`${schemaDir}/${snake(view.name)}_row.ex`, renderViewRowSchema(view, webModule));
      files.set(
        `${schemaDir}/${snake(view.name)}_response.ex`,
        renderViewResponseSchema(view, ctx, webModule),
      );
    }
  }

  // --- OpenAPI controller ---------------------------------------------------
  const controllerPath = `lib/${appName}_web/controllers/openapi_controller.ex`;
  files.set(controllerPath, renderOpenapiController(appModule, webModule, apiPascal));

  // --- Route entry ----------------------------------------------------------
  // Served at the router ROOT (`!root:` sentinel — like /health, /ready), not
  // inside `scope "/api"`, so the spec sits at /openapi.json on every backend
  // (cross-backend alignment) and stays off the same-origin `/api` surface.
  routes.push({
    method: "get",
    path: "!root:/openapi.json",
    controller: "OpenapiController",
    action: ":index",
  });

  return { files, routes };
}

// ---------------------------------------------------------------------------
// Spec module renderer
// ---------------------------------------------------------------------------

/** RFC 7807 error response-map entries (with a leading comma) for an
 *  operation kind, from the shared matrix.  Each declared 4xx/5xx response
 *  carries the `ProblemDetails` schema MODULE under `application/problem+json`
 *  — matching Hono/.NET so the conformance gate's error-response dimension
 *  compares equal. */
function errorResponseEntries(kind: OpErrorKind, schemasModule: string, guarded = false): string {
  return statusResponseEntries(errorStatuses(kind, guarded), schemasModule);
}

/** The same ProblemDetails response-map entries for an explicit status list —
 *  used where the status set isn't a matrix kind (a union find's absent
 *  variant status). */
function statusResponseEntries(statuses: readonly number[], schemasModule: string): string {
  return statuses
    .map(
      (s) => `,
            ${s} => %OpenApiSpex.Response{
              description: "${problemTitle(s)}",
              content: %{"${PROBLEM_JSON}" => %OpenApiSpex.MediaType{schema: ${schemasModule}.ProblemDetails}}
            }`,
    )
    .join("");
}

function renderApiSpec(
  _appModule: string,
  webModule: string,
  _apiSnake: string,
  apiPascal: string,
  allAggregates: Array<{ ctx: EnrichedBoundedContextIR; agg: EnrichedAggregateIR }>,
  allWorkflows: Array<{
    ctx: EnrichedBoundedContextIR;
    wf: import("../../../ir/types/loom-ir.js").WorkflowIR;
  }>,
  allViews: Array<{
    ctx: EnrichedBoundedContextIR;
    view: import("../../../ir/types/loom-ir.js").ViewIR;
  }>,
  observableWorkflows: Array<import("../../../ir/types/loom-ir.js").WorkflowIR>,
): string {
  const specModule = `${webModule}.Api.${apiPascal}Spec`;
  const schemasModule = `${webModule}.Api.Schemas`;

  // Build paths map entries
  const pathEntries: string[] = [];

  // Workflow paths: POST /workflows/<slug>
  for (const { wf } of allWorkflows) {
    const slug = snake(wf.name);
    const reqMod = `${schemasModule}.${upperFirst(wf.name)}Request`;
    pathEntries.push(`      "/workflows/${slug}" => %OpenApiSpex.PathItem{
        post: %OpenApiSpex.Operation{
          summary: "Run ${wf.name} workflow",
          operationId: "${camelId(opWorkflow(wf.name))}",
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
            }${errorResponseEntries("workflow", schemasModule, workflowIsGuarded(wf))}
          }
        }
      }`);
  }

  // Observable-workflow instance paths: GET /workflows/<slug>/instances
  // (named `<Wf>InstanceListResponse` carrier) + `/instances/{id}` (single
  // `<Wf>InstanceResponse`, 404 when absent) — matching the other backends'
  // read-only saga-state surface (workflow-instance-visibility.md).
  for (const wf of observableWorkflows) {
    const slug = snake(wf.name);
    const T = upperFirst(wf.name);
    const corr = (wf.instanceWireShape ?? []).find((f) => f.source === "id");
    const corrValueType = corr
      ? (wireTypeInfo(corr.type, "response").idValueType ?? "guid")
      : "guid";
    const idSchema = OPENAPI_ID_VALUE[corrValueType] ?? OPENAPI_ID_VALUE.guid;
    pathEntries.push(`      "/workflows/${slug}/instances" => %OpenApiSpex.PathItem{
        get: %OpenApiSpex.Operation{
          summary: "List ${wf.name} instances",
          operationId: "${camelId(opWorkflowInstances(wf.name))}",
          tags: ["workflows"],
          responses: %{
            200 => %OpenApiSpex.Response{
              description: "OK",
              content: %{"application/json" => %OpenApiSpex.MediaType{schema: ${schemasModule}.${T}InstanceListResponse}}
            }
          }
        }
      }`);
    pathEntries.push(`      "/workflows/${slug}/instances/{id}" => %OpenApiSpex.PathItem{
        get: %OpenApiSpex.Operation{
          summary: "Get ${wf.name} instance by correlation id",
          operationId: "${camelId(opWorkflowInstanceById(wf.name))}",
          tags: ["workflows"],
          parameters: [
            %OpenApiSpex.Parameter{name: :id, in: :path, required: true, schema: ${idSchema}}
          ],
          responses: %{
            200 => %OpenApiSpex.Response{
              description: "OK",
              content: %{"application/json" => %OpenApiSpex.MediaType{schema: ${schemasModule}.${T}InstanceResponse}}
            }${errorResponseEntries("getById", schemasModule)}
          }
        }
      }`);
  }

  // View paths: GET /views/<slug>
  for (const { view } of allViews) {
    const slug = snake(view.name);
    // Shorthand views reuse the aggregate's `<Agg>ListResponse`; full-form
    // views project to their own `<View>Response`.  Matches Hono/.NET.
    const respMod = view.output
      ? `${schemasModule}.${upperFirst(view.name)}Response`
      : `${schemasModule}.${view.source.name}ListResponse`;
    pathEntries.push(`      "/views/${slug}" => %OpenApiSpex.PathItem{
        get: %OpenApiSpex.Operation{
          summary: "Query ${view.name} view",
          operationId: "${camelId(opView(view.name))}",
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

  // Map the aggregate's `idValueType` to the OpenAPI path-param schema
  // shape Hono and .NET emit.  Without this, every `:id` parameter
  // landed as plain `{type: :string}`, which surfaces in the parity
  // diff as `path-param types: hono=[string:uuid] phoenix=[string]`
  // (caught by `pathParamSignatures` in test/_helpers/openapi-normalize.ts).
  function idParamSchema(idValueType: string): string {
    switch (idValueType) {
      case "guid":
        return "%OpenApiSpex.Schema{type: :string, format: :uuid}";
      case "int":
      case "long":
        return "%OpenApiSpex.Schema{type: :integer}";
      default:
        return "%OpenApiSpex.Schema{type: :string}";
    }
  }

  // Aggregate CRUD paths: GET /<plural>, GET /<plural>/{id}, POST /<plural>
  // Note: path-template parameters use the OpenAPI `{id}` syntax (not the
  // Plug-router `:id` form), matching the Hono/.NET emitters so the
  // conformance parity diff treats them as the same operation.
  // Plus per-op and per-find paths derived from the aggregate's
  // public operations and repository finds.
  for (const { ctx, agg } of allAggregates) {
    const aggSlug = snake(plural(agg.name));
    const respMod = `${schemasModule}.${agg.name}Response`;
    const listRespMod = `${schemasModule}.${agg.name}ListResponse`;
    const createReqMod = `${schemasModule}.Create${agg.name}Request`;
    const createRespMod = `${schemasModule}.Create${agg.name}Response`;
    // The `post` create operation rides the SAME `emitsRestCreate` predicate as
    // the router route (api-emit.ts) — documenting a create the router doesn't
    // wire (or vice versa) is the exact divergence this shares away.  A
    // non-constructible / abstract aggregate documents no create.
    const createPost = emitsRestCreate(agg)
      ? `,
        post: %OpenApiSpex.Operation{
          summary: "Create ${agg.name}",
          operationId: "${camelId(opCreate(agg.name))}",
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
              content: %{"application/json" => %OpenApiSpex.MediaType{schema: ${createRespMod}}}
            }${errorResponseEntries("create", schemasModule)}
          }
        }`
      : "";
    pathEntries.push(
      `      "/${aggSlug}" => %OpenApiSpex.PathItem{
        get: %OpenApiSpex.Operation{
          summary: "List ${agg.name}",
          operationId: "${camelId(opList(agg.name))}",
          tags: ["${aggSlug}"],
          responses: %{
            200 => %OpenApiSpex.Response{
              description: "OK",
              content: %{"application/json" => %OpenApiSpex.MediaType{schema: ${listRespMod}}}
            }
          }
        }${createPost}
      }`,
      `      "/${aggSlug}/{id}" => %OpenApiSpex.PathItem{
        get: %OpenApiSpex.Operation{
          summary: "Get ${agg.name} by id",
          operationId: "${camelId(opGetById(agg.name))}",
          tags: ["${aggSlug}"],
          parameters: [
            %OpenApiSpex.Parameter{name: :id, in: :path, required: true, schema: ${idParamSchema(agg.idValueType)}}
          ],
          responses: %{
            200 => %OpenApiSpex.Response{
              description: "OK",
              content: %{"application/json" => %OpenApiSpex.MediaType{schema: ${respMod}}}
            }${errorResponseEntries("getById", schemasModule)}
          }
        }${
          // Canonical destroy → DELETE /<aggs>/{id}.  Gated on the IR
          // lifecycle so the Phoenix spec matches the Hono/.NET destroy
          // route (operationId + 404/409 error set from the shared matrix);
          // the route + controller `def destroy` are emitted in api-emit.ts.
          agg.canonicalDestroy
            ? `,
        delete: %OpenApiSpex.Operation{
          summary: "Destroy ${agg.name}",
          operationId: "${camelId(opDestroy(agg.name))}",
          tags: ["${aggSlug}"],
          parameters: [
            %OpenApiSpex.Parameter{name: :id, in: :path, required: true, schema: ${idParamSchema(agg.idValueType)}}
          ],
          responses: %{
            204 => %OpenApiSpex.Response{description: "No Content"}${errorResponseEntries("destroy", schemasModule)}
          }
        }`
            : ""
        }
      }`,
    );

    // Per-operation paths: POST /<plural>/{id}/<op>
    for (const op of agg.operations.filter((o) => o.visibility === "public")) {
      // Spec path must track the route's URL segment (routeSlug, D-URLSTYLE);
      // operationId + request module stay keyed on op.name.
      const opSnake = snake(op.routeSlug ?? op.name);
      const opReqMod = `${schemasModule}.${upperFirst(op.name)}${agg.name}Request`;
      pathEntries.push(
        `      "/${aggSlug}/{id}/${opSnake}" => %OpenApiSpex.PathItem{
        post: %OpenApiSpex.Operation{
          summary: "${op.name} on ${agg.name}",
          operationId: "${camelId(opOperation(agg.name, op.name))}",
          tags: ["${aggSlug}"],
          parameters: [
            %OpenApiSpex.Parameter{name: :id, in: :path, required: true, schema: ${idParamSchema(agg.idValueType)}}
          ],
          requestBody: %OpenApiSpex.RequestBody{
            required: true,
            content: %{
              "application/json" => %OpenApiSpex.MediaType{schema: ${opReqMod}}
            }
          },
          responses: %{
            ${
              // An exception-less union-returning op answers 200 with the
              // tagged union DTO (exception-less.md) — matching Hono's
              // discriminatedUnion / .NET's [ProducesResponseType(union)];
              // a void op stays 204 No Content.
              op.returnType?.kind === "union"
                ? `200 => %OpenApiSpex.Response{
              description: "OK",
              content: %{"application/json" => %OpenApiSpex.MediaType{schema: ${schemasModule}.${unionInstanceName(op.returnType.variants)}}}
            }`
                : `204 => %OpenApiSpex.Response{description: "No Content"}`
            }${errorResponseEntries("operation", schemasModule, operationIsGuarded(op))}${
              // A `when` state gate OR a versioned aggregate's `update` (stale
              // `If-Match` → optimistic-concurrency conflict) declares 409,
              // mirroring the Hono / .NET contract.
              op.when || (op.name === "update" && aggregateIsVersioned(agg))
                ? `,
            409 => %OpenApiSpex.Response{
              description: "Conflict",
              content: %{"${PROBLEM_JSON}" => %OpenApiSpex.MediaType{schema: ${schemasModule}.ProblemDetails}}
            }`
                : ""
            }
          }
        }
      }`,
      );
      // The auto-exposed `GET /<plural>/{id}/can_<op>` companion of a
      // `when`-gated op — returns `{ allowed }` (criterion.md, use site 2).
      if (op.when) {
        pathEntries.push(
          `      "/${aggSlug}/{id}/can_${opSnake}" => %OpenApiSpex.PathItem{
        get: %OpenApiSpex.Operation{
          summary: "can_${op.name} on ${agg.name}",
          operationId: "${camelId(opOperation(agg.name, `can_${op.name}`))}",
          tags: ["${aggSlug}"],
          parameters: [
            %OpenApiSpex.Parameter{name: :id, in: :path, required: true, schema: ${idParamSchema(agg.idValueType)}}
          ],
          responses: %{
            200 => %OpenApiSpex.Response{
              description: "OK",
              content: %{"application/json" => %OpenApiSpex.MediaType{schema: ${schemasModule}.CanResponse}}
            }${errorResponseEntries("getById", schemasModule)}
          }
        }
      }`,
        );
      }
    }

    // Per-find paths: GET /<plural>/<find>.  Skip auto-`all` (already served
    // by the CRUD `GET /<plural>` above).  Response cardinality follows the
    // declared find return type: array → list response; otherwise single.
    const repo = ctx.repositories.find((r) => r.aggregateName === agg.name);
    if (repo) {
      for (const find of repo.finds) {
        if (find.name === "all") continue;
        const findSnake = snake(find.name);
        const isArrayReturn = find.returnType.kind === "array";
        const findRespMod = isArrayReturn ? listRespMod : respMod;
        const findKind: OpErrorKind =
          find.returnType.kind === "optional"
            ? "findOptional"
            : isArrayReturn
              ? "findList"
              : "findSingle";
        // Union finds (`Agg or NotFound` / `Agg option`) translate absence to
        // a ProblemDetails at the absent variant's status — 200 stays the
        // SUCCESS variant (`<Agg>Response`).  Same edge translation as Hono's
        // union-find route and Java's customizer (exception-less.md).
        const unionSpec = findUnionSpec(find.returnType, agg.name, ctx);
        const unionAbsentStatus = unionSpec
          ? unionSpec.absent.kind === "none"
            ? 404
            : (ctx.errorStatusOverrides?.[unionSpec.absent.tag] ??
              defaultErrorStatus(unionSpec.absent.tag))
          : undefined;
        // Filter params cross as query parameters — Hono/.NET declare them,
        // so Phoenix must too (name + type + required), or the parity gate's
        // query-param dimension diffs `phoenix=[]`.  Required mirrors Hono's
        // `zodFor`: a nullable param is optional, everything else required.
        const queryParams = find.params
          .map(
            (p) =>
              `            %OpenApiSpex.Parameter{name: :${p.name}, in: :query, required: ${
                wireTypeInfo(p.type, "request").isNullable ? "false" : "true"
              }, schema: ${openApiType(p.type, schemasModule)}}`,
          )
          .join(",\n");
        const queryParamsBlock =
          find.params.length > 0 ? `\n          parameters: [\n${queryParams}\n          ],` : "";
        pathEntries.push(
          `      "/${aggSlug}/${findSnake}" => %OpenApiSpex.PathItem{
        get: %OpenApiSpex.Operation{
          summary: "${find.name} on ${agg.name}",
          operationId: "${camelId(opFind(agg.name, find.name))}",
          tags: ["${aggSlug}"],${queryParamsBlock}
          responses: %{
            200 => %OpenApiSpex.Response{
              description: "OK",
              content: %{"application/json" => %OpenApiSpex.MediaType{schema: ${findRespMod}}}
            }${
              unionAbsentStatus !== undefined
                ? statusResponseEntries([unionAbsentStatus], schemasModule)
                : errorResponseEntries(findKind, schemasModule)
            }
          }
        }
      }`,
        );
      }
    }
  }

  const pathsBlock =
    pathEntries.length > 0
      ? pathEntries.join(",\n")
      : "      # No paths — no aggregates, workflows, or views";

  return `# Auto-generated.
defmodule ${specModule} do
  @moduledoc """
  OpenApiSpex-based API spec for this deployable.

  Serves the full contract: workflow endpoints, view endpoints, and
  per-aggregate CRUD endpoints (list, get-by-id, create).

  Consumed by OpenapiController to serve GET /openapi.json.
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

/** Wire-primitive → OpenApiSpex %Schema{} literal.  Money crosses as
 *  `{type: string, format: decimal}` for cross-backend wire parity
 *  (see `.loom/wire-spec.json`).  Datetime is `:'date-time'`, guid is
 *  `:uuid`, decimal is `:double` — matching .NET's Swashbuckle mapping for
 *  `System.Decimal` (double is the least-lossy JSON-number hint; `:float`
 *  diverged from .NET and threw away precision). */
const OPENAPI_PRIMITIVE: Record<WirePrimitive, string> = {
  int: "%OpenApiSpex.Schema{type: :integer}",
  long: "%OpenApiSpex.Schema{type: :integer}",
  decimal: "%OpenApiSpex.Schema{type: :number, format: :double}",
  money: "%OpenApiSpex.Schema{type: :string, format: :decimal}",
  string: "%OpenApiSpex.Schema{type: :string}",
  bool: "%OpenApiSpex.Schema{type: :boolean}",
  datetime: "%OpenApiSpex.Schema{type: :string, format: :'date-time'}",
  guid: "%OpenApiSpex.Schema{type: :string, format: :uuid}",
  json: "%OpenApiSpex.Schema{type: :object}",
};

/** Id value-type → OpenApiSpex %Schema{} literal.  Mirrors the
 *  path-param schema used by `idParamSchema` above. */
const OPENAPI_ID_VALUE: Record<string, string> = {
  guid: "%OpenApiSpex.Schema{type: :string, format: :uuid}",
  int: "%OpenApiSpex.Schema{type: :integer}",
  long: "%OpenApiSpex.Schema{type: :integer}",
  string: "%OpenApiSpex.Schema{type: :string}",
};

/** Map a TypeIR to an OpenApiSpex %Schema{} literal snippet.
 *  `schemasModule` is the `<Web>.Api.Schemas` prefix: enum / entity refs
 *  are emitted as the bare schema MODULE atom (not a raw
 *  `%OpenApiSpex.Reference{}`) so OpenApiSpex's `resolve_schema_modules`
 *  pulls them into `components.schemas` — a raw `$ref` string is left
 *  dangling and never registered (the bug that dropped `Visibility` /
 *  `BuildState` / `PipelineResponse` from the Phoenix spec).  Value
 *  objects stay raw refs: Hono/.NET don't publish them as named
 *  components, so registering them would add a Phoenix-only schema. */
function openApiType(t: TypeIR, schemasModule: string): string {
  const info = wireTypeInfo(t, "response");
  // Nullable rides on the parent property (`required[]`), not the
  // child schema — peel through.
  if (info.isNullable) return openApiType(peelNullable(t), schemasModule);
  if (info.isCollection) {
    return `%OpenApiSpex.Schema{type: :array, items: ${openApiType(peelCollection(t), schemasModule)}}`;
  }
  switch (info.refKind) {
    case "primitive":
      return OPENAPI_PRIMITIVE[info.primitive!];
    case "id":
      return OPENAPI_ID_VALUE[info.idValueType!]!;
    case "enum":
      // Named string schema carrying the value-set.  Module atom → the
      // resolver registers it in components and rewrites to a `$ref`.
      return `${schemasModule}.${info.base}`;
    case "valueObject":
      // Raw ref — VOs are not published as named components (parity with
      // Hono/.NET, which inline them).
      return `%OpenApiSpex.Reference{"$ref": "#/components/schemas/${info.base}"}`;
    case "entity":
      // Containment part → its `<Part>Response`, as a module atom so the
      // part schema is registered in components.
      return `${schemasModule}.${info.base}Response`;
  }
}

/** Render a list of fields into OpenApiSpex properties + required list.
 *  `isRequest` drops non-nullable `bool` fields from the `required` list:
 *  Phoenix's controller (like Hono's `z.coerce.boolean()` and .NET's
 *  model-binding) treats an omitted request bool as `false`, so neither
 *  backend marks request bools required — matching keeps the parity gate
 *  green. */
function renderProperties(
  fields: Array<{ name: string; type: TypeIR; optional: boolean; wireDefault?: boolean }>,
  schemasModule: string,
  isRequest = false,
): {
  propsLines: string[];
  requiredAtoms: string[];
} {
  const propsLines: string[] = [];
  const requiredAtoms: string[] = [];

  // Field names land in the spec as the source-level identifier from the
  // `.ddd` source (camelCase by convention, e.g. `createdAt`,
  // `pipelineCount`).  The runtime wire shape — produced by the
  // per-resource `defimpl Jason.Encoder` introduced in PR C — emits the
  // same casing, so the spec and the response body agree.  Snake-casing
  // here would re-introduce the divergence the parity harness reports
  // as `only-phoenix=[created_at,...]`.
  for (const f of fields) {
    const key = f.name;
    const schema = openApiType(f.type, schemasModule);
    propsLines.push(`      ${key}: ${schema}`);
    const info = wireTypeInfo(f.type, isRequest ? "request" : "response");
    const optionalBoolRequest =
      isRequest && !info.isNullable && info.refKind === "primitive" && info.primitive === "bool";
    // An explicitly-defaulted request field is optional input (Ash applies
    // the default on omission), so it drops from the required set too.
    if (!f.optional && !optionalBoolRequest && !f.wireDefault) requiredAtoms.push(`:${key}`);
  }

  return { propsLines, requiredAtoms };
}

/** Convert WireField[] to the uniform shape renderProperties expects. */
function wireFieldsToProps(
  fields: WireField[],
): Array<{ name: string; type: TypeIR; optional: boolean }> {
  return fields.map((f) => ({ name: f.name, type: f.type, optional: f.optional }));
}

function renderSchemaModule(
  moduleName: string,
  schemaTitle: string,
  fields: Array<{ name: string; type: TypeIR; optional: boolean; wireDefault?: boolean }>,
  schemasModule: string,
  isRequest = false,
): string {
  const { propsLines, requiredAtoms } = renderProperties(fields, schemasModule, isRequest);
  const propsBlock = propsLines.length > 0 ? propsLines.join(",\n") : "      # no properties";
  const requiredBlock = requiredAtoms.length > 0 ? `[${requiredAtoms.join(", ")}]` : "[]";

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

/** RFC 7807 ProblemDetails schema module — the shared error body.  Base 5
 *  spec fields + the §3.2 `errors[]` extension (per-field `{ pointer,
 *  message }` array) that the runtime emits on 422 validation responses.
 *  All fields optional — base 5 per the spec core; `errors` is only
 *  present on 422 validation responses (consumed by the frontend ACL's
 *  `applyServerErrors`).  Phase D of validation-error-extension.md —
 *  all three backends (Hono / .NET / Phoenix) declare the same shape in
 *  lockstep so the cross-backend parity gate stays green. */
function renderProblemDetailsSchema(webModule: string): string {
  return `# Auto-generated.
defmodule ${webModule}.Api.Schemas.ProblemDetails do
  @moduledoc "RFC 7807 problem details — the shared cross-backend error body."

  require OpenApiSpex

  OpenApiSpex.schema(%{
    title: "ProblemDetails",
    type: :object,
    properties: %{
      type: %OpenApiSpex.Schema{type: :string},
      title: %OpenApiSpex.Schema{type: :string},
      status: %OpenApiSpex.Schema{type: :integer},
      detail: %OpenApiSpex.Schema{type: :string},
      instance: %OpenApiSpex.Schema{type: :string},
      errors: %OpenApiSpex.Schema{
        type: :array,
        items: %OpenApiSpex.Schema{
          type: :object,
          required: [:pointer, :message],
          properties: %{
            pointer: %OpenApiSpex.Schema{type: :string},
            message: %OpenApiSpex.Schema{type: :string}
          }
        }
      }
    }
  })
end
`;
}

function renderEnumSchema(en: EnumIR, webModule: string): string {
  const moduleName = `${webModule}.Api.Schemas.${en.name}`;
  const values = en.values.map((v) => `"${v}"`).join(", ");
  return [
    "# Auto-generated.",
    `defmodule ${moduleName} do`,
    `  @moduledoc "OpenApiSpex schema for #{__MODULE__}."`,
    "",
    "  require OpenApiSpex",
    "",
    "  OpenApiSpex.schema(%{",
    `    title: "${en.name}",`,
    `    type: :string,`,
    `    enum: [${values}]`,
    `  })`,
    `end`,
    "",
  ].join("\n");
}

function renderValueObjectSchema(vo: ValueObjectIR, webModule: string): string {
  const moduleName = `${webModule}.Api.Schemas.${vo.name}`;
  const fields: Array<{ name: string; type: TypeIR; optional: boolean }> = vo.fields.map(
    (f: FieldIR) => ({
      name: f.name,
      type: f.type,
      optional: f.optional,
    }),
  );
  return renderSchemaModule(moduleName, vo.name, fields, `${webModule}.Api.Schemas`);
}

function renderPartResponseSchema(part: EnrichedEntityPartIR, webModule: string): string {
  const moduleName = `${webModule}.Api.Schemas.${part.name}Response`;
  // `forApiRead` drops `internal` and `secret` fields from the OpenAPI
  // response schema so it matches what the Phoenix LiveView controller
  // actually serves — same contract the .NET / Hono / React backends
  // follow.
  const wireFields = forApiRead(wireFieldsFor(part));
  return renderSchemaModule(
    moduleName,
    `${part.name}Response`,
    wireFieldsToProps(wireFields),
    `${webModule}.Api.Schemas`,
  );
}

function renderAggregateResponseSchema(
  agg: EnrichedAggregateIR,
  webModule: string,
  payloads: readonly PayloadIR[] = [],
): string {
  const moduleName = `${webModule}.Api.Schemas.${agg.name}Response`;
  // M-T5.10: when a `response <Agg>Response` record is declared, READ its
  // fields (in declared order) instead of re-deriving from `wireShape`.  The
  // record omits `id` (grammar-reserved) — re-prepend it exactly as
  // `forApiRead` surfaces it — and a containment field carries its already-wire
  // `<Part>Response` name, so its type is peeled back to the part name before
  // `openApiType` re-appends `Response` (never `<Part>ResponseResponse`).
  // Byte-identical to the wireShape path for a scaffolded record.
  const declared = payloads.find((p) => p.kind === "response" && p.name === `${agg.name}Response`);
  const props = declared
    ? declaredResponseProps(agg, declared, payloads)
    : wireFieldsToProps(forApiRead(wireFieldsFor(agg)));
  return renderSchemaModule(moduleName, `${agg.name}Response`, props, `${webModule}.Api.Schemas`);
}

/** True iff `name` is a declared `response` payload — a containment field's
 *  already-wire type, which `openApiType` must not re-suffix. */
function isResponsePayloadName(payloads: readonly PayloadIR[], name: string): boolean {
  return payloads.some((p) => p.kind === "response" && p.name === name);
}

/** A containment field's declared type is `<Part>Response` (an entity whose
 *  name is a declared `response`); `openApiType` appends `Response` to an entity
 *  ref, so peel the name back to the part so the shared renderer re-appends it —
 *  yielding `<Part>Response`, not `<Part>ResponseResponse`.  Scalars / VOs /
 *  enums pass through unchanged (their declared type IS the domain type). */
function normalizeDeclaredType(t: TypeIR, payloads: readonly PayloadIR[]): TypeIR {
  if (t.kind === "array") return { ...t, element: normalizeDeclaredType(t.element, payloads) };
  if (t.kind === "optional") return { ...t, inner: normalizeDeclaredType(t.inner, payloads) };
  if (t.kind === "entity" && isResponsePayloadName(payloads, t.name)) {
    return { ...t, name: t.name.replace(/Response$/, "") };
  }
  return t;
}

/** Build the `<Agg>Response` schema props from a DECLARED `response` record:
 *  the re-prepended id row + each declared field (containment types peeled). */
function declaredResponseProps(
  agg: EnrichedAggregateIR,
  payload: PayloadIR,
  payloads: readonly PayloadIR[],
): Array<{ name: string; type: TypeIR; optional: boolean }> {
  const props: Array<{ name: string; type: TypeIR; optional: boolean }> = [];
  const idField = forApiRead(wireFieldsFor(agg)).find((w) => w.source === "id");
  if (idField) props.push({ name: idField.name, type: idField.type, optional: idField.optional });
  for (const f of payload.fields) {
    props.push({
      name: f.name,
      type: normalizeDeclaredType(f.type, payloads),
      optional: f.optional,
    });
  }
  return props;
}

/** Create-response schema — `{ id }` only, matching Hono/.NET's
 *  `Create<Agg>Response`.  The create endpoint returns just the new id. */
function renderCanResponseSchema(webModule: string): string {
  return `# Auto-generated.
defmodule ${webModule}.Api.Schemas.CanResponse do
  @moduledoc "OpenApiSpex schema for #{__MODULE__}."

  require OpenApiSpex

  OpenApiSpex.schema(%{
    title: "CanResponse",
    type: :object,
    properties: %{
      allowed: %OpenApiSpex.Schema{type: :boolean}
    },
    required: [:allowed]
  })
end
`;
}

function renderCreateResponseSchema(agg: AggregateIR, webModule: string): string {
  const moduleName = `${webModule}.Api.Schemas.Create${agg.name}Response`;
  const idSchema = OPENAPI_ID_VALUE[agg.idValueType] ?? OPENAPI_ID_VALUE.guid;
  return `# Auto-generated.
defmodule ${moduleName} do
  @moduledoc "OpenApiSpex schema for #{__MODULE__}."

  require OpenApiSpex

  OpenApiSpex.schema(%{
    title: "Create${agg.name}Response",
    type: :object,
    properties: %{
      id: ${idSchema}
    },
    required: [:id]
  })
end
`;
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
  // Create request carries the canonical create-input set the client may
  // supply.  `createInputFields` = `forCreateInput` (drops `managed`,
  // `token`, `internal`; keeps `immutable` and `secret`) INCLUDING
  // optionals — which ride their own type nullability into the `required`
  // list (see `renderProperties`).  Matches the .NET / Hono / React
  // CreateRequest shapes so the parity gate's property + required sets agree.
  const fields: Array<{ name: string; type: TypeIR; optional: boolean; wireDefault?: boolean }> =
    createInputFields(agg).map((f: FieldIR) => ({
      name: f.name,
      type: f.type,
      optional: f.optional,
      wireDefault: wireCreateDefault(f) !== undefined,
    }));
  return renderSchemaModule(
    moduleName,
    `Create${agg.name}Request`,
    fields,
    `${webModule}.Api.Schemas`,
    true,
  );
}

function renderOperationRequestSchema(
  agg: AggregateIR,
  op: import("../../../ir/types/loom-ir.js").OperationIR,
  webModule: string,
): string {
  const schemaName = `${upperFirst(op.name)}${agg.name}Request`;
  const moduleName = `${webModule}.Api.Schemas.${schemaName}`;
  // Optionality rides on the param's own type nullability — a nullable
  // param (`description?` etc., as crudish's `update` carries through from
  // a nullable field) is NOT required.  Hono derives the same from
  // `zodFor` (nullable → `.nullish()` → optional in OpenAPI); hardcoding
  // `false` here made Phoenix mark those params required and tripped the
  // parity gate's required-set dimension (UpdateProjectRequest drift).
  const fields: Array<{ name: string; type: TypeIR; optional: boolean }> = op.params.map(
    (p: ParamIR) => ({
      name: p.name,
      type: p.type,
      optional: wireTypeInfo(p.type, "request").isNullable,
    }),
  );
  return renderSchemaModule(moduleName, schemaName, fields, `${webModule}.Api.Schemas`, true);
}

function renderWorkflowRequestSchema(
  wf: import("../../../ir/types/loom-ir.js").WorkflowIR,
  webModule: string,
): string {
  const schemaName = `${upperFirst(wf.name)}Request`;
  const moduleName = `${webModule}.Api.Schemas.${schemaName}`;
  const fields: Array<{ name: string; type: TypeIR; optional: boolean }> = wf.params.map(
    (p: ParamIR) => ({
      name: p.name,
      type: p.type,
      optional: false,
    }),
  );
  return renderSchemaModule(moduleName, schemaName, fields, `${webModule}.Api.Schemas`, true);
}

/** Operation-return union DTO — the tagged wire union an exception-less
 *  op's 200 carries (`operation reserve(): Project or ProjectNotFound`).
 *  One `oneOf` arm per variant: the `type` discriminator literal plus the
 *  variant's wire fields (`unionMembers` — the same member specs Hono's
 *  discriminatedUnion and .NET's Application union DTO render), so the
 *  spec's component set + response bodies agree across backends. */
function renderOperationUnionSchema(
  unionName: string,
  variants: TypeIR[],
  ctx: EnrichedBoundedContextIR,
  webModule: string,
): string {
  const schemasModule = `${webModule}.Api.Schemas`;
  const members = unionMembers(variants, ctx);
  const arms = members.map((m) => {
    const tagProp = `        type: %OpenApiSpex.Schema{type: :string, enum: ["${m.tag}"]}`;
    if (m.shape === "none") {
      return `      %OpenApiSpex.Schema{
        type: :object,
        properties: %{
${tagProp}
        },
        required: [:type]
      }`;
    }
    if (m.shape === "scalar") {
      return `      %OpenApiSpex.Schema{
        type: :object,
        properties: %{
${tagProp},
        value: ${openApiType(m.type, schemasModule)}
        },
        required: [:type, :value]
      }`;
    }
    const { propsLines, requiredAtoms } = renderProperties(
      m.fields.map((f) => ({ name: f.name, type: f.type, optional: f.optional })),
      schemasModule,
    );
    const indented = propsLines.map((l) => `  ${l}`);
    return `      %OpenApiSpex.Schema{
        type: :object,
        properties: %{
${[tagProp, ...indented].join(",\n")}
        },
        required: [${[":type", ...requiredAtoms].join(", ")}]
      }`;
  });
  return `# Auto-generated.
defmodule ${schemasModule}.${unionName} do
  @moduledoc "OpenApiSpex schema for #{__MODULE__}."

  require OpenApiSpex

  OpenApiSpex.schema(%{
    title: "${unionName}",
    oneOf: [
${arms.join(",\n")}
    ]
  })
end
`;
}

/** Observable-workflow instance response — the `instanceWireShape`
 *  projection (correlation id + folded state fields), the saga analogue of
 *  an aggregate's `<Agg>Response`.  Required set mirrors Hono/Python: every
 *  non-optional wire field. */
function renderWorkflowInstanceResponseSchema(
  wf: import("../../../ir/types/loom-ir.js").WorkflowIR,
  webModule: string,
): string {
  const schemasModule = `${webModule}.Api.Schemas`;
  const schemaName = `${upperFirst(wf.name)}InstanceResponse`;
  return renderSchemaModule(
    `${schemasModule}.${schemaName}`,
    schemaName,
    wireFieldsToProps(wf.instanceWireShape ?? []),
    schemasModule,
  );
}

/** The named array carrier for the instance list — items reference the
 *  instance response MODULE so OpenApiSpex registers + `$ref`s it (same
 *  pattern as `renderViewResponseSchema`). */
function renderWorkflowInstanceListResponseSchema(
  wf: import("../../../ir/types/loom-ir.js").WorkflowIR,
  webModule: string,
): string {
  const schemasModule = `${webModule}.Api.Schemas`;
  const schemaName = `${upperFirst(wf.name)}InstanceListResponse`;
  return `# Auto-generated.
defmodule ${schemasModule}.${schemaName} do
  @moduledoc "OpenApiSpex schema for #{__MODULE__}."

  require OpenApiSpex

  OpenApiSpex.schema(%{
    title: "${schemaName}",
    type: :array,
    items: ${schemasModule}.${upperFirst(wf.name)}InstanceResponse
  })
end
`;
}

/** The schema module for one element of a view's result list.  Full-form
 *  views (with declared `output`) get a dedicated `<View>Row`; shorthand
 *  views reuse the source aggregate's `<Agg>Response`. */
function viewItemModule(
  view: import("../../../ir/types/loom-ir.js").ViewIR,
  schemasModule: string,
): string {
  return view.output
    ? `${schemasModule}.${upperFirst(view.name)}Row`
    : `${schemasModule}.${view.source.name}Response`;
}

/** Full-form view row schema — the named element type (`<View>Row`)
 *  referenced by the view's list-response wrapper.  Emitted only for
 *  views with a declared `output`. */
function renderViewRowSchema(
  view: import("../../../ir/types/loom-ir.js").ViewIR,
  webModule: string,
): string {
  const schemasModule = `${webModule}.Api.Schemas`;
  const rowName = `${upperFirst(view.name)}Row`;
  const fields = (view.output?.fields ?? []).map((f: FieldIR) => ({
    name: f.name,
    type: f.type,
    optional: f.optional,
  }));
  return renderSchemaModule(`${schemasModule}.${rowName}`, rowName, fields, schemasModule);
}

/** View list-response wrapper — a bare `array` whose `items` reference the
 *  element schema MODULE (so OpenApiSpex registers it and rewrites to a
 *  `$ref`).  This makes the wrapper a structural list-wrapper that the
 *  conformance harness resolves to `array<element>`, matching Hono/.NET's
 *  inline array — instead of the old inline-object form that read as a
 *  Phoenix-only named schema. */
function renderViewResponseSchema(
  view: import("../../../ir/types/loom-ir.js").ViewIR,
  ctx: EnrichedBoundedContextIR,
  webModule: string,
): string {
  void ctx;
  const schemasModule = `${webModule}.Api.Schemas`;
  const schemaName = `${upperFirst(view.name)}Response`;
  const moduleName = `${schemasModule}.${schemaName}`;
  const itemModule = viewItemModule(view, schemasModule);

  return `# Auto-generated.
defmodule ${moduleName} do
  @moduledoc "OpenApiSpex schema for #{__MODULE__}."

  require OpenApiSpex

  OpenApiSpex.schema(%{
    title: "${schemaName}",
    type: :array,
    items: ${itemModule}
  })
end
`;
}

// ---------------------------------------------------------------------------
// OpenAPI controller renderer
// ---------------------------------------------------------------------------

function renderOpenapiController(_appModule: string, webModule: string, apiPascal: string): string {
  const specModule = `${webModule}.Api.${apiPascal}Spec`;
  return `# Auto-generated.
defmodule ${webModule}.OpenapiController do
  use ${webModule}, :controller

  @moduledoc """
  Serves the OpenAPI spec as JSON.

  GET /openapi.json → returns the full spec generated by #{${specModule}}.
  """

  @doc "GET /openapi.json"
  def index(conn, _params) do
    spec = ${specModule}.spec()
    conn
    |> put_resp_content_type("application/json")
    |> send_resp(200, Jason.encode!(spec))
  end
end
`;
}

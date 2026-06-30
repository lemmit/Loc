import { hasCreate } from "../../../ir/enrich/wire-projection.js";
import type {
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  RepositoryIR,
} from "../../../ir/types/loom-ir.js";
import {
  operationIsGuarded,
  workflowEmitsCommandRoute,
  workflowIsGuarded,
} from "../../../ir/types/loom-ir.js";
import {
  errorStatuses,
  PROBLEM_JSON,
  PROBLEM_SCHEMA,
  problemTitle,
} from "../../../ir/util/openapi-errors.js";
import { lines } from "../../../util/code-builder.js";
import { defaultErrorStatus } from "../../../util/error-defaults.js";
import { plural, snake, upperFirst } from "../../../util/naming.js";
import { findUnionSpec } from "../../_payload/union-wire.js";
import { declaredFinds, isPagedFind } from "./repository.js";
import { returnUnionSpec } from "./unions.js";

// ---------------------------------------------------------------------------
// springdoc OpenApiCustomizer — the .NET document-filter analog for Java.
//
// springdoc infers the controller routes correctly (paths / params / request
// bodies / 2xx schema components) but produces a spec that diverges from the
// other four backends in three ways that are NOT expressible through the route
// return types alone:
//
//   1. Success responses are served under the `*/*` media type (springdoc's
//      default for a bare `List<X>` / `ResponseEntity<X>` return), so the
//      parity normalizer — which reads `content["application/json"]` — sees no
//      schema and classifies the response as `object`.  We rewrite every 2xx
//      success body onto `application/json`.
//   2. List / view GETs are inline `{ type: array, items: $ref }`; the other
//      backends name the wrapper (`<Agg>ListResponse`, full-form-view
//      `<View>Response`).  We register the named array component and retarget
//      the response `$ref` to it (mirrors .NET's ListResponseWrapperFilter).
//   3. No RFC 7807 error responses are declared at all.  We add the per-op
//      `application/problem+json` → `ProblemDetails` responses, with the exact
//      status set every other backend emits (the shared
//      `src/ir/util/openapi-errors.ts` matrix — single source of truth).
//
// The customizer is data-driven: the generator bakes a per-route descriptor
// table (computed here, off the same IR the controllers walk) into the emitted
// class, so the Java side just applies the document edits.
// ---------------------------------------------------------------------------

/** A 4xx/5xx error response to declare on a route: status + the
 *  ProblemDetails component it carries. */
interface RouteError {
  status: number;
}

/** One emitted HTTP route and the OpenAPI corrections it needs. */
interface RouteContract {
  /** HTTP method, lowercase (`get` / `post` / `delete`). */
  method: string;
  /** Full path as it appears in the spec (route prefix included). */
  path: string;
  /** Named array-wrapper component the 2xx body should `$ref`, when this is a
   *  list/view GET; otherwise undefined (the 2xx body keeps its inferred
   *  component, only its media type is normalized to application/json). */
  listWrapper?: string;
  /** RFC 7807 error responses, ascending by status. */
  errors: RouteError[];
}

/** element-schema → array-wrapper component name, registered as
 *  `{ type: array, items: { $ref: <element> } }`. */
interface WrapperComponent {
  wrapper: string;
  element: string;
}

interface Contract {
  routes: RouteContract[];
  wrappers: WrapperComponent[];
}

/** Build the per-route OpenAPI contract from the IR, walking the same route
 *  shapes the controllers (api.ts / view.ts / workflow.ts) emit. */
export function buildJavaOpenApiContract(
  contexts: readonly EnrichedBoundedContextIR[],
  routePrefix: string,
): Contract {
  const routes: RouteContract[] = [];
  const wrappers = new Map<string, string>();

  const err = (statuses: number[]): RouteError[] => statuses.map((status) => ({ status }));

  for (const ctx of contexts) {
    const repoByAgg = new Map<string, RepositoryIR | undefined>(
      ctx.repositories.map((r) => [r.aggregateName, r]),
    );

    for (const agg of ctx.aggregates) {
      if (agg.isAbstract) continue;
      const route = `${routePrefix}/${snake(plural(agg.name))}`;
      const repo = repoByAgg.get(agg.name);

      // POST /<plural>  (create) → 400, 422
      if (hasCreate(agg) || isEsConstructible(agg)) {
        routes.push({ method: "post", path: route, errors: err(errorStatuses("create")) });
      }

      // GET /<plural>/{id} (getById) → 404
      routes.push({ method: "get", path: `${route}/{id}`, errors: err(errorStatuses("getById")) });

      // DELETE /<plural>/{id} (destroy) → 404, 409
      if ((agg.destroys?.length ?? 0) > 0) {
        routes.push({
          method: "delete",
          path: `${route}/{id}`,
          errors: err(errorStatuses("destroy")),
        });
      }

      // GET /<plural> (auto-findAll) → array of <Agg>ListResponse
      const listWrapper = `${agg.name}ListResponse`;
      wrappers.set(listWrapper, `${agg.name}Response`);
      routes.push({ method: "get", path: route, listWrapper, errors: [] });

      // Operations — POST /<plural>/{id}/<op> (+ optional GET can_<op>).
      for (const op of agg.operations) {
        if (op.visibility !== "public") continue;
        const opPath = `${route}/{id}/${snake(op.name)}`;
        const spec = ctx ? returnUnionSpec(op, ctx) : undefined;
        if (spec) {
          // Exception-less return union: success 200 + each error variant's
          // mapped ProblemDetails status (no universal 400/404/422 base).
          const statuses = new Set<number>();
          for (const a of spec.arms) if (a.isError) statuses.add(a.status);
          if (operationIsGuarded(op)) statuses.add(403);
          routes.push({
            method: "post",
            path: opPath,
            errors: err([...statuses].sort((x, y) => x - y)),
          });
        } else {
          routes.push({
            method: "post",
            path: opPath,
            errors: err(errorStatuses("operation", operationIsGuarded(op))),
          });
        }
        // can_<op> companion (GET) → 404 (loads the aggregate first).
        if (op.when) {
          routes.push({
            method: "get",
            path: `${route}/{id}/can_${snake(op.name)}`,
            errors: err([404]),
          });
        }
      }

      // Declared finds — GET /<plural>/<find_snake>.
      for (const f of declaredFinds(repo)) {
        const findPath = `${route}/${snake(f.name)}`;
        const spec = ctx ? findUnionSpec(f.returnType, agg.name, ctx) : null;
        if (spec) {
          // Union find: absent `none` → 404, absent `error` → its mapped status.
          const status =
            spec.absent.kind === "none"
              ? 404
              : (ctx.errorStatusOverrides?.[spec.absent.tag] ??
                defaultErrorStatus(spec.absent.tag));
          routes.push({ method: "get", path: findPath, errors: err([status]) });
          continue;
        }
        if (isPagedFind(f)) {
          routes.push({ method: "get", path: findPath, errors: [] });
          continue;
        }
        if (f.returnType.kind === "array") {
          // List find → reuse the aggregate's list wrapper.
          routes.push({ method: "get", path: findPath, listWrapper, errors: [] });
        } else {
          // Single optional find → 404.
          routes.push({
            method: "get",
            path: findPath,
            errors: err(errorStatuses("findOptional")),
          });
        }
      }
    }

    // Views — GET /views/<snake(name)>.  Shorthand reuses the source
    // aggregate's list wrapper; a full-form view names `<View>Response`.
    for (const view of ctx.views) {
      const viewPath = `${routePrefix}/views/${snake(view.name)}`;
      let wrapper: string;
      if (view.output) {
        wrapper = `${upperFirst(view.name)}Response`;
        wrappers.set(wrapper, `${upperFirst(view.name)}Row`);
      } else if (view.source.kind === "aggregate") {
        const aggName = view.source.name;
        wrapper = `${aggName}ListResponse`;
        wrappers.set(wrapper, `${aggName}Response`);
      } else {
        // Workflow-sourced view → `<View>Row` element wrapper.
        wrapper = `${upperFirst(view.name)}Response`;
        wrappers.set(wrapper, `${upperFirst(view.name)}Row`);
      }
      routes.push({ method: "get", path: viewPath, listWrapper: wrapper, errors: [] });
    }

    // Workflows — POST /workflows/<snake(name)>.
    for (const wf of ctx.workflows) {
      if (!workflowEmitsCommandRoute(wf)) continue;
      routes.push({
        method: "post",
        path: `${routePrefix}/workflows/${snake(wf.name)}`,
        errors: err(errorStatuses("workflow", workflowIsGuarded(wf))),
      });
    }
  }

  return {
    routes,
    wrappers: [...wrappers.entries()].map(([wrapper, element]) => ({ wrapper, element })),
  };
}

/** Event-sourced aggregates are constructible via `create` even when field
 *  constructibility (`hasCreate`) is false (mirrors api.ts's esConstructible —
 *  `persistedAs(eventLog)` with a declared create). */
function isEsConstructible(agg: EnrichedAggregateIR): boolean {
  return agg.persistedAs === "eventLog" && (agg.creates?.length ?? 0) > 0;
}

/** Render the springdoc OpenApiCustomizer @Configuration class.  Returns null
 *  when there are no routes to correct (no aggregates → no API surface). */
export function renderJavaOpenApiCustomizer(basePkg: string, contract: Contract): string | null {
  if (contract.routes.length === 0) return null;

  // Bake the route table as Java literals.  Each route is a method, path,
  // optional wrapper, and ascending error-status list.
  const routeLiterals = contract.routes.map((r) => {
    const statusList = r.errors.map((e) => String(e.status)).join(", ");
    const statusArr = `new int[] {${statusList}}`;
    const wrapperArg = r.listWrapper ? JSON.stringify(r.listWrapper) : "null";
    return `        new Route(${JSON.stringify(r.method)}, ${JSON.stringify(r.path)}, ${wrapperArg}, ${statusArr}),`;
  });
  const wrapperLiterals = contract.wrappers.map(
    (w) => `        new Wrapper(${JSON.stringify(w.wrapper)}, ${JSON.stringify(w.element)}),`,
  );

  // Title table for the RFC 7807 problem responses (matches problemTitle()).
  const allStatuses = new Set<number>();
  for (const r of contract.routes) for (const e of r.errors) allStatuses.add(e.status);
  const titleCases = [...allStatuses]
    .sort((a, b) => a - b)
    .map((s) => `            case ${s} -> ${JSON.stringify(problemTitle(s))};`);

  return lines(
    `package ${basePkg}.config;`,
    ``,
    `import java.util.List;`,
    `import java.util.Map;`,
    ``,
    `import org.springdoc.core.customizers.OpenApiCustomizer;`,
    `import org.springframework.context.annotation.Bean;`,
    `import org.springframework.context.annotation.Configuration;`,
    ``,
    `import io.swagger.v3.oas.models.Components;`,
    `import io.swagger.v3.oas.models.OpenAPI;`,
    `import io.swagger.v3.oas.models.Operation;`,
    `import io.swagger.v3.oas.models.PathItem;`,
    `import io.swagger.v3.oas.models.media.ArraySchema;`,
    `import io.swagger.v3.oas.models.media.Content;`,
    `import io.swagger.v3.oas.models.media.MediaType;`,
    `import io.swagger.v3.oas.models.media.ObjectSchema;`,
    `import io.swagger.v3.oas.models.media.Schema;`,
    `import io.swagger.v3.oas.models.media.StringSchema;`,
    `import io.swagger.v3.oas.models.responses.ApiResponse;`,
    `import io.swagger.v3.oas.models.responses.ApiResponses;`,
    ``,
    // ----------------------------------------------------------------
    `/**`,
    ` * Aligns the springdoc-generated OpenAPI document with the other Loom`,
    ` * backends' contract: success bodies under application/json (list GETs`,
    ` * promoted to named <Agg>ListResponse array wrappers) and the shared RFC`,
    ` * 7807 ProblemDetails error responses under application/problem+json.`,
    ` */`,
    `@Configuration`,
    `public class OpenApiContractCustomizer {`,
    ``,
    `    private static final String JSON = "application/json";`,
    `    private static final String PROBLEM_JSON = ${JSON.stringify(PROBLEM_JSON)};`,
    `    private static final String PROBLEM_SCHEMA = ${JSON.stringify(PROBLEM_SCHEMA)};`,
    ``,
    `    private record Route(String method, String path, String wrapper, int[] statuses) {}`,
    `    private record Wrapper(String name, String element) {}`,
    ``,
    `    private static final List<Wrapper> WRAPPERS = List.of(`,
    ...(wrapperLiterals.length > 0 ? trimTrailingComma(wrapperLiterals) : []),
    `    );`,
    ``,
    `    private static final List<Route> ROUTES = List.of(`,
    ...trimTrailingComma(routeLiterals),
    `    );`,
    ``,
    `    @Bean`,
    `    public OpenApiCustomizer loomContractCustomizer() {`,
    `        return openApi -> {`,
    `            ensureProblemSchema(openApi);`,
    `            registerWrappers(openApi);`,
    `            for (Route route : ROUTES) {`,
    `                PathItem item = openApi.getPaths() == null ? null : openApi.getPaths().get(route.path());`,
    `                if (item == null) continue;`,
    `                Operation op = operationFor(item, route.method());`,
    `                if (op == null) continue;`,
    `                normalizeSuccess(op, route.wrapper());`,
    `                addErrors(op, route.statuses());`,
    `            }`,
    `        };`,
    `    }`,
    ``,
    `    /** Promote every 2xx success body to application/json; retarget a list`,
    `     *  GET to its named array wrapper. */`,
    `    private static void normalizeSuccess(Operation op, String wrapper) {`,
    `        if (op.getResponses() == null) return;`,
    `        for (Map.Entry<String, ApiResponse> e : op.getResponses().entrySet()) {`,
    `            String code = e.getKey();`,
    `            if (!code.startsWith("2")) continue;`,
    `            ApiResponse resp = e.getValue();`,
    `            Content content = resp.getContent();`,
    `            if (content == null) continue;`,
    `            MediaType media = content.get("*/*");`,
    `            if (media == null) media = content.get(JSON);`,
    `            if (media == null) {`,
    `                // No body content (e.g. 204): nothing to normalize.`,
    `                continue;`,
    `            }`,
    `            if (wrapper != null) {`,
    `                media.setSchema(new Schema<>().$ref("#/components/schemas/" + wrapper));`,
    `            }`,
    `            Content normalized = new Content();`,
    `            normalized.addMediaType(JSON, media);`,
    `            resp.setContent(normalized);`,
    `        }`,
    `    }`,
    ``,
    `    /** Declare the RFC 7807 error responses for an operation. */`,
    `    private static void addErrors(Operation op, int[] statuses) {`,
    `        if (statuses.length == 0) return;`,
    `        ApiResponses responses = op.getResponses();`,
    `        if (responses == null) {`,
    `            responses = new ApiResponses();`,
    `            op.setResponses(responses);`,
    `        }`,
    `        for (int status : statuses) {`,
    `            Content content = new Content();`,
    `            content.addMediaType(PROBLEM_JSON, new MediaType()`,
    `                .schema(new Schema<>().$ref("#/components/schemas/" + PROBLEM_SCHEMA)));`,
    `            responses.addApiResponse(String.valueOf(status), new ApiResponse()`,
    `                .description(titleFor(status))`,
    `                .content(content));`,
    `        }`,
    `    }`,
    ``,
    `    /** Register the named array wrappers (<Agg>ListResponse / <View>Response). */`,
    `    private static void registerWrappers(OpenAPI openApi) {`,
    `        Components components = openApi.getComponents();`,
    `        if (components == null || components.getSchemas() == null) return;`,
    `        for (Wrapper w : WRAPPERS) {`,
    `            if (!components.getSchemas().containsKey(w.element())) continue;`,
    `            if (components.getSchemas().containsKey(w.name())) continue;`,
    `            ArraySchema arr = new ArraySchema();`,
    `            arr.setItems(new Schema<>().$ref("#/components/schemas/" + w.element()));`,
    `            components.addSchemas(w.name(), arr);`,
    `        }`,
    `    }`,
    ``,
    `    /** Add the shared RFC 7807 ProblemDetails component (core fields + the`,
    `     *  §3.2 errors[] validation extension), matching the other backends. */`,
    `    private static void ensureProblemSchema(OpenAPI openApi) {`,
    `        Components components = openApi.getComponents();`,
    `        if (components == null) {`,
    `            components = new Components();`,
    `            openApi.setComponents(components);`,
    `        }`,
    `        if (components.getSchemas() != null && components.getSchemas().containsKey(PROBLEM_SCHEMA)) {`,
    `            return;`,
    `        }`,
    `        ObjectSchema problem = new ObjectSchema();`,
    `        problem.addProperty("type", new StringSchema());`,
    `        problem.addProperty("title", new StringSchema());`,
    `        problem.addProperty("status", new Schema<>().type("integer").format("int32"));`,
    `        problem.addProperty("detail", new StringSchema());`,
    `        problem.addProperty("instance", new StringSchema());`,
    `        ObjectSchema errorItem = new ObjectSchema();`,
    `        errorItem.addProperty("pointer", new StringSchema());`,
    `        errorItem.addProperty("message", new StringSchema());`,
    `        errorItem.setRequired(List.of("pointer", "message"));`,
    `        ArraySchema errors = new ArraySchema();`,
    `        errors.setItems(errorItem);`,
    `        errors.setNullable(true);`,
    `        problem.addProperty("errors", errors);`,
    `        components.addSchemas(PROBLEM_SCHEMA, problem);`,
    `    }`,
    ``,
    `    private static Operation operationFor(PathItem item, String method) {`,
    `        return switch (method) {`,
    `            case "get" -> item.getGet();`,
    `            case "post" -> item.getPost();`,
    `            case "put" -> item.getPut();`,
    `            case "delete" -> item.getDelete();`,
    `            case "patch" -> item.getPatch();`,
    `            default -> null;`,
    `        };`,
    `    }`,
    ``,
    `    private static String titleFor(int status) {`,
    `        return switch (status) {`,
    ...titleCases,
    `            default -> "Error";`,
    `        };`,
    `    }`,
    `}`,
    ``,
  );
}

/** Strip the trailing comma off the last literal in a Java `List.of(...)`. */
function trimTrailingComma(literals: string[]): string[] {
  if (literals.length === 0) return literals;
  const out = [...literals];
  out[out.length - 1] = out[out.length - 1]!.replace(/,$/, "");
  return out;
}

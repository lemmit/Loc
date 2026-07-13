import { forApiRead } from "../../../ir/enrich/wire-projection.js";
import { unionInstanceName } from "../../../ir/stdlib/unions.js";
import type {
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  EnumIR,
  RepositoryIR,
  TypeIR,
  WireField,
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
import { aggregateIsVersioned } from "../../../ir/util/versioned-capability.js";
import { lines } from "../../../util/code-builder.js";
import { defaultErrorStatus } from "../../../util/error-defaults.js";
import { lowerFirst, plural, snake, upperFirst } from "../../../util/naming.js";
import { findUnionSpec, unionJsonSchema } from "../../_payload/union-wire.js";
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
  /** Named scalar component the 2xx body should `$ref` — used when springdoc
   *  can't infer the success schema (a union find's controller returns
   *  `ResponseEntity<?>`), so we pin `<Agg>Response` explicitly.  Shares the
   *  runtime `wrapper` slot with `listWrapper` (both just `$ref` a component);
   *  at most one is set. */
  successRef?: string;
  /** RFC 7807 error responses, ascending by status. */
  errors: RouteError[];
  /** operationId override — the canonical id the other backends emit, when
   *  springdoc's controller-derived default diverges (workflow command routes
   *  carry a `Workflow` suffix, view routes a `View` suffix).  Undefined for
   *  aggregate-op routes, whose springdoc default already matches node. */
  operationId?: string;
}

/** element-schema → array-wrapper component name, registered as
 *  `{ type: array, items: { $ref: <element> } }`. */
interface WrapperComponent {
  wrapper: string;
  element: string;
}

/** A named string-enum component the other backends publish (`Visibility`,
 *  `BuildState`) but springdoc inlines as a bare `String` — registered as a
 *  `StringSchema` carrying the value list. */
interface EnumComponent {
  name: string;
  values: string[];
}

/** A `<field-name> → <enum-component>` retarget: any plain-string property
 *  named `<property>` across the whole document is repointed at the named
 *  enum `$ref` (springdoc renders an enum-typed field as bare `String`). */
interface EnumProp {
  property: string;
  enumName: string;
}

/** An empty-object request body to attach to a param-less public operation —
 *  the other backends emit a named `{}` request schema (`ArchiveProjectRequest`)
 *  and bind it as the op's `requestBody`; springdoc emits none for a no-body
 *  op. */
interface EmptyRequest {
  path: string;
  schema: string;
}

interface Contract {
  routes: RouteContract[];
  wrappers: WrapperComponent[];
  /** Operation-return union components — name + raw oneOf JSON schema,
   *  registered via Json.mapper at customize time (springdoc never sees the
   *  union: the controller returns `ResponseEntity<?>`). */
  unions: { name: string; schemaJson: string }[];
  /** Referenced string-enum components (other backends name them; springdoc
   *  inlines them as `String`). */
  enums: EnumComponent[];
  /** Unambiguous field-name → enum-component retargets. */
  enumProps: EnumProp[];
  /** Empty-object request bodies for param-less public operations. */
  emptyRequests: EmptyRequest[];
  /** `schema name → required-field list` — the non-optional field set per
   *  DTO/wire component, matching what the other backends mark required.
   *  Required lists are alphabetically sorted (the other backends' specs
   *  carry them sorted; the parity diff compares the set, not the order). */
  required: { schema: string; fields: string[] }[];
}

/** Build the per-route OpenAPI contract from the IR, walking the same route
 *  shapes the controllers (api.ts / view.ts / workflow.ts) emit. */
export function buildJavaOpenApiContract(
  contexts: readonly EnrichedBoundedContextIR[],
  routePrefix: string,
): Contract {
  const routes: RouteContract[] = [];
  const wrappers = new Map<string, string>();
  // Operation-return union components — name → raw oneOf JSON (parsed by the
  // emitted customizer via Json.mapper), see the op union branch below.
  const unions = new Map<string, string>();
  // schema-name → required-field set (collected as a set, sorted at the end).
  const required = new Map<string, string[]>();
  const emptyRequests: EmptyRequest[] = [];
  // enum-name → values, for enums actually referenced by an enum-typed field.
  const referencedEnums = new Map<string, string[]>();
  // field-name → set of enum-names it maps to (ambiguous names are dropped).
  const enumFieldTargets = new Map<string, Set<string>>();
  const allEnums = new Map<string, EnumIR>();

  const setRequired = (schema: string, fields: string[]): void => {
    required.set(schema, [...fields].sort());
  };
  /** Note every enum a type references (peeling array/optional), so the
   *  customizer registers exactly the enums the other backends name. */
  const noteEnumRefs = (t: TypeIR | undefined, fieldName?: string): void => {
    const name = enumNameOf(t);
    if (!name) return;
    referencedEnums.set(name, allEnums.get(name)?.values ?? []);
    if (fieldName) {
      const set = enumFieldTargets.get(fieldName) ?? new Set<string>();
      set.add(name);
      enumFieldTargets.set(fieldName, set);
    }
  };

  const err = (statuses: number[]): RouteError[] => statuses.map((status) => ({ status }));

  // Index every declared enum (root + per-context) so a referenced one can be
  // resolved to its value list.
  for (const e of [...contexts.flatMap((c) => c.enums ?? [])]) allEnums.set(e.name, e);

  for (const ctx of contexts) {
    const repoByAgg = new Map<string, RepositoryIR | undefined>(
      ctx.repositories.map((r) => [r.aggregateName, r]),
    );

    for (const agg of ctx.aggregates) {
      if (agg.isAbstract) continue;
      const route = `${routePrefix}/${snake(plural(agg.name))}`;
      const repo = repoByAgg.get(agg.name);

      // Required-field sets — the non-optional field set per emitted DTO/wire
      // component, matching what the other backends mark required (springdoc
      // marks nothing required).  The rules mirror the Hono zod emitter:
      //   - response (<Agg>Response / <Part>Response): forApiRead(wireShape)
      //     fields that aren't optional (id is always present → required);
      //   - create request (Create<Agg>Request): the createInput contract's
      //     `requiredInput` set (already folds bool/default/optional → omit);
      //   - op / workflow request (<Op><Agg>Request, <Wf>Request): params that
      //     are neither optional-typed nor a bare body-bool (→ default false);
      //   - create response (Create<Agg>Response): just `{ id }`.
      const apiRead = forApiRead(agg.wireShape ?? []);
      for (const w of apiRead) noteEnumRefs(w.type, w.name);
      setRequired(`${agg.name}Response`, requiredWireFields(apiRead));
      for (const part of agg.parts) {
        const partRead = forApiRead(part.wireShape ?? []);
        for (const w of partRead) noteEnumRefs(w.type, w.name);
        setRequired(`${part.name}Response`, requiredWireFields(partRead));
      }

      // POST /<plural>  (create) → 400, 422
      if (agg.canonicalCreate != null || isEsConstructible(agg)) {
        routes.push({ method: "post", path: route, errors: err(errorStatuses("create")) });
        const createInput = agg.createInput ?? [];
        for (const c of createInput) noteEnumRefs(c.field.type, c.field.name);
        setRequired(
          `Create${agg.name}Request`,
          createInput.filter((c) => c.requiredInput).map((c) => c.field.name),
        );
        setRequired(`Create${agg.name}Response`, ["id"]);
      }

      // Per-public-operation requests (Create-shaped op DTOs incl. crudish
      // `update`).  Param-less public ops get an empty-object request body the
      // other backends name + attach (springdoc emits none).
      for (const op of agg.operations) {
        if (op.visibility !== "public") continue;
        for (const p of op.params) noteEnumRefs(p.type, p.name);
        const reqName = `${upperFirst(op.name)}${agg.name}Request`;
        if (op.params.length === 0) {
          emptyRequests.push({ path: `${route}/{id}/${snake(op.name)}`, schema: reqName });
          setRequired(reqName, []);
        } else {
          setRequired(reqName, requiredParams(op.params));
        }
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
        // A versioned aggregate's `update` declares 409 (stale `If-Match` →
        // optimistic-concurrency conflict), mirroring the Hono / .NET contract.
        const versionedUpdate = op.name === "update" && aggregateIsVersioned(agg);
        if (spec && op.returnType?.kind === "union") {
          // Exception-less return union: 200 carries the tagged union DTO
          // (the controller returns `ResponseEntity<?>`, so springdoc infers
          // nothing — pin the component + `$ref` explicitly, like union
          // finds pin `<Agg>Response`).  Errors = the standard operation
          // matrix ∪ each error variant's mapped status, matching
          // Hono / .NET (showcase's `reserve` surfaced both gaps live).
          const unionName = unionInstanceName(op.returnType.variants);
          unions.set(unionName, JSON.stringify(unionJsonSchema(op.returnType.variants, ctx)));
          const statuses = new Set<number>(errorStatuses("operation", operationIsGuarded(op)));
          for (const a of spec.arms) if (a.isError) statuses.add(a.status);
          if (versionedUpdate) statuses.add(409);
          routes.push({
            method: "post",
            path: opPath,
            successRef: unionName,
            errors: err([...statuses].sort((x, y) => x - y)),
          });
        } else {
          const statuses = new Set<number>(errorStatuses("operation", operationIsGuarded(op)));
          if (versionedUpdate) statuses.add(409);
          routes.push({
            method: "post",
            path: opPath,
            errors: err([...statuses].sort((x, y) => x - y)),
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
          // 200 is the SUCCESS variant directly (`<Agg>Response`); the union
          // controller returns `ResponseEntity<?>` so springdoc infers nothing,
          // hence the explicit ref.  Error/absent variant → `status`.
          routes.push({
            method: "get",
            path: findPath,
            successRef: `${agg.name}Response`,
            errors: err([status]),
          });
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
        const rowName = `${upperFirst(view.name)}Row`;
        wrappers.set(wrapper, rowName);
        // Full-form view Row — required = the non-optional declared fields.
        for (const f of view.output.fields) noteEnumRefs(f.type, f.name);
        setRequired(
          rowName,
          view.output.fields.filter((f) => !isOptionalType(f.type)).map((f) => f.name),
        );
      } else if (view.source.kind === "aggregate") {
        const aggName = view.source.name;
        wrapper = `${aggName}ListResponse`;
        wrappers.set(wrapper, `${aggName}Response`);
      } else {
        // Workflow- or projection-sourced shorthand view → `<View>Row` element
        // wrapper (both emit a dedicated row record, unlike an aggregate
        // shorthand which reuses `<Agg>Response`).
        wrapper = `${upperFirst(view.name)}Response`;
        wrappers.set(wrapper, `${upperFirst(view.name)}Row`);
      }
      // View route operationId carries a `View` suffix on the other backends
      // (`activeProjectsView`); springdoc derives the bare method name.
      routes.push({
        method: "get",
        path: viewPath,
        listWrapper: wrapper,
        errors: [],
        operationId: `${lowerFirst(view.name)}View`,
      });
    }

    // Workflows — POST /workflows/<snake(name)>.
    for (const wf of ctx.workflows) {
      // Observable workflows (instanceWireShape) expose the two read-only
      // instance routes regardless of whether a command POST exists (an
      // event-triggered saga has no command route but is still observable).
      // List → named `<Wf>InstanceListResponse` wrapper (Hono/Python name
      // it; springdoc inlines `List<T>`); byId → 404 ProblemDetails; the
      // instance DTO's required set = every non-optional wire field.
      if (wf.instanceWireShape) {
        const T = upperFirst(wf.name);
        const instancesPath = `${routePrefix}/workflows/${snake(wf.name)}/instances`;
        wrappers.set(`${T}InstanceListResponse`, `${T}InstanceResponse`);
        routes.push({
          method: "get",
          path: instancesPath,
          listWrapper: `${T}InstanceListResponse`,
          errors: [],
        });
        routes.push({
          method: "get",
          path: `${instancesPath}/{id}`,
          errors: err(errorStatuses("getById")),
        });
        for (const f of wf.instanceWireShape) noteEnumRefs(f.type, f.name);
        setRequired(`${T}InstanceResponse`, requiredWireFields(wf.instanceWireShape));
      }
      if (!workflowEmitsCommandRoute(wf)) continue;
      routes.push({
        method: "post",
        path: `${routePrefix}/workflows/${snake(wf.name)}`,
        errors: err(errorStatuses("workflow", workflowIsGuarded(wf))),
        // Workflow command operationId carries a `Workflow` suffix on the other
        // backends (`registerProjectWorkflow`); springdoc derives the bare name.
        operationId: `${lowerFirst(wf.name)}Workflow`,
      });
      // <Wf>Request — required = command params (same op-param rule).
      for (const p of wf.params) noteEnumRefs(p.type, p.name);
      setRequired(`${upperFirst(wf.name)}Request`, requiredParams(wf.params));
    }

    // Observable workflows — read-only instance endpoints
    // (workflow-instance-visibility.md).  Independent of the command route:
    // an event-triggered-only saga still exposes its instances.  Bring the
    // springdoc-inferred list/by-id ops to Hono's canonical shape:
    //   - GET /workflows/<slug>/instances → named `<Wf>InstanceListResponse`
    //     wrapper (springdoc inlines `List<<Wf>InstanceResponse>` as a bare
    //     array; retarget it like the aggregate list wrappers);
    //   - GET /workflows/<slug>/instances/{id} → 404 error response;
    //   - `<Wf>InstanceResponse` required set (springdoc marks nothing).
    // The `{id}` path param binds `UUID` on the controller for guid
    // correlation ids, so springdoc emits `{type: string, format: uuid}`
    // matching Hono's `z.string().uuid()` (non-guid ids stay `String`).
    for (const wf of ctx.workflows) {
      if (!wf.instanceWireShape) continue;
      const slug = snake(wf.name);
      const instancesPath = `${routePrefix}/workflows/${slug}/instances`;
      const listWrapper = `${upperFirst(wf.name)}InstanceListResponse`;
      wrappers.set(listWrapper, `${upperFirst(wf.name)}InstanceResponse`);
      routes.push({ method: "get", path: instancesPath, listWrapper, errors: [] });
      routes.push({
        method: "get",
        path: `${instancesPath}/{id}`,
        errors: err(errorStatuses("getById")),
      });
      for (const w of wf.instanceWireShape) noteEnumRefs(w.type, w.name);
      setRequired(
        `${upperFirst(wf.name)}InstanceResponse`,
        requiredWireFields(wf.instanceWireShape),
      );
    }
  }

  // Unambiguous field-name → enum retargets only: a field name mapping to
  // exactly one enum across the whole model (skip ambiguous names for safety).
  const enumProps: EnumProp[] = [...enumFieldTargets.entries()]
    .filter(([, names]) => names.size === 1)
    .map(([property, names]) => ({ property, enumName: [...names][0]! }))
    .sort((a, b) => a.property.localeCompare(b.property));

  return {
    routes,
    wrappers: [...wrappers.entries()].map(([wrapper, element]) => ({ wrapper, element })),
    unions: [...unions.entries()]
      .map(([name, schemaJson]) => ({ name, schemaJson }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    enums: [...referencedEnums.entries()]
      .map(([name, values]) => ({ name, values }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    enumProps,
    emptyRequests,
    required: [...required.entries()]
      .map(([schema, fields]) => ({ schema, fields }))
      .sort((a, b) => a.schema.localeCompare(b.schema)),
  };
}

/** The required-field list for a response/wire component: the id row (always
 *  present → required) plus every non-optional declared/containment/derived
 *  field.  Mirrors the Hono response zod (`z.string()` for id; `.nullish()`
 *  only for optional fields). */
function requiredWireFields(fields: readonly WireField[]): string[] {
  return fields.filter((w) => w.source === "id" || !w.optional).map((w) => w.name);
}

/** Required params for a request DTO: those neither optional-typed nor a bare
 *  body-bool (a non-nullable bool defaults to `false` when omitted, so the
 *  other backends drop it from `required` — see Hono `zodFor`). */
function requiredParams(params: readonly { name: string; type: TypeIR }[]): string[] {
  return params.filter((p) => !isOptionalType(p.type) && !isBareBool(p.type)).map((p) => p.name);
}

function isOptionalType(t: TypeIR): boolean {
  return t.kind === "optional";
}

function isBareBool(t: TypeIR): boolean {
  const base = t.kind === "optional" ? t.inner : t;
  return base.kind === "primitive" && base.name === "bool";
}

/** The enum name a type references, peeling array/optional wrappers; undefined
 *  when the type is not (ultimately) an enum. */
function enumNameOf(t: TypeIR | undefined): string | undefined {
  if (!t) return undefined;
  if (t.kind === "enum") return t.name;
  if (t.kind === "optional") return enumNameOf(t.inner);
  if (t.kind === "array") return enumNameOf(t.element);
  return undefined;
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
    const wrapperRef = r.listWrapper ?? r.successRef;
    const wrapperArg = wrapperRef ? JSON.stringify(wrapperRef) : "null";
    const opIdArg = r.operationId ? JSON.stringify(r.operationId) : "null";
    return `        new Route(${JSON.stringify(r.method)}, ${JSON.stringify(r.path)}, ${wrapperArg}, ${statusArr}, ${opIdArg}),`;
  });
  const wrapperLiterals = contract.wrappers.map(
    (w) => `        new Wrapper(${JSON.stringify(w.wrapper)}, ${JSON.stringify(w.element)}),`,
  );
  const unionLiterals = contract.unions.map(
    (u) =>
      `        new UnionComponent(${JSON.stringify(u.name)}, ${JSON.stringify(u.schemaJson)}),`,
  );
  const enumLiterals = contract.enums.map((e) => {
    const vals = e.values.map((v) => JSON.stringify(v)).join(", ");
    return `        new EnumComponent(${JSON.stringify(e.name)}, List.of(${vals})),`;
  });
  const enumPropLiterals = contract.enumProps.map(
    (p) => `        new EnumProp(${JSON.stringify(p.property)}, ${JSON.stringify(p.enumName)}),`,
  );
  const emptyRequestLiterals = contract.emptyRequests.map(
    (e) => `        new EmptyRequest(${JSON.stringify(e.path)}, ${JSON.stringify(e.schema)}),`,
  );
  const requiredLiterals = contract.required.map((r) => {
    const fields = r.fields.map((f) => JSON.stringify(f)).join(", ");
    return `        new RequiredSet(${JSON.stringify(r.schema)}, List.of(${fields})),`;
  });

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
    `import io.swagger.v3.oas.models.media.IntegerSchema;`,
    `import io.swagger.v3.oas.models.media.MediaType;`,
    `import io.swagger.v3.oas.models.media.ObjectSchema;`,
    `import io.swagger.v3.oas.models.media.Schema;`,
    `import io.swagger.v3.oas.models.media.StringSchema;`,
    `import io.swagger.v3.oas.models.parameters.RequestBody;`,
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
    `    private record Route(String method, String path, String wrapper, int[] statuses, String operationId) {}`,
    `    private record Wrapper(String name, String element) {}`,
    `    private record EnumComponent(String name, List<String> values) {}`,
    `    private record EnumProp(String property, String enumName) {}`,
    `    private record EmptyRequest(String path, String schema) {}`,
    `    private record RequiredSet(String schema, List<String> fields) {}`,
    `    private record UnionComponent(String name, String schemaJson) {}`,
    ``,
    `    private static final List<Wrapper> WRAPPERS = List.of(`,
    ...(wrapperLiterals.length > 0 ? trimTrailingComma(wrapperLiterals) : []),
    `    );`,
    ``,
    `    private static final List<EnumComponent> ENUMS = List.of(`,
    ...(enumLiterals.length > 0 ? trimTrailingComma(enumLiterals) : []),
    `    );`,
    ``,
    `    private static final List<EnumProp> ENUM_PROPS = List.of(`,
    ...(enumPropLiterals.length > 0 ? trimTrailingComma(enumPropLiterals) : []),
    `    );`,
    ``,
    `    private static final List<EmptyRequest> EMPTY_REQUESTS = List.of(`,
    ...(emptyRequestLiterals.length > 0 ? trimTrailingComma(emptyRequestLiterals) : []),
    `    );`,
    ``,
    `    private static final List<RequiredSet> REQUIRED = List.of(`,
    ...(requiredLiterals.length > 0 ? trimTrailingComma(requiredLiterals) : []),
    `    );`,
    ``,
    `    private static final List<UnionComponent> UNIONS = List.of(`,
    ...(unionLiterals.length > 0 ? trimTrailingComma(unionLiterals) : []),
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
    `            registerEnums(openApi);`,
    `            registerUnions(openApi);`,
    `            for (Route route : ROUTES) {`,
    `                PathItem item = openApi.getPaths() == null ? null : openApi.getPaths().get(route.path());`,
    `                if (item == null) continue;`,
    `                Operation op = operationFor(item, route.method());`,
    `                if (op == null) continue;`,
    `                normalizeSuccess(op, route.wrapper());`,
    `                addErrors(op, route.statuses());`,
    `                if (route.operationId() != null) op.setOperationId(route.operationId());`,
    `            }`,
    `            attachEmptyRequests(openApi);`,
    `            retargetEnumProps(openApi);`,
    `            applyRequired(openApi);`,
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
    `                // No body content: nothing to normalize — unless a component`,
    `                // is pinned (a union op's 200), in which case create it.`,
    `                if (wrapper == null) continue;`,
    `                media = new MediaType();`,
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
    `    /** Register the operation-return union components (raw oneOf JSON —`,
    `     *  springdoc never sees the union: the controller returns`,
    `     *  ResponseEntity<?>).  Parsed via swagger-core's Json mapper. */`,
    `    private static void registerUnions(OpenAPI openApi) {`,
    `        Components components = openApi.getComponents();`,
    `        if (components == null) return;`,
    `        for (UnionComponent u : UNIONS) {`,
    `            if (components.getSchemas() != null && components.getSchemas().containsKey(u.name())) continue;`,
    `            try {`,
    `                Schema<?> schema = io.swagger.v3.core.util.Json.mapper().readValue(u.schemaJson(), Schema.class);`,
    `                components.addSchemas(u.name(), schema);`,
    `            } catch (com.fasterxml.jackson.core.JsonProcessingException e) {`,
    `                // Baked at generation time — unreachable for valid output.`,
    `                throw new IllegalStateException("invalid baked union schema for " + u.name(), e);`,
    `            }`,
    `        }`,
    `    }`,
    ``,
    `    /** Register the named string-enum components the other backends publish`,
    `     *  (springdoc inlines an enum-typed field as a bare String). */`,
    `    private static void registerEnums(OpenAPI openApi) {`,
    `        Components components = openApi.getComponents();`,
    `        if (components == null) return;`,
    `        for (EnumComponent e : ENUMS) {`,
    `            if (components.getSchemas() != null && components.getSchemas().containsKey(e.name())) continue;`,
    `            StringSchema schema = new StringSchema();`,
    `            for (String v : e.values()) schema.addEnumItem(v);`,
    `            components.addSchemas(e.name(), schema);`,
    `        }`,
    `    }`,
    ``,
    `    /** Retarget every plain-string property whose name maps unambiguously to`,
    `     *  an enum onto that enum's $ref — across every component schema (the`,
    `     *  other backends reference the named enum, not a bare string). */`,
    `    private static void retargetEnumProps(OpenAPI openApi) {`,
    `        Components components = openApi.getComponents();`,
    `        if (components == null || components.getSchemas() == null) return;`,
    `        Map<String, String> byProp = new java.util.HashMap<>();`,
    `        for (EnumProp p : ENUM_PROPS) byProp.put(p.property(), p.enumName());`,
    `        for (Schema<?> schema : components.getSchemas().values()) {`,
    `            Map<String, Schema> props = schema.getProperties();`,
    `            if (props == null) continue;`,
    `            for (Map.Entry<String, Schema> pe : props.entrySet()) {`,
    `                String enumName = byProp.get(pe.getKey());`,
    `                if (enumName == null) continue;`,
    `                Schema<?> prop = pe.getValue();`,
    `                // Only retarget a currently-plain string-shaped property (the`,
    `                // springdoc inline-enum form — type string, possibly carrying`,
    `                // an inline enum list); leave a collection / already-ref'd /`,
    `                // non-string property untouched.`,
    `                if (prop == null || prop.get$ref() != null) continue;`,
    `                boolean stringShaped = "string".equals(prop.getType())`,
    `                    || (prop.getEnum() != null && !prop.getEnum().isEmpty());`,
    `                if (!stringShaped) continue;`,
    `                pe.setValue(new Schema<>().$ref("#/components/schemas/" + enumName));`,
    `            }`,
    `        }`,
    `    }`,
    ``,
    `    /** Attach an empty-object request body to each param-less public op the`,
    `     *  other backends give a named ` + "`{}`" + ` request schema (springdoc emits`,
    `     *  none for a no-body operation). */`,
    `    private static void attachEmptyRequests(OpenAPI openApi) {`,
    `        Components components = openApi.getComponents();`,
    `        if (components == null) return;`,
    `        for (EmptyRequest e : EMPTY_REQUESTS) {`,
    `            if (components.getSchemas() == null || !components.getSchemas().containsKey(e.schema())) {`,
    `                components.addSchemas(e.schema(), new ObjectSchema());`,
    `            }`,
    `            PathItem item = openApi.getPaths() == null ? null : openApi.getPaths().get(e.path());`,
    `            if (item == null || item.getPost() == null) continue;`,
    `            Operation op = item.getPost();`,
    `            if (op.getRequestBody() != null) continue;`,
    `            Content content = new Content();`,
    `            content.addMediaType(JSON, new MediaType()`,
    `                .schema(new Schema<>().$ref("#/components/schemas/" + e.schema())));`,
    `            op.setRequestBody(new RequestBody().content(content));`,
    `        }`,
    `    }`,
    ``,
    `    /** Mark each component's non-optional fields required, matching the other`,
    `     *  backends (springdoc marks nothing required). */`,
    `    private static void applyRequired(OpenAPI openApi) {`,
    `        Components components = openApi.getComponents();`,
    `        if (components == null || components.getSchemas() == null) return;`,
    `        for (RequiredSet r : REQUIRED) {`,
    `            Schema<?> schema = components.getSchemas().get(r.schema());`,
    `            if (schema == null || r.fields().isEmpty()) continue;`,
    `            schema.setRequired(List.copyOf(r.fields()));`,
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
    `        problem.addProperty("status", new IntegerSchema().format("int32"));`,
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

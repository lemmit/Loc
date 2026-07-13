import type { EnrichedBoundedContextIR, WireField, WorkflowIR } from "../../../ir/types/loom-ir.js";
import {
  camelId,
  opWorkflowInstanceById,
  opWorkflowInstances,
} from "../../../ir/util/openapi-ids.js";
import {
  workflowCorrIdValueType,
  workflowCorrWireField,
} from "../../../ir/util/workflow-instances.js";
import { lines } from "../../../util/code-builder.js";
import { lowerFirst, snake, upperFirst } from "../../../util/naming.js";
import { javaValueTypeForId } from "../render-expr.js";
import { collectWireImports, domainToWire, wireJavaType } from "./wire.js";
import {
  esEventLogTable,
  esWorkflowCorrIdClass,
  esWorkflowStateClass,
} from "./workflow-eventsourced.js";
import { workflowStateClass } from "./workflow-state.js";

// ---------------------------------------------------------------------------
// Read-only workflow-instance endpoints (workflow-instance-visibility.md),
// Java saga slice 3.  For every observable workflow (a correlation-state row +
// enriched `instanceWireShape`) emit an instance Response record and a
// controller exposing `GET /workflows/<snake>/instances` (list) +
// `/instances/{id}` (one by correlation id, 404 if absent) over the persisted
// `<Wf>State` saga row the dispatcher upserts.  The read-side analogue of an
// aggregate's GET list / GET-by-id, mirroring the .NET / python / Hono /
// elixir-vanilla instance reads.  Driven off `instanceWireShape` independently
// of the command route, so an event-triggered-only saga is still observed.
//
// The row is read through the saga-state Spring Data `<Wf>StateRepository`
// (slice 1): `findAll()` for the list, `findById(<Corr>Id)` for one.  Each row
// projects through `instanceWireShape` (the same camelCase wire key the .NET
// `<Wf>InstanceResponse` uses), id → `.value()`, datetime/money ISO-/plain-
// coded exactly like the aggregate `<Agg>Response`.
// ---------------------------------------------------------------------------

export interface WorkflowInstancesCtx {
  basePkg: string;
  /** Instance-response DTO package (application.workflows). */
  pkg: string;
  /** Route prefix ("/api" — the shared API base path). */
  routePrefix?: string;
  /** Saga-state Spring Data repository package (infrastructure.repositories). */
  stateRepoPkg: string;
  /** The workflows' owning-context Postgres schema — qualifies the ES saga
   *  stream in native SQL to match the migration.  Undefined ⇒ unqualified. */
  contextSchema?: string;
}

/** Observable workflows — correlation-bearing sagas the enricher gave an
 *  `instanceWireShape`.  Each gets the read-only instance endpoints. */
export function observableWorkflowsOf(ctx: EnrichedBoundedContextIR): WorkflowIR[] {
  return ctx.workflows.filter((wf) => !!wf.instanceWireShape);
}

/** The saga-state repository field name (`orderFulfillmentStateRepository`). */
function stateRepoField(wf: WorkflowIR): string {
  return `${lowerFirst(wf.name)}StateRepository`;
}

/** The correlation field's wire row (`source: "id"`) — its id targetName +
 *  value type drive the `{id}` path-param type and `new <Corr>Id(id)` wrap.
 *  Shared with the other backends via `ir/util/workflow-instances.ts`. */
const corrWireField = workflowCorrWireField;

export function renderJavaWorkflowInstanceReads(
  ctx: EnrichedBoundedContextIR,
  wctx: WorkflowInstancesCtx,
): Map<string, { category: "workflow-service" | "api-common"; content: string }> | null {
  const observable = observableWorkflowsOf(ctx);
  if (observable.length === 0) return null;
  const out = new Map<string, { category: "workflow-service" | "api-common"; content: string }>();

  for (const wf of observable) {
    out.set(`${upperFirst(wf.name)}InstanceResponse.java`, {
      category: "workflow-service",
      content: renderInstanceResponseDto(wf, wctx),
    });
  }
  out.set(`${ctx.name}WorkflowInstancesController.java`, {
    category: "api-common",
    content: renderInstancesController(ctx, observable, wctx),
  });
  return out;
}

/** The instance Response record — `instanceWireShape` projected to wire types,
 *  the workflow-instance analogue of an aggregate's `<Agg>Response`. */
function renderInstanceResponseDto(wf: WorkflowIR, wctx: WorkflowInstancesCtx): string {
  const shape = wf.instanceWireShape ?? [];
  const wireImports = new Set<string>();
  const components = shape.map((f) => {
    guardInstanceField(wf, f);
    collectWireImports(f.type, wireImports);
    return `${wireJavaType(f.type, "Response")} ${f.name}`;
  });
  return lines(
    `package ${wctx.pkg};`,
    ``,
    ...[...wireImports].sort().map((i) => `import ${i};`),
    wireImports.size > 0 ? `` : null,
    `import ${wctx.basePkg}.domain.enums.*;`,
    `import ${wctx.basePkg}.domain.ids.*;`,
    `import ${wctx.basePkg}.domain.valueobjects.*;`,
    ``,
    `public record ${upperFirst(wf.name)}InstanceResponse(${components.join(", ")}) {`,
    `}`,
    ``,
  );
}

/** One controller per context exposing every observable workflow's instances
 *  as `GET workflows/<snake>/instances` + `.../instances/{id}`, reading the
 *  saga-state via its Spring Data repository and projecting each row through
 *  `instanceWireShape`. */
function renderInstancesController(
  ctx: EnrichedBoundedContextIR,
  workflows: WorkflowIR[],
  wctx: WorkflowInstancesCtx,
): string {
  const className = `${ctx.name}WorkflowInstancesController`;
  const anyUuid = workflows.some(
    (wf) => javaValueTypeForId(workflowCorrIdValueType(wf)) === "UUID",
  );
  const stateWfs = workflows.filter((wf) => !wf.eventSourced);
  const esWfs = workflows.filter((wf) => wf.eventSourced);
  // ES instance reads fold the `<wf>_events` stream over a shared JdbcTemplate
  // (no mutable state repo); needs `ArrayList` for the fold accumulator.
  const esPresent = esWfs.length > 0;

  const routes: string[] = [];
  for (const wf of workflows) {
    const T = `${upperFirst(wf.name)}InstanceResponse`;
    const slug = snake(wf.name);
    const corr = corrWireField(wf);
    const idJava = javaValueTypeForId(workflowCorrIdValueType(wf));
    // The `{id}` param binds the correlation id's Java value type (UUID / int /
    // long / String), so springdoc emits the matching param schema — guid →
    // `{type: string, format: uuid}`, int/long → integer — parity with Hono /
    // .NET / Python / Phoenix by construction
    // (docs/old/plans/non-guid-id-http-params.md).
    const paramJava = idJava;
    const idExpr = "id";
    const shape = wf.instanceWireShape ?? [];
    const proj = (rowVar: string): string =>
      shape.map((f) => domainToWire(f.type, `${rowVar}.${f.name}()`)).join(", ");
    // The read body diverges on `wf.eventSourced`: a state-based saga reads its
    // `<Wf>State` Spring Data repository, while an event-sourced workflow folds
    // the per-correlation `<wf>_events` stream — LIST loads every event row
    // ordered by (stream_id, version), groups by stream_id, folds each via
    // `_fromEvents` (mirroring the ES-aggregate group-fold); byId loads one
    // stream + folds it (404 on an empty stream).  The folded `<Wf>State`
    // exposes record-style accessors, so projection / operationIds / paths stay
    // identical to the state path.
    if (wf.eventSourced) {
      const cls = esWorkflowStateClass(wf);
      const corrId = esWorkflowCorrIdClass(wf);
      // The single per-context event log; this workflow's instances are the
      // rows tagged `stream_type = "<Wf>"`.
      const table = esEventLogTable(ctx.name, wctx.contextSchema);
      const streamType = wf.name;
      routes.push(
        `    @GetMapping("/${slug}/instances")`,
        `    public List<${T}> ${camelId(opWorkflowInstances(wf.name))}() {`,
        `        var __rows = jdbc.queryForList(`,
        `            "select stream_id, type, data from ${table} where stream_type = ? order by stream_id, version", "${streamType}");`,
        `        var __byStream = new LinkedHashMap<String, List<DomainEvent>>();`,
        `        for (var __r : __rows) {`,
        `            var __sid = (String) __r.get("stream_id");`,
        `            __byStream.computeIfAbsent(__sid, __k -> new ArrayList<>())`,
        `                .add(${cls}._rowToEvent((String) __r.get("type"), String.valueOf(__r.get("data"))));`,
        `        }`,
        `        return __byStream.entrySet().stream()`,
        `            .map(__e -> ${cls}._fromEvents(new ${corrId}(${idFromString("__e.getKey()", idJava)}), __e.getValue()))`,
        `            .map(x -> new ${T}(${proj("x")}))`,
        `            .toList();`,
        `    }`,
        ``,
        `    @GetMapping("/${slug}/instances/{id}")`,
        `    public ResponseEntity<${T}> ${camelId(opWorkflowInstanceById(wf.name))}(@PathVariable ${paramJava} id) {`,
        `        var __sid = ${idJava === "String" ? "id" : "String.valueOf(id)"};`,
        `        var __rows = jdbc.queryForList(`,
        `            "select type, data from ${table} where stream_type = ? and stream_id = ? order by version", "${streamType}", __sid);`,
        `        if (__rows.isEmpty()) return ResponseEntity.notFound().build();`,
        `        var __loaded = new ArrayList<DomainEvent>();`,
        `        for (var __r : __rows) __loaded.add(${cls}._rowToEvent((String) __r.get("type"), String.valueOf(__r.get("data"))));`,
        `        var x = ${cls}._fromEvents(new ${corrId}(${idExpr}), __loaded);`,
        `        return ResponseEntity.ok(new ${T}(${proj("x")}));`,
        `    }`,
        ``,
      );
    } else {
      const repo = stateRepoField(wf);
      const idClass = `${idTargetName(corr)}Id`;
      routes.push(
        `    @GetMapping("/${slug}/instances")`,
        `    public List<${T}> ${camelId(opWorkflowInstances(wf.name))}() {`,
        `        return ${repo}.findAll().stream()`,
        `            .map(x -> new ${T}(${proj("x")}))`,
        `            .toList();`,
        `    }`,
        ``,
        `    @GetMapping("/${slug}/instances/{id}")`,
        `    public ResponseEntity<${T}> ${camelId(opWorkflowInstanceById(wf.name))}(@PathVariable ${paramJava} id) {`,
        `        return ${repo}.findById(new ${idClass}(${idExpr}))`,
        `            .map(x -> ResponseEntity.ok(new ${T}(${proj("x")})))`,
        `            .orElse(ResponseEntity.notFound().build());`,
        `    }`,
        ``,
      );
    }
  }
  while (routes[routes.length - 1] === "") routes.pop();

  // Injected fields / ctor: a Spring Data repo per state-based saga + a single
  // shared JdbcTemplate when any ES workflow folds its stream.
  const repoFields = stateWfs.map(
    (wf) => `    private final ${workflowStateClass(wf)}Repository ${stateRepoField(wf)};`,
  );
  const fieldDecls = [
    ...repoFields,
    ...(esPresent ? [`    private final JdbcTemplate jdbc;`] : []),
  ];
  const ctorParams = [
    ...stateWfs.map((wf) => `${workflowStateClass(wf)}Repository ${stateRepoField(wf)}`),
    ...(esPresent ? ["JdbcTemplate jdbc"] : []),
  ].join(", ");
  const ctorAssigns = [
    ...stateWfs.map((wf) => `        this.${stateRepoField(wf)} = ${stateRepoField(wf)};`),
    ...(esPresent ? ["        this.jdbc = jdbc;"] : []),
  ];

  return lines(
    `package ${wctx.basePkg}.api;`,
    ``,
    esPresent ? `import java.util.ArrayList;` : null,
    `import java.util.List;`,
    esPresent ? `import java.util.LinkedHashMap;` : null,
    anyUuid ? `import java.util.UUID;` : null,
    ``,
    `import org.springframework.http.ResponseEntity;`,
    esPresent ? `import org.springframework.jdbc.core.JdbcTemplate;` : null,
    `import org.springframework.web.bind.annotation.*;`,
    ``,
    `import ${wctx.pkg}.*;`,
    stateWfs.length > 0 ? `import ${wctx.stateRepoPkg}.*;` : null,
    esPresent ? `import ${wctx.basePkg}.domain.events.*;` : null,
    `import ${wctx.basePkg}.domain.ids.*;`,
    ``,
    `@RestController`,
    `@RequestMapping("${wctx.routePrefix ?? ""}/workflows")`,
    `public class ${className} {`,
    ...fieldDecls,
    ``,
    `    public ${className}(${ctorParams}) {`,
    ...ctorAssigns,
    `    }`,
    ``,
    ...routes,
    `}`,
    ``,
  );
}

/** Convert a stream_id `String` back to the correlation id's value type so a
 *  folded ES instance can wrap it in `new <Corr>Id(...)`.  The stream_id column
 *  stores `String.valueOf(key.value())`, so the inverse depends on the value
 *  type (UUID → `UUID.fromString`, numeric → parse, string → identity). */
function idFromString(expr: string, idJava: string): string {
  switch (idJava) {
    case "UUID":
      return `UUID.fromString(${expr})`;
    case "int":
      return `Integer.parseInt(${expr})`;
    case "long":
      return `Long.parseLong(${expr})`;
    default:
      return expr;
  }
}

function idTargetName(f: WireField): string {
  const t = f.type.kind === "optional" ? f.type.inner : f.type;
  if (t.kind !== "id")
    throw new Error("java workflow-instances: correlation field must be id-typed");
  return t.targetName;
}

/** Instance projection rides the three domain wildcards (enums / ids /
 *  valueobjects); a VO- or entity-typed saga-state field would need a
 *  `<Vo>Response` / `<Part>Response` DTO that doesn't live in those packages.
 *  Saga state is scalars / ids / enums in practice — flag the unsupported
 *  shapes explicitly rather than emit a non-compiling import (the views
 *  emitter guards cross-aggregate follows the same way). */
function guardInstanceField(wf: WorkflowIR, f: WireField): void {
  const t = f.type.kind === "optional" ? f.type.inner : f.type;
  const leaf =
    t.kind === "array" ? (t.element.kind === "optional" ? t.element.inner : t.element) : t;
  if (leaf.kind === "valueobject" || leaf.kind === "entity") {
    throw new Error(
      `java workflow-instances: instance field '${f.name}' of '${wf.name}' is ${leaf.kind}-typed — not yet supported on the java backend.`,
    );
  }
}

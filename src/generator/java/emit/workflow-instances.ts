import type { EnrichedBoundedContextIR, WireField, WorkflowIR } from "../../../ir/types/loom-ir.js";
import {
  camelId,
  opWorkflowInstanceById,
  opWorkflowInstances,
} from "../../../ir/util/openapi-ids.js";
import { lines } from "../../../util/code-builder.js";
import { lowerFirst, snake, upperFirst } from "../../../util/naming.js";
import { javaValueTypeForId } from "../render-expr.js";
import { collectWireImports, domainToWire, wireJavaType } from "./wire.js";
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
 *  value type drive the `{id}` path-param type and `new <Corr>Id(id)` wrap. */
function corrWireField(wf: WorkflowIR): WireField {
  const corr = (wf.instanceWireShape ?? []).find((f) => f.source === "id");
  if (!corr) {
    throw new Error(`java workflow-instances: '${wf.name}' has no id-shaped instance field`);
  }
  return corr;
}

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
    (wf) => javaValueTypeForId(idValueType(corrWireField(wf))) === "UUID",
  );

  const routes: string[] = [];
  for (const wf of workflows) {
    const T = `${upperFirst(wf.name)}InstanceResponse`;
    const slug = snake(wf.name);
    const repo = stateRepoField(wf);
    const corr = corrWireField(wf);
    const idClass = `${idTargetName(corr)}Id`;
    const idJava = javaValueTypeForId(idValueType(corr));
    const shape = wf.instanceWireShape ?? [];
    const proj = (rowVar: string): string =>
      shape.map((f) => domainToWire(f.type, `${rowVar}.${f.name}()`)).join(", ");
    routes.push(
      `    @GetMapping("/${slug}/instances")`,
      `    public List<${T}> ${camelId(opWorkflowInstances(wf.name))}() {`,
      `        return ${repo}.findAll().stream()`,
      `            .map(x -> new ${T}(${proj("x")}))`,
      `            .toList();`,
      `    }`,
      ``,
      `    @GetMapping("/${slug}/instances/{id}")`,
      `    public ResponseEntity<${T}> ${camelId(opWorkflowInstanceById(wf.name))}(@PathVariable ${idJava} id) {`,
      `        return ${repo}.findById(new ${idClass}(id))`,
      `            .map(x -> ResponseEntity.ok(new ${T}(${proj("x")})))`,
      `            .orElse(ResponseEntity.notFound().build());`,
      `    }`,
      ``,
    );
  }
  while (routes[routes.length - 1] === "") routes.pop();

  const repoFields = workflows.map(
    (wf) => `    private final ${workflowStateClass(wf)}Repository ${stateRepoField(wf)};`,
  );
  const ctorParams = workflows
    .map((wf) => `${workflowStateClass(wf)}Repository ${stateRepoField(wf)}`)
    .join(", ");
  const ctorAssigns = workflows.map(
    (wf) => `        this.${stateRepoField(wf)} = ${stateRepoField(wf)};`,
  );

  return lines(
    `package ${wctx.basePkg}.api;`,
    ``,
    `import java.util.List;`,
    anyUuid ? `import java.util.UUID;` : null,
    ``,
    `import org.springframework.http.ResponseEntity;`,
    `import org.springframework.web.bind.annotation.*;`,
    ``,
    `import ${wctx.pkg}.*;`,
    `import ${wctx.stateRepoPkg}.*;`,
    `import ${wctx.basePkg}.domain.ids.*;`,
    ``,
    `@RestController`,
    `@RequestMapping("${wctx.routePrefix ?? ""}/workflows")`,
    `public class ${className} {`,
    ...repoFields,
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

function idTargetName(f: WireField): string {
  const t = f.type.kind === "optional" ? f.type.inner : f.type;
  if (t.kind !== "id")
    throw new Error("java workflow-instances: correlation field must be id-typed");
  return t.targetName;
}

function idValueType(f: WireField): string {
  const t = f.type.kind === "optional" ? f.type.inner : f.type;
  return t.kind === "id" ? t.valueType : "guid";
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

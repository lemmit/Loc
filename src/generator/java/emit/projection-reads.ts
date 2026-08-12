import type {
  EnrichedBoundedContextIR,
  ProjectionIR,
  WireField,
} from "../../../ir/types/loom-ir.js";
import { exprUsesCurrentUser, isMaterializedProjection } from "../../../ir/types/loom-ir.js";
import { lines } from "../../../util/code-builder.js";
import { lowerFirst, snake, upperFirst } from "../../../util/naming.js";
import { collectJavaExprImports, javaValueTypeForId, renderJavaExpr } from "../render-expr.js";
import { projectionCorrIdClass } from "./projection-state.js";
import { collectWireImports, domainToWire, wireJavaType } from "./wire.js";

// ---------------------------------------------------------------------------
// Read-only projection endpoints (projection.md), the Java read half.  For
// every projection emit a `<Proj>Response` record and one per-context controller
// exposing `GET /projections/<snake>` (list) + `/projections/<snake>/{key}` (one
// by correlation id, 404 if absent) over the persisted `<Proj>Row` read-model
// row the dispatcher fold upserts.  The read-side analogue of a workflow's
// instance reads (`workflow-instances.ts`), mirroring the shipped Hono / Python
// projection routes.
//
// The row is read through the Spring Data `<Proj>RowRepository`:
// `findAll()` for the list, `findById(new <Corr>Id(key))` for one.  Each row
// projects through the projection's `wireShape` (correlation field as an id
// token, then the state fields), id → `.value()`, datetime/money coded exactly
// like the aggregate `<Agg>Response`.
// ---------------------------------------------------------------------------

export interface ProjectionReadsCtx {
  basePkg: string;
  /** Response-DTO package (application.workflows — shared with instance reads). */
  pkg: string;
  /** Route prefix ("/api" — the shared API base path). */
  routePrefix?: string;
  /** Read-model row Spring Data repository package (infrastructure.repositories). */
  rowRepoPkg: string;
}

/** The read-model row repository field name (`orderBookRowRepository`). */
export function projectionRepoField(proj: ProjectionIR): string {
  return `${lowerFirst(proj.name)}RowRepository`;
}

export function renderJavaProjectionReads(
  ctx: EnrichedBoundedContextIR,
  pctx: ProjectionReadsCtx,
): Map<string, { category: "workflow-service" | "api-common"; content: string }> | null {
  // FOLDED (materialized) projections only — the event-folded read model with a
  // physical `<Proj>Row` table.  Query-time projections (read-path-architecture.md
  // rev.13) have no read-model row; they are served by
  // `renderJavaQueryProjections` instead.
  const folded = ctx.projections.filter(isMaterializedProjection);
  if (folded.length === 0) return null;
  const out = new Map<string, { category: "workflow-service" | "api-common"; content: string }>();

  for (const proj of folded) {
    out.set(`${upperFirst(proj.name)}Response.java`, {
      category: "workflow-service",
      content: renderProjectionResponseDto(proj, pctx),
    });
  }
  out.set(`${ctx.name}ProjectionsController.java`, {
    category: "api-common",
    content: renderProjectionsController(ctx, pctx),
  });
  return out;
}

/** The projection Response record — `wireShape` projected to wire types, the
 *  read-model analogue of a workflow instance's `<Wf>InstanceResponse`. */
function renderProjectionResponseDto(proj: ProjectionIR, pctx: ProjectionReadsCtx): string {
  const shape = proj.wireShape ?? [];
  const wireImports = new Set<string>();
  const components = shape.map((f) => {
    guardProjectionField(proj, f);
    collectWireImports(f.type, wireImports);
    return `${wireJavaType(f.type, "Response")} ${f.name}`;
  });
  return lines(
    `package ${pctx.pkg};`,
    ``,
    ...[...wireImports].sort().map((i) => `import ${i};`),
    wireImports.size > 0 ? `` : null,
    `import ${pctx.basePkg}.domain.enums.*;`,
    `import ${pctx.basePkg}.domain.ids.*;`,
    `import ${pctx.basePkg}.domain.valueobjects.*;`,
    ``,
    `public record ${upperFirst(proj.name)}Response(${components.join(", ")}) {`,
    `}`,
    ``,
  );
}

/** One controller per context exposing every projection's read model as
 *  `GET projections/<snake>` + `.../<snake>/{key}`, reading the read-model row
 *  via its Spring Data repository and projecting each row through `wireShape`. */
function renderProjectionsController(
  ctx: EnrichedBoundedContextIR,
  pctx: ProjectionReadsCtx,
): string {
  const className = `${ctx.name}ProjectionsController`;
  const folded = ctx.projections.filter(isMaterializedProjection);
  const corrValueType = (proj: ProjectionIR): string => {
    const t = corrWire(proj).type;
    const inner = t.kind === "optional" ? t.inner : t;
    if (inner.kind !== "id") {
      throw new Error(`java projection-reads: correlation of '${proj.name}' must be id-typed`);
    }
    return javaValueTypeForId(inner.valueType);
  };
  const anyUuid = folded.some((p) => corrValueType(p) === "UUID");

  const routes: string[] = [];
  // The `requires` gate — the folded read model's twin of the query-time
  // projection gate in `query-projection-reads.ts`: bind the principal (only
  // when the predicate reads it), then 403 BEFORE the read.  Collected across
  // projections because the import set and the accessor injection are
  // controller-wide decisions.
  const gateImports = new Set<string>();
  let anyGate = false;
  let anyGateUsesUser = false;
  for (const proj of folded) {
    const g = proj.query?.requires;
    if (!g) continue;
    anyGate = true;
    collectJavaExprImports(g, gateImports);
    if (exprUsesCurrentUser(g)) anyGateUsesUser = true;
  }
  const gateLines = (proj: ProjectionIR): string[] => {
    const g = proj.query?.requires;
    if (!g) return [];
    const gl: string[] = [];
    if (exprUsesCurrentUser(g)) gl.push(`        var currentUser = currentUserAccessor.user();`);
    gl.push(
      `        if (!(${renderJavaExpr(g, { thisName: "this" })})) throw new ForbiddenException(${JSON.stringify(
        `Forbidden: projection ${proj.name}`,
      )});`,
    );
    return gl;
  };
  for (const proj of folded) {
    const T = `${upperFirst(proj.name)}Response`;
    const slug = snake(proj.name);
    const repo = projectionRepoField(proj);
    const idClass = projectionCorrIdClass(proj);
    // The `{key}` param binds the correlation id's Java value type (UUID / int /
    // long / String), so springdoc emits the matching param schema — parity with
    // Hono / Python by construction (non-guid-id-http-params.md).
    const paramJava = corrValueType(proj);
    const shape = proj.wireShape ?? [];
    const projRow = (rowVar: string): string =>
      shape.map((f) => domainToWire(f.type, `${rowVar}.${f.name}()`)).join(", ");
    routes.push(
      `    @GetMapping("/${slug}")`,
      `    public List<${T}> list${upperFirst(proj.name)}() {`,
      ...gateLines(proj),
      `        return ${repo}.findAll().stream()`,
      `            .map(x -> new ${T}(${projRow("x")}))`,
      `            .toList();`,
      `    }`,
      ``,
      `    @GetMapping("/${slug}/{key}")`,
      `    public ResponseEntity<${T}> get${upperFirst(proj.name)}(@PathVariable ${paramJava} key) {`,
      // Gate before the lookup: a caller who fails it must not learn whether
      // the key exists.
      ...gateLines(proj),
      `        return ${repo}.findById(new ${idClass}(key))`,
      `            .map(x -> ResponseEntity.ok(new ${T}(${projRow("x")})))`,
      `            .orElse(ResponseEntity.notFound().build());`,
      `    }`,
      ``,
    );
  }
  while (routes[routes.length - 1] === "") routes.pop();

  const fieldDecls = [
    ...folded.map(
      (p) => `    private final ${upperFirst(p.name)}RowRepository ${projectionRepoField(p)};`,
    ),
    ...(anyGateUsesUser ? [`    private final CurrentUserAccessor currentUserAccessor;`] : []),
  ];
  const ctorParams = [
    ...folded.map((p) => `${upperFirst(p.name)}RowRepository ${projectionRepoField(p)}`),
    ...(anyGateUsesUser ? [`CurrentUserAccessor currentUserAccessor`] : []),
  ].join(", ");
  const ctorAssigns = [
    ...folded.map((p) => `        this.${projectionRepoField(p)} = ${projectionRepoField(p)};`),
    ...(anyGateUsesUser ? [`        this.currentUserAccessor = currentUserAccessor;`] : []),
  ];

  return lines(
    `package ${pctx.basePkg}.api;`,
    ``,
    `import java.util.List;`,
    anyUuid ? `import java.util.UUID;` : null,
    ``,
    `import org.springframework.http.ResponseEntity;`,
    `import org.springframework.web.bind.annotation.*;`,
    ``,
    ...[...gateImports].sort().map((i) => `import ${i};`),
    gateImports.size > 0 ? `` : null,
    `import ${pctx.pkg}.*;`,
    `import ${pctx.rowRepoPkg}.*;`,
    anyGate ? `import ${pctx.basePkg}.domain.common.ForbiddenException;` : null,
    anyGateUsesUser ? `import ${pctx.basePkg}.auth.CurrentUserAccessor;` : null,
    `import ${pctx.basePkg}.domain.ids.*;`,
    ``,
    `@RestController`,
    `@RequestMapping("${pctx.routePrefix ?? ""}/projections")`,
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

/** The correlation field's wire row (`source: "id"`, always first). */
function corrWire(proj: ProjectionIR): WireField {
  const shape = proj.wireShape ?? [];
  const f = shape.find((w) => w.source === "id");
  if (!f) throw new Error(`java projection-reads: '${proj.name}' has no id-source wire field`);
  return f;
}

/** A VO-typed read-model row field projects through its `<Vo>Response` record,
 *  co-located in `application.workflows` by `renderReadModelVoResponseDtos`
 *  (`domainToWire` emits `<Vo>Response.from(...)`).  An entity (containment
 *  part) type would need a `<Part>Response` DTO — but a part type never
 *  resolves in projection scope, so this arm is an unreachable backstop
 *  mirrored by the `loom.java-projection-field-unsupported` validator gate. */
function guardProjectionField(proj: ProjectionIR, f: WireField): void {
  const t = f.type.kind === "optional" ? f.type.inner : f.type;
  const leaf =
    t.kind === "array" ? (t.element.kind === "optional" ? t.element.inner : t.element) : t;
  if (leaf.kind === "entity") {
    throw new Error(
      `java projection-reads: row field '${f.name}' of '${proj.name}' is entity-typed — not yet supported on the java backend.`,
    );
  }
}

import type { EnrichedBoundedContextIR, ExprIR, ProjectionIR } from "../../../ir/types/loom-ir.js";
import { isQueryTimeProjection } from "../../../ir/types/loom-ir.js";
import { lines } from "../../../util/code-builder.js";
import { lowerFirst, plural, snake, upperFirst } from "../../../util/naming.js";
import { collectJavaExprImports, renderJavaExpr } from "../render-expr.js";
import { collectWireImports, domainToWire, wireJavaType } from "./wire.js";

// ---------------------------------------------------------------------------
// Query-time projections (read-path-architecture.md rev.13) — the Java port.
//
// A query-time projection (`projection X { from <Agg> [as a] where … join …
// select … }`, no `on(e)` folds) is the always-current read model of the
// query-time projection read.  It reads live: the source find rides a synthesized
// parameterless repository find (`queryProjectionFindsFor`),
// each `join <Agg> as a on <idRef>` bulk-loads the followed
// aggregate through its own (tenancy-scoped) `findAll()` into a
// `Map<idValue, Agg>` keyed by `.id().value()` (Java has no lazy JPA assoc for
// an `X id` FK, so the follow is an explicit map load — the analogue of Hono
// `findManyByIds` / Python `find_many_by_ids` / the Elixir bulk-load map), and
// each `select f = <expr>` projects one row.  A `select` that reads a join
// alias (`c.name`) rewrites to `<mapVar>.get(<key>).name()`.
//
// One `<Ctx>QueryProjections` @Service + a `<Ctx>QueryProjectionsController`
// exposing `GET /projections/<slug>` per projection (sibling of the folded
// `<Ctx>ProjectionsController` at the same prefix; distinct projection names ⇒
// distinct slugs ⇒ no route collision).  Only backends in
// `PROJECTION_QT_SUPPORTED` are permitted a query-time projection by the IR
// validator; java joins node/python/elixir here.
// ---------------------------------------------------------------------------

/** Query-time projections sourced from `agg`, as synthesized parameterless
 *  finds the repository emitters pick up (name = lowerFirst(projection name)) —
 *  the `viewFindsFor` analogue, so the source read shares the JPQL find path. */
export function queryProjectionFindsFor(
  aggName: string,
  ctx: EnrichedBoundedContextIR,
): {
  name: string;
  params: never[];
  returnType: { kind: "array"; element: { kind: "entity"; name: string } };
  filter?: ExprIR;
}[] {
  return (ctx.projections ?? [])
    .filter((p) => isQueryTimeProjection(p) && p.query?.source === aggName)
    .map((p) => ({
      name: lowerFirst(p.name),
      params: [] as never[],
      returnType: { kind: "array" as const, element: { kind: "entity" as const, name: aggName } },
      ...(p.query?.filter ? { filter: p.query.filter } : {}),
    }));
}

export interface QueryProjectionCtx {
  basePkg: string;
  /** Shared reads package (`<base>.application.views`) — the query-projection reads. */
  pkg: string;
  /** Route prefix ("/api" in fullstack mode). */
  routePrefix?: string;
  entityPkgOf: (aggName: string) => string;
  repoPkgOf: (aggName: string) => string;
}

interface JoinMap {
  mapVar: string;
  /** The source-row key expression yielding this alias's id value. */
  keyExpr: string;
}

export function renderJavaQueryProjections(
  ctx: EnrichedBoundedContextIR,
  qpctx: QueryProjectionCtx,
): Map<string, { category: "view-service" | "api-common"; content: string }> | null {
  const projections = (ctx.projections ?? []).filter(isQueryTimeProjection);
  if (projections.length === 0) return null;

  const out = new Map<string, { category: "view-service" | "api-common"; content: string }>();
  const imports = new Set<string>(["java.util.List"]);
  const explicitImports = new Set<string>();
  const methods: string[] = [];
  const repoAggs = new Set<string>();
  const routes: string[] = [];

  for (const proj of projections) {
    const source = proj.query!.source!;
    repoAggs.add(source);
    const findName = lowerFirst(proj.name);
    const rowName = `${upperFirst(proj.name)}Row`;
    const shape = proj.wireShape ?? [];

    // Row record from the projection's wire shape.
    const rowImports = new Set<string>();
    const components = shape.map((f) => {
      collectWireImports(f.type, rowImports);
      return `${wireJavaType(f.type, "Response")} ${f.name}`;
    });
    out.set(`${rowName}.java`, {
      category: "view-service",
      content: lines(
        `package ${qpctx.pkg};`,
        ``,
        ...[...rowImports].sort().map((i) => `import ${i};`),
        rowImports.size > 0 ? `` : null,
        `import ${qpctx.basePkg}.domain.enums.*;`,
        `import ${qpctx.basePkg}.domain.ids.*;`,
        `import ${qpctx.basePkg}.domain.valueobjects.*;`,
        ``,
        `public record ${rowName}(${components.join(", ")}) {`,
        `}`,
        ``,
      ),
    });

    // Each `join <Agg> as c on <idRef>` → a `Map<idValue, Agg>` loaded via the
    // followed aggregate's own tenancy-scoped `findAll()`.  The alias binds to
    // that map + the source-row key expression the join keys on.
    const aliasMap = new Map<string, JoinMap>();
    const aggMapVar = new Map<string, string>();
    const mapLines: string[] = [];
    const joins = proj.query!.joins;
    for (const join of joins) {
      repoAggs.add(join.aggregate);
      let mapVar = aggMapVar.get(join.aggregate);
      if (!mapVar) {
        mapVar = `${lowerFirst(join.aggregate)}ById`;
        aggMapVar.set(join.aggregate, mapVar);
        imports.add("java.util.Map");
        imports.add("java.util.stream.Collectors");
        mapLines.push(
          `        var ${mapVar} = ${repoField(join.aggregate)}.findAll().stream()`,
          `            .collect(Collectors.toMap(__a -> __a.id().value(), __a -> __a));`,
        );
      }
      // The join keys on `<idRef>` rendered off the source row `a`, then `.value()`
      // to reach the raw FK the map is keyed by.
      const keyExpr = `${renderJavaExpr(join.idRef, { thisName: "a", accessorProps: true })}.value()`;
      aliasMap.set(join.alias, { mapVar, keyExpr });
    }

    // Project each row through the `select` expressions, keyed by wire field.
    const selectByField = new Map((proj.query!.selects ?? []).map((s) => [s.field, s] as const));
    const args = shape.map((f) => {
      const sel = selectByField.get(f.name);
      if (!sel) return `null`;
      collectJavaExprImports(sel.expr, imports);
      return domainToWire(f.type, renderSelect(sel.expr, aliasMap));
    });

    methods.push(
      `    public List<${rowName}> ${findName}() {`,
      ...mapLines,
      `        return ${repoField(source)}.${findName}().stream()`,
      `            .map(a -> new ${rowName}(${args.join(", ")}))`,
      `            .toList();`,
      `    }`,
      ``,
    );
    routes.push(
      `    @GetMapping("/${snake(proj.name)}")`,
      `    public List<${rowName}> ${findName}() {`,
      `        return queryProjections.${findName}();`,
      `    }`,
      ``,
    );
  }
  while (methods[methods.length - 1] === "") methods.pop();
  while (routes[routes.length - 1] === "") routes.pop();

  const repoFields = [...repoAggs].sort();
  const serviceName = `${ctx.name}QueryProjections`;
  for (const a of repoFields) {
    if (qpctx.repoPkgOf(a) !== qpctx.pkg)
      explicitImports.add(`${qpctx.repoPkgOf(a)}.${a}Repository`);
    if (qpctx.entityPkgOf(a) !== qpctx.pkg) explicitImports.add(`${qpctx.entityPkgOf(a)}.${a}`);
  }

  out.set(`${serviceName}.java`, {
    category: "view-service",
    content: lines(
      `package ${qpctx.pkg};`,
      ``,
      ...[...imports].sort().map((i) => `import ${i};`),
      ``,
      `import org.springframework.stereotype.Service;`,
      `import org.springframework.transaction.annotation.Transactional;`,
      ``,
      ...[...explicitImports].sort().map((i) => `import ${i};`),
      `import ${qpctx.basePkg}.domain.enums.*;`,
      `import ${qpctx.basePkg}.domain.ids.*;`,
      `import ${qpctx.basePkg}.domain.valueobjects.*;`,
      ``,
      `@Service`,
      `@Transactional(readOnly = true)`,
      `public class ${serviceName} {`,
      ...repoFields.map((a) => `    private final ${a}Repository ${repoField(a)};`),
      ``,
      `    public ${serviceName}(${repoFields
        .map((a) => `${a}Repository ${repoField(a)}`)
        .join(", ")}) {`,
      ...repoFields.map((a) => `        this.${repoField(a)} = ${repoField(a)};`),
      `    }`,
      ``,
      ...methods,
      `}`,
      ``,
    ),
  });

  out.set(`${ctx.name}QueryProjectionsController.java`, {
    category: "api-common",
    content: lines(
      `package ${qpctx.basePkg}.api;`,
      ``,
      `import java.util.List;`,
      ``,
      `import org.springframework.web.bind.annotation.*;`,
      ``,
      `import ${qpctx.pkg}.*;`,
      ``,
      `@RestController`,
      `@RequestMapping("${qpctx.routePrefix ?? ""}/projections")`,
      `public class ${ctx.name}QueryProjectionsController {`,
      `    private final ${serviceName} queryProjections;`,
      ``,
      `    public ${ctx.name}QueryProjectionsController(${serviceName} queryProjections) {`,
      `        this.queryProjections = queryProjections;`,
      `    }`,
      ``,
      ...routes,
      `}`,
      ``,
    ),
  });

  return out;
}

/** Render a `select` expression against the source row `a` and the join alias
 *  maps.  A member read on a join alias (`c.name`) rewrites to
 *  `<mapVar>.get(<key>).name()` — the loaded-by-id aggregate for this row.
 *  Source-candidate reads (`o.id`, bare `lineCount`) render off `a`. */
function renderSelect(expr: ExprIR, aliasMap: Map<string, JoinMap>): string {
  if (expr.kind === "member" && expr.receiver.kind === "ref") {
    const alias = aliasMap.get(expr.receiver.name);
    if (alias) return `${alias.mapVar}.get(${alias.keyExpr}).${expr.member}()`;
  }
  return renderJavaExpr(expr, { thisName: "a", accessorProps: true });
}

function repoField(aggName: string): string {
  return `${lowerFirst(plural(aggName))}Repository`;
}

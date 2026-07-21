import { forApiRead, wireFieldsFor } from "../../../ir/enrich/wire-projection.js";
import type {
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  ExprIR,
  ProjectionIR,
  TypeIR,
  WorkflowIR,
} from "../../../ir/types/loom-ir.js";
import { exprUsesCurrentUser, isQueryTimeProjection } from "../../../ir/types/loom-ir.js";
import { lines } from "../../../util/code-builder.js";
import { lowerFirst, plural, snake, upperFirst } from "../../../util/naming.js";
import { collectJavaExprImports, renderJavaExpr } from "../render-expr.js";
import { projectionRepoField } from "./projection-reads.js";
import { projectionRowClass } from "./projection-state.js";
import { collectWireImports, domainToWire, wireJavaType } from "./wire.js";
import { workflowStateClass } from "./workflow-state.js";

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
  bypassAll?: boolean;
  bypassCaps?: string[];
}[] {
  return (ctx.projections ?? [])
    .filter((p) => isQueryTimeProjection(p) && p.query?.source === aggName)
    .map((p) => ({
      name: lowerFirst(p.name),
      params: [] as never[],
      returnType: { kind: "array" as const, element: { kind: "entity" as const, name: aggName } },
      ...(p.query?.filter ? { filter: p.query.filter } : {}),
      ...(p.query?.bypassAll ? { bypassAll: true } : {}),
      ...(p.query?.bypassCaps ? { bypassCaps: p.query.bypassCaps } : {}),
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
  /** Saga-state / read-model Spring Data repository package
   *  (infrastructure.repositories) — where a `from <Workflow>`-sourced
   *  projection reads the `<Wf>StateRepository`, and a `from <Projection>`-sourced
   *  projection reads the source folded projection's `<Src>RowRepository`. */
  stateRepoPkg: string;
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
  // Workflows whose persisted saga-state repository a `from <Workflow>`-sourced
  // projection reads (NON-event-sourced, observable — guaranteed by the IR
  // validator).  Injected alongside the aggregate repositories.
  const stateRepoWfs = new Set<WorkflowIR>();
  // Source folded projections whose persisted read-model repository a
  // `from <Projection>`-sourced projection reads (`<Src>RowRepository.findAll()`).
  // Injected alongside the aggregate / saga-state repositories.
  const sourceProjs = new Set<ProjectionIR>();
  const routes: string[] = [];
  // Authorization gates on query-time projections (D-AUTH-OIDC / default-deny) —
  // a `requires <expr>` clause runs in the controller action BEFORE delegating
  // to the read service, throwing ForbiddenException (→ 403 via
  // ApiExceptionAdvice).  The `currentUser`-only gate binds the principal from a
  // `CurrentUserAccessor` before evaluating.  Exact twin of the repository find
  // gate in `api.ts`.
  const controllerGateImports = new Set<string>();
  let anyGate = false;
  let anyGateUsesUser = false;

  for (const proj of projections) {
    const source = proj.query!.source!;
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

    const selectByField = new Map((proj.query!.selects ?? []).map((s) => [s.field, s] as const));

    if (proj.query!.sourceKind === "workflow") {
      // `from <Workflow>` — read the persisted saga-state through the
      // `<Wf>StateRepository` (workflows have no aggregate repository), apply the
      // `where` filter in-memory, and project the `select` off each state row
      // `x`.  The validator guarantees a NON-event-sourced observable workflow,
      // NO `join`, NO `ignoring` — so this is just findAll + filter + map.
      const wf = ctx.workflows.find((w) => w.name === source);
      if (!wf) throw new Error(`java query-projection: workflow source '${source}' not found`);
      stateRepoWfs.add(wf);
      const repo = stateRepoField(wf);
      const args = shape.map((f) => {
        const sel = selectByField.get(f.name);
        if (!sel) return `null`;
        collectJavaExprImports(sel.expr, imports);
        return domainToWire(
          f.type,
          renderJavaExpr(sel.expr, { thisName: "x", accessorProps: true }),
        );
      });
      const filter = proj.query!.filter;
      const filterLine = filter
        ? (() => {
            collectJavaExprImports(filter, imports);
            return `            .filter(x -> ${renderJavaExpr(filter, { thisName: "x", accessorProps: true })})`;
          })()
        : undefined;
      methods.push(
        `    public List<${rowName}> ${findName}() {`,
        `        return ${repo}.findAll().stream()`,
        ...(filterLine ? [filterLine] : []),
        `            .map(x -> new ${rowName}(${args.join(", ")}))`,
        `            .toList();`,
        `    }`,
        ``,
      );
    } else if (proj.query!.sourceKind === "projection") {
      // `from <Projection>` — read the SOURCE folded projection's persisted
      // read-model rows through its `<Src>RowRepository` (the fold-materialized
      // `<Src>Row` table), apply the `where` filter in-memory, and project the
      // `select` off each source row `x`.  The validator guarantees the source is
      // a materialized projection, NO `join`, NO `ignoring` — findAll + filter +
      // map, exactly like the workflow-source arm but keyed on a projection row.
      const src = ctx.projections.find((p) => p.name === source);
      if (!src) throw new Error(`java query-projection: projection source '${source}' not found`);
      sourceProjs.add(src);
      const repo = projectionRepoField(src);
      const args = shape.map((f) => {
        const sel = selectByField.get(f.name);
        if (!sel) return `null`;
        collectJavaExprImports(sel.expr, imports);
        return domainToWire(
          f.type,
          renderJavaExpr(sel.expr, { thisName: "x", accessorProps: true }),
        );
      });
      const filter = proj.query!.filter;
      const filterLine = filter
        ? (() => {
            collectJavaExprImports(filter, imports);
            return `            .filter(x -> ${renderJavaExpr(filter, { thisName: "x", accessorProps: true })})`;
          })()
        : undefined;
      methods.push(
        `    public List<${rowName}> ${findName}() {`,
        `        return ${repo}.findAll().stream()`,
        ...(filterLine ? [filterLine] : []),
        `            .map(x -> new ${rowName}(${args.join(", ")}))`,
        `            .toList();`,
        `    }`,
        ``,
      );
    } else {
      repoAggs.add(source);

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
      // Shorthand form (`projection X { from <Agg> [as a] where … }`, no declared
      // fields / no `select`): the row shape is enriched to the source
      // aggregate's full wire shape, so project each domain row `a` exactly like
      // the aggregate's own `<Agg>Response.from(a)` — reusing the aggregate's
      // domain→wire arg builder (`forApiRead(wireFieldsFor)` order + provenance
      // trailers) instead of the per-select map, which would emit `null` for
      // every field.
      const isShorthand = (proj.query!.selects?.length ?? 0) === 0;
      const sourceAgg = ctx.aggregates.find((x) => x.name === source);
      const args =
        isShorthand && sourceAgg
          ? aggregateWireArgs(sourceAgg, "a")
          : shape.map((f) => {
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
    }
    // The `requires` gate: bind the principal (when the predicate reads it) then
    // a 403 on failure, BEFORE the read — mirroring the find gate in api.ts.
    const gate = proj.query!.requires;
    const gateLines: string[] = [];
    if (gate) {
      anyGate = true;
      collectJavaExprImports(gate, controllerGateImports);
      if (exprUsesCurrentUser(gate)) {
        anyGateUsesUser = true;
        gateLines.push(`        var currentUser = currentUserAccessor.user();`);
      }
      gateLines.push(
        `        if (!(${renderJavaExpr(gate, { thisName: "this" })})) throw new ForbiddenException(${JSON.stringify(
          `Forbidden: projection ${proj.name}`,
        )});`,
      );
    }
    routes.push(
      `    @GetMapping("/${snake(proj.name)}")`,
      `    public List<${rowName}> ${findName}() {`,
      ...gateLines,
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
  // Injected dependencies: the aggregate repositories above plus a
  // `<Wf>StateRepository` for every `from <Workflow>`-sourced projection.  The
  // state var (`x`) is `var`-inferred off `findAll()`, so only the repository
  // type needs importing (not the `<Wf>State` entity).
  const stateWfList = [...stateRepoWfs].sort((a, b) => a.name.localeCompare(b.name));
  for (const wf of stateWfList) {
    if (qpctx.stateRepoPkg !== qpctx.pkg)
      explicitImports.add(`${qpctx.stateRepoPkg}.${workflowStateClass(wf)}Repository`);
  }
  // Source folded projections read via their read-model `<Src>RowRepository`.
  // The source row var (`x`) is `var`-inferred off `findAll()`, so only the
  // repository type needs importing (not the `<Src>Row` entity).
  const sourceProjList = [...sourceProjs].sort((a, b) => a.name.localeCompare(b.name));
  for (const p of sourceProjList) {
    if (qpctx.stateRepoPkg !== qpctx.pkg)
      explicitImports.add(`${qpctx.stateRepoPkg}.${projectionRowClass(p)}Repository`);
  }
  const injected: { type: string; field: string }[] = [
    ...repoFields.map((a) => ({ type: `${a}Repository`, field: repoField(a) })),
    ...stateWfList.map((wf) => ({
      type: `${workflowStateClass(wf)}Repository`,
      field: stateRepoField(wf),
    })),
    ...sourceProjList.map((p) => ({
      type: `${projectionRowClass(p)}Repository`,
      field: projectionRepoField(p),
    })),
  ];

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
      ...injected.map((d) => `    private final ${d.type} ${d.field};`),
      ``,
      `    public ${serviceName}(${injected.map((d) => `${d.type} ${d.field}`).join(", ")}) {`,
      ...injected.map((d) => `        this.${d.field} = ${d.field};`),
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
      ...[...controllerGateImports].sort().map((i) => `import ${i};`),
      anyGate ? `import ${qpctx.basePkg}.domain.common.ForbiddenException;` : null,
      anyGateUsesUser ? `import ${qpctx.basePkg}.auth.CurrentUserAccessor;` : null,
      anyGate ? `import ${qpctx.basePkg}.domain.enums.*;` : null,
      anyGate ? `import ${qpctx.basePkg}.domain.ids.*;` : null,
      `import ${qpctx.pkg}.*;`,
      ``,
      `@RestController`,
      `@RequestMapping("${qpctx.routePrefix ?? ""}/projections")`,
      `public class ${ctx.name}QueryProjectionsController {`,
      `    private final ${serviceName} queryProjections;`,
      anyGateUsesUser ? `    private final CurrentUserAccessor currentUserAccessor;` : null,
      ``,
      `    public ${ctx.name}QueryProjectionsController(${serviceName} queryProjections${anyGateUsesUser ? ", CurrentUserAccessor currentUserAccessor" : ""}) {`,
      `        this.queryProjections = queryProjections;`,
      anyGateUsesUser ? `        this.currentUserAccessor = currentUserAccessor;` : null,
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

/** Normalise the optional flag into the type, matching `dto.ts`'s `eff` so a
 *  shorthand projection's domain→wire args are byte-identical to the aggregate's
 *  own `<Agg>Response.from(...)` mapper. */
function effOptional(t: TypeIR, optional: boolean): TypeIR {
  return optional && t.kind !== "optional" ? { kind: "optional", inner: t } : t;
}

/** Positional `new <Proj>Row(...)` args for a SHORTHAND projection sourced from
 *  `agg` — the exact domain→wire projection the aggregate's own `<Agg>Response`
 *  DTO uses (`dto.ts`'s non-declared `wireRecord` path): `forApiRead`-filtered
 *  wire fields in wireShape order (`domainToWire` over each field, the id row
 *  carrying its bare value type) plus one trailing `<field>Provenance` arg per
 *  provenanced field.  `<Proj>Row`'s components ≡ these wire fields (same
 *  names/order/types), so the row is populated, not `null`-filled. */
function aggregateWireArgs(agg: EnrichedAggregateIR, domainVar: string): string[] {
  const args: string[] = [];
  for (const w of forApiRead(wireFieldsFor(agg))) {
    const t = w.source === "id" ? w.type : effOptional(w.type, w.optional);
    args.push(domainToWire(t, `${domainVar}.${w.name}()`));
  }
  for (const f of agg.fields.filter((pf) => pf.provenanced)) {
    args.push(`${domainVar}.${f.name}Provenance()`);
  }
  return args;
}

/** The saga-state repository field for a `from <Workflow>` projection
 *  (`fulfilStateRepository`) — mirrors the workflow-instances reader's naming. */
function stateRepoField(wf: WorkflowIR): string {
  return `${lowerFirst(wf.name)}StateRepository`;
}

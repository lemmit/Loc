import type {
  EnrichedBoundedContextIR,
  ProjectionIR,
  ViewIR,
  WireField,
  WorkflowIR,
} from "../../../ir/types/loom-ir.js";
import { exprUsesCurrentUser } from "../../../ir/types/loom-ir.js";
import { lines } from "../../../util/code-builder.js";
import { lowerFirst, plural, snake, upperFirst } from "../../../util/naming.js";
import { collectJavaExprImports, javaValueTypeForId, renderJavaExpr } from "../render-expr.js";
import { projectionRepoField } from "./projection-reads.js";
import { projectionRowClass } from "./projection-state.js";
import { collectWireImports, domainToWire, wireJavaType } from "./wire.js";
import {
  esWorkflowCorrIdClass,
  esWorkflowStateClass,
  esWorkflowStreamTable,
} from "./workflow-eventsourced.js";
import { workflowStateClass } from "./workflow-state.js";

// ---------------------------------------------------------------------------
// Views — read-only projections, served under `GET /views/<snake(name)>`
// (the cross-backend route contract).  A shorthand view reuses the source
// aggregate's `<Agg>Response`; a full-form view gets a `<View>Row` record
// built from its bind expressions.  The filtered read itself rides a
// synthesized repository find (`viewFindsFor` — the mergeViewsAsFinds
// analog), so the JPQL path is shared with declared finds.
// ---------------------------------------------------------------------------

/** Views sourced from `agg`, as synthesized parameterless finds the
 *  repository emitters pick up (name = lowerFirst(view name)).  A view's
 *  `ignoring` bypass (`bypassAll`/`bypassCaps`) rides onto the synthesized find
 *  so the repository impl honours it exactly as a declared find would. */
export function viewFindsFor(
  aggName: string,
  ctx: EnrichedBoundedContextIR,
): {
  name: string;
  params: never[];
  returnType: { kind: "array"; element: { kind: "entity"; name: string } };
  filter?: ViewIR["filter"];
  bypassAll?: boolean;
  bypassCaps?: string[];
}[] {
  return ctx.views
    .filter((v) => v.source.kind === "aggregate" && v.source.name === aggName)
    .map((v) => ({
      name: lowerFirst(v.name),
      params: [],
      returnType: { kind: "array", element: { kind: "entity", name: aggName } },
      filter: v.filter,
      bypassAll: v.bypassAll,
      bypassCaps: v.bypassCaps,
    }));
}

export interface ViewCtx {
  basePkg: string;
  /** Shared views package (`<base>.application.views`). */
  pkg: string;
  /** Route prefix ("/api" in fullstack mode). */
  routePrefix?: string;
  applicationPkgOf: (aggName: string) => string;
  entityPkgOf: (aggName: string) => string;
  repoPkgOf: (aggName: string) => string;
  /** Saga-state Spring Data repository package (workflow-sourced views read
   *  the persisted correlation row through it). */
  stateRepoPkg: string;
  /** Workflow-service package (application.workflows) — the home of the ES
   *  `<Wf>State` fold class an event-sourced workflow-view reads through. */
  workflowPkg: string;
  /** The workflows' owning-context Postgres schema — qualifies the ES saga
   *  stream in native SQL to match the migration.  Undefined ⇒ unqualified. */
  contextSchema?: string;
}

export function renderJavaViews(
  ctx: EnrichedBoundedContextIR,
  vctx: ViewCtx,
): Map<string, { category: "view-service" | "api-common"; content: string }> | null {
  const views = ctx.views.filter((v) => v.source.kind === "aggregate");
  // Workflow-sourced views (workflow-instance-views.md): a shorthand
  // `view X = <Workflow> where …` reads the saga-state row (the source's
  // `instanceWireShape`) with the filter applied, the read-side analogue of the
  // instance endpoints.  Only observable (correlation-bearing) workflows have an
  // `instanceWireShape` — both state-table sagas (read the `<Wf>State` row) and
  // event-sourced workflows (group-fold the `<wf>_events` stream in memory);
  // full-form workflow views are rejected upstream
  // (`loom.view-workflow-fullform-unsupported`), so these are always shorthand
  // (filter-only).
  const wfByName = new Map(ctx.workflows.map((w) => [w.name, w] as const));
  const wfViews = ctx.views.filter(
    (v) => v.source.kind === "workflow" && !!wfByName.get(v.source.name)?.instanceWireShape,
  );
  // Projection-sourced views (projection.md v1.1): a `view X = <Projection> …`
  // reads the persisted `<Proj>Row` read-model table through its Spring Data
  // repository (`findAll()` + in-memory filter — the state-based workflow-view
  // read, no aggregate repo).  Shorthand returns the projection's own
  // `<Proj>Response` wire shape (the v1 `GET /projections/<name>` DTO);
  // full-form runs the aggregate bind-projection tail over those rows (plain
  // columns only — `X id` follows stay rejected exactly as for an aggregate
  // view).
  const projByName = new Map(ctx.projections.map((p) => [p.name, p] as const));
  const projViews = ctx.views.filter(
    (v) => v.source.kind === "projection" && projByName.has(v.source.name),
  );
  if (views.length === 0 && wfViews.length === 0 && projViews.length === 0) return null;
  const out = new Map<string, { category: "view-service" | "api-common"; content: string }>();
  const imports = new Set<string>(["java.util.List"]);
  const explicitImports = new Set<string>();
  const methods: string[] = [];
  const repoAggs = new Set<string>();
  const routes: string[] = [];
  // Source workflows whose saga-state repository the service must inject
  // (state-based sagas), and event-sourced workflows whose stream the service
  // group-folds over a shared JdbcTemplate.
  const stateWfs: WorkflowIR[] = [];
  const esWfs: WorkflowIR[] = [];
  // Projections whose read-model row repository the service must inject
  // (projection-sourced views read the row through it).
  const projRepos: ProjectionIR[] = [];

  // Authorization gate (D-AUTH-OIDC / default-deny).  A `view … requires <expr>`
  // gate runs in the views service method before the read — the read-side
  // analogue of an operation's `requires`.  A failure throws ForbiddenException
  // (→ 403 via the controller advice, the same path operations use).  The gate
  // is currentUser-only; when it references currentUser the service injects the
  // CurrentUserAccessor and binds a local `currentUser` for the predicate.
  // `requires true` needs neither (and an unused field would be dead code).
  const anyGate = [...views, ...wfViews, ...projViews].some((v) => v.requires);
  const anyGateUsesUser = [...views, ...wfViews, ...projViews].some(
    (v) => v.requires && exprUsesCurrentUser(v.requires),
  );
  const gateLinesFor = (view: ViewIR): string[] => {
    if (!view.requires) return [];
    collectJavaExprImports(view.requires, imports);
    const gl: string[] = [];
    if (exprUsesCurrentUser(view.requires)) {
      gl.push(`        var currentUser = currentUserAccessor.user();`);
    }
    gl.push(
      `        if (!(${renderJavaExpr(view.requires, { thisName: "this" })})) throw new ForbiddenException(${JSON.stringify(
        `Forbidden: view ${view.name}`,
      )});`,
    );
    return gl;
  };
  if (anyGate) explicitImports.add(`${vctx.basePkg}.domain.common.ForbiddenException`);
  if (anyGateUsesUser) explicitImports.add(`${vctx.basePkg}.auth.CurrentUserAccessor`);

  for (const view of views) {
    const aggName = (view.source as { name: string }).name;
    repoAggs.add(aggName);
    const findName = lowerFirst(view.name);
    if (view.output) {
      if (view.output.auxiliaries.length > 0) {
        throw new Error(
          `java views: view '${view.name}' uses cross-aggregate follows — not yet implemented on the java backend.`,
        );
      }
      // Row record from the declared fields + bind expressions.
      const rowName = `${upperFirst(view.name)}Row`;
      const rowImports = new Set<string>();
      const components = view.output.fields.map((f) => {
        collectWireImports(f.type, rowImports);
        return `${wireJavaType(f.type, "Response")} ${f.name}`;
      });
      out.set(`${rowName}.java`, {
        category: "view-service",
        content: lines(
          `package ${vctx.pkg};`,
          ``,
          ...[...rowImports].sort().map((i) => `import ${i};`),
          rowImports.size > 0 ? `` : null,
          `import ${vctx.basePkg}.domain.enums.*;`,
          `import ${vctx.basePkg}.domain.ids.*;`,
          `import ${vctx.basePkg}.domain.valueobjects.*;`,
          ``,
          `public record ${rowName}(${components.join(", ")}) {`,
          `}`,
          ``,
        ),
      });
      const args = view.output.binds.map((b) => {
        collectJavaExprImports(b.expr, imports);
        const rendered = renderJavaExpr(b.expr, { thisName: "a", accessorProps: true });
        return domainToWire(b.type, rendered);
      });
      methods.push(
        `    public List<${rowName}> ${findName}() {`,
        ...gateLinesFor(view),
        `        return ${repoField(aggName)}.${findName}().stream()`,
        `            .map(a -> new ${rowName}(${args.join(", ")}))`,
        `            .toList();`,
        `    }`,
        ``,
      );
      routes.push(
        `    @GetMapping("/${snake(view.name)}")`,
        `    public List<${rowName}> ${findName}() {`,
        `        return views.${findName}();`,
        `    }`,
        ``,
      );
    } else {
      // Shorthand — reuse the aggregate's response record.
      explicitImports.add(`${vctx.applicationPkgOf(aggName)}.${aggName}Response`);
      methods.push(
        `    public List<${aggName}Response> ${findName}() {`,
        ...gateLinesFor(view),
        `        return ${repoField(aggName)}.${findName}().stream().map(${aggName}Response::from).toList();`,
        `    }`,
        ``,
      );
      routes.push(
        `    @GetMapping("/${snake(view.name)}")`,
        `    public List<${aggName}Response> ${findName}() {`,
        `        return views.${findName}();`,
        `    }`,
        ``,
      );
    }
  }
  // Workflow-sourced views — a `<View>Row` record over the source saga's
  // `instanceWireShape`, plus a service method reading the saga-state through
  // its Spring Data repository, filtering in-memory (the filter renders to a
  // boolean Java predicate over the state accessors via `accessorProps`), and
  // projecting each row through the same wire shape the instance endpoints use.
  for (const view of wfViews) {
    const wf = wfByName.get((view.source as { name: string }).name)!;
    const findName = lowerFirst(view.name);
    const rowName = `${upperFirst(view.name)}Row`;
    const shape = wf.instanceWireShape ?? [];
    // Row record from the saga wire shape (same components as <Wf>InstanceResponse).
    const rowImports = new Set<string>();
    const components = shape.map((f) => {
      collectWireImports(f.type, rowImports);
      return `${wireJavaType(f.type, "Response")} ${f.name}`;
    });
    out.set(`${rowName}.java`, {
      category: "view-service",
      content: lines(
        `package ${vctx.pkg};`,
        ``,
        ...[...rowImports].sort().map((i) => `import ${i};`),
        rowImports.size > 0 ? `` : null,
        `import ${vctx.basePkg}.domain.enums.*;`,
        `import ${vctx.basePkg}.domain.ids.*;`,
        `import ${vctx.basePkg}.domain.valueobjects.*;`,
        ``,
        `public record ${rowName}(${components.join(", ")}) {`,
        `}`,
        ``,
      ),
    });
    const proj = shape.map((f) => domainToWire(f.type, `x.${f.name}()`)).join(", ");
    // The filter renders to an in-memory boolean over the folded state's
    // record-style accessors (`accessorProps`).  Both source kinds filter in
    // memory: a state-based saga over the `<Wf>State` rows from its repository,
    // an event-sourced workflow over the group-folded `<wf>_events` stream
    // (mirroring the ES instance LIST) — there is no `<Wf>State` table to push
    // the predicate into for ES.
    const filterLine = view.filter
      ? (() => {
          collectJavaExprImports(view.filter, imports);
          return `            .filter(x -> ${renderJavaExpr(view.filter, { thisName: "x", accessorProps: true })})`;
        })()
      : undefined;
    if (wf.eventSourced) {
      esWfs.push(wf);
      const cls = esWorkflowStateClass(wf);
      const corrId = esWorkflowCorrIdClass(wf);
      const table = esWorkflowStreamTable(wf, vctx.contextSchema);
      const corr = shape.find((f) => f.source === "id");
      const idJava = javaValueTypeForId(idValueTypeOf(corr));
      imports.add("java.util.ArrayList");
      imports.add("java.util.LinkedHashMap");
      // `UUID.fromString(...)` rewraps the stream_id key when the correlation id
      // is guid-typed (mirrors the ES instance LIST controller's import).
      if (idJava === "UUID") imports.add("java.util.UUID");
      explicitImports.add(`${vctx.workflowPkg}.${cls}`);
      explicitImports.add(`${vctx.basePkg}.domain.events.DomainEvent`);
      methods.push(
        `    public List<${rowName}> ${findName}() {`,
        ...gateLinesFor(view),
        `        var __rows = jdbc.queryForList(`,
        `            "select stream_id, type, data from ${table} order by stream_id, version");`,
        `        var __byStream = new LinkedHashMap<String, List<DomainEvent>>();`,
        `        for (var __r : __rows) {`,
        `            var __sid = (String) __r.get("stream_id");`,
        `            __byStream.computeIfAbsent(__sid, __k -> new ArrayList<>())`,
        `                .add(${cls}._rowToEvent((String) __r.get("type"), String.valueOf(__r.get("data"))));`,
        `        }`,
        `        return __byStream.entrySet().stream()`,
        `            .map(__e -> ${cls}._fromEvents(new ${corrId}(${idFromString("__e.getKey()", idJava)}), __e.getValue()))`,
        ...(filterLine ? [filterLine] : []),
        `            .map(x -> new ${rowName}(${proj}))`,
        `            .toList();`,
        `    }`,
        ``,
      );
    } else {
      stateWfs.push(wf);
      const repo = `${lowerFirst(wf.name)}StateRepository`;
      methods.push(
        `    public List<${rowName}> ${findName}() {`,
        ...gateLinesFor(view),
        `        return ${repo}.findAll().stream()`,
        ...(filterLine ? [filterLine] : []),
        `            .map(x -> new ${rowName}(${proj}))`,
        `            .toList();`,
        `    }`,
        ``,
      );
    }
    routes.push(
      `    @GetMapping("/${snake(view.name)}")`,
      `    public List<${rowName}> ${findName}() {`,
      `        return views.${findName}();`,
      `    }`,
      ``,
    );
  }
  // Projection-sourced views — the `<Proj>Row` read-model row is read through
  // its Spring Data repository (`findAll()`), the filter renders to an in-memory
  // boolean over the row's record-style accessors (`accessorProps`, exactly like
  // the state-based workflow-view arm).  Full-form binds project each row through
  // the aggregate bind-projection tail (`X id` follows rejected as for an
  // aggregate view); shorthand projects each row through the projection's own
  // `wireShape` into `<Proj>Response`.
  for (const view of projViews) {
    const proj = projByName.get((view.source as { name: string }).name)!;
    projRepos.push(proj);
    const findName = lowerFirst(view.name);
    const repo = projectionRepoField(proj);
    const filterLine = view.filter
      ? (() => {
          collectJavaExprImports(view.filter, imports);
          return `            .filter(a -> ${renderJavaExpr(view.filter, { thisName: "a", accessorProps: true })})`;
        })()
      : undefined;
    if (view.output) {
      if (view.output.auxiliaries.length > 0) {
        throw new Error(
          `java views: view '${view.name}' uses cross-aggregate follows — not yet implemented on the java backend.`,
        );
      }
      // Row record from the declared fields + bind expressions (same shape as
      // the aggregate full-form arm).
      const rowName = `${upperFirst(view.name)}Row`;
      const rowImports = new Set<string>();
      const components = view.output.fields.map((f) => {
        collectWireImports(f.type, rowImports);
        return `${wireJavaType(f.type, "Response")} ${f.name}`;
      });
      out.set(`${rowName}.java`, {
        category: "view-service",
        content: lines(
          `package ${vctx.pkg};`,
          ``,
          ...[...rowImports].sort().map((i) => `import ${i};`),
          rowImports.size > 0 ? `` : null,
          `import ${vctx.basePkg}.domain.enums.*;`,
          `import ${vctx.basePkg}.domain.ids.*;`,
          `import ${vctx.basePkg}.domain.valueobjects.*;`,
          ``,
          `public record ${rowName}(${components.join(", ")}) {`,
          `}`,
          ``,
        ),
      });
      const args = view.output.binds.map((b) => {
        collectJavaExprImports(b.expr, imports);
        const rendered = renderJavaExpr(b.expr, { thisName: "a", accessorProps: true });
        return domainToWire(b.type, rendered);
      });
      methods.push(
        `    public List<${rowName}> ${findName}() {`,
        ...gateLinesFor(view),
        `        return ${repo}.findAll().stream()`,
        ...(filterLine ? [filterLine] : []),
        `            .map(a -> new ${rowName}(${args.join(", ")}))`,
        `            .toList();`,
        `    }`,
        ``,
      );
      routes.push(
        `    @GetMapping("/${snake(view.name)}")`,
        `    public List<${rowName}> ${findName}() {`,
        `        return views.${findName}();`,
        `    }`,
        ``,
      );
    } else {
      // Shorthand — reuse the projection's `<Proj>Response` wire shape (the v1
      // read endpoint's DTO), projecting each row through `wireShape`.
      const respName = `${upperFirst(proj.name)}Response`;
      explicitImports.add(`${vctx.workflowPkg}.${respName}`);
      const shape = proj.wireShape ?? [];
      const projRow = shape.map((f) => domainToWire(f.type, `x.${f.name}()`)).join(", ");
      const shortFilter = view.filter
        ? `            .filter(x -> ${renderJavaExpr(view.filter, { thisName: "x", accessorProps: true })})`
        : undefined;
      if (view.filter) collectJavaExprImports(view.filter, imports);
      methods.push(
        `    public List<${respName}> ${findName}() {`,
        ...gateLinesFor(view),
        `        return ${repo}.findAll().stream()`,
        ...(shortFilter ? [shortFilter] : []),
        `            .map(x -> new ${respName}(${projRow}))`,
        `            .toList();`,
        `    }`,
        ``,
      );
      routes.push(
        `    @GetMapping("/${snake(view.name)}")`,
        `    public List<${respName}> ${findName}() {`,
        `        return views.${findName}();`,
        `    }`,
        ``,
      );
    }
  }
  while (methods[methods.length - 1] === "") methods.pop();
  while (routes[routes.length - 1] === "") routes.pop();

  const repoFields = [...repoAggs].sort();
  const serviceName = `${ctx.name}Views`;
  for (const a of repoFields) {
    if (vctx.repoPkgOf(a) !== vctx.pkg) explicitImports.add(`${vctx.repoPkgOf(a)}.${a}Repository`);
    if (vctx.entityPkgOf(a) !== vctx.pkg) explicitImports.add(`${vctx.entityPkgOf(a)}.${a}`);
  }
  // Saga-state repos for workflow-sourced views, in declaration order.
  const stateFields = stateWfs.map(
    (wf) =>
      `    private final ${workflowStateClass(wf)}Repository ${lowerFirst(wf.name)}StateRepository;`,
  );
  for (const wf of stateWfs) {
    explicitImports.add(`${vctx.stateRepoPkg}.${workflowStateClass(wf)}Repository`);
  }
  const stateCtorParams = stateWfs.map(
    (wf) => `${workflowStateClass(wf)}Repository ${lowerFirst(wf.name)}StateRepository`,
  );
  const stateCtorAssigns = stateWfs.map(
    (wf) =>
      `        this.${lowerFirst(wf.name)}StateRepository = ${lowerFirst(wf.name)}StateRepository;`,
  );
  // A single shared JdbcTemplate folds every event-sourced workflow-view's
  // stream (no mutable state repository to inject).
  const esPresent = esWfs.length > 0;
  if (esPresent) explicitImports.add("org.springframework.jdbc.core.JdbcTemplate");
  // Read-model row repos for projection-sourced views, de-duplicated in
  // declaration order (two views over the same projection share one repo).
  const projReposUnique = [...new Map(projRepos.map((p) => [p.name, p])).values()];
  const projRepoFields = projReposUnique.map(
    (p) => `    private final ${projectionRowClass(p)}Repository ${projectionRepoField(p)};`,
  );
  for (const p of projReposUnique) {
    explicitImports.add(`${vctx.stateRepoPkg}.${projectionRowClass(p)}Repository`);
  }
  const projCtorParams = projReposUnique.map(
    (p) => `${projectionRowClass(p)}Repository ${projectionRepoField(p)}`,
  );
  const projCtorAssigns = projReposUnique.map(
    (p) => `        this.${projectionRepoField(p)} = ${projectionRepoField(p)};`,
  );
  out.set(`${serviceName}.java`, {
    category: "view-service",
    content: lines(
      `package ${vctx.pkg};`,
      ``,
      ...[...imports].sort().map((i) => `import ${i};`),
      ``,
      `import org.springframework.stereotype.Service;`,
      `import org.springframework.transaction.annotation.Transactional;`,
      ``,
      ...[...explicitImports].sort().map((i) => `import ${i};`),
      `import ${vctx.basePkg}.domain.enums.*;`,
      `import ${vctx.basePkg}.domain.ids.*;`,
      `import ${vctx.basePkg}.domain.valueobjects.*;`,
      ``,
      `@Service`,
      `@Transactional(readOnly = true)`,
      `public class ${serviceName} {`,
      ...repoFields.map((a) => `    private final ${a}Repository ${repoField(a)};`),
      ...stateFields,
      ...projRepoFields,
      esPresent ? `    private final JdbcTemplate jdbc;` : null,
      anyGateUsesUser ? `    private final CurrentUserAccessor currentUserAccessor;` : null,
      ``,
      `    public ${serviceName}(${[
        ...repoFields.map((a) => `${a}Repository ${repoField(a)}`),
        ...stateCtorParams,
        ...projCtorParams,
        ...(esPresent ? ["JdbcTemplate jdbc"] : []),
        ...(anyGateUsesUser ? ["CurrentUserAccessor currentUserAccessor"] : []),
      ].join(", ")}) {`,
      ...repoFields.map((a) => `        this.${repoField(a)} = ${repoField(a)};`),
      ...stateCtorAssigns,
      ...projCtorAssigns,
      esPresent ? `        this.jdbc = jdbc;` : null,
      anyGateUsesUser ? `        this.currentUserAccessor = currentUserAccessor;` : null,
      `    }`,
      ``,
      ...methods,
      `}`,
      ``,
    ),
  });

  out.set(`${ctx.name}ViewsController.java`, {
    category: "api-common",
    content: lines(
      `package ${vctx.basePkg}.api;`,
      ``,
      `import java.util.List;`,
      ``,
      `import org.springframework.web.bind.annotation.*;`,
      ``,
      `import ${vctx.pkg}.*;`,
      ...views
        .filter((v) => !v.output)
        .map((v) => {
          const aggName = (v.source as { name: string }).name;
          return `import ${vctx.applicationPkgOf(aggName)}.${aggName}Response;`;
        })
        .filter((v, i, arr) => arr.indexOf(v) === i),
      // Shorthand projection views return `List<<Proj>Response>`; that DTO lives
      // in the workflow-service package (shared with the projection reads).
      ...projViews
        .filter((v) => !v.output)
        .map((v) => {
          const proj = projByName.get((v.source as { name: string }).name)!;
          return `import ${vctx.workflowPkg}.${upperFirst(proj.name)}Response;`;
        })
        .filter((v, i, arr) => arr.indexOf(v) === i),
      ``,
      `@RestController`,
      `@RequestMapping("${vctx.routePrefix ?? ""}/views")`,
      `public class ${ctx.name}ViewsController {`,
      `    private final ${serviceName} views;`,
      ``,
      `    public ${ctx.name}ViewsController(${serviceName} views) {`,
      `        this.views = views;`,
      `    }`,
      ``,
      ...routes,
      `}`,
      ``,
    ),
  });

  return out;
}

function repoField(aggName: string): string {
  return `${lowerFirst(plural(aggName))}Repository`;
}

/** The correlation id's value type, off the `source: "id"` wire field. */
function idValueTypeOf(f: WireField | undefined): string {
  const t = f && f.type.kind === "optional" ? f.type.inner : f?.type;
  return t && t.kind === "id" ? t.valueType : "guid";
}

/** Convert a stream_id `String` back to the correlation id's value type so a
 *  folded ES instance can wrap it in `new <Corr>Id(...)` — mirroring the ES
 *  instance LIST controller (workflow-instances.ts). */
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

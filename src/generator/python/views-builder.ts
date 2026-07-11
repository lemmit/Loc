import type {
  EnrichedBoundedContextIR,
  ExprIR,
  ProjectionIR,
  TypeIR,
  ViewIR,
  WireField,
  WorkflowIR,
} from "../../ir/types/loom-ir.js";
import { exprUsesCurrentUser } from "../../ir/types/loom-ir.js";
import { camelId, opView } from "../../ir/util/openapi-ids.js";
import { lines } from "../../util/code-builder.js";
import { snake } from "../../util/naming.js";
import { responsePyType } from "./emit/http-models.js";
import {
  lowerProjectionFilterToSqlAlchemy,
  lowerWorkflowFilterToSqlAlchemy,
  type PyPredicate,
} from "./find-predicate.js";
import { dtImportLine, wireHelperImport } from "./py-type-imports.js";
import { collectPyExprImports, renderPyExpr } from "./render-expr.js";
import { esFns } from "./workflow-eventsourced-emit.js";
import { instanceFieldValue } from "./workflows-builder.js";

// ---------------------------------------------------------------------------
// View routes — `app/http/views_routes.py`, mounted at `/views`.
//
// One `GET /views/<snake(view)>` per aggregate-sourced view:
//   - shorthand (`view X = Y where …`): the source repo's synthesised
//     view find + `to_wire` projection (reuses `<Agg>Response`).
//   - full form (custom `fields` + `bind`): bulk-load every `X id`
//     follow's foreign aggregates via `find_many_by_ids`, then project
//     each row through the bind expressions with follow rewriting —
//     the Python port of Hono's `renderBindWithFollows`.
//
// Workflow-sourced views land with S15.  Wire parity notes: money
// binds serialize as strings on view rows (TS rows carry decimal.js
// instances that JSON-stringify to strings — copied, not invented).
// ---------------------------------------------------------------------------

export function buildPyViewsFile(
  ctx: EnrichedBoundedContextIR,
  hasDispatch = false,
): string | null {
  const views = ctx.views.filter((v) => v.source.kind === "aggregate");
  const projByName = new Map(ctx.projections.map((p) => [p.name, p] as const));
  // Projection-sourced views (projection.md v1.1): a `view X = <Proj> where …`
  // reads the projection's `<Proj>Row` read-model table directly (no
  // repository), with the filter lowered to a SQLAlchemy `where` — the exact
  // analogue of the state-based workflow-view arm's row acquisition.  Unlike a
  // workflow view, full-form (bind-projected) output IS supported: the shared
  // aggregate full-form tail (foreign-repo bulk-load + bind-follow projection)
  // composes verbatim over those rows.
  const projViews = ctx.views.filter(
    (v) => v.source.kind === "projection" && projByName.has(v.source.name),
  );
  const wfByName = new Map(ctx.workflows.map((w) => [w.name, w] as const));
  // Workflow-sourced views (workflow-instance-views.md): a shorthand `view X =
  // <Workflow> where …` reads the saga-state row (the source's
  // `instanceWireShape`) with the filter lowered to a SQLAlchemy `where`, the
  // read-side analogue of the instance endpoints.  eventSourced / stateless
  // workflows have no `instanceWireShape` and emit nothing here.
  const wfViews = ctx.views.filter(
    (v) => v.source.kind === "workflow" && wfByName.get(v.source.name)?.instanceWireShape != null,
  );
  if (views.length === 0 && wfViews.length === 0 && projViews.length === 0) return null;
  // Lower each projection view's filter once to a SQLAlchemy `where` over its
  // `<Proj>Row` (reused by the route + the SQLAlchemy-op import scan) — the same
  // SQL-push the state-based workflow-view arm does.
  const projLowered = new Map<string, PyPredicate | null>();
  for (const v of projViews) {
    projLowered.set(
      v.name,
      v.filter ? lowerProjectionFilterToSqlAlchemy(v.filter, v.source.name) : null,
    );
  }
  // Lower each STATE-based workflow view's filter once to SQLAlchemy (reused by
  // the route + import scan).  An event-sourced workflow has no `<Wf>Row` table
  // to push the predicate into — it group-folds the `<wf>_events` stream and
  // filters the folded instances in memory — so its filter is NOT lowered here.
  const wfLowered = new Map<string, PyPredicate | null>();
  for (const v of wfViews) {
    const wf = wfByName.get(v.source.name)!;
    if (wf.eventSourced) continue;
    wfLowered.set(v.name, v.filter ? lowerWorkflowFilterToSqlAlchemy(v.filter, wf) : null);
  }
  const aggsByName = new Map(ctx.aggregates.map((a) => [a.name, a] as const));
  // View reads never save, but repos take the deployable's default
  // dispatcher uniformly (Hono parity).
  const dispatcherExpr = hasDispatch ? "make_dispatcher(session)" : "NoopDomainEventDispatcher()";

  const models: string[] = [];
  // Full-form Row/Response DTOs — aggregate AND projection full-form views share
  // the exact same `<View>Row`/`<View>Response` shape (declared `fields`).
  for (const view of [...views, ...projViews]) {
    if (!view.output) continue;
    models.push(
      lines(
        `class ${view.name}Row(BaseModel):`,
        view.output.fields.map((f) => `    ${f.name}: ${rowFieldType(f.type)}`),
        "",
        "",
        // Named array component (`<View>Response`, RootModel → $ref) —
        // response-schema parity with the other backends.
        `class ${view.name}Response(RootModel[list[${view.name}Row]]):`,
        "    pass",
        "",
        "",
      ),
    );
  }

  // Workflow-view response DTOs — the saga instance wire shape (`<View>Row` /
  // `<View>Response`), the same shape the instance endpoints expose.
  const wfModels = wfViews
    .map((v) => workflowViewModels(v, wfByName.get(v.source.name)!, ctx))
    .join("");

  const routeBlocks = [
    ...views.map((v) => viewRoute(v, dispatcherExpr)),
    ...wfViews.map((v) =>
      workflowViewRoute(v, wfByName.get(v.source.name)!, wfLowered.get(v.name) ?? null),
    ),
    ...projViews.map((v) =>
      projectionViewRoute(
        v,
        projByName.get(v.source.name)!,
        projLowered.get(v.name) ?? null,
        dispatcherExpr,
      ),
    ),
  ];
  // ES workflow-view filters render to in-memory Python predicates (`row.<col>`)
  // via `renderPyExpr`; collect their imports (e.g. `re` for `.matches`) so the
  // module header stays correct.
  const esWfViews = wfViews.filter((v) => wfByName.get(v.source.name)!.eventSourced);
  const stateWfViews = wfViews.filter((v) => !wfByName.get(v.source.name)!.eventSourced);
  const esFilterImports = new Set<string>();
  for (const v of esWfViews) if (v.filter) collectPyExprImports(v.filter, esFilterImports);
  const needsRe = esFilterImports.has("re");
  const needsMath = esFilterImports.has("math");
  const routes = routeBlocks.join("\n\n\n");
  const body = `${models.join("")}${wfModels}router = APIRouter(prefix="/views", tags=["views"])\n\n\n${routes}`;

  const scan = body.replace(/"(?:\\.|[^"\\])*"/g, '""');
  const refersTo = (n: string): boolean => new RegExp(`\\b${n}\\b`).test(scan);
  const sourceAggs = [...new Set(views.map((v) => v.source.name))];
  // A projection full-form view bind-follows into foreign aggregate repositories
  // (the same `X id` → `find_many_by_ids` bulk-load as an aggregate view), so its
  // auxiliaries' repos must be imported too — but the projection SOURCE itself is
  // a `<Proj>Row` table read, not an aggregate repo.
  const auxAggs = [
    ...new Set(
      [...views, ...projViews].flatMap((v) => (v.output?.auxiliaries ?? []).map((a) => a.aggName)),
    ),
  ];
  const repoAggs = [...new Set([...sourceAggs, ...auxAggs])]
    .filter((n) => aggsByName.has(n))
    .sort();
  const responseAggs = sourceAggs
    .filter((n) => refersTo(`${n}Response`) || refersTo(`${n}ListResponse`))
    .sort();
  const voEnumNames = [...ctx.valueObjects.map((v) => v.name), ...ctx.enums.map((e) => e.name)]
    .filter(refersTo)
    .sort();
  // SQLAlchemy helpers a STATE-based workflow view OR a projection view route
  // calls: `select` for the direct table read, plus any `and_`/`or_`/`not_`/etc.
  // a lowered filter needs.  (ES workflow views fold the stream + filter in
  // memory — no SQLAlchemy.)
  const saOps = new Set<string>(stateWfViews.length > 0 || projViews.length > 0 ? ["select"] : []);
  for (const p of wfLowered.values()) for (const op of p?.ops ?? []) saOps.add(op);
  for (const p of projLowered.values()) for (const op of p?.ops ?? []) saOps.add(op);
  // Row classes read directly from schema: STATE-based workflow saga rows +
  // projection `<Proj>Row` read-model tables.  ES workflow views have no `<Wf>Row`
  // table — they fold the event stream via dispatch.
  const schemaRows = [
    ...new Set([
      ...stateWfViews.map((v) => `${wfByName.get(v.source.name)!.name}Row`),
      ...projViews.map((v) => `${projByName.get(v.source.name)!.name}Row`),
    ]),
  ].sort();
  // ES workflow-view fold helpers (`_load_all_<wf>`), reused from `app.dispatch`
  // so the read mirrors the dispatch-handler / instance-LIST load machinery.
  const esLoadAll = [
    ...new Set(esWfViews.map((v) => esFns(wfByName.get(v.source.name)!).loadAll)),
  ].sort();
  // Authorization gates: any `view … requires <expr>` pulls in ForbiddenError;
  // a currentUser-referencing gate additionally threads `Request` + the `User`
  // principal type.  `requires true` needs only ForbiddenError.
  const anyGate = [...views, ...wfViews, ...projViews].some((v) => v.requires);
  const anyGateUsesUser = [...views, ...wfViews, ...projViews].some((v) => viewGateNeedsUser(v));
  // Shorthand projection views (no `view.output`) return the raw `<Proj>Row`
  // rows as the projection's `<Proj>ListResponse` — reuse the type the v1
  // `GET /projections/<name>` endpoint already emits (projections_routes.py).
  const projListResponses = [
    ...new Set(projViews.filter((v) => !v.output).map((v) => `${v.source.name}ListResponse`)),
  ].sort();
  // A projection full-form view wraps each length-1 follow id (a nullable
  // `<Proj>Row` column) in the target aggregate's id NewType before the
  // `find_many_by_ids` bulk-load — import those `<Agg>Id` constructors.
  const projIdTypes = [
    ...new Set(
      projViews.flatMap((v) =>
        (v.output?.auxiliaries ?? [])
          .filter((a) => a.path.length === 1)
          .map((a) => `${a.aggName}Id`),
      ),
    ),
  ]
    .filter(refersTo)
    .sort();

  return lines(
    `"""Read-model view routes.  Auto-generated."""`,
    "",
    needsMath ? "import math" : null,
    needsRe ? "import re" : null,
    // A5 temporal — a view filter can bind `datetime.now(UTC)` (value-side
    // `now()`) or reach for `timedelta` (ES in-memory filters).
    dtImportLine(refersTo),
    needsMath || needsRe || dtImportLine(refersTo) != null ? "" : null,
    `from fastapi import APIRouter, Depends${anyGateUsesUser ? ", Request" : ""}`,
    models.length > 0 || wfModels.length > 0 ? "from pydantic import BaseModel, RootModel" : null,
    saOps.size > 0 ? `from sqlalchemy import ${[...saOps].sort().join(", ")}` : null,
    "from sqlalchemy.ext.asyncio import AsyncSession",
    "from typing import Annotated",
    "",
    "from app.db.engine import get_session",
    ...repoAggs.map((n) => `from app.db.repositories.${snake(n)}_repository import ${n}Repository`),
    schemaRows.length > 0 ? `from app.db.schema import ${schemaRows.join(", ")}` : null,
    projIdTypes.length > 0 ? `from app.domain.ids import ${projIdTypes.join(", ")}` : null,
    projListResponses.length > 0
      ? `from app.http.projections_routes import ${projListResponses.join(", ")}`
      : null,
    esLoadAll.length > 0 ? `from app.dispatch import ${esLoadAll.join(", ")}` : null,
    wireHelperImport(refersTo),
    hasDispatch && refersTo("make_dispatcher") ? "from app.dispatch import make_dispatcher" : null,
    !hasDispatch && refersTo("NoopDomainEventDispatcher")
      ? "from app.domain.events import NoopDomainEventDispatcher"
      : null,
    voEnumNames.length > 0
      ? `from app.domain.value_objects import ${voEnumNames.join(", ")}`
      : null,
    anyGate ? "from app.domain.errors import ForbiddenError" : null,
    anyGateUsesUser ? "from app.auth.user import User" : null,
    ...responseAggs.map((n) => {
      const names = [
        refersTo(`${n}ListResponse`) ? `${n}ListResponse` : null,
        refersTo(`${n}Response`) ? `${n}Response` : null,
      ].filter((x): x is string => x != null);
      return `from app.http.${snake(n)}_routes import ${names.join(", ")}`;
    }),
    "",
    "SessionDep = Annotated[AsyncSession, Depends(get_session)]",
    "",
    "",
    body,
    "",
  );
}

function viewRoute(view: ViewIR, dispatcherExpr: string): string {
  const src = view.source.name;
  const fn = snake(view.name);
  const opId = camelId(opView(view.name));
  const repoInit = `    repo = ${src}Repository(session, ${dispatcherExpr})`;
  if (!view.output) {
    return lines(
      `@router.get("/${fn}", response_model=${src}ListResponse, operation_id="${opId}")`,
      `async def ${fn}_view(${viewSig(view)}) -> list[dict[str, object]]:`,
      ...viewGateLines(view),
      repoInit,
      `    return [repo.to_wire(r) for r in await repo.${fn}()]`,
    );
  }
  // Full form: bulk-load follows (dependency order — shortest path
  // first), then project binds per row.
  const out: string[] = [
    `@router.get("/${fn}", response_model=${view.name}Response, operation_id="${opId}")`,
    `async def ${fn}_view(${viewSig(view)}) -> list[dict[str, object]]:`,
    ...viewGateLines(view),
    repoInit,
    `    rows = await repo.${fn}()`,
    ...emitFullFormTail(view, dispatcherExpr),
  ];
  return out.join("\n");
}

/** The full-form projection tail, shared by an aggregate source and a projection
 *  source (both bind `rows`/`r`): bulk-load every foreign aggregate referenced by
 *  an `X id` follow (dependency order, shortest path first — length-1 paths
 *  source from `rows`, longer ones from a prior map), then project each row
 *  through the bind expressions with the follow rewrites.  Row acquisition is the
 *  caller's job (repo find vs. `<Proj>Row` table select), so this tail is
 *  source-agnostic — the Python port of Hono's `emitFullFormTail`. */
function emitFullFormTail(view: ViewIR, dispatcherExpr: string, projectionRows = false): string[] {
  const out: string[] = [];
  const pathToMap = new Map<string, { mapVar: string; aggName: string }>();
  for (const aux of view.output!.auxiliaries) {
    const mapVar = snake(aux.mapVar);
    const repoVar = `${snake(aux.aggName)}_repo`;
    out.push(`    ${repoVar} = ${aux.aggName}Repository(session, ${dispatcherExpr})`);
    const idsSource =
      aux.path.length === 1
        ? // Length-1 ids source straight from the rows.  Projection `<Proj>Row`
          // columns are nullable `str` (a fold upserts partial rows), so wrap each
          // in the target aggregate's id NewType and drop NULLs to satisfy
          // `find_many_by_ids(list[<Agg>Id])` under mypy --strict; aggregate rows
          // already carry the id-typed field, so their source stays bare.
          projectionRows
          ? `[${aux.aggName}Id(r.${snake(aux.path[0]!)}) for r in rows if r.${snake(aux.path[0]!)} is not None]`
          : `[r.${snake(aux.path[0]!)} for r in rows]`
        : (() => {
            const prev = pathToMap.get(aux.path.slice(0, -1).join("."));
            const finalField = snake(aux.path[aux.path.length - 1]!);
            return prev ? `[a.${finalField} for a in ${prev.mapVar}.values()]` : "[]";
          })();
    out.push(
      `    ${mapVar} = {str(a.id): a for a in await ${repoVar}.find_many_by_ids(${idsSource})}`,
    );
    pathToMap.set(aux.path.join("."), { mapVar, aggName: aux.aggName });
  }
  out.push("    return [");
  out.push("        {");
  for (const b of view.output!.binds) {
    out.push(`            "${b.name}": ${renderBind(b.expr, b.type, pathToMap)},`);
  }
  out.push("        }");
  out.push("        for r in rows");
  out.push("    ]");
  return out;
}

// --- projection-sourced views (projection.md v1.1) ------------------------

/** `GET /views/<view>` over a projection's `<Proj>Row` read-model table.  Rows
 *  come from a direct `select(<Proj>Row)` with the shorthand filter lowered to a
 *  SQLAlchemy `where` (SQL-pushed, no repository — the exact analogue of the
 *  state-based workflow-view arm).  Full-form views then run the shared
 *  aggregate bind-projection tail (foreign-repo bulk-load + `X id` follow) over
 *  those rows; shorthand views return the raw rows as the projection's
 *  `<Proj>ListResponse` (the v1 read endpoint's shape). */
function projectionViewRoute(
  view: ViewIR,
  proj: ProjectionIR,
  pred: PyPredicate | null,
  dispatcherExpr: string,
): string {
  const fn = snake(view.name);
  const opId = camelId(opView(view.name));
  const row = `${proj.name}Row`;
  const where = pred ? `.where(${pred.expr})` : "";
  const responseModel = view.output ? `${view.name}Response` : `${proj.name}ListResponse`;
  const head = [
    `@router.get("/${fn}", response_model=${responseModel}, operation_id="${opId}")`,
    `async def ${fn}_view(${viewSig(view)}) -> list[dict[str, object]]:`,
    ...viewGateLines(view),
    `    rows = (await session.execute(select(${row})${where})).scalars().all()`,
  ];
  if (!view.output) {
    // Shorthand: project each row through the projection's wire shape (camelCase
    // key ← snake column, datetime/money serialised) exactly as the v1
    // `GET /projections/<name>` list route does — the `<Proj>ListResponse` shape.
    const proj_ = (proj.wireShape ?? [])
      .map((f: WireField) => `"${f.name}": ${instanceFieldValue("row", f)}`)
      .join(", ");
    return lines(...head, `    return [{${proj_}} for row in rows]`);
  }
  return [...head, ...emitFullFormTail(view, dispatcherExpr, true)].join("\n");
}

// --- workflow-sourced views (workflow-instance-views.md) ------------------------

/** A workflow-sourced view's response DTOs — `<View>Row` (the source saga's
 *  `instanceWireShape`, id-source rows as `str`) + a `<View>Response` RootModel
 *  list carrier.  Same wire shape the instance endpoints expose, so a curated
 *  saga projection and the raw instance list agree field-for-field. */
function workflowViewModels(view: ViewIR, wf: WorkflowIR, ctx: EnrichedBoundedContextIR): string {
  const fieldLines = (wf.instanceWireShape ?? []).map((f) => {
    const t = f.source === "id" ? "str" : responsePyType(f.type, ctx);
    const optional = f.optional || f.type.kind === "optional";
    const suffix = optional && !t.endsWith("| None") ? " | None = None" : optional ? " = None" : "";
    return `    ${f.name}: ${t}${suffix}`;
  });
  return lines(
    `class ${view.name}Row(BaseModel):`,
    fieldLines.length > 0 ? fieldLines : ["    pass"],
    "",
    "",
    `class ${view.name}Response(RootModel[list[${view.name}Row]]):`,
    "    pass",
    "",
    "",
  );
}

/** `GET /views/<view>` over the source workflow's instance read model.  The
 *  read diverges on `wf.eventSourced`:
 *
 *   - **state-based saga** — selects the `<Wf>Row` correlation table with the
 *     shorthand filter lowered to a SQLAlchemy `where` (SQL-pushed);
 *   - **event-sourced** — has no `<Wf>Row` table, so it group-folds the
 *     `<wf>_events` stream via `_load_all_<wf>` (the same helper the ES instance
 *     LIST route uses) and applies the SAME predicate IN-MEMORY as a Python
 *     boolean over the folded state's attributes (`row.<col>`).
 *
 *  Both paths project through the shared instance wire projection (camelCase key
 *  ← snake column), so operationIds / route paths / the response component are
 *  identical across the two. */
function workflowViewRoute(view: ViewIR, wf: WorkflowIR, pred: PyPredicate | null): string {
  const fn = snake(view.name);
  const proj = (wf.instanceWireShape ?? [])
    .map((f: WireField) => `"${f.name}": ${instanceFieldValue("row", f)}`)
    .join(", ");
  const head = [
    `@router.get("/${fn}", response_model=${view.name}Response, operation_id="${camelId(opView(view.name))}")`,
    `async def ${fn}_view(${viewSig(view)}) -> list[dict[str, object]]:`,
    ...viewGateLines(view),
  ];
  if (wf.eventSourced) {
    const loadAll = esFns(wf).loadAll;
    // In-memory predicate over the folded state — `this.<col>` → `row.<col>`.
    const guard = view.filter ? ` if ${renderPyExpr(view.filter, { thisName: "row" })}` : "";
    return lines(
      ...head,
      `    rows = await ${loadAll}(session)`,
      `    return [{${proj}} for row in rows${guard}]`,
    );
  }
  const row = `${wf.name}Row`;
  const where = pred ? `.where(${pred.expr})` : "";
  return lines(
    ...head,
    `    rows = (await session.execute(select(${row})${where})).scalars().all()`,
    `    return [{${proj}} for row in rows]`,
  );
}

/** Money binds serialize as strings on view rows (TS parity — see the
 *  module header); everything else passes through. */
function renderBind(
  expr: ExprIR,
  type: TypeIR,
  pathToMap: Map<string, { mapVar: string; aggName: string }>,
): string {
  const rendered = renderBindWithFollows(expr, pathToMap);
  if (type.kind === "primitive" && type.name === "money") return `money_str(${rendered})`;
  return rendered;
}

/** Bind expression with `X id` follow rewriting: a member access whose
 *  receiver is id-typed routes through the auxiliary map. */
function renderBindWithFollows(
  expr: ExprIR,
  pathToMap: Map<string, { mapVar: string; aggName: string }>,
): string {
  if (expr.kind === "member" && expr.receiverType.kind === "id") {
    const path = idFollowPath(expr.receiver);
    if (path) {
      const map = pathToMap.get(path.join("."));
      if (map) {
        const receiver = renderIdReceiver(expr.receiver, pathToMap);
        return `${map.mapVar}[str(${receiver})].${snake(expr.member)}`;
      }
    }
  }
  return renderPyExpr(expr, { thisName: "r" });
}

function renderIdReceiver(
  expr: ExprIR,
  pathToMap: Map<string, { mapVar: string; aggName: string }>,
): string {
  if (expr.kind === "ref") return `r.${snake(expr.name)}`;
  if (expr.kind === "member" && expr.receiverType.kind === "id") {
    const path = idFollowPath(expr.receiver);
    if (path) {
      const map = pathToMap.get(path.join("."));
      if (map) {
        const inner = renderIdReceiver(expr.receiver, pathToMap);
        return `${map.mapVar}[str(${inner})].${snake(expr.member)}`;
      }
    }
  }
  return renderPyExpr(expr, { thisName: "r" });
}

// --- authorization gate (D-AUTH-OIDC / default-deny) ----------------------

/** True when a view's `requires` gate references currentUser — the route then
 *  threads the request principal in (`request: Request`). */
function viewGateNeedsUser(view: ViewIR): boolean {
  return !!view.requires && exprUsesCurrentUser(view.requires);
}

/** The view route's parameter list.  `request: Request` is threaded in only
 *  when a currentUser-referencing gate needs the principal; `requires true`
 *  (and ungated views) keep the bare `session` signature. */
function viewSig(view: ViewIR): string {
  return viewGateNeedsUser(view) ? "request: Request, session: SessionDep" : "session: SessionDep";
}

/** Authorization-gate body lines: a 403 raised before the query when the
 *  `requires` predicate fails — the read-side analogue of an operation's
 *  `requires`.  Mirrors render-stmt's `requires` (ForbiddenError → 403 via the
 *  app exception handler). */
function viewGateLines(view: ViewIR): string[] {
  if (!view.requires) return [];
  const out: string[] = [];
  if (viewGateNeedsUser(view)) out.push(`    current_user: User = request.state.current_user`);
  out.push(`    if not (${renderPyExpr(view.requires)}):`);
  out.push(`        raise ForbiddenError(${JSON.stringify(`Forbidden: view ${view.name}`)})`);
  return out;
}

function idFollowPath(e: ExprIR): string[] | undefined {
  if (e.kind === "ref" && e.type?.kind === "id") return [e.name];
  if (e.kind === "member" && e.receiverType.kind === "id") {
    const inner = idFollowPath(e.receiver);
    if (!inner) return undefined;
    return [...inner, e.member];
  }
  return undefined;
}

/** Pydantic type for a view-row field (mirrors Hono's zodForRow —
 *  money is a string on view rows, datetimes ride as ISO strings). */
function rowFieldType(t: TypeIR): string {
  switch (t.kind) {
    case "primitive":
      switch (t.name) {
        case "int":
        case "long":
          return "int";
        case "decimal":
          return "float";
        case "money":
        case "string":
        case "guid":
        case "datetime":
          return "str";
        case "bool":
          return "bool";
        default:
          return "object";
      }
    case "id":
      return "str";
    case "enum":
      return t.name;
    case "array":
      return `list[${rowFieldType(t.element)}]`;
    case "optional":
      return `${rowFieldType(t.inner)} | None`;
    default:
      return "object";
  }
}

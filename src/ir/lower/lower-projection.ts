// ⑤a lowering — projection read models (projection.md + read-path-architecture.md
// rev.13 § "projection generalises").
//
// A projection is a derived read model.  Two flavors share one declaration:
//
//   • FOLDED (today's projection) — declared state fields + pure `on(e: Event)`
//     folds over FOREIGN events, `keyed by` a correlation column.  Materialized.
//   • QUERY-TIME (the query-time projection read) — a LINQ/SQL-shaped comprehension:
//     `from <Source> [as a]` / `where <criterion>` / `join <Agg> as c on <idRef>`
//     / `select field = …`.  Computed per read, always-current.
//
// Every "mode" fact is DERIVED from clause presence (never stamped): folds
// present ⇒ materialized (`isMaterializedProjection`); no `keyed by` ⇒ singleton
// (`isSingletonProjection`); a `from` with no folds ⇒ query-time.  The fold body
// is lowered PURE (`lowerStatement`, like an aggregate `apply`); the query
// expressions are Loom's one candidate-rooted language (the same `criterion`
// dialect), so `where` composes named criteria and the source alias resolves
// exactly like `criterion … of T as o`.
//
// Leaf discipline (pipeline-layering): imports only sibling leaves, never the
// `lower.ts` orchestrator.

import type { Projection, ProjectionOn } from "../../language/generated/ast.js";
import { isAggregate, isProjection, isProperty, isWorkflow } from "../../language/generated/ast.js";
import type {
  FieldIR,
  ProjectionIR,
  ProjectionJoinIR,
  ProjectionOnIR,
  ProjectionQueryIR,
  StmtIR,
} from "../types/loom-ir.js";
import { joinRefPath, mapVarForPath } from "./id-follow.js";
import { resolveBypass } from "./lower-capabilities.js";
import { criterionRefOf, inferExprType, lowerExpr } from "./lower-expr.js";
import { lowerField } from "./lower-members.js";
import { lowerStatement } from "./lower-stmt.js";
import {
  type Env,
  inAggregate,
  inProjection,
  inWorkflow,
  lowerType,
  withLocal,
} from "./lower-types.js";
import { originFor } from "./origin.js";

/** Lower a `projection <Name>[(params)] [keyed by <field>] { … }` declaration.
 *  The env arrives at context scope; `inProjection` binds `this` to the row so
 *  bare state-field names (`status := Shipped`, or a hybrid `join … on customer`)
 *  resolve as `this`-props. */
export function lowerProjection(p: Projection, env: Env): ProjectionIR {
  const projEnv = inProjection(env, p);
  const stateFields: FieldIR[] = p.members.filter(isProperty).map((m) => lowerField(m, projEnv));
  const handlers: ProjectionOnIR[] = [];
  for (const m of p.members) {
    if (isProjectionOnMember(m)) handlers.push(lowerProjectionOn(m, projEnv));
  }
  return {
    name: p.name,
    params: p.params.map((param) => ({ name: param.name, type: lowerType(param.type) })),
    stateFields,
    // `keyed by` is OPTIONAL now: present ⇒ keyed (validation confirms it names
    // a declared id-shaped state field, `loom.projection-key-*`); absent ⇒ a
    // SINGLETON (one row) — `correlationField` stays undefined.
    ...(p.key ? { correlationField: p.key } : {}),
    handlers,
    ...(hasQueryClauses(p) ? { query: lowerProjectionQuery(p, env) } : {}),
    origin: originFor(p),
  };
}

/** Whether the projection declares any query-time comprehension clause. */
function hasQueryClauses(p: Projection): boolean {
  return !!p.source || !!p.gate || !!p.filter || p.joins.length > 0 || p.selects.length > 0;
}

/** Lower the query-time comprehension (`from`/`where`/`join`/`select`).
 *  The candidate scope is the `from` source (`inAggregate` + the author's alias,
 *  reusing the criterion `candidateAlias` binder) when present, else the
 *  projection row itself (`inProjection`, the folded+`join` hybrid — joins
 *  resolve stored id columns).  Params bind as locals; each join alias binds as
 *  an entity-typed local so `c.name` in `select`/`where` resolves. */
function lowerProjectionQuery(p: Projection, env: Env): ProjectionQueryIR {
  const sourceRef = p.source?.ref;
  const sourceName = sourceRef?.name ?? p.source?.$refText;
  const sourceIsWorkflow = !!sourceRef && isWorkflow(sourceRef);
  // A `from <Projection>` source — reads a projection's read-model row.  Distinct
  // from the no-`from` folded+join hybrid (which also binds via `inProjection` but
  // has no `sourceRef`).  A self-source (`from <Self>`) is admitted here so the
  // validator can reject the cycle (`loom.projection-source-self`).
  const sourceIsProjection = !!sourceRef && isProjection(sourceRef);

  // Candidate scope: the `from` source.  An AGGREGATE binds `this`/alias to its
  // fields (`inAggregate`, aliased like `criterion … of T as o`); a WORKFLOW
  // binds `this`/alias to its instance state fields (`inWorkflow`); another
  // PROJECTION binds `this`/alias to its read-model row fields (`inProjection`
  // over the SOURCE projection) — the same source-agnostic predicate machinery
  // the removed workflow/projection-source view used.  No `from` ⇒ the current
  // projection row itself (folded+join hybrid).
  let scope: Env = { ...env, locals: new Map() };
  if (sourceRef && isAggregate(sourceRef)) {
    scope = inAggregate(scope, sourceRef);
    if (p.sourceAlias) scope = { ...scope, candidateAlias: p.sourceAlias };
  } else if (sourceRef && isWorkflow(sourceRef)) {
    scope = inWorkflow(scope, sourceRef);
    if (p.sourceAlias) scope = { ...scope, candidateAlias: p.sourceAlias };
  } else if (sourceIsProjection) {
    scope = inProjection(scope, sourceRef);
    if (p.sourceAlias) scope = { ...scope, candidateAlias: p.sourceAlias };
  } else {
    scope = inProjection(scope, p);
  }
  // Query parameters resolve as `param` locals inside `where`/`select`.
  for (const param of p.params) {
    scope = withLocal(scope, param.name, "param", lowerType(param.type));
  }

  // Joins bind incrementally: a multi-hop chain (`join Region as r on c.regionId`)
  // reads the earlier alias, so each `on <idRef>` lowers in the env that already
  // carries the prior aliases.  Each join is one bulk-load auxiliary.
  const joins: ProjectionJoinIR[] = [];
  const auxiliaries: ProjectionQueryIR["auxiliaries"] = [];
  for (const j of p.joins) {
    const idRef = lowerExpr(j.idRef, scope);
    const joinedAgg = j.aggregate?.ref;
    const aggName = joinedAgg?.name ?? j.aggregate?.$refText ?? "Unknown";
    joins.push({ aggregate: aggName, alias: j.alias, idRef });
    const refPath = joinRefPath(idRef);
    const path = refPath.length > 0 ? refPath : [j.alias];
    auxiliaries.push({ path, aggName, mapVar: mapVarForPath(path, aggName) });
    // Bind the loaded aggregate under its alias for downstream clauses.
    scope = withLocal(scope, j.alias, "let", { kind: "entity", name: aggName });
  }

  const selects = p.selects.map((s) => ({
    field: s.field,
    expr: lowerExpr(s.expr, scope),
    type: inferExprType(s.expr, scope),
  }));

  const query: ProjectionQueryIR = { joins, auxiliaries, ...resolveBypass(p) };
  if (sourceIsWorkflow) query.sourceKind = "workflow";
  else if (sourceIsProjection) query.sourceKind = "projection";
  // The `requires` gate lowers in the BARE context env (not `scope`), so
  // `currentUser` resolves but the source row's fields do not — it decides
  // endpoint access before any row exists, so it may reference only the
  // principal (+ constants).  A source-field ref is then an unknown ref the
  // validator rejects (the projection twin of the find gate).
  if (p.gate) query.requires = lowerExpr(p.gate, env);
  if (sourceName) query.source = sourceName;
  if (p.sourceAlias) query.sourceAlias = p.sourceAlias;
  if (p.filter) {
    query.filter = lowerExpr(p.filter, scope);
    const ref = criterionRefOf(p.filter, scope);
    if (ref) query.criterionRef = ref;
  }
  if (selects.length > 0) query.selects = selects;
  return query;
}

/** A pure fold over one foreign event.  Binds the event param as a
 *  `refKind: "param"` local typed as the event entity (so `e.field` resolves),
 *  then lowers the body PURE against the projection-bound `this`. */
function lowerProjectionOn(o: ProjectionOn, projEnv: Env): ProjectionOnIR {
  const eventName = o.event.ref?.name ?? o.event.$refText;
  const inner = withLocal(projEnv, o.param, "param", { kind: "entity", name: eventName });
  const correlation = o.correlation ? lowerExpr(o.correlation, inner) : undefined;
  const statements: StmtIR[] = [];
  let bodyEnv = inner;
  for (const s of o.body) {
    const result = lowerStatement(s, bodyEnv);
    statements.push(result.stmt);
    bodyEnv = result.envAfter;
  }
  return {
    event: eventName,
    param: o.param,
    ...(correlation ? { correlation } : {}),
    statements,
  };
}

// `ProjectionMember = ProjectionOn | Property`; the generated `isProjectionOn`
// guard is imported lazily to keep this leaf's import surface minimal.
function isProjectionOnMember(m: Projection["members"][number]): m is ProjectionOn {
  return m.$type === "ProjectionOn";
}

import type {
  ActionIR,
  AggregateIR,
  BoundedContextIR,
  ComponentIR,
  CriterionIR,
  DerivedIR,
  DomainServiceIR,
  EntityPartIR,
  ExprIR,
  FieldIR,
  FindIR,
  FunctionIR,
  InvariantIR,
  LayoutIR,
  LoomModel,
  MenuBlockIR,
  MenuMetaIR,
  OperationIR,
  PageIR,
  ParamIR,
  ProjectionIR,
  ProjectionQueryIR,
  RepositoryIR,
  RetrievalIR,
  SeedIR,
  StateFieldIR,
  StoreIR,
  SystemIR,
  TestIR,
  TestStmtIR,
  UiIR,
  ValueObjectIR,
  WireField,
  WorkflowIR,
} from "../types/loom-ir.js";
import { walkExprDeep, walkStmtExprsDeep, walkWorkflowStmtExprsDeep } from "./walk.js";

// ---------------------------------------------------------------------------
// The MODEL-WIDE EXPRESSION ENUMERATION — one outer loop over every place a
// `LoomModel` can hold an expression (M-T9.40).
//
// WHY IT EXISTS.  Eleven modules under `src/ir/validate/checks/` and
// `src/ir/enrich/` each roll their own outer loop over the model's
// expression-bearing sites, and they disagree about which sites exist.
// `validateExprIntegrity` — the check whose name claims the whole surface —
// reached 2,316 of the 3,609 expressions in five examples.  It carried its own
// outer loop over page body/title/requires/state plus the aggregate/workflow
// domain sites, and skipped every find filter, criterion, retrieval, domain
// service, command/query handler, seed value, field default, context filter
// and stamp, every test, every value-object and entity-part member, and — on
// the UI side it partly covered — every component, store, action, named
// layout, menu and notification.
// So "does this check reach every expression" had no answer anywhere in the
// tree, and a check that reads as total was silently 36% partial.  That
// number is an A/B measurement against this module, not an estimate: the
// first two estimates of it, made by reading the source, were both wrong.
//
// TWO HALVES, ONLY ONE OF WHICH WAS SOLVED.  `walk.ts` owns the INTRA
// -expression recursion exhaustively — `walkExprChildren` switches on `kind`
// with a `never` default, so a new `ExprIR` arm fails the build.  This module
// owns the other half: the walk over DECLARATIONS that reaches those
// expressions in the first place.  It delegates every descent into an
// expression or statement to `walk.ts` rather than re-implementing it.
//
// WHY IT IS EXPLICIT RATHER THAN GENERIC.  The obvious cheap version —
// descend structurally and treat any `{ kind: … }` object tagged with an
// `ExprIR` kind as an expression — needs no per-type knowledge and would be
// total over the actual data for free.  It is unsafe here, because the tag
// namespaces OVERLAP: `id` and `primitive` are both `ExprIR` kinds and `TypeIR`
// kinds, and `call` is both an `ExprIR` kind and a `StmtIR` kind.  Such a walk
// would hand a `TypeIR` to an expression consumer, or skip a real expression,
// depending on which disambiguation rule it guessed — and mis-visiting
// silently is the exact failure class this module exists to remove.
//
// SO WHAT STOPS *THIS* FROM BEING PARTIAL?  `SITES` below names every census
// site this module handles, and `test/ir/model-exprs-completeness.test.ts`
// asserts it equals the census computed independently from `loom-ir.ts`'s own
// declarations (`test/_helpers/expr-sites.ts`).  Add an expression-bearing
// field to the IR and that gate fails until this module acknowledges it.  Two
// derivations of one contract, with a gate between them — which is the part
// the previous eleven walks were missing.
// ---------------------------------------------------------------------------

/** One expression, with where it came from. */
export interface ExprVisit {
  readonly expr: ExprIR;
  /** Human-readable path — `Ctx/Agg/op` — for diagnostics. */
  readonly source: string;
  /** The census site id (`OperationIR.statements`) whose root this expression
   *  was reached through.  Lets a consumer report WHICH declaration site a
   *  finding sits on, and lets the completeness gate check reachability
   *  dynamically as well as statically. */
  readonly site: string;
  /** True when this expression sits on the UI side — a page, component, store,
   *  menu, layout or notification — rather than in domain / application code.
   *
   *  It is a fact only the WALK has: the same site id occurs on both sides
   *  (`DerivedIR.expr` is an aggregate's derived property and a page's
   *  `derived` alike; `ActionIR.body` belongs to a page and to a store), so a
   *  consumer cannot recover it from `site`, and `source` is a display string
   *  rather than a structure.  The checks that gate a construct as
   *  render-scope-only (`loom.collection-op-in-ui`) need exactly this. */
  readonly ui: boolean;
}

export type ExprVisitor = (v: ExprVisit) => void;

/**
 * Every census site this module handles.
 *
 * `visited` are walked.  `aliased` are the `Enriched*` branded subtypes, whose
 * fields ARE the base type's fields — the walk takes the base and reaches them
 * there, so listing them again would double-count rather than add coverage.
 * `inert` are sites whose expression is not part of the model's semantics.
 *
 * Every entry in `inert` is a decision, not an oversight: state the reason, and
 * expect it to be argued with.
 */
export const SITES = {
  visited: new Set<string>([
    "ActionIR.body",
    "ActionIR.params",
    "AggregateIR.appliers",
    "AggregateIR.canonicalCreate",
    "AggregateIR.canonicalDestroy",
    "AggregateIR.contextFilterRefs",
    "AggregateIR.contextFilters",
    "AggregateIR.contextStamps",
    "AggregateIR.createInput",
    "AggregateIR.creates",
    "AggregateIR.derived",
    "AggregateIR.destroys",
    "AggregateIR.displayDerived",
    "AggregateIR.fields",
    "AggregateIR.functions",
    "AggregateIR.inspectDerived",
    "AggregateIR.invariants",
    "AggregateIR.operations",
    "AggregateIR.parts",
    "AggregateIR.tests",
    "AggregateIR.writeScopeFilter",
    "ApplyIR.statements",
    "BackfillIntentIR.value",
    "BoundedContextIR.aggregates",
    "BoundedContextIR.commandHandlers",
    "BoundedContextIR.criteria",
    "BoundedContextIR.domainServices",
    "BoundedContextIR.events",
    "BoundedContextIR.payloads",
    "BoundedContextIR.projections",
    "BoundedContextIR.queryHandlers",
    "BoundedContextIR.repositories",
    "BoundedContextIR.retrievals",
    "BoundedContextIR.seeds",
    "BoundedContextIR.tests",
    "BoundedContextIR.valueObjects",
    "BoundedContextIR.workflows",
    "CommandHandlerIR.params",
    "CommandHandlerIR.returnValue",
    "CommandHandlerIR.statements",
    "ComponentIR.actions",
    "ComponentIR.body",
    "ComponentIR.derived",
    "ComponentIR.params",
    "ComponentIR.state",
    "ContextStampAssignmentIR.value",
    "ContextStampIR.assignments",
    "CreateInputFieldIR.field",
    "CreateIR.correlation",
    "CreateIR.params",
    "CreateIR.statements",
    "CriterionIR.body",
    "CriterionIR.params",
    "DerivedIR.expr",
    "DomainServiceIR.operations",
    "DomainServiceIR.tests",
    "DomainServiceOperationIR.body",
    "DomainServiceOperationIR.params",
    "EntityPartIR.derived",
    "EntityPartIR.fields",
    "EntityPartIR.functions",
    "EntityPartIR.invariants",
    "EventIR.fields",
    "FieldIR.default",
    "FieldIR.maskUnless",
    "FindIR.criterionRef",
    "FindIR.filter",
    "FindIR.params",
    "FindIR.requires",
    "FunctionBodyIR.expr",
    "FunctionBodyIR.stmts",
    "FunctionIR.body",
    "FunctionIR.params",
    "HandleIR.params",
    "HandleIR.statements",
    "InvariantIR.expr",
    "InvariantIR.guard",
    "LayoutIR.footer",
    "LayoutIR.header",
    "LayoutIR.sidebar",
    "LoomModel.backfillIntents",
    "LoomModel.components",
    "LoomModel.contexts",
    "LoomModel.rootPayloads",
    "LoomModel.rootValueObjects",
    "LoomModel.systems",
    "MenuBlockIR.sections",
    "MenuLinkIR.props",
    "MenuMetaIR.entries",
    "MenuSectionIR.links",
    "OnIR.correlation",
    "OnIR.statements",
    "OperationIR.params",
    "OperationIR.statements",
    "OperationIR.when",
    "PageIR.actions",
    "PageIR.body",
    "PageIR.derived",
    "PageIR.menuMeta",
    "PageIR.params",
    "PageIR.requires",
    "PageIR.state",
    "PageIR.title",
    "ParamIR.default",
    "PayloadIR.fields",
    "ProjectionAggregateIR.arg",
    "ProjectionIR.handlers",
    "ProjectionIR.params",
    "ProjectionIR.query",
    "ProjectionIR.stateFields",
    "ProjectionIR.wireShape",
    "ProjectionJoinIR.idRef",
    "ProjectionOnIR.correlation",
    "ProjectionOnIR.statements",
    "ProjectionQueryIR.criterionRef",
    "ProjectionQueryIR.filter",
    "ProjectionQueryIR.groupBy",
    "ProjectionQueryIR.joins",
    "ProjectionQueryIR.requires",
    "ProjectionQueryIR.selects",
    "QueryHandlerIR.params",
    "QueryHandlerIR.returnValue",
    "QueryHandlerIR.statements",
    "RepositoryIR.finds",
    "RepositoryIR.historyFind",
    "RetrievalIR.criterionRef",
    "RetrievalIR.params",
    "RetrievalIR.where",
    "SeedIR.rows",
    "SeedRowIR.fields",
    "StateFieldIR.init",
    "StoreIR.actions",
    "StoreIR.state",
    "SubdomainIR.contexts",
    "SystemIR.e2eTests",
    "SystemIR.layouts",
    "SystemIR.subdomains",
    "SystemIR.uis",
    "SystemIR.user",
    "TestE2EIR.statements",
    "TestIR.statements",
    "TestStmtIR.expr",
    "UiFunctionIR.params",
    "UiIR.components",
    "UiIR.functions",
    "UiIR.menu",
    "UiIR.notifications",
    "UiIR.pages",
    "UiIR.stores",
    "UiNotificationIR.toasts",
    "UserIR.fields",
    "ValueObjectIR.derived",
    "ValueObjectIR.fields",
    "ValueObjectIR.functions",
    "ValueObjectIR.invariants",
    "ValueObjectIR.tests",
    "WireField.maskUnless",
    "WorkflowIR.appliers",
    "WorkflowIR.creates",
    "WorkflowIR.functions",
    "WorkflowIR.handlers",
    "WorkflowIR.instanceReadGate",
    "WorkflowIR.instanceWireShape",
    "WorkflowIR.params",
    "WorkflowIR.stateFields",
    "WorkflowIR.statements",
    "WorkflowIR.subscriptions",
  ]),
  /** `Enriched*` are branded subtypes of the plain IR types; the walk takes the
   *  base and reaches these fields through it. */
  aliased: new Set<string>([
    "EnrichedAggregateIR.createInput",
    "EnrichedAggregateIR.parts",
    "EnrichedBoundedContextIR.aggregates",
    "EnrichedBoundedContextIR.valueObjects",
    "EnrichedLoomModel.contexts",
    "EnrichedLoomModel.rootValueObjects",
    "EnrichedLoomModel.systems",
    "EnrichedSubdomainIR.contexts",
    "EnrichedSystemIR.subdomains",
  ]),
  inert: new Map<string, string>([]),
} as const;

// ---------------------------------------------------------------------------
// The walk.  One function per owner; each states its sites in the order they
// appear in `SITES.visited`, so the two stay legibly in step.
// ---------------------------------------------------------------------------

/** Hand one root expression (and everything under it) to the visitor. */
const expr = (e: ExprIR | undefined, source: string, site: string, v: ExprVisitor): void =>
  walkExprDeep(e, (x) => v({ expr: x, source, site, ui: false }));

/** Hand every expression under a statement list to the visitor.  Generic over
 *  the statement family so each caller supplies its own already-typed list and
 *  the `walk.ts` walker that belongs to it — the three families (`StmtIR`,
 *  `WorkflowStmtIR`, and the test-statement union) share this shape and nothing
 *  else, and inference ties the two arguments together without an `any`. */
function stmts<S>(
  list: readonly S[] | undefined,
  source: string,
  site: string,
  v: ExprVisitor,
  walker: (s: S, visit: (e: ExprIR) => void) => void,
): void {
  for (const s of list ?? []) walker(s, (x) => v({ expr: x, source, site, ui: false }));
}

function visitParams(
  ps: readonly ParamIR[] | undefined,
  src: string,
  site: string,
  v: ExprVisitor,
) {
  for (const p of ps ?? []) expr(p.default, `${src}/${p.name}`, "ParamIR.default", v);
  void site;
}

function visitFields(fs: readonly FieldIR[] | undefined, src: string, v: ExprVisitor) {
  for (const f of fs ?? []) {
    expr(f.default, `${src}/${f.name}`, "FieldIR.default", v);
    expr(f.maskUnless, `${src}/${f.name}`, "FieldIR.maskUnless", v);
  }
}

function visitWireShape(ws: readonly WireField[] | undefined, src: string, v: ExprVisitor) {
  for (const w of ws ?? []) expr(w.maskUnless, `${src}/${w.name}`, "WireField.maskUnless", v);
}

function visitDerived(ds: readonly DerivedIR[] | undefined, src: string, v: ExprVisitor) {
  for (const d of ds ?? []) expr(d.expr, `${src}/${d.name}`, "DerivedIR.expr", v);
}

function visitInvariants(is: readonly InvariantIR[] | undefined, src: string, v: ExprVisitor) {
  for (const i of is ?? []) {
    expr(i.expr, src, "InvariantIR.expr", v);
    expr(i.guard, src, "InvariantIR.guard", v);
  }
}

function visitFunctions(fs: readonly FunctionIR[] | undefined, src: string, v: ExprVisitor) {
  for (const f of fs ?? []) {
    const s = `${src}/${f.name}`;
    visitParams(f.params, s, "FunctionIR.params", v);
    if ("expr" in f.body) expr(f.body.expr, s, "FunctionBodyIR.expr", v);
    else stmts(f.body.stmts, s, "FunctionBodyIR.stmts", v, walkStmtExprsDeep);
  }
}

function visitStateFields(ss: readonly StateFieldIR[] | undefined, src: string, v: ExprVisitor) {
  for (const s of ss ?? []) expr(s.init, `${src}/${s.name}`, "StateFieldIR.init", v);
}

function visitActions(as: readonly ActionIR[] | undefined, src: string, v: ExprVisitor) {
  for (const a of as ?? []) {
    const s = `${src}/${a.name}`;
    visitParams(a.params, s, "ActionIR.params", v);
    stmts(a.body, s, "ActionIR.body", v, walkStmtExprsDeep);
  }
}

function visitTests(ts: readonly TestIR[] | undefined, src: string, v: ExprVisitor) {
  for (const t of ts ?? [])
    visitTestStmts(t.statements, `${src}/${t.name}`, "TestIR.statements", v);
}

/** `TestStmtIR` is `StmtIR | expect | expect-throws` — the two assertion arms
 *  are NOT `StmtIR`, so `walkStmtExprsDeep` alone would silently drop them.
 *  `walk.ts` has no TestStmt walker to delegate to; this is the seam. */
function visitTestStmts(
  list: readonly TestStmtIR[] | undefined,
  src: string,
  site: string,
  v: ExprVisitor,
): void {
  for (const s of list ?? []) {
    if (s.kind === "expect" || s.kind === "expect-throws") {
      expr(s.expr, src, "TestStmtIR.expr", v);
      continue;
    }
    walkStmtExprsDeep(s, (x) => v({ expr: x, source: src, site, ui: false }));
  }
}

function visitOperation(op: OperationIR, src: string, v: ExprVisitor) {
  const s = `${src}/${op.name}`;
  visitParams(op.params, s, "OperationIR.params", v);
  stmts(op.statements, s, "OperationIR.statements", v, walkStmtExprsDeep);
  expr(op.when, s, "OperationIR.when", v);
}

function visitFind(f: FindIR, src: string, v: ExprVisitor) {
  const s = `${src}/${f.name}`;
  visitParams(f.params, s, "FindIR.params", v);
  expr(f.requires, s, "FindIR.requires", v);
  expr(f.filter, s, "FindIR.filter", v);
  for (const a of f.criterionRef?.args ?? []) expr(a, s, "FindIR.criterionRef", v);
}

function visitRepository(r: RepositoryIR, src: string, v: ExprVisitor) {
  const s = `${src}/${r.name}`;
  for (const f of r.finds) visitFind(f, s, v);
  if (r.historyFind) visitFind(r.historyFind, s, v);
}

function visitPart(p: EntityPartIR, src: string, v: ExprVisitor) {
  const s = `${src}/${p.name}`;
  visitFields(p.fields, s, v);
  visitDerived(p.derived, s, v);
  visitInvariants(p.invariants, s, v);
  visitFunctions(p.functions, s, v);
}

function visitValueObject(vo: ValueObjectIR, src: string, v: ExprVisitor) {
  const s = `${src}/${vo.name}`;
  visitFields(vo.fields, s, v);
  visitDerived(vo.derived, s, v);
  visitInvariants(vo.invariants, s, v);
  visitFunctions(vo.functions, s, v);
  visitTests(vo.tests, s, v);
}

function visitAggregate(a: AggregateIR, src: string, v: ExprVisitor) {
  const s = `${src}/${a.name}`;
  visitFields(a.fields, s, v);
  for (const ci of a.createInput ?? []) visitFields([ci.field], `${s}/createInput`, v);
  visitDerived(a.derived, s, v);
  if (a.displayDerived) visitDerived([a.displayDerived], s, v);
  if (a.inspectDerived) visitDerived([a.inspectDerived], s, v);
  visitInvariants(a.invariants, s, v);
  visitFunctions(a.functions, s, v);
  visitTests(a.tests, s, v);
  for (const op of a.operations) visitOperation(op, s, v);
  for (const op of a.creates ?? []) visitOperation(op, s, v);
  for (const op of a.destroys ?? []) visitOperation(op, s, v);
  if (a.canonicalCreate) visitOperation(a.canonicalCreate, s, v);
  if (a.canonicalDestroy) visitOperation(a.canonicalDestroy, s, v);
  for (const ap of a.appliers ?? []) {
    stmts(ap.statements, `${s}/apply(${ap.event})`, "ApplyIR.statements", v, walkStmtExprsDeep);
  }
  for (const f of a.contextFilters ?? []) expr(f, s, "AggregateIR.contextFilters", v);
  for (const r of a.contextFilterRefs ?? []) {
    for (const arg of r?.args ?? []) expr(arg, s, "AggregateIR.contextFilterRefs", v);
  }
  expr(a.writeScopeFilter, s, "AggregateIR.writeScopeFilter", v);
  for (const st of a.contextStamps ?? []) {
    for (const as of st.assignments) {
      expr(as.value, `${s}/stamp(${st.event})`, "ContextStampAssignmentIR.value", v);
    }
  }
  for (const p of a.parts) visitPart(p, s, v);
}

function visitWorkflow(w: WorkflowIR, src: string, v: ExprVisitor) {
  const s = `${src}/${w.name}`;
  visitParams(w.params, s, "WorkflowIR.params", v);
  stmts(w.statements, s, "WorkflowIR.statements", v, walkWorkflowStmtExprsDeep);
  visitFields(w.stateFields, s, v);
  visitWireShape(w.instanceWireShape, s, v);
  expr(w.instanceReadGate, s, "WorkflowIR.instanceReadGate", v);
  visitFunctions(w.functions, s, v);
  for (const c of w.creates) {
    const cs = `${s}/create(${c.name ?? ""})`;
    visitParams(c.params, cs, "CreateIR.params", v);
    expr(c.correlation, cs, "CreateIR.correlation", v);
    stmts(c.statements, cs, "CreateIR.statements", v, walkWorkflowStmtExprsDeep);
  }
  for (const o of w.subscriptions ?? []) {
    const os = `${s}/on(${o.event})`;
    expr(o.correlation, os, "OnIR.correlation", v);
    stmts(o.statements, os, "OnIR.statements", v, walkWorkflowStmtExprsDeep);
  }
  for (const h of w.handlers ?? []) {
    const hs = `${s}/${h.name}`;
    visitParams(h.params, hs, "HandleIR.params", v);
    stmts(h.statements, hs, "HandleIR.statements", v, walkWorkflowStmtExprsDeep);
  }
  for (const ap of w.appliers ?? []) {
    stmts(ap.statements, `${s}/apply(${ap.event})`, "ApplyIR.statements", v, walkStmtExprsDeep);
  }
}

function visitProjectionQuery(q: ProjectionQueryIR, src: string, v: ExprVisitor) {
  expr(q.filter, src, "ProjectionQueryIR.filter", v);
  expr(q.requires, src, "ProjectionQueryIR.requires", v);
  for (const a of q.criterionRef?.args ?? []) expr(a, src, "ProjectionQueryIR.criterionRef", v);
  for (const g of q.groupBy ?? []) expr(g, src, "ProjectionQueryIR.groupBy", v);
  for (const j of q.joins) expr(j.idRef, `${src}/${j.alias}`, "ProjectionJoinIR.idRef", v);
  for (const sel of q.selects ?? []) {
    expr(sel.expr, `${src}/${sel.field}`, "ProjectionQueryIR.selects", v);
    expr(sel.aggregate?.arg, `${src}/${sel.field}`, "ProjectionAggregateIR.arg", v);
  }
}

function visitProjection(p: ProjectionIR, src: string, v: ExprVisitor) {
  const s = `${src}/${p.name}`;
  visitParams(p.params, s, "ProjectionIR.params", v);
  visitFields(p.stateFields, s, v);
  visitWireShape(p.wireShape, s, v);
  if (p.query) visitProjectionQuery(p.query, s, v);
  for (const h of p.handlers) {
    const hs = `${s}/on(${h.event})`;
    expr(h.correlation, hs, "ProjectionOnIR.correlation", v);
    stmts(h.statements, hs, "ProjectionOnIR.statements", v, walkStmtExprsDeep);
  }
}

function visitCriterion(c: CriterionIR, src: string, v: ExprVisitor) {
  const s = `${src}/${c.name}`;
  visitParams(c.params, s, "CriterionIR.params", v);
  expr(c.body, s, "CriterionIR.body", v);
}

function visitRetrieval(r: RetrievalIR, src: string, v: ExprVisitor) {
  const s = `${src}/${r.name}`;
  visitParams(r.params, s, "RetrievalIR.params", v);
  expr(r.where, s, "RetrievalIR.where", v);
  for (const a of r.criterionRef?.args ?? []) expr(a, s, "RetrievalIR.criterionRef", v);
}

function visitDomainService(d: DomainServiceIR, src: string, v: ExprVisitor) {
  const s = `${src}/${d.name}`;
  for (const op of d.operations) {
    const os = `${s}/${op.name}`;
    visitParams(op.params, os, "DomainServiceOperationIR.params", v);
    stmts(op.body, os, "DomainServiceOperationIR.body", v, walkStmtExprsDeep);
  }
  visitTests(d.tests, s, v);
}

function visitSeed(sd: SeedIR, src: string, v: ExprVisitor) {
  for (const row of sd.rows) {
    for (const f of row.fields) {
      expr(f.value, `${src}/${sd.dataset}/${row.aggregate}/${f.name}`, "SeedRowIR.fields", v);
    }
  }
}

function visitMenuMeta(m: MenuMetaIR | undefined, src: string, v: ExprVisitor) {
  for (const e of m?.entries ?? []) expr(e.value, `${src}/${e.name}`, "MenuMetaIR.entries", v);
}

function visitMenuBlock(m: MenuBlockIR | undefined, src: string, v: ExprVisitor) {
  for (const sec of m?.sections ?? []) {
    for (const link of sec.links) {
      const ls = `${src}/${sec.label}`;
      if ("props" in link) {
        for (const p of link.props) expr(p.value, `${ls}/${p.name}`, "MenuLinkIR.props", v);
      }
    }
  }
}

function visitPage(p: PageIR, src: string, v: ExprVisitor) {
  const s = `${src}/${p.name}`;
  visitParams(p.params, s, "PageIR.params", v);
  expr(p.title, s, "PageIR.title", v);
  expr(p.requires, s, "PageIR.requires", v);
  visitStateFields(p.state, s, v);
  visitDerived(p.derived, s, v);
  visitActions(p.actions, s, v);
  expr(p.body, s, "PageIR.body", v);
  visitMenuMeta(p.menuMeta, s, v);
}

function visitComponent(c: ComponentIR, src: string, v: ExprVisitor) {
  const s = `${src}/${c.name}`;
  visitParams(c.params, s, "ComponentIR.params", v);
  visitStateFields(c.state, s, v);
  visitDerived(c.derived, s, v);
  visitActions(c.actions, s, v);
  expr(c.body, s, "ComponentIR.body", v);
}

function visitStore(st: StoreIR, src: string, v: ExprVisitor) {
  const s = `${src}/${st.name}`;
  visitStateFields(st.state, s, v);
  visitActions(st.actions, s, v);
}

/** Re-tag every visit below as UI-side.  Wrapping at the entry point keeps the
 *  flag out of ~30 walk signatures — the alternative is threading a boolean
 *  through every helper, where one missed hand-off is a silently mis-tagged
 *  expression. */
const asUi =
  (v: ExprVisitor): ExprVisitor =>
  (x) =>
    v({ ...x, ui: true });

function visitUi(u: UiIR, src: string, outer: ExprVisitor) {
  const v = asUi(outer);
  const s = `${src}/${u.name}`;
  for (const p of u.pages) visitPage(p, s, v);
  for (const c of u.components) visitComponent(c, s, v);
  for (const st of u.stores) visitStore(st, s, v);
  visitMenuBlock(u.menu, s, v);
  for (const f of u.functions ?? [])
    visitParams(f.params, `${s}/${f.name}`, "UiFunctionIR.params", v);
  for (const n of u.notifications ?? []) {
    for (const t of n.toasts) expr(t, `${s}/${n.paramName}`, "UiNotificationIR.toasts", v);
  }
}

function visitLayout(l: LayoutIR, src: string, outer: ExprVisitor) {
  const v = asUi(outer);
  const s = `${src}/${l.name}`;
  expr(l.header, s, "LayoutIR.header", v);
  expr(l.sidebar, s, "LayoutIR.sidebar", v);
  expr(l.footer, s, "LayoutIR.footer", v);
}

function visitContext(c: BoundedContextIR, v: ExprVisitor) {
  const s = c.name;
  for (const a of c.aggregates) visitAggregate(a, s, v);
  for (const vo of c.valueObjects) visitValueObject(vo, s, v);
  for (const e of c.events) visitFields(e.fields, `${s}/${e.name}`, v);
  for (const p of c.payloads) visitFields(p.fields, `${s}/${p.name}`, v);
  for (const r of c.repositories) visitRepository(r, s, v);
  for (const w of c.workflows) visitWorkflow(w, s, v);
  for (const p of c.projections) visitProjection(p, s, v);
  for (const cr of c.criteria) visitCriterion(cr, s, v);
  for (const r of c.retrievals) visitRetrieval(r, s, v);
  for (const d of c.domainServices) visitDomainService(d, s, v);
  for (const sd of c.seeds) visitSeed(sd, s, v);
  visitTests(c.tests, s, v);
  for (const h of c.commandHandlers ?? []) {
    const hs = `${s}/${h.name}`;
    visitParams(h.params, hs, "CommandHandlerIR.params", v);
    stmts(h.statements, hs, "CommandHandlerIR.statements", v, walkWorkflowStmtExprsDeep);
    expr(h.returnValue, hs, "CommandHandlerIR.returnValue", v);
  }
  for (const h of c.queryHandlers ?? []) {
    const hs = `${s}/${h.name}`;
    visitParams(h.params, hs, "QueryHandlerIR.params", v);
    stmts(h.statements, hs, "QueryHandlerIR.statements", v, walkWorkflowStmtExprsDeep);
    expr(h.returnValue, hs, "QueryHandlerIR.returnValue", v);
  }
}

function visitSystem(sys: SystemIR, v: ExprVisitor) {
  const s = sys.name;
  for (const sub of sys.subdomains) for (const c of sub.contexts) visitContext(c, v);
  for (const u of sys.uis) visitUi(u, s, v);
  for (const l of sys.layouts) visitLayout(l, s, v);
  if (sys.user) visitFields(sys.user.fields, `${s}/user`, v);
  for (const t of sys.e2eTests) {
    visitTestStmts(t.statements, `${s}/${t.name}`, "TestE2EIR.statements", v);
  }
}

/**
 * Visit every expression the model holds, deep — each sub-expression is
 * reported too, so a consumer cannot be accidentally shallow.
 *
 * Takes the plain `LoomModel` rather than the enriched brand on purpose: the
 * enumeration is a structural walk, and every consumer (the verifier, the
 * cross-cutting proofs, the checks that will drop their own partial loops)
 * wants it available at both stages of the pipeline.
 */
export function forEachModelExpr(model: LoomModel, visit: ExprVisitor): void {
  for (const sys of model.systems) visitSystem(sys, visit);
  for (const c of model.contexts) visitContext(c, visit);
  for (const vo of model.rootValueObjects) visitValueObject(vo, "(root)", visit);
  for (const p of model.rootPayloads) visitFields(p.fields, `(root)/${p.name}`, visit);
  for (const c of model.components) visitComponent(c, "(root)", asUi(visit));
  for (const b of model.backfillIntents ?? []) {
    expr(b.value, `${b.context}/${b.aggregate}/${b.field}`, "BackfillIntentIR.value", visit);
  }
}

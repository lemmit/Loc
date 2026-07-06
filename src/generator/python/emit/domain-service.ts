// Domain-service emission (Python / FastAPI) — domain-services.md, v1 Shape A.
//
// Each `domainService Pricing { operation quote(...) {...} }` lowers to a
// module of bare, stateless module-level functions (snake_cased) under
// `app/domain/services/<snake(service)>.py` — NO class, no `self`:
//
//   def quote(cart: Cart, customer: Customer) -> Decimal: ...
//
// The operation bodies render through the shared Python statement /
// expression path (`renderPyStatements` / `renderPyExpr`) — parameters
// resolve as bare locals (refKind `param`), there is no `this`.  An
// `or`-union return reuses the EXACT exception-less union shape the
// aggregate operations emit (`renderPyOperationReturnType` → `dict[str,
// object]`, with `return` tagged-dict variants from render-stmt.ts) — no
// new union machinery.
//
// CALL-SITE CONTRACT: `PY_TARGET.domainServiceCall` (render-expr.ts)
// renders a member call as BARE `quote(...)`, so the consuming module
// (the aggregate / workflow that calls it) imports the function by name
// — `domainServiceImportLines` builds those `from app.domain.services.…
// import …` lines from the calling body's IR (see aggregate.ts /
// workflows-builder.ts).
//
// Imports are computed from the declared signature types (params +
// returns) — Decimal / datetime / id NewTypes / VO+enum classes /
// aggregate classes — plus the expression-triggered ones (re / Decimal /
// datetime / DomainError / ForbiddenError) the body reaches, so the file
// passes `mypy --strict` with no unused imports.

import type {
  BoundedContextIR,
  DomainServiceIR,
  DomainServiceOperationIR,
  ExprIR,
  StmtIR,
  TypeIR,
  WorkflowStmtIR,
} from "../../../ir/types/loom-ir.js";
import {
  type ReadPort,
  readPortsForOperation,
} from "../../../ir/util/domain-service-read-ports.js";
import { lines } from "../../../util/code-builder.js";
import { snake } from "../../../util/naming.js";
import { emptyPyTypeImports, visitPyTypeImports } from "../py-type-imports.js";
import { collectPyExprImports, renderPyType } from "../render-expr.js";
import { renderPyStatements } from "../render-stmt.js";

/** One emitted file: the module path and its source. */
export interface PyDomainServiceFile {
  path: string;
  content: string;
}

/** The module path for a domain service — `app/domain/services/<snake>.py`. */
export function domainServicePath(serviceName: string): string {
  return `app/domain/services/${snake(serviceName)}.py`;
}

/** Emit one module per domain service in the context, or `[]` when the
 *  context declares none.  Each module is a flat set of module-level
 *  functions (stateless: no class, no `self`). */
export function renderPyDomainServices(ctx: BoundedContextIR): PyDomainServiceFile[] {
  return ctx.domainServices.map((svc) => ({
    path: domainServicePath(svc.name),
    content: renderService(svc, ctx),
  }));
}

function renderService(svc: DomainServiceIR, ctx: BoundedContextIR): string {
  const fns = svc.operations.map(renderOperation);
  const body = fns.join("\n\n\n");

  // --- import resolution -------------------------------------------------
  // Signature types (params + returns) always need their import even when
  // the body never re-mentions the name.
  const types = emptyPyTypeImports();
  for (const op of svc.operations) {
    for (const p of op.params) visitPyTypeImports(p.type, types);
    if (op.returnType) visitPyTypeImports(op.returnType, types);
  }
  // Aggregate (`entity`) params/returns reference the aggregate class —
  // imported from its own module (`app.domain.<snake>`).  Only names that
  // are real aggregates/parts in this context import: a union variant is
  // an `error`-payload named type that never materialises at runtime (the
  // union return degrades to `dict[str, object]`), so it needs no import.
  const aggLike = new Set<string>([
    ...ctx.aggregates.map((a) => a.name),
    ...ctx.aggregates.flatMap((a) => a.parts.map((p) => p.name)),
  ]);
  const aggNames = new Set<string>();
  for (const op of svc.operations) {
    for (const p of op.params) collectEntityNames(p.type, aggNames);
    if (op.returnType) collectEntityNames(op.returnType, aggNames);
  }
  for (const n of [...aggNames]) if (!aggLike.has(n)) aggNames.delete(n);

  // Expression-triggered imports (re / decimal / datetime), plus the error
  // classes the precondition / requires gates raise.
  const exprImports = new Set<string>();
  let usesDomainError = false;
  let usesForbidden = false;
  for (const op of svc.operations) {
    for (const st of op.body) {
      collectStmtExprImports(st, exprImports);
      if (st.kind === "precondition") usesDomainError = true;
      if (st.kind === "requires") usesForbidden = true;
    }
  }
  const usesDatetime = types.usesDatetime || exprImports.has("datetime");
  const usesDecimal = types.usesDecimal || exprImports.has("decimal");

  const errorNames = [
    usesDomainError ? "DomainError" : null,
    usesForbidden ? "ForbiddenError" : null,
  ].filter((n): n is string => n != null);

  const idImports = [...types.idNames].sort().map((n) => `${n}Id`);
  const voEnumNames = [...types.voNames, ...types.enumNames].sort();

  // Read-port repository classes (domain-services.md rev. 4, Slice 1): a
  // `reading`-tier op takes an `<Aggregate>Repository` handle param, so THIS
  // service's module imports that class for the annotation.  Scoped to the
  // service's own operations (Python emits one module per service, unlike the
  // single TS `services.ts`), so a PURE-only service's module stays import-free.
  // De-duplicated by aggregate, sorted for deterministic output.
  const readPortRepos = collectReadPortRepos(svc).sort((a, b) =>
    a.aggregate.localeCompare(b.aggregate),
  );

  const header = lines(
    `"""${svc.name} domain service — stateless pure calculator (domain-services.md).`,
    "",
    "Auto-generated by Loom.  Pin via .loomignore to customise.",
    `"""`,
    "",
    exprImports.has("math") ? "import math" : null,
    exprImports.has("re") ? "import re" : null,
    usesDatetime ? "from datetime import UTC, datetime" : null,
    usesDecimal ? "from decimal import Decimal" : null,
    exprImports.has("math") || exprImports.has("re") || usesDatetime || usesDecimal ? "" : null,
    errorNames.length > 0 ? `from app.domain.errors import ${errorNames.join(", ")}` : null,
    idImports.length > 0 ? `from app.domain.ids import ${idImports.join(", ")}` : null,
    voEnumNames.length > 0
      ? `from app.domain.value_objects import ${voEnumNames.join(", ")}`
      : null,
    ...[...aggNames].sort().map((n) => `from app.domain.${snake(n)} import ${n}`),
    ...readPortRepos.map(
      (p) =>
        `from app.db.repositories.${snake(p.aggregate)}_repository import ${p.aggregate}Repository`,
    ),
  );

  return `${header}\n\n\n${body}\n`;
}

function renderOperation(op: DomainServiceOperationIR): string {
  // Read-port parameters (domain-services.md rev. 4, Slice 1): a `reading`-tier
  // op takes one repository handle per repo it reads, AHEAD of the user params —
  // `accounts: AccountRepository` — exactly the handle the body's `repo-read`
  // arms render against (`await accounts.by_holder(holder)`) and the
  // orchestrating workflow supplies.  A PURE op has no ports, so its declaration
  // is unchanged (byte-identical).  Each read-port read awaits the repo method,
  // so a reading op is `async def` (the orchestrator awaits the call at its site).
  const ports = readPortsForOperation(op);
  const portParams = ports.map((p) => `${snake(p.repo)}: ${p.aggregate}Repository`);
  const userParams = op.params.map((p) => `${snake(p.name)}: ${renderPyType(p.type)}`);
  const params = [...portParams, ...userParams].join(", ");
  const isReading = ports.length > 0;
  const kw = isReading ? "async def" : "def";
  const ret = op.returnType ? renderPyOperationReturnType(op.returnType) : "None";
  const body = renderPyStatements(op.body, "    ");
  return lines(
    `${kw} ${snake(op.name)}(${params}) -> ${ret}:`,
    ...(body.length > 0 ? [body] : ["    pass"]),
  );
}

/** The distinct read-port repositories (`<Aggregate>Repository` classes) a
 *  service's reading-tier operations read — drives its module's repository-class
 *  import surface.  De-duplicated by aggregate.  A pure service reads none, so
 *  its module imports no repository. */
function collectReadPortRepos(svc: DomainServiceIR): ReadPort[] {
  const byAgg = new Map<string, ReadPort>();
  for (const op of svc.operations) {
    for (const p of readPortsForOperation(op)) {
      if (!byAgg.has(p.aggregate)) byAgg.set(p.aggregate, p);
    }
  }
  return [...byAgg.values()];
}

/** Exception-less `or`-union returns carry the tagged dict the statement
 *  renderer emits — typed `dict[str, object]` (parity with the aggregate
 *  operation return type, `renderPyOperationReturnType` in emit/aggregate.ts). */
function renderPyOperationReturnType(t: TypeIR): string {
  if (t.kind === "union") return "dict[str, object]";
  return renderPyType(t);
}

/** Collect aggregate (`entity`) class names reachable through a TypeIR —
 *  these need a `from app.domain.<snake> import <Name>` import. */
function collectEntityNames(t: TypeIR, into: Set<string>): void {
  switch (t.kind) {
    case "entity":
      into.add(t.name);
      return;
    case "array":
      collectEntityNames(t.element, into);
      return;
    case "optional":
      collectEntityNames(t.inner, into);
      return;
    case "genericInstance":
      collectEntityNames(t.arg, into);
      return;
    // A `union` return degrades to `dict[str, object]`; its variant types
    // are never materialised, so they contribute no aggregate import.
  }
}

/** Recursive import collection over a statement's expressions (mirror of
 *  the aggregate emitter's `collectStmtExprImports`). */
function collectStmtExprImports(st: StmtIR, into: Set<string>): void {
  switch (st.kind) {
    case "precondition":
    case "requires":
    case "let":
    case "expression":
      collectPyExprImports(st.expr, into);
      return;
    case "assign":
    case "add":
    case "remove":
      collectPyExprImports(st.value, into);
      return;
    case "emit":
      for (const f of st.fields) collectPyExprImports(f.value, into);
      return;
    case "call":
      for (const a of st.args) collectPyExprImports(a, into);
      return;
    case "return":
      collectPyExprImports(st.value, into);
      return;
  }
}

// ---------------------------------------------------------------------------
// Call-site importer wiring.
//
// Because the PY_TARGET leaf renders a domain-service call as the BARE
// function name (`quote(...)`), every module that calls a domain service
// must import that function.  `domainServiceImportLines` walks the calling
// body's IR for `callKind: "domain-service"` calls and returns the
// `from app.domain.services.<snake(service)> import <snake(op)>` lines,
// grouped per service module.
// ---------------------------------------------------------------------------

/** Build the `from app.domain.services.… import …` lines a calling module
 *  needs, from every `domainService` call reachable in `stmts` (aggregate
 *  operation / applier / es-create bodies). */
export function domainServiceImportLines(stmts: readonly StmtIR[]): string[] {
  const byService = new Map<string, Set<string>>();
  for (const st of stmts) forEachStmtExpr(st, (e) => collectServiceRef(e, byService));
  return importLinesFor(byService);
}

/** The workflow-statement sibling — `WorkflowStmtIR` has its own shape, so
 *  it walks a distinct (recursive, branch-bearing) statement tree. */
export function domainServiceImportLinesForWorkflow(stmts: readonly WorkflowStmtIR[]): string[] {
  const byService = new Map<string, Set<string>>();
  for (const st of stmts) forEachWorkflowStmtExpr(st, (e) => collectServiceRef(e, byService));
  return importLinesFor(byService);
}

function importLinesFor(byService: Map<string, Set<string>>): string[] {
  return [...byService.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([service, ops]) => {
      const fns = [...ops].sort().map(snake).join(", ");
      return `from app.domain.services.${snake(service)} import ${fns}`;
    });
}

function collectServiceRef(e: ExprIR, byService: Map<string, Set<string>>): void {
  if (e.kind === "call" && e.callKind === "domain-service" && e.serviceRef) {
    const ops = byService.get(e.serviceRef.service) ?? new Set<string>();
    ops.add(e.serviceRef.op);
    byService.set(e.serviceRef.service, ops);
  }
}

/** Visit every sub-expression of a statement (recurses into nested
 *  expressions), so a domain-service call in any position is found. */
function forEachStmtExpr(st: StmtIR, visit: (e: ExprIR) => void): void {
  switch (st.kind) {
    case "precondition":
    case "requires":
    case "let":
    case "expression":
      walkExpr(st.expr, visit);
      return;
    case "assign":
    case "add":
    case "remove":
      walkExpr(st.value, visit);
      return;
    case "emit":
      for (const f of st.fields) walkExpr(f.value, visit);
      return;
    case "call":
      for (const a of st.args) walkExpr(a, visit);
      return;
    case "return":
      walkExpr(st.value, visit);
      return;
  }
}

/** Visit every sub-expression of a workflow statement, recursing into the
 *  nested bodies of `for-each` / `if-let`. */
function forEachWorkflowStmtExpr(st: WorkflowStmtIR, visit: (e: ExprIR) => void): void {
  switch (st.kind) {
    case "precondition":
    case "requires":
      walkExpr(st.expr, visit);
      return;
    case "emit":
    case "factory-let":
      for (const f of st.fields) walkExpr(f.value, visit);
      return;
    case "repo-let":
    case "op-call":
      for (const a of st.args) walkExpr(a, visit);
      return;
    case "expr-let":
      walkExpr(st.expr, visit);
      return;
    case "repo-run":
      for (const a of st.retrievalArgs) walkExpr(a, visit);
      walkExpr(st.page?.offset, visit);
      walkExpr(st.page?.limit, visit);
      return;
    case "for-each":
      walkExpr(st.iterable, visit);
      for (const inner of st.body) forEachWorkflowStmtExpr(inner, visit);
      return;
    case "resource-call":
    case "domain-service-call":
      walkExpr(st.call, visit);
      return;
    case "if-let":
      for (const a of st.retrievalArgs) walkExpr(a, visit);
      for (const inner of st.thenBody) forEachWorkflowStmtExpr(inner, visit);
      for (const inner of st.elseBody ?? []) forEachWorkflowStmtExpr(inner, visit);
      return;
  }
}

/** Depth-first expression walk — visits `e` and every sub-expression. */
function walkExpr(e: ExprIR | undefined, visit: (e: ExprIR) => void): void {
  if (!e) return;
  visit(e);
  switch (e.kind) {
    case "member":
      walkExpr(e.receiver, visit);
      return;
    case "method-call":
      walkExpr(e.receiver, visit);
      for (const a of e.args) walkExpr(a, visit);
      return;
    case "call":
      for (const a of e.args) walkExpr(a, visit);
      return;
    case "binary":
      walkExpr(e.left, visit);
      walkExpr(e.right, visit);
      return;
    case "unary":
      walkExpr(e.operand, visit);
      return;
    case "paren":
      walkExpr(e.inner, visit);
      return;
    case "ternary":
      walkExpr(e.cond, visit);
      walkExpr(e.then, visit);
      walkExpr(e.otherwise, visit);
      return;
    case "convert":
      walkExpr(e.value, visit);
      return;
    case "lambda":
      walkExpr(e.body, visit);
      return;
    case "new":
    case "object":
      for (const f of e.fields) walkExpr(f.value, visit);
      return;
    case "list":
      for (const el of e.elements) walkExpr(el, visit);
      return;
    case "match":
      for (const arm of e.arms) {
        walkExpr(arm.cond, visit);
        walkExpr(arm.value, visit);
      }
      walkExpr(e.otherwise, visit);
      return;
  }
}

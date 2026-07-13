import type { WorkflowStmtIR } from "../../ir/types/loom-ir.js";

// ---------------------------------------------------------------------------
// The shared workflow statement-sequence spine — the `WorkflowStmtIR`
// analogue of the `ExprTarget` seam in `_expr/target.ts`.
//
// Every backend's workflow emitter walks the same body: the 10-kind
// `WorkflowStmtIR` sequence in declaration order, recursing into `for-each`
// bodies. Only the per-kind *spelling* diverges (let syntax, block syntax,
// guard idiom, the expression renderer) plus the indent unit. Before this
// seam each backend re-implemented the whole switch.
//
// `renderWorkflowStmts` owns the dispatch + `for-each` recursion once; each
// backend supplies a `WorkflowStmtTarget` leaf table. A new `WorkflowStmtIR`
// kind is a compile error here (exhaustive switch) AND in every target (the
// interface), exactly like adding an `ExprIR.kind`.
//
// NOTE: this is the *statement* spine only. The per-workflow envelope
// (route/handler shell, transaction wrapping, repo construction, param
// binding, exit-save + event-dispatch loops) is genuinely divergent
// per-driver scaffolding and stays in each backend's emitter.
// ---------------------------------------------------------------------------

type ByKind<K extends WorkflowStmtIR["kind"]> = Extract<WorkflowStmtIR, { kind: K }>;

export interface WorkflowStmtTarget {
  /** Indent step the spine adds for a `for-each` body — `"  "` (Hono) /
   *  `"    "` (Python). The target reuses the same unit when rendering the
   *  loop's per-iteration saves. */
  readonly indentUnit: string;

  precondition(st: ByKind<"precondition">, indent: string): string[];
  requires(st: ByKind<"requires">, indent: string): string[];
  emit(st: ByKind<"emit">, indent: string): string[];
  factoryLet(st: ByKind<"factory-let">, indent: string): string[];
  repoLet(st: ByKind<"repo-let">, indent: string): string[];
  exprLet(st: ByKind<"expr-let">, indent: string): string[];
  /** `field := value` — write `value` to the workflow's own persisted state
   *  field named by `st.target` (a single-segment `this-prop` path).  The
   *  target writes onto the backend's correlation/instance state object. */
  assign(st: ByKind<"assign">, indent: string): string[];
  repoRun(st: ByKind<"repo-run">, indent: string): string[];
  opCall(st: ByKind<"op-call">, indent: string): string[];
  /** `<Repo>.delete(o)` — a repository DELETE (destroy).  Renders to the
   *  backend's already-emitted repository delete verb.  The argument shape
   *  diverges per backend (the aggregate value for .NET/Java, `<entity>.id`
   *  for Hono/Python), so the target renders `st.entity` itself. */
  repoDelete(st: ByKind<"repo-delete">, indent: string): string[];
  resourceCall(st: ByKind<"resource-call">, indent: string): string[];
  /** `Transfer.run(src, dst, amount)` — a bare orchestrator call into a
   *  `domainService` operation (domain-services.md rev. 4, the `mutating`
   *  tier).  Renders `st.call` (a `callKind: "domain-service"` Call) as a
   *  statement; the aggregates it mutates persist via the workflow's exit-saves
   *  (`savesAtExit`), not here. */
  domainServiceCall(st: ByKind<"domain-service-call">, indent: string): string[];

  /** `for-each`: `renderedBody` is the loop body already rendered at
   *  `indent + indentUnit` by the spine; the target wraps it in the backend's
   *  loop construct and appends the per-iteration saves. */
  forEach(st: ByKind<"for-each">, indent: string, renderedBody: string[]): string[];

  /** `if-let`: `renderedThen` / `renderedElse` are the two branch bodies
   *  already rendered at `indent + indentUnit` by the spine. The target runs
   *  the synthetic `findAllBy<Criterion>` retrieval with `limit: 1`, binds the
   *  first row (or null/none) to `st.var`, and emits the present/absent
   *  branches — appending each branch's saves (`savesInThen` / `savesInElse`).
   *  `renderedElse` is empty when the source had no `else`. */
  ifLet(
    st: ByKind<"if-let">,
    indent: string,
    renderedThen: string[],
    renderedElse: string[],
  ): string[];
}

/** Let-bound names whose RHS was a UNION-returning find (`find x(): Agg or
 *  Err`).  Per the union-find wire contract (exception-less.md §4 /
 *  docs/payloads.md) the backends' Domain repositories lower such a find to
 *  its OPTIONAL TWIN — the success aggregate, nullable on absence — and emit
 *  NO union carrier types.  A variant-`match` over one of these bindings must
 *  therefore render as a null-check, not a carrier-pattern dispatch; backends
 *  consult this set in their `exprLet` arm. */
export function collectUnionFindLets(stmts: readonly WorkflowStmtIR[]): Set<string> {
  const out = new Set<string>();
  const walk = (sts: readonly WorkflowStmtIR[]): void => {
    for (const st of sts) {
      if (st.kind === "repo-let" && st.returnType.kind === "union") out.add(st.name);
      else if (st.kind === "for-each") walk(st.body);
      else if (st.kind === "if-let") {
        walk(st.thenBody);
        walk(st.elseBody ?? []);
      }
    }
  };
  walk(stmts);
  return out;
}

/** Render a workflow statement sequence at `indent`, dispatching each kind to
 *  the backend `target`. Owns the only `for-each` recursion.  Byte-identical
 *  by construction: exactly the one-level flatten of
 *  `renderWorkflowStmtChunks` (`stmts.flatMap(f)` and `stmts.map(f).flat()`
 *  are the same array for every `f`). */
export function renderWorkflowStmts(
  stmts: readonly WorkflowStmtIR[],
  target: WorkflowStmtTarget,
  indent: string,
): string[] {
  return renderWorkflowStmtChunks(stmts, target, indent).flat();
}

/** Same rendering as `renderWorkflowStmts`, but one chunk (the statement's
 *  own — possibly multi-line — lines array) per TOP-LEVEL `WorkflowStmtIR`
 *  instead of the pre-flattened whole.  A `for-each` / `if-let`'s nested body
 *  lines stay INSIDE their statement's chunk (`statementSubRegions` is a flat
 *  walk keyed 1:1 against `stmts`, so nested-body granularity is out of scope
 *  for this cursor — see `src/generator/_trace/sourcemap.ts`).  Lets a caller
 *  that owns the final file content recover each top-level statement's own
 *  line span for `SourceMapRecorder.fragment`, mirroring
 *  `renderTsStatementChunks` / `renderCsStatementChunks` / the Python and Java
 *  siblings — this is the `WorkflowStmtIR` analogue for workflow bodies. */
export function renderWorkflowStmtChunks(
  stmts: readonly WorkflowStmtIR[],
  target: WorkflowStmtTarget,
  indent: string,
): string[][] {
  return stmts.map((st) => renderWorkflowStmt(st, target, indent));
}

function renderWorkflowStmt(
  st: WorkflowStmtIR,
  target: WorkflowStmtTarget,
  indent: string,
): string[] {
  switch (st.kind) {
    case "precondition":
      return target.precondition(st, indent);
    case "requires":
      return target.requires(st, indent);
    case "emit":
      return target.emit(st, indent);
    case "factory-let":
      return target.factoryLet(st, indent);
    case "repo-let":
      return target.repoLet(st, indent);
    case "expr-let":
      return target.exprLet(st, indent);
    case "assign":
      return target.assign(st, indent);
    case "repo-run":
      return target.repoRun(st, indent);
    case "op-call":
      return target.opCall(st, indent);
    case "repo-delete":
      return target.repoDelete(st, indent);
    case "for-each":
      return target.forEach(
        st,
        indent,
        renderWorkflowStmts(st.body, target, indent + target.indentUnit),
      );
    case "if-let":
      return target.ifLet(
        st,
        indent,
        renderWorkflowStmts(st.thenBody, target, indent + target.indentUnit),
        renderWorkflowStmts(st.elseBody ?? [], target, indent + target.indentUnit),
      );
    case "resource-call":
      return target.resourceCall(st, indent);
    case "domain-service-call":
      return target.domainServiceCall(st, indent);
  }
}

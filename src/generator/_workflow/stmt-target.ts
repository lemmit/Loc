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
  resourceCall(st: ByKind<"resource-call">, indent: string): string[];

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

/** Render a workflow statement sequence at `indent`, dispatching each kind to
 *  the backend `target`. Owns the only `for-each` recursion. */
export function renderWorkflowStmts(
  stmts: readonly WorkflowStmtIR[],
  target: WorkflowStmtTarget,
  indent: string,
): string[] {
  return stmts.flatMap((st) => renderWorkflowStmt(st, target, indent));
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
  }
}

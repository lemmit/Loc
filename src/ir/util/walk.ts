// One shared, exhaustively-`never`-checked IR child-walker.
//
// Before this module, ≥5 near-identical hand-copied expression / statement
// traversals lived across `ir/validate`, `ir/util`, and `ir/types` — each one
// lagging the IR by a different set of node kinds (`convert.value`,
// `list.elements`, lambda `block` bodies, `match` arms, and half the
// `WorkflowStmtIR` kinds).  A missed child is a silent traversal dead-zone:
// a `currentUser` hidden in a `match` arm never threads the auth param; a
// `repo-read` inside a for-each body never derives a read-port; a `files.put`
// nested in a loop never trips its capability gate (full-code-review 2026-07,
// findings 2 + 24 + the shared-walker mediums).
//
// The fix is one seam.  `walk{Expr,Stmt,WorkflowStmt}Children` are SHALLOW,
// one-level child visitors whose `switch` covers every kind of its union and
// ends in a `never` assignment — so adding a new `ExprIR` / `StmtIR` /
// `WorkflowStmtIR` kind fails `tsc` (and the `walk-completeness` property test)
// until its children are wired here, ONCE, instead of in five drifting copies.
//
// The `walk*Deep` recursive helpers are what most call sites actually want
// (visit every reachable sub-expression); they are defined purely in terms of
// the shallow visitors, so the exhaustiveness guarantee flows through them.
//
// Layering: this file lives in `ir/util/` and imports ONLY types from
// `ir/types/loom-ir.ts` (`import type`, erased at emit — no runtime edge), so
// it may be consumed from anywhere in `ir/` (and downstream) without inverting
// the pipeline.  `loom-ir.ts` itself value-imports `walkExprDeep` from here to
// implement its `*UsesCurrentUser` family; that back-edge is type-only in the
// reverse direction, so no runtime cycle forms.

import type { ExprIR, StmtIR, WorkflowStmtIR } from "../types/loom-ir.js";

/** Callbacks for {@link walkExprChildren}.  An expression's immediate children
 *  are other expressions, EXCEPT a block-body lambda whose `block` holds
 *  `StmtIR` statements — hence the two channels. */
export interface ExprChildVisitor {
  /** Every immediate child *expression*. */
  expr?: (child: ExprIR) => void;
  /** Every immediate child *statement* (block-body lambda only). */
  stmt?: (child: StmtIR) => void;
}

/** Callbacks for {@link walkWorkflowStmtChildren}.  A workflow statement's
 *  children are expressions PLUS the nested workflow-statement bodies that
 *  `for-each` / `if-let` carry. */
export interface WorkflowStmtChildVisitor {
  /** Every immediate child expression. */
  expr?: (child: ExprIR) => void;
  /** Every immediate nested workflow statement (for-each / if-let bodies). */
  workflowStmt?: (child: WorkflowStmtIR) => void;
}

/**
 * Visit the immediate children of an expression — one level only.
 *
 * Exhaustive over every `ExprIR.kind`; the trailing `never` assignment makes a
 * newly-added kind a compile error here until its children are declared.  Leaf
 * kinds (`literal`, `this`, `id`, `ref`, `action-ref`) intentionally have no
 * children and are listed so the switch stays total.
 */
export function walkExprChildren(e: ExprIR, v: ExprChildVisitor): void {
  const expr = v.expr;
  const stmt = v.stmt;
  switch (e.kind) {
    case "literal":
    case "this":
    case "id":
    case "ref":
    case "action-ref":
      // Leaves — no child expressions.
      break;
    case "member":
      expr?.(e.receiver);
      break;
    case "method-call":
      expr?.(e.receiver);
      for (const a of e.args) expr?.(a);
      break;
    case "call":
      for (const a of e.args) expr?.(a);
      // The per-primitive `style: { … }` escape hatch carries ExprIR values —
      // a real child slot the old hand copies all missed.
      for (const s of e.style?.entries ?? []) expr?.(s.value);
      break;
    case "lambda":
      if (e.body) expr?.(e.body);
      // Block-body lambdas (`x => { … }`) carry StmtIR statements — the child
      // slot every prior walkExpr copy dropped on the floor.
      for (const s of e.block ?? []) stmt?.(s);
      break;
    case "new":
    case "object":
      for (const f of e.fields) expr?.(f.value);
      break;
    case "list":
      for (const el of e.elements) expr?.(el);
      break;
    case "paren":
      expr?.(e.inner);
      break;
    case "unary":
      expr?.(e.operand);
      break;
    case "binary":
      expr?.(e.left);
      expr?.(e.right);
      break;
    case "ternary":
      expr?.(e.cond);
      expr?.(e.then);
      expr?.(e.otherwise);
      break;
    case "convert":
      expr?.(e.value);
      break;
    case "duration":
      expr?.(e.amount);
      break;
    case "match":
      if (e.subject) expr?.(e.subject);
      for (const a of e.arms) {
        expr?.(a.cond);
        expr?.(a.value);
      }
      for (const a of e.variantArms) expr?.(a.value);
      if (e.otherwise) expr?.(e.otherwise);
      break;
    default: {
      const _exhaustive: never = e;
      void _exhaustive;
    }
  }
}

/**
 * Visit the immediate child *expressions* of an operation-body statement — one
 * level only.  Almost every `StmtIR` kind carries only expression children (a
 * nested lambda block is reached by descending into the child expression, not
 * here); the exception is `variant-match`, whose arm/else bodies nest further
 * statements — those are delivered through the optional `nestedStmt` channel.
 * Exhaustive + `never`-checked.
 */
export function walkStmtChildren(
  s: StmtIR,
  visit: (child: ExprIR) => void,
  nestedStmt?: (child: StmtIR) => void,
): void {
  switch (s.kind) {
    case "precondition":
    case "requires":
    case "let":
    case "expression":
      visit(s.expr);
      break;
    case "assign":
    case "add":
    case "remove":
    case "return":
      visit(s.value);
      break;
    case "emit":
      for (const f of s.fields) visit(f.value);
      break;
    case "call":
      for (const a of s.args) visit(a);
      break;
    case "variant-match":
      visit(s.subject);
      for (const a of s.arms) for (const st of a.body) nestedStmt?.(st);
      for (const st of s.elseBody ?? []) nestedStmt?.(st);
      break;
    default: {
      const _exhaustive: never = s;
      void _exhaustive;
    }
  }
}

/**
 * Visit the immediate children of a workflow-body statement — one level only.
 *
 * Exhaustive over every `WorkflowStmtIR.kind`.  Unlike the operation-body
 * `StmtIR`, three kinds nest further workflow statements (`for-each.body`,
 * `if-let.thenBody`/`elseBody`), delivered through the `workflowStmt` channel;
 * expression children go through `expr`.  The trailing `never` makes a new
 * workflow-statement kind a compile error until wired.
 */
export function walkWorkflowStmtChildren(s: WorkflowStmtIR, v: WorkflowStmtChildVisitor): void {
  const expr = v.expr;
  const wf = v.workflowStmt;
  switch (s.kind) {
    case "precondition":
    case "requires":
    case "expr-let":
      expr?.(s.expr);
      break;
    case "assign":
      expr?.(s.value);
      break;
    case "emit":
    case "factory-let":
      for (const f of s.fields) expr?.(f.value);
      break;
    case "repo-let":
    case "op-call":
      for (const a of s.args) expr?.(a);
      break;
    case "repo-run":
      for (const a of s.retrievalArgs) expr?.(a);
      if (s.page?.offset) expr?.(s.page.offset);
      if (s.page?.limit) expr?.(s.page.limit);
      break;
    case "resource-call":
    case "domain-service-call":
      expr?.(s.call);
      break;
    case "for-each":
      expr?.(s.iterable);
      for (const st of s.body) wf?.(st);
      break;
    case "if-let":
      for (const a of s.retrievalArgs) expr?.(a);
      for (const st of s.thenBody) wf?.(st);
      for (const st of s.elseBody ?? []) wf?.(st);
      break;
    default: {
      const _exhaustive: never = s;
      void _exhaustive;
    }
  }
}

// ---------------------------------------------------------------------------
// Recursive helpers — visit EVERY reachable sub-expression.  Defined purely in
// terms of the shallow visitors above, so they inherit the exhaustiveness
// guarantee.  These are what most call sites want.
// ---------------------------------------------------------------------------

/** Visit `e` and every sub-expression reachable from it, descending through
 *  block-body lambda statements too. */
export function walkExprDeep(e: ExprIR | undefined, visit: (e: ExprIR) => void): void {
  if (!e) return;
  visit(e);
  walkExprChildren(e, {
    expr: (c) => walkExprDeep(c, visit),
    stmt: (s) => walkStmtExprsDeep(s, visit),
  });
}

/** Visit every expression reachable from an operation-body statement. */
export function walkStmtExprsDeep(s: StmtIR, visit: (e: ExprIR) => void): void {
  walkStmtChildren(
    s,
    (c) => walkExprDeep(c, visit),
    (n) => walkStmtExprsDeep(n, visit),
  );
}

/** Visit every expression reachable from a workflow-body statement, descending
 *  through `for-each` / `if-let` nested bodies. */
export function walkWorkflowStmtExprsDeep(s: WorkflowStmtIR, visit: (e: ExprIR) => void): void {
  walkWorkflowStmtChildren(s, {
    expr: (c) => walkExprDeep(c, visit),
    workflowStmt: (c) => walkWorkflowStmtExprsDeep(c, visit),
  });
}

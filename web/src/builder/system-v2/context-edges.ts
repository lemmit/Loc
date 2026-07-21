// Pure walker that derives the relational structure of a BoundedContext: the
// repository→aggregate / aggregate→event / workflow→…
// relationships that turn a context's children-list into a tree.
//
// The aggregate-level walker (`aggregate-edges.ts`) is the source of truth for
// per-aggregate behaviour — we lift `rel.emits` from each aggregate into a
// context-level "aggregate → event" edge here, so the two layers stay
// consistent. Direct ref fields (`Repository.aggregate`) come
// straight off the AST; workflows walk their statement bodies for top-level
// receiver names (aggregates + repositories) and emits.

import type { AstNode } from "langium";
import type {
  Aggregate,
  AssignOrCallStmt,
  BoundedContext,
  EmitStmt,
  Expression,
  LetStmt,
  PreconditionStmt,
  Repository,
  RequiresStmt,
  Statement,
  Workflow,
} from "../../../../src/language/generated/ast.js";
import {
  isApply,
  isHandleDecl,
  isOnDecl,
  isWorkflowCreateDecl,
} from "../../../../src/language/generated/ast.js";
import { computeAggregateRelations } from "./aggregate-edges";

/** A2-S5f: a workflow body is members-only; its sequential statements live
 *  inside `create` / `handle` / `on` / `apply` member bodies.  Flatten them so
 *  edge collection sees every aggregate / repository / event touch. */
function workflowStatements(wf: Workflow): Statement[] {
  const out: Statement[] = [];
  for (const m of wf.members) {
    if (isWorkflowCreateDecl(m) || isHandleDecl(m) || isOnDecl(m) || isApply(m)) {
      out.push(...m.body);
    }
  }
  return out;
}

export interface ContextRelations {
  /** repository name → aggregate name */
  repoFor: Map<string, string>;
  /** aggregate name → set of event names emitted by its operations */
  emits: Map<string, Set<string>>;
  /** workflow name → set of aggregate names the body calls into via
   *  `<Aggregate>.<op>(...)` at top level (a static reference, not via a
   *  let-bound variable) */
  workflowUses: Map<string, Set<string>>;
  /** workflow name → set of repository names the body addresses by name
   *  (`Repo.find(...)` in *any* expression — assignment value, let RHS,
   *  precondition/requires expr, call arguments, etc.) */
  workflowUsesRepo: Map<string, Set<string>>;
  /** workflow name → set of event names the body emits */
  workflowEmits: Map<string, Set<string>>;
}

const addEdge = (m: Map<string, Set<string>>, src: string, name: string): void => {
  let set = m.get(src);
  if (!set) {
    set = new Set();
    m.set(src, set);
  }
  set.add(name);
};

/** Walk every descendant of `root` (including itself), invoking `cb`. Plain
 *  recursive object walk — used to find MemberAccess nodes whose receiver
 *  bottoms out at a NameRef of a known repository. */
function walkAst(root: AstNode | undefined, cb: (n: AstNode) => void): void {
  if (!root) return;
  cb(root);
  for (const key of Object.keys(root)) {
    if (key.startsWith("$")) continue;
    const v = (root as unknown as Record<string, unknown>)[key];
    if (Array.isArray(v)) {
      for (const item of v) {
        if (item && typeof item === "object" && "$type" in item) walkAst(item as AstNode, cb);
      }
    } else if (v && typeof v === "object" && "$type" in (v as object)) {
      walkAst(v as AstNode, cb);
    }
  }
}

/** Walk an expression for any `NameRef` whose `name` is one of `targets`,
 *  used as the head of a `PostfixChain` (post grammar-flatten the receiver
 *  chain is flat). Catches `Repo.find(x)`, `where Repo.byId(x)`, `Repo.x.y`, …. */
function collectReceiverNames(expr: Expression | undefined, targets: Set<string>, into: Set<string>): void {
  walkAst(expr, (n) => {
    if (n.$type !== "PostfixChain") return;
    const head = (n as { head?: AstNode }).head;
    if (head?.$type === "NameRef") {
      const name = (head as { name?: string }).name;
      if (name && targets.has(name)) into.add(name);
    }
  });
}

/** Statement-shape helper: yields every Expression dangling off a statement,
 *  regardless of which form it is. Keeps the workflow walker oblivious to
 *  per-form layout (one place to update if the grammar grows new statement
 *  kinds). */
function* statementExprs(s: Statement): Iterable<Expression | undefined> {
  switch (s.$type) {
    case "AssignOrCallStmt": {
      const a = s as AssignOrCallStmt;
      yield a.value;
      for (const arg of a.target.args) yield arg;
      return;
    }
    case "LetStmt":
      yield (s as LetStmt).expr;
      return;
    case "PreconditionStmt":
      yield (s as PreconditionStmt).expr;
      return;
    case "RequiresStmt":
      yield (s as RequiresStmt).expr;
      return;
    case "EmitStmt": {
      const e = s as EmitStmt;
      for (const f of e.fields) yield (f as { value?: Expression }).value;
      return;
    }
  }
}

/** Collect a workflow's outgoing edges:
 *
 *   - `usesAgg`  — top-level direct call `Account.deposit(x)` where the LValue
 *                  head matches a known aggregate.
 *   - `usesRepo` — any `Repo.<op>(...)` reference anywhere in the body's
 *                  expressions (let RHS, assign value, requires/precondition,
 *                  call args, emit field values).
 *   - `emits`    — `emit Event { ... }`.
 */
function collectWorkflow(
  wf: Workflow,
  rel: ContextRelations,
  knownAggregates: Set<string>,
  knownRepositories: Set<string>,
): void {
  const usesAgg = new Set<string>();
  const usesRepo = new Set<string>();
  const emitsSet = new Set<string>();
  for (const s of workflowStatements(wf)) {
    if (s.$type === "AssignOrCallStmt") {
      const a = s as AssignOrCallStmt;
      // A method-call target like `Account.deposit` has LValue.head =
      // "Account" + tail = ["deposit"]. Restrict to known aggregate names so
      // we don't pick up calls on let-bound variables (whose head is the
      // local name, not the type).
      if (!a.op && a.target.tail.length > 0) {
        const head = a.target.head;
        if (knownAggregates.has(head)) usesAgg.add(head);
        else if (knownRepositories.has(head)) usesRepo.add(head);
      }
    } else if (s.$type === "EmitStmt") {
      const ev = (s as EmitStmt).event?.$refText;
      if (ev) emitsSet.add(ev);
    }
    // Repository receivers can also appear deep inside any expression on
    // any statement form — `let src = Accounts.getById(x)` is the
    // canonical case. Walk every dangling expression.
    for (const expr of statementExprs(s)) collectReceiverNames(expr, knownRepositories, usesRepo);
  }
  if (usesAgg.size > 0) rel.workflowUses.set(wf.name, usesAgg);
  if (usesRepo.size > 0) rel.workflowUsesRepo.set(wf.name, usesRepo);
  if (emitsSet.size > 0) rel.workflowEmits.set(wf.name, emitsSet);
}

export function computeContextRelations(ctx: BoundedContext): ContextRelations {
  const rel: ContextRelations = {
    repoFor: new Map(),
    emits: new Map(),
    workflowUses: new Map(),
    workflowUsesRepo: new Map(),
    workflowEmits: new Map(),
  };
  const aggregateNames = new Set<string>();
  const repositoryNames = new Set<string>();
  for (const m of ctx.members) {
    if (m.$type === "Aggregate") aggregateNames.add((m as Aggregate).name);
    else if (m.$type === "Repository") repositoryNames.add((m as Repository).name);
  }

  for (const m of ctx.members) {
    if (m.$type === "Repository") {
      const r = m as Repository;
      const a = r.aggregate?.$refText;
      if (a) rel.repoFor.set(r.name, a);
    } else if (m.$type === "Aggregate") {
      const a = m as Aggregate;
      const sub = computeAggregateRelations(a);
      // Flatten all per-operation emit sets into the aggregate's outgoing set.
      const allEmits = new Set<string>();
      for (const set of sub.emits.values()) for (const ev of set) allEmits.add(ev);
      if (allEmits.size > 0) rel.emits.set(a.name, allEmits);
    } else if (m.$type === "Workflow") {
      collectWorkflow(m as Workflow, rel, aggregateNames, repositoryNames);
    }
  }
  return rel;
}

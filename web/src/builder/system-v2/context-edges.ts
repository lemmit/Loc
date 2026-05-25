// Pure walker that derives the relational structure of a BoundedContext: the
// repository→aggregate / view→aggregate / aggregate→event / workflow→…
// relationships that turn a context's children-list into a tree.
//
// The aggregate-level walker (`aggregate-edges.ts`) is the source of truth for
// per-aggregate behaviour — we lift `rel.emits` from each aggregate into a
// context-level "aggregate → event" edge here, so the two layers stay
// consistent. Direct ref fields (`Repository.aggregate`, `View.source`) come
// straight off the AST; workflows walk their statement bodies the same way
// aggregate operations do.

import type {
  Aggregate,
  AssignOrCallStmt,
  BoundedContext,
  EmitStmt,
  Repository,
  View,
  Workflow,
} from "../../../../src/language/generated/ast.js";
import { computeAggregateRelations } from "./aggregate-edges";

export interface ContextRelations {
  /** repository name → aggregate name */
  repoFor: Map<string, string>;
  /** view name → aggregate name */
  viewSource: Map<string, string>;
  /** aggregate name → set of event names emitted by its operations */
  emits: Map<string, Set<string>>;
  /** workflow name → set of aggregate names the body refers to (method calls
   *  on `<Aggregate>.x` or `<Aggregate>(...)`) */
  workflowUses: Map<string, Set<string>>;
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

/** Walk a workflow body for the names it touches at top level: methods on a
 *  receiver (`Customer.x`) and emits. Keeps the spike scope-bounded — full
 *  expression walking lives in aggregate-edges.ts when we need it. */
function collectWorkflow(wf: Workflow, rel: ContextRelations, knownAggregateNames: Set<string>): void {
  const usesSet = new Set<string>();
  const emitsSet = new Set<string>();
  for (const s of wf.body) {
    if (s.$type === "AssignOrCallStmt") {
      const a = s as AssignOrCallStmt;
      // A method-call target like `Customer.placeOrder` has LValue.head =
      // "Customer" + tail = ["placeOrder"]. A bare repository-call like
      // `Orders.byId(x)` is the same shape — both are useful "this workflow
      // touches that name" signal. We restrict to known aggregate names to
      // keep the edge set semantic.
      if (!a.op && a.target.tail.length > 0 && knownAggregateNames.has(a.target.head)) {
        usesSet.add(a.target.head);
      }
    } else if (s.$type === "EmitStmt") {
      const ev = (s as EmitStmt).event?.$refText;
      if (ev) emitsSet.add(ev);
    }
  }
  if (usesSet.size > 0) rel.workflowUses.set(wf.name, usesSet);
  if (emitsSet.size > 0) rel.workflowEmits.set(wf.name, emitsSet);
}

export function computeContextRelations(ctx: BoundedContext): ContextRelations {
  const rel: ContextRelations = {
    repoFor: new Map(),
    viewSource: new Map(),
    emits: new Map(),
    workflowUses: new Map(),
    workflowEmits: new Map(),
  };
  const aggregateNames = new Set<string>();
  for (const m of ctx.members) {
    if (m.$type === "Aggregate") aggregateNames.add((m as Aggregate).name);
  }

  for (const m of ctx.members) {
    if (m.$type === "Repository") {
      const r = m as Repository;
      const a = r.aggregate?.$refText;
      if (a) rel.repoFor.set(r.name, a);
    } else if (m.$type === "View") {
      const v = m as View;
      const a = v.source?.$refText;
      if (a) rel.viewSource.set(v.name, a);
    } else if (m.$type === "Aggregate") {
      const a = m as Aggregate;
      const sub = computeAggregateRelations(a);
      // Flatten all per-operation emit sets into the aggregate's outgoing set.
      const allEmits = new Set<string>();
      for (const set of sub.emits.values()) for (const ev of set) allEmits.add(ev);
      if (allEmits.size > 0) rel.emits.set(a.name, allEmits);
    } else if (m.$type === "Workflow") {
      collectWorkflow(m as Workflow, rel, aggregateNames);
    }
  }
  return rel;
}

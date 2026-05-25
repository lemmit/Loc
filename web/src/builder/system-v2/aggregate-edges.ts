// Pure walker that derives the relational structure of an Aggregate: which
// operation/derived/invariant/function references which field/containment,
// which operation writes which field, which operation emits which event.
//
// Used by view-graph.ts to surface aggregate-level edges (reads / writes /
// constrains / emits) — the tree-structure cue the user asked for: an
// aggregate is not a flat bag of children, its operations *act on* its state.
//
// We walk the AST directly (no IR), since v2 operates on the same unlinked
// Langium parse the editor seeds from. A bare `NameRef` in an invariant /
// derived / function body is a read of the same-aggregate field if its name
// matches; in an operation body it may also be a let-bound name (we don't
// resolve those; matching against the known field set rejects them).

import type { AstNode } from "langium";
import type {
  Aggregate,
  AssignOrCallStmt,
  Containment,
  DerivedProp,
  EmitStmt,
  Expression,
  FunctionDecl,
  Invariant,
  LValue,
  MemberAccess,
  NameRef,
  Operation,
  Property,
  Statement,
  ThisRef,
} from "../../../../src/language/generated/ast.js";

/** A source node (an `op:`/`derived:`/`invariant:`/`function:` id from the
 *  view-graph) and the set of field-names it touches in some way. */
export type EdgeSet = Map<string, Set<string>>;

export interface AggregateRelations {
  /** consumer (op/derived/invariant/function id) → set of field names read */
  reads: EdgeSet;
  /** operation id → set of field names assigned */
  writes: EdgeSet;
  /** operation id → set of event names emitted */
  emits: EdgeSet;
}

const addEdge = (m: EdgeSet, src: string, name: string): void => {
  let set = m.get(src);
  if (!set) {
    set = new Set();
    m.set(src, set);
  }
  set.add(name);
};

/** The set of names a consumer may legitimately reference as "state" on this
 *  aggregate — fields + containments. Used to filter NameRef matches inside
 *  invariants / derived bodies (which use bare names, not `this.`). */
function aggregateStateNames(agg: Aggregate): Set<string> {
  const names = new Set<string>();
  for (const m of agg.members) {
    if (m.$type === "Property") names.add((m as Property).name);
    else if (m.$type === "Containment") names.add((m as Containment).name);
    else if (m.$type === "DerivedProp") names.add((m as DerivedProp).name);
  }
  return names;
}

/** Walk every descendant expression under `root`, calling `cb` for each node.
 *  Mirrors the structure of the Langium AST without depending on AstUtils. */
function walkExpr(root: AstNode | undefined, cb: (n: AstNode) => void): void {
  if (!root) return;
  cb(root);
  for (const key of Object.keys(root) as (keyof typeof root)[]) {
    if (key === "$container" || (key as string).startsWith("$")) continue;
    const v = (root as unknown as Record<string, unknown>)[key as string];
    if (Array.isArray(v)) {
      for (const item of v) if (item && typeof item === "object" && "$type" in item) walkExpr(item as AstNode, cb);
    } else if (v && typeof v === "object" && "$type" in (v as object)) {
      walkExpr(v as AstNode, cb);
    }
  }
}

/** Read targets in an expression tree: `this.X` (any depth — the OUTERMOST
 *  member with a ThisRef receiver counts), and bare `NameRef` whose name is
 *  one of the aggregate's state names. */
function collectReads(expr: Expression | undefined, stateNames: Set<string>, into: Set<string>): void {
  walkExpr(expr, (n) => {
    if (n.$type === "MemberAccess") {
      const ma = n as MemberAccess;
      // Only count the outermost step on a `this.` chain — `this.x.y.z` reads
      // field `x`, not `y`/`z` (which are members of the receiver's type).
      // The walker still descends into the receiver, but a non-`this`
      // receiver suppresses the read.
      if (isThisChainTip(ma)) into.add(ma.member);
    } else if (n.$type === "NameRef") {
      const nr = n as NameRef;
      if (stateNames.has(nr.name)) into.add(nr.name);
    }
  });
}

/** True when this `MemberAccess` is the outermost `this.X` reference — i.e.
 *  its receiver is a ThisRef (we want `this.x`, but on `this.x.y` we want the
 *  outer access whose receiver is `this.x`'s member-access, NOT this one).
 *
 *  The trick: we read FIELD names off the aggregate, so only single-step
 *  `this.x` counts. The walker descends and re-visits the inner `this.x` of
 *  `this.x.y` — that inner one is the one we record. */
function isThisChainTip(ma: MemberAccess): boolean {
  return ma.receiver?.$type === "ThisRef";
}

/** Top-level segment written by an assign statement: `x := ...` writes `x`;
 *  `this.x := ...` writes `x`; `this.x.y := ...` writes `x` (the same
 *  outermost-segment rule as reads — backends know how to handle nested
 *  mutation; from a relational standpoint the field touched is the head). */
function writtenField(lv: LValue, stateNames: Set<string>): string | null {
  if (!lv) return null;
  if (lv.head === "this") {
    return lv.tail[0] ?? null;
  }
  return stateNames.has(lv.head) ? lv.head : null;
}

/** Walk an operation/workflow body and collect writes/emits/reads for `src`. */
function collectFromStatements(
  body: Statement[],
  src: string,
  stateNames: Set<string>,
  rel: AggregateRelations,
): void {
  const reads = new Set<string>();
  for (const s of body) {
    if (s.$type === "AssignOrCallStmt") {
      const a = s as AssignOrCallStmt;
      // Op present → it's an assignment; op absent → method call (no write).
      if (a.op) {
        const f = writtenField(a.target, stateNames);
        if (f) addEdge(rel.writes, src, f);
      }
      // The RHS of an assign and the args of a call both contribute reads.
      collectReads(a.value, stateNames, reads);
      for (const arg of a.target.args) collectReads(arg, stateNames, reads);
    } else if (s.$type === "EmitStmt") {
      const e = s as EmitStmt;
      const ev = e.event?.$refText;
      if (ev) addEdge(rel.emits, src, ev);
      for (const f of e.fields) {
        // EmitField has `value` per the grammar — walk it for reads.
        const expr = (f as unknown as { value?: Expression }).value;
        collectReads(expr, stateNames, reads);
      }
    } else if (s.$type === "LetStmt") {
      collectReads((s as { expr: Expression }).expr, stateNames, reads);
    } else if (s.$type === "PreconditionStmt" || s.$type === "RequiresStmt") {
      collectReads((s as { expr: Expression }).expr, stateNames, reads);
    }
  }
  for (const r of reads) addEdge(rel.reads, src, r);
}

export function computeAggregateRelations(agg: Aggregate): AggregateRelations {
  const rel: AggregateRelations = { reads: new Map(), writes: new Map(), emits: new Map() };
  const stateNames = aggregateStateNames(agg);

  // Operations: walk their statement bodies.
  for (const m of agg.members) {
    if (m.$type === "Operation") {
      const op = m as Operation;
      collectFromStatements(op.body, `operation:${op.name}`, stateNames, rel);
    } else if (m.$type === "FunctionDecl") {
      const fn = m as FunctionDecl;
      const reads = new Set<string>();
      collectReads(fn.body, stateNames, reads);
      for (const r of reads) addEdge(rel.reads, `function:${fn.name}`, r);
    } else if (m.$type === "DerivedProp") {
      const d = m as DerivedProp;
      const reads = new Set<string>();
      collectReads(d.expr, stateNames, reads);
      for (const r of reads) addEdge(rel.reads, `derived:${d.name}`, r);
    } else if (m.$type === "Invariant") {
      // Invariants are unnamed — index in source order, matching the view-graph.
      const inv = m as Invariant;
      const idx = invariantIndex(agg, inv);
      const reads = new Set<string>();
      collectReads(inv.expr, stateNames, reads);
      if (inv.guard) collectReads(inv.guard, stateNames, reads);
      for (const r of reads) addEdge(rel.reads, `invariant:${idx}`, r);
    }
  }
  return rel;
}

function invariantIndex(agg: Aggregate, target: Invariant): number {
  let i = 0;
  for (const m of agg.members) {
    if (m.$type === "Invariant") {
      if (m === target) return i;
      i++;
    }
  }
  return -1;
}

// Re-export for callers that don't want to import the AST types just to type
// the result map.
export type { ThisRef };

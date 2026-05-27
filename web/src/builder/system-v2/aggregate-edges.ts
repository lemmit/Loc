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
  EntityPart,
  EntityPartMember,
  EmitStmt,
  Expression,
  FunctionDecl,
  Invariant,
  LValue,
  MemberSuffix,
  NameRef,
  PostfixChain,
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
    if (n.$type === "PostfixChain") {
      const pc = n as PostfixChain;
      // `this.x` / `this.x.y` / `this.x.y.z` all read field `x` — the
      // first member-suffix on a ThisRef head. Subsequent suffixes
      // address members of the receiver's type, not aggregate state.
      if (pc.head?.$type === "ThisRef" && pc.suffixes.length > 0) {
        const first = pc.suffixes[0];
        if (first?.$type === "MemberSuffix") into.add((first as MemberSuffix).member);
      }
    } else if (n.$type === "NameRef") {
      const nr = n as NameRef;
      if (stateNames.has(nr.name)) into.add(nr.name);
    }
  });
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
        collectReads(f.value, stateNames, reads);
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

function entityPartInvariantIndex(part: EntityPart, target: Invariant): number {
  let i = 0;
  for (const m of part.members) {
    if (m.$type === "Invariant") {
      if (m === target) return i;
      i++;
    }
  }
  return -1;
}

/** Entities have the same shape as aggregates minus operations — so reads /
 *  writes from external behaviour don't apply, but `derived`, `invariant`,
 *  and `function` bodies still produce read edges into the entity's own
 *  state. Mirrors `computeAggregateRelations` but loops over
 *  `EntityPartMember` and ignores operation-shaped members (entities don't
 *  declare them). */
export function computeEntityPartRelations(part: EntityPart): AggregateRelations {
  const rel: AggregateRelations = { reads: new Map(), writes: new Map(), emits: new Map() };
  const stateNames = new Set<string>();
  for (const m of part.members as EntityPartMember[]) {
    if (m.$type === "Property") stateNames.add((m as Property).name);
    else if (m.$type === "Containment") stateNames.add((m as Containment).name);
    else if (m.$type === "DerivedProp") stateNames.add((m as DerivedProp).name);
  }
  for (const m of part.members as EntityPartMember[]) {
    if (m.$type === "FunctionDecl") {
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
      const inv = m as Invariant;
      const idx = entityPartInvariantIndex(part, inv);
      const reads = new Set<string>();
      collectReads(inv.expr, stateNames, reads);
      if (inv.guard) collectReads(inv.guard, stateNames, reads);
      for (const r of reads) addEdge(rel.reads, `invariant:${idx}`, r);
    }
  }
  return rel;
}

// Re-export for callers that don't want to import the AST types just to type
// the result map.
export type { ThisRef };

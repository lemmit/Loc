// -------------------------------------------------------------------------
// Id-follow analysis — the bulk-load planning for cross-aggregate follows.
// A cross-aggregate reference is an
// `X id` (opaque handle); reading the referenced aggregate is a batched
// load-by-id through its own repository (boundary-respecting, N+1-visible).
// This leaf owns the path/mapVar machinery the projection `join` lowering
// (`lower-projection`, which reads DECLARED `join` clauses) consumes, plus the
// INFER path that walks bind expressions for id-dots.
// -------------------------------------------------------------------------

import type { ExprIR } from "../types/loom-ir.js";

/** One planned bulk-load: the field-path to the id, the target aggregate, and
 *  the emitter-facing map variable that holds the loaded-by-id lookup. */
export interface Auxiliary {
  path: string[];
  aggName: string;
  mapVar: string;
}

/** Walk a bind expression's IR tree and capture every `X id` follow as an
 *  auxiliary path entry.  Single-hop (`customerId.name`) yields path
 *  `["customerId"]` with target Customer; two-hop (`customerId.regionId.name`)
 *  yields paths `["customerId"]` (Customer) AND `["customerId", "regionId"]`
 *  (Region) — the longer path's prerequisites get loaded first thanks to
 *  dependency ordering at emission time.  Used for inferred
 *  follows; the projection path uses the declared `join` clauses instead. */
export function collectIdFollows(
  expr: ExprIR,
  out: Map<string, { path: string[]; aggName: string }>,
): void {
  if (expr.kind === "member" && expr.receiverType.kind === "id") {
    const path = idFollowPath(expr.receiver);
    if (path) {
      const key = path.join(".");
      if (!out.has(key)) {
        out.set(key, { path, aggName: expr.receiverType.targetName });
      }
    }
    collectIdFollows(expr.receiver, out);
    return;
  }
  if (expr.kind === "member") {
    collectIdFollows(expr.receiver, out);
    return;
  }
  switch (expr.kind) {
    case "method-call":
      collectIdFollows(expr.receiver, out);
      for (const a of expr.args) collectIdFollows(a, out);
      return;
    case "call":
      for (const a of expr.args) collectIdFollows(a, out);
      return;
    case "lambda":
      // Lambda body is optional — single-expression form sets `body`,
      // block-body form sets `block`.  Block bodies don't contribute
      // Id-follow paths (they appear only in event handlers, not in
      // bind/derived/filter expressions where this walker runs).
      if (expr.body) collectIdFollows(expr.body, out);
      return;
    case "match":
      for (const arm of expr.arms) {
        collectIdFollows(arm.cond, out);
        collectIdFollows(arm.value, out);
      }
      if (expr.otherwise) collectIdFollows(expr.otherwise, out);
      return;
    case "binary":
      collectIdFollows(expr.left, out);
      collectIdFollows(expr.right, out);
      return;
    case "unary":
      collectIdFollows(expr.operand, out);
      return;
    case "ternary":
      collectIdFollows(expr.cond, out);
      collectIdFollows(expr.then, out);
      collectIdFollows(expr.otherwise, out);
      return;
    case "paren":
      collectIdFollows(expr.inner, out);
      return;
    case "new":
    case "object":
      for (const f of expr.fields) collectIdFollows(f.value, out);
      return;
  }
}

/** Map-variable name for an auxiliary at a given path.  Single-hop paths get a
 *  clean `<agg>ById`; multi-hop paths suffix the intermediate Pascal'd field
 *  names so two paths that reach the same target aggregate via different
 *  intermediates get distinct map vars. */
export function mapVarForPath(path: string[], aggName: string): string {
  const baseName = aggName.charAt(0).toLowerCase() + aggName.slice(1);
  if (path.length <= 1) return `${baseName}ById`;
  // Multi-hop: e.g. ["customerId", "regionId"] → "regionByCustomerId"
  const prefix = path
    .slice(0, -1)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
  return `${baseName}By${prefix}`;
}

/** Extract the chain of source-field names from an Id-typed expression that's
 *  rooted in a `ref` and built up through `member` accesses on Id-typed
 *  receivers.  Returns undefined for any expression that doesn't fit this
 *  shape (calls, lambdas, member access through non-Id receivers, etc.). */
export function idFollowPath(e: ExprIR): string[] | undefined {
  if (e.kind === "ref" && e.type?.kind === "id") {
    return [e.name];
  }
  if (e.kind === "member" && e.receiverType.kind === "id") {
    const inner = idFollowPath(e.receiver);
    if (!inner) return undefined;
    return [...inner, e.member];
  }
  return undefined;
}

/** Extract the field-name path of a projection `join … on <idRef>` clause —
 *  the DECLARED counterpart of `idFollowPath`.  A join resolves an id-column
 *  reference on the source/alias (`o.customerId`, a stored `customer`, or a
 *  multi-hop `c.regionId`) to a loaded aggregate; the path is that reference's
 *  field-name chain (source `this.<field>` → `[field]`; a prior alias
 *  `<alias>.<field>` → `[alias, field]`).  Returns `[]` for a shape that isn't
 *  a field reference (the caller falls back to the join alias). */
export function joinRefPath(e: ExprIR): string[] {
  if (e.kind === "ref") return [e.name];
  if (e.kind === "member") {
    if (e.receiver.kind === "this") return [e.member];
    return [...joinRefPath(e.receiver), e.member];
  }
  if (e.kind === "paren") return joinRefPath(e.inner);
  return [];
}

/** Order a set of inferred follow paths (shortest first) into emitter-ready
 *  auxiliaries, minting each `mapVar`. */
export function orderAuxiliaries(
  auxByKey: Map<string, { path: string[]; aggName: string }>,
): Auxiliary[] {
  const ordered = [...auxByKey.values()].sort((a, b) => a.path.length - b.path.length);
  return ordered.map((a) => ({ ...a, mapVar: mapVarForPath(a.path, a.aggName) }));
}

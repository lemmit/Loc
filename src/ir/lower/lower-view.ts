// -------------------------------------------------------------------------
// View lowering — lowerView + the Id-follow analysis (bulk-load
// planning over view bind/source expressions). Pure leaf consumed by
// lowerContext in ./lower.ts; builds on lower-members (lowerField).
// -------------------------------------------------------------------------

import { isWorkflow, type View } from "../../language/generated/ast.js";
import type { ExprIR, ViewIR, ViewSourceIR } from "../types/loom-ir.js";
import { resolveBypass } from "./lower-capabilities.js";
import { inferExprType, lowerExpr } from "./lower-expr.js";
import { lowerField } from "./lower-members.js";
import { type Env, inAggregate, inWorkflow } from "./lower-types.js";
import { originFor } from "./origin.js";

export function lowerView(view: View, env: Env): ViewIR {
  // Filter + bind expressions resolve against the source's schema — same env
  // shape repository find filters use.  Bare names (`status`, `lines.count`,
  // `total`) lower to this-rooted property / containment / derived refs.  A
  // workflow source binds `this` to its state fields via `inWorkflow`
  // (workflow-instance-views.md), exactly as an aggregate source uses
  // `inAggregate` — the predicate machinery downstream is source-agnostic.
  const source = view.source?.ref;
  let inner = env;
  let sourceIR: ViewSourceIR = { kind: "aggregate", name: "Unknown" };
  if (source && isWorkflow(source)) {
    inner = inWorkflow(env, source);
    sourceIR = { kind: "workflow", name: source.name };
  } else if (source) {
    inner = inAggregate(env, source);
    sourceIR = { kind: "aggregate", name: source.name };
  }
  const filter = view.filter ? lowerExpr(view.filter, inner) : undefined;
  // The `requires` gate is lowered in the BARE context env (not `inner`), so
  // `currentUser` resolves but the source row's fields do not — a view-level
  // gate decides endpoint access before any row exists, so it must be
  // currentUser-only.  Referencing a source field is then a name-resolution
  // error, exactly the restriction we want.
  const requires = view.gate ? lowerExpr(view.gate, env) : undefined;
  // Full-form views declare an output record.  Each `fields+=Property`
  // gives us a typed field; each `binds+=BindEntry` gives us the
  // expression that produces its value at projection time.  The
  // shorthand form leaves `fields` empty and we surface
  // `output: undefined` so emitters fall back to the aggregate's
  // wire shape.
  const hasOutput = view.fields.length > 0;
  let output: ViewIR["output"] | undefined;
  if (hasOutput) {
    const binds = view.binds.map((b) => ({
      name: b.name,
      expr: lowerExpr(b.expr, inner),
      type: inferExprType(b.expr, inner),
    }));
    // Walk every bind expression for `X id` follow patterns;
    // each unique path becomes one bulk-load + map at emission
    // time.  Order by path length (shortest first) so each
    // hop's prerequisites are guaranteed to load before it.
    const auxByKey = new Map<string, { path: string[]; aggName: string }>();
    for (const b of binds) {
      collectIdFollows(b.expr, auxByKey);
    }
    const ordered = [...auxByKey.values()].sort((a, b) => a.path.length - b.path.length);
    const auxiliaries = ordered.map((a) => ({
      ...a,
      mapVar: mapVarForPath(a.path, a.aggName),
    }));
    output = {
      fields: view.fields.map((p) => lowerField(p)),
      binds,
      auxiliaries,
    };
  }
  return {
    name: view.name,
    source: sourceIR,
    requires,
    filter,
    ...resolveBypass(view),
    output,
    origin: originFor(view),
  };
}

/** Walk a bind expression's IR tree and capture every `X id`
 *  follow as an auxiliary path entry.  Single-hop
 *  (`customerId.name`) yields path `["customerId"]` with target
 *  Customer; two-hop (`customerId.regionId.name`) yields paths
 *  `["customerId"]` (Customer) AND `["customerId", "regionId"]`
 *  (Region) — the longer path's prerequisites get loaded first
 *  thanks to dependency ordering at emission time. */
function collectIdFollows(
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
      // Lambda body is now optional — single-expression form
      // sets `body`, block-body form sets `block`.  Block bodies don't
      // contribute Id-follow paths in v0 (they only appear in event
      // handlers, not in `bind`/`derived`/filter expressions where this
      // walker runs); recurse into `body` only when present.
      if (expr.body) collectIdFollows(expr.body, out);
      return;
    case "match":
      // Recurse through every arm condition + value plus the
      // `else` branch.  Match expressions can appear inside view
      // `bind` exprs and `derived` bodies; their Id-follow members
      // must still surface for the bulk-load auxiliary planner.
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

/** Map-variable name for an auxiliary at a given path.  Single-hop
 *  paths get a clean `<agg>ById`; multi-hop paths suffix the
 *  intermediate Pascal'd field names so two paths that happen to
 *  reach the same target aggregate via different intermediates
 *  get distinct map vars. */
function mapVarForPath(path: string[], aggName: string): string {
  const baseName = aggName.charAt(0).toLowerCase() + aggName.slice(1);
  if (path.length === 1) return `${baseName}ById`;
  // Multi-hop: e.g. ["customerId", "regionId"] → "regionByCustomerId"
  const prefix = path
    .slice(0, -1)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
  return `${baseName}By${prefix}`;
}

/** Extract the chain of source-field names from an Id-typed
 *  expression that's rooted in a `ref` and built up through
 *  `member` accesses on Id-typed receivers.  Returns undefined for
 *  any expression that doesn't fit this shape (calls, lambdas,
 *  member access through non-Id receivers, etc.). */
function idFollowPath(e: ExprIR): string[] | undefined {
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

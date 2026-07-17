// -------------------------------------------------------------------------
// View lowering — lowerView + the Id-follow analysis (bulk-load
// planning over view bind/source expressions). Pure leaf consumed by
// lowerContext in ./lower.ts; builds on lower-members (lowerField).
// -------------------------------------------------------------------------

import { isProjection, isWorkflow, type View } from "../../language/generated/ast.js";
import type { ViewIR, ViewSourceIR } from "../types/loom-ir.js";
import { collectIdFollows, orderAuxiliaries } from "./id-follow.js";
import { resolveBypass } from "./lower-capabilities.js";
import { inferExprType, lowerExpr } from "./lower-expr.js";
import { lowerField } from "./lower-members.js";
import { type Env, inAggregate, inProjection, inWorkflow } from "./lower-types.js";
import { originFor } from "./origin.js";

export function lowerView(view: View, env: Env): ViewIR {
  // Filter + bind expressions resolve against the source's schema — same env
  // shape repository find filters use.  Bare names (`status`, `lines.count`,
  // `total`) lower to this-rooted property / containment / derived refs.  A
  // workflow source binds `this` to its state fields via `inWorkflow`
  // (workflow-instance-views.md), exactly as an aggregate source uses
  // `inAggregate` — the predicate machinery downstream is source-agnostic.
  // A projection source binds `this` to its read-model state fields via
  // `inProjection` (projection.md v1.1), the same source-agnostic path — so the
  // full-form bind-follow works unchanged over a projection row.
  const source = view.source?.ref;
  let inner = env;
  let sourceIR: ViewSourceIR = { kind: "aggregate", name: "Unknown" };
  if (source && isWorkflow(source)) {
    inner = inWorkflow(env, source);
    sourceIR = { kind: "workflow", name: source.name };
  } else if (source && isProjection(source)) {
    inner = inProjection(env, source);
    sourceIR = { kind: "projection", name: source.name };
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
    const auxiliaries = orderAuxiliaries(auxByKey);
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

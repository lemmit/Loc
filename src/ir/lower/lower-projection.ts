// ⑤a lowering — projection read models (projection.md).
//
// A projection is the passive read-half of an event-sourced workflow: declared
// state fields (`Property`) + pure `on(e: Event)` folds over FOREIGN events,
// keyed by an explicit correlation column.  This leaf mirrors the workflow
// state-field + reactor-subscription lowering (`lower-workflow.ts`), but the
// fold body is lowered PURE (`lowerStatement`, like an aggregate `apply`) —
// never `lowerWorkflowStatement` — so it drags in no load/save/emit machinery
// and the impurity gate (`loom.projection-fold-impure`) has something to catch.
//
// Leaf discipline (pipeline-layering): imports only sibling leaves, never the
// `lower.ts` orchestrator.

import type { Projection, ProjectionOn } from "../../language/generated/ast.js";
import { isProperty } from "../../language/generated/ast.js";
import type { FieldIR, ProjectionIR, ProjectionOnIR, StmtIR } from "../types/loom-ir.js";
import { lowerExpr } from "./lower-expr.js";
import { lowerField } from "./lower-members.js";
import { lowerStatement } from "./lower-stmt.js";
import { type Env, inProjection, withLocal } from "./lower-types.js";
import { originFor } from "./origin.js";

/** Lower a `projection <Name> keyed by <field> { … }` declaration.  The env
 *  arrives at context scope; `inProjection` binds `this` to the row so bare
 *  state-field names (`status := Shipped`) resolve as `this`-props. */
export function lowerProjection(p: Projection, env: Env): ProjectionIR {
  const projEnv = inProjection(env, p);
  const stateFields: FieldIR[] = p.members.filter(isProperty).map((m) => lowerField(m, projEnv));
  const handlers: ProjectionOnIR[] = [];
  for (const m of p.members) {
    if (isProjectionOnMember(m)) handlers.push(lowerProjectionOn(m, projEnv));
  }
  return {
    name: p.name,
    stateFields,
    // `keyed by` is required by the grammar; validation confirms it names a
    // declared id-shaped state field (`loom.projection-key-*`).
    correlationField: p.key,
    handlers,
    origin: originFor(p),
  };
}

/** A pure fold over one foreign event.  Binds the event param as a
 *  `refKind: "param"` local typed as the event entity (so `e.field` resolves),
 *  then lowers the body PURE against the projection-bound `this`. */
function lowerProjectionOn(o: ProjectionOn, projEnv: Env): ProjectionOnIR {
  const eventName = o.event.ref?.name ?? o.event.$refText;
  const inner = withLocal(projEnv, o.param, "param", { kind: "entity", name: eventName });
  const correlation = o.correlation ? lowerExpr(o.correlation, inner) : undefined;
  const statements: StmtIR[] = [];
  let bodyEnv = inner;
  for (const s of o.body) {
    const result = lowerStatement(s, bodyEnv);
    statements.push(result.stmt);
    bodyEnv = result.envAfter;
  }
  return {
    event: eventName,
    param: o.param,
    ...(correlation ? { correlation } : {}),
    statements,
  };
}

// `ProjectionMember = ProjectionOn | Property`; the generated `isProjectionOn`
// guard is imported lazily to keep this leaf's import surface minimal.
function isProjectionOnMember(m: Projection["members"][number]): m is ProjectionOn {
  return m.$type === "ProjectionOn";
}

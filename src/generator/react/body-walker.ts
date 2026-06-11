// React entry to the shared markup walker.
//
// The walker core (walk dispatch, primitive emitters, WalkContext)
// lives in `src/generator/_walker/walker-core.ts` and is shared with
// the Svelte frontend; this module re-exports its full surface so
// react-side consumers (page-shell, pages-emitter, layouts-emitter,
// tests) keep their import path, and adds the TSX-flavoured entry
// point that threads `tsxTarget` into the walk.

import type {
  AggregateIR,
  BoundedContextIR,
  ExprIR,
  ParamIR,
  UiApiParamIR,
  WorkflowIR,
} from "../../ir/types/loom-ir.js";
import type { LoadedPack } from "../_packs/loader.js";
import { type WalkResult, walkBody } from "../_walker/walker-core.js";
import { tsxTarget } from "./walker/tsx-target.js";

export * from "../_walker/walker-core.js";

/** Walk a page/component body and emit TSX through the shared walker
 *  core with the React target.  Signature unchanged from the
 *  pre-extraction inline walker — callers are agnostic of the split. */
export function walkBodyToTsx(
  body: ExprIR,
  pack: LoadedPack,
  paramNames: ReadonlySet<string> = new Set(),
  stateNames: ReadonlySet<string> = new Set(),
  userComponents: ReadonlyMap<string, readonly ParamIR[]> = new Map(),
  apiParams: ReadonlyArray<UiApiParamIR> = [],
  aggregatesByName: ReadonlyMap<string, AggregateIR> = new Map(),
  bcByAggregate: ReadonlyMap<string, BoundedContextIR> = new Map(),
  workflowsByName: ReadonlyMap<string, WorkflowIR> = new Map(),
  bcByWorkflow: ReadonlyMap<string, BoundedContextIR> = new Map(),
  paramTypes: ReadonlyMap<string, string> = new Map(),
  pageRoutes: ReadonlyMap<string, string> = new Map(),
  /** Extern frontend function names declared on this ui. */
  externFunctions: ReadonlySet<string> = new Set(),
): WalkResult {
  return walkBody(
    body,
    tsxTarget,
    pack,
    paramNames,
    stateNames,
    userComponents,
    apiParams,
    aggregatesByName,
    bcByAggregate,
    workflowsByName,
    bcByWorkflow,
    paramTypes,
    pageRoutes,
    externFunctions,
  );
}

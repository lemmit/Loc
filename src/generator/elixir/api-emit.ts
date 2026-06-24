import type { BoundedContextIR, DeployableIR, SystemIR } from "../../ir/types/loom-ir.js";
import { snake } from "../../util/naming.js";

// ---------------------------------------------------------------------------
// API controller route vocabulary for the Phoenix LiveView (vanilla) backend.
//
// `platform: elixir` generates plain Phoenix + Ecto; the per-aggregate
// controller emission lives in `vanilla/api-emit.ts`.  This module now holds
// only the cross-cutting route vocabulary the vanilla emitters + shell router
// splicer share:
//
//   - `ApiRoute` — the route descriptor collected per-controller and spliced
//     into router.ex's `scope "/api"` block (the `!root:` sentinel marks the
//     handful of routes — /health, /ready — that land outside the api scope).
//   - `CRUD_VERB_NAMES` / `crudOpNames` — the standard CRUD action names and
//     the subset claimed by a public operation (so the per-op route wins and
//     the redundant standard CRUD action is suppressed).
// ---------------------------------------------------------------------------

export interface ApiEmitArgs {
  contexts: BoundedContextIR[];
  deployable: DeployableIR;
  sys: SystemIR;
  /** snake_case application name, e.g. "phoenix_app" */
  appName: string;
  /** PascalCase module prefix, e.g. "PhoenixApp" */
  appModule: string;
  /** Compile-time --trace switch. */
  emitTrace?: boolean;
}

/** Standard CRUD action/define names the Phoenix backend emits for a served
 *  aggregate (list/get/create/update/destroy).  A public operation whose
 *  snake name collides with one of these (e.g. crudish's canonical `update`)
 *  is the **canonical cross-backend form** — Hono/.NET serve it as
 *  `POST /<plural>/:id/<op>` with a per-op request schema (`UpdateXRequest`),
 *  and the conformance gate compares that schema across backends.  Phoenix
 *  must match it.  So when an op claims a CRUD-verb name, the **operation
 *  wins**: the per-op route/controller `def`/domain `define`/OpenAPI path are
 *  kept, and the redundant **standard** CRUD action of that name (which is
 *  Phoenix-controller-only — never in the OpenAPI or Hono) is suppressed, so
 *  the two don't collide into a duplicate `def <verb>/2` clause.
 *  `crudOpNames(agg)` returns the set to suppress. */
export const CRUD_VERB_NAMES: ReadonlySet<string> = new Set([
  "list",
  "get",
  "create",
  "update",
  "destroy",
]);

/** The CRUD-verb names claimed by an aggregate's public operations — the
 *  standard CRUD actions/defines to suppress in favour of the operation. */
export function crudOpNames(agg: {
  operations: { name: string; visibility?: string }[];
}): ReadonlySet<string> {
  const out = new Set<string>();
  for (const op of agg.operations) {
    if (op.visibility !== "public") continue;
    const s = snake(op.name);
    if (CRUD_VERB_NAMES.has(s)) out.add(s);
  }
  return out;
}

export interface ApiRoute {
  method: "get" | "post" | "put" | "patch" | "delete";
  /**
   * Path inside `scope "/api"` — e.g. "/workflows/place_order".
   * Paths that start with `!root:` (e.g. `!root:/health`) are outside
   * the api scope; the orchestrator strips the prefix and splices them
   * at router root level.
   */
  path: string;
  /**
   * Controller module local name (without `<App>Web.` prefix),
   * e.g. "WorkflowsController".
   */
  controller: string;
  /** Action atom, e.g. ":place_order". */
  action: string;
}

export interface ApiEmitResult {
  files: Map<string, string>;
  apiRoutes: ApiRoute[];
}

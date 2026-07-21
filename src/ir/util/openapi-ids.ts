// Canonical operationId tokens — the single source of truth for the
// `operationId` every backend stamps on its OpenAPI operations.
//
// Each `op*` function returns an ordered **token array** (e.g.
// `["get", "Project", "byId"]`).  A backend renders that array in its own
// idiom by joining the tokens:
//
//   camelId(opGetById("Project"))  // → "getProjectById"   (Hono / .NET)
//   snakeId(opGetById("Project"))  // → "get_project_by_id" (Phoenix)
//
// The conformance gate compares operationIds case-insensitively (lower +
// strip separators), so the same token array renders to forms that
// compare equal across backends.  Keeping the token arrays here — rather
// than hand-built per backend — is what stops the three specs from
// drifting on operationId naming (the divergence the parity series
// flagged: `all` vs `list`, `…Workflow` vs `run_…`, `…View` vs `query_…`).
//
// Canonical token sequences (chosen to match Hono's pre-existing scheme,
// which the playground Backend console keys on as a stable picker id):
//   create   → [create, <Agg>]
//   getById  → [get, <Agg>, byId]
//   list     → [all, <Agg>]            (canonical stem is `all`, not `list`)
//   operation→ [<op>, <Agg>]
//   find     → [<find>, <Agg>]
//   workflow → [<wf>, workflow]

import { lowerFirst, snake, upperFirst } from "../../util/naming.js";

/** An operationId as an ordered token array (each token may itself be
 *  camelCase, e.g. `"addPipeline"`). */
export type OpIdTokens = readonly string[];

/** `POST /<aggs>` — create a new aggregate. */
export function opCreate(aggName: string): OpIdTokens {
  return ["create", aggName];
}

/** `GET /<aggs>/{id}` — fetch one aggregate by id. */
export function opGetById(aggName: string): OpIdTokens {
  return ["get", aggName, "byId"];
}

/** `DELETE /<aggs>/{id}` — hard-delete an aggregate (canonical destroy). */
export function opDestroy(aggName: string): OpIdTokens {
  return ["destroy", aggName];
}

/** `GET /<aggs>` — list all aggregates (canonical stem is `all`, not `list`). */
export function opList(aggName: string): OpIdTokens {
  return ["all", aggName];
}

/** `POST /<aggs>/{id}/<op>` — invoke a domain operation. */
export function opOperation(aggName: string, opName: string): OpIdTokens {
  return [opName, aggName];
}

/** `GET /<aggs>/<find>` — a repository finder. */
export function opFind(aggName: string, findName: string): OpIdTokens {
  return [findName, aggName];
}

/** `POST /workflows/<wf>` — run a workflow. */
export function opWorkflow(wfName: string): OpIdTokens {
  return [wfName, "workflow"];
}

/** `GET /workflows/<wf>/instances` — list a workflow's running instances. */
export function opWorkflowInstances(wfName: string): OpIdTokens {
  return ["all", wfName, "instances"];
}

/** `GET /workflows/<wf>/instances/{id}` — fetch one workflow instance by its
 *  correlation id. */
export function opWorkflowInstanceById(wfName: string): OpIdTokens {
  return ["get", wfName, "instance", "byId"];
}

/** Render tokens as camelCase (`getProjectById`) — Hono / .NET idiom. */
export function camelId(tokens: OpIdTokens): string {
  return tokens.map((t, i) => (i === 0 ? lowerFirst(t) : upperFirst(t))).join("");
}

/** Render tokens as snake_case (`get_project_by_id`) — Phoenix idiom.
 *  Each token is individually snake-cased, so a camelCase token like
 *  `addPipeline` becomes `add_pipeline` before the tokens are joined. */
export function snakeId(tokens: OpIdTokens): string {
  return tokens.map((t) => snake(t)).join("_");
}

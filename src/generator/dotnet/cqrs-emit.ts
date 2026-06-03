import { createInputFields, hasCreate } from "../../ir/enrich/wire-projection.js";
import type {
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  RepositoryIR,
} from "../../ir/types/loom-ir.js";
import { plural } from "../../util/naming.js";
import {
  emitCreateCommandAndHandler,
  emitDestroyCommandAndHandler,
  emitOperationCommandsAndHandlers,
} from "./cqrs/commands.js";
import { emitController } from "./cqrs/controller.js";
import { emitRequestDtos, emitResponseDtos } from "./cqrs/dtos.js";
import { emitFindQueriesAndHandlers, emitGetByIdQueryAndHandler } from "./cqrs/queries.js";

// ---------------------------------------------------------------------------
// Per-aggregate CQRS file emission.  This module is the orchestrator: it
// drives the per-concern emitters under `./cqrs/` (dtos, commands, queries,
// controller), each of which is an independent leaf.
//
// For each aggregate this produces:
//   - Request DTOs (Create<Agg>Request, <Op>Request, <VO>Request, …)
//   - Response DTOs (<Agg>Response, <Part>Response, <VO>Response,
//     Create<Agg>Response, …)
//   - Create<Agg> command + handler (factory call → repo.Save)
//   - One command + handler per public operation (repo.Get → method →
//     repo.Save)
//   - Get<Agg>ById query + handler (repo.Get → projectToResponse)
//   - One query + handler per repository `find` (repo.<find> → project list)
//   - The aggregate's Web API controller (Request → Command, Response
//     pass-through)
// ---------------------------------------------------------------------------

export function emitCqrs(
  agg: EnrichedAggregateIR,
  repo: RepositoryIR | undefined,
  ctx: EnrichedBoundedContextIR,
  ns: string,
  out: Map<string, string>,
  options?: { routePrefix?: string; emitTrace?: boolean; usingDapper?: boolean },
): void {
  const aggFolder = plural(agg.name);
  // Create-request payload: required + access-permitted client input.
  // `forCreateInput` excludes `managed` / `token` / `internal` (server-
  // owned or domain-only), keeps `immutable` (settable at creation) and
  // `secret` (client supplies password hashes / API keys).
  const requiredFields = createInputFields(agg);

  emitResponseDtos(agg, ctx, ns, aggFolder, out);
  emitRequestDtos(agg, ctx, ns, aggFolder, out);
  // Create command/handler gated on the IR lifecycle (`canonicalCreate`),
  // mirroring the destroy gate below: an aggregate that declares no create
  // is not constructible over HTTP and emits no Create command/handler,
  // request DTO, response, or controller action.
  if (hasCreate(agg)) emitCreateCommandAndHandler(agg, requiredFields, ns, aggFolder, out);
  // Canonical destroy → Delete command + handler (gated on the IR
  // lifecycle, so plain aggregates emit no extra CQRS files).
  if (agg.canonicalDestroy) emitDestroyCommandAndHandler(agg, ns, aggFolder, out);
  emitOperationCommandsAndHandlers(agg, ctx, ns, aggFolder, out);
  emitGetByIdQueryAndHandler(agg, ctx, ns, aggFolder, out);
  emitFindQueriesAndHandlers(agg, repo, ctx, ns, aggFolder, out);
  emitController(
    agg,
    repo,
    ctx,
    requiredFields,
    ns,
    out,
    options?.routePrefix,
    options?.emitTrace,
    options?.usingDapper,
  );
}

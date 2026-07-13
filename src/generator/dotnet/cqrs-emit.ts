import { createInputFields, emitsRestCreate } from "../../ir/enrich/wire-projection.js";
import type {
  AggregateIR,
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  RepositoryIR,
} from "../../ir/types/loom-ir.js";
import { tableOwnerName } from "../../ir/util/inheritance.js";
import { plural } from "../../util/naming.js";
import {
  emitCreateCommandAndHandler,
  emitDestroyCommandAndHandler,
  emitOperationCommandsAndHandlers,
} from "./cqrs/commands.js";
import { emitController } from "./cqrs/controller.js";
import { emitRequestDtos, emitResponseDtos, emitUnionDtos } from "./cqrs/dtos.js";
import {
  emitCanOpQueriesAndHandlers,
  emitFindQueriesAndHandlers,
  emitGetByIdQueryAndHandler,
} from "./cqrs/queries.js";

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
  // Strongly-typed id class for this aggregate's key — a TPH (`sharedTable`)
  // concrete shares its base's `<Base>Id`; everyone else uses `<Agg>Id`
  // (`tableOwnerName` returns the aggregate itself off the TPH path, so this is
  // byte-identical there).  Threaded into the command / query / controller
  // emitters so every id surface names the inherited key.
  const idClass = `${tableOwnerName(agg, ctx.aggregates)}Id`;
  // Create-request payload: required + access-permitted client input.
  // `forCreateInput` excludes `managed` / `token` / `internal` (server-
  // owned or domain-only), keeps `immutable` (settable at creation) and
  // `secret` (client supplies password hashes / API keys).
  // Event sourcing (appliers A2.2b): an event-sourced aggregate is
  // constructed from its single `create` action's params (the command
  // shape), not the field set — so the CreateRequest / CreateCommand /
  // handler / controller bind those params and call the event-sourced
  // `Create(...)` factory.  The FluentValidation create-validator (built
  // from invariants over the field set) is skipped: domain invariants are
  // enforced on the fold (`_FromEvents` AssertInvariants), and the params
  // need not align with the field set.
  const esCreate = agg.persistedAs === "eventLog" ? agg.creates?.[0] : undefined;
  const requiredFields = esCreate
    ? esCreate.params.map(
        (p) => ({ name: p.name, type: p.type, optional: false }) as AggregateIR["fields"][number],
      )
    : createInputFields(agg);
  const aggHasCreate = emitsRestCreate(agg);

  emitResponseDtos(agg, ctx, ns, aggFolder, out);
  // Discriminated-union response DTOs (P4c) — polymorphic base + variant
  // records for each union find return on this aggregate's repository.
  emitUnionDtos(agg, repo, ctx, ns, aggFolder, out);
  emitRequestDtos(agg, ctx, ns, aggFolder, out, aggHasCreate ? requiredFields : undefined);
  // Create command/handler gated on the IR lifecycle (`canonicalCreate`),
  // mirroring the destroy gate below: an aggregate that declares no create
  // is not constructible over HTTP and emits no Create command/handler,
  // request DTO, response, or controller action.
  // Audited lifecycle (audit-and-logging.md): a `create(...) audited` /
  // `destroy audited` stages an audit_records row in the lifecycle transaction.
  // The route-driving create is the ES `create` for an event-sourced aggregate,
  // else the canonical create; a named create has no route, so only the
  // route-driving action's `audited` flag matters (mirrors the Hono gate).
  const auditedCreateAction = esCreate ?? agg.canonicalCreate ?? null;
  const auditCreate = !options?.usingDapper && !!auditedCreateAction?.audited;
  const auditDestroy = !options?.usingDapper && !!agg.canonicalDestroy?.audited;
  if (aggHasCreate) {
    emitCreateCommandAndHandler(agg, requiredFields, ns, aggFolder, out, {
      emitValidator: !esCreate,
      idClass,
      auditCtx: auditCreate ? ctx : undefined,
    });
  }
  // Canonical destroy → Delete command + handler (gated on the IR
  // lifecycle, so plain aggregates emit no extra CQRS files).
  if (agg.canonicalDestroy)
    emitDestroyCommandAndHandler(agg, ns, aggFolder, out, idClass, auditDestroy ? ctx : undefined);
  emitOperationCommandsAndHandlers(agg, ctx, ns, aggFolder, out, idClass);
  emitGetByIdQueryAndHandler(agg, ctx, ns, aggFolder, out, idClass);
  emitCanOpQueriesAndHandlers(agg, ns, aggFolder, out, idClass);
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
    aggHasCreate,
    idClass,
  );
}

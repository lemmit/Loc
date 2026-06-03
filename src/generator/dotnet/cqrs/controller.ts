import { hasCreate } from "../../../ir/enrich/wire-projection.js";
import { pagedReturn } from "../../../ir/stdlib/generics.js";
import type {
  AggregateIR,
  EnrichedBoundedContextIR,
  RepositoryIR,
} from "../../../ir/types/loom-ir.js";
import { operationIsGuarded } from "../../../ir/types/loom-ir.js";
import { plural, upperFirst } from "../../../util/naming.js";
import {
  collectWireUsings,
  csIdValueClrType,
  wireToCommandArgument,
  wireType,
} from "../dto-mapping.js";
import { renderController } from "../emit.js";

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export function emitController(
  agg: AggregateIR,
  repo: RepositoryIR | undefined,
  ctx: EnrichedBoundedContextIR,
  requiredFields: AggregateIR["fields"],
  ns: string,
  out: Map<string, string>,
  routePrefix?: string,
  emitTrace?: boolean,
  usingDapper?: boolean,
  /** Force the POST create action on (event-sourced aggregates are
   *  constructible via their `create` action even when `hasCreate` — the
   *  field-set constructibility check — is false).  Defaults to
   *  `hasCreate(agg)`. */
  createActionOverride?: boolean,
): void {
  // Namespaces the wire→command conversions below reach into (e.g.
  // System.Globalization for a datetime/money parse); collected over the
  // same types those conversions consume so the controller file imports
  // each once, only when actually needed.
  const publicOps = agg.operations.filter((o) => o.visibility === "public");
  const usings = new Set<string>();
  for (const f of requiredFields) collectWireUsings(f.type, ctx, usings);
  for (const op of publicOps) for (const p of op.params) collectWireUsings(p.type, ctx, usings);
  for (const find of repo?.finds ?? [])
    for (const p of find.params) collectWireUsings(p.type, ctx, usings);
  // A paged find's action returns `Paged<…Response>` from the shared runtime.
  if ((repo?.finds ?? []).some((f) => pagedReturn(f.returnType))) usings.add(`${ns}.Domain.Common`);
  out.set(
    `Api/${upperFirst(plural(agg.name))}Controller.cs`,
    renderController(agg, repo, ns, {
      idClrType: csIdValueClrType(agg.idValueType),
      createAction: createActionOverride ?? hasCreate(agg),
      destroyAction: !!agg.canonicalDestroy,
      createCmdArgs: requiredFields.map((f) =>
        wireToCommandArgument(`request.${upperFirst(f.name)}`, f.type, ctx),
      ),
      publicOps: agg.operations
        .filter((o) => o.visibility === "public")
        .map((op) => ({
          name: op.name,
          // URL segment from routeSlug (D-URLSTYLE); name stays the verb
          // for the C# action method + command type.
          routeSlug: op.routeSlug,
          cmdArgs: op.params.map((p) =>
            wireToCommandArgument(`request.${upperFirst(p.name)}`, p.type, ctx),
          ),
          // Wire-shape key set for --trace's wire_in line.  Param names
          // are lowerCamel in the IR — same form the JSON wire uses
          // (default ASP.NET JsonNamingPolicy.CamelCase).
          paramNames: op.params.map((p) => p.name),
          guarded: operationIsGuarded(op),
        })),
      finds: (repo?.finds ?? []).map((find) => {
        const paged = pagedReturn(find.returnType);
        return {
          name: find.name,
          isRoot: find.name === "all",
          queryRouteParams: [
            ...find.params.map((p) => {
              // A required find param must bind required so Swashbuckle emits
              // `required: true` — a non-nullable reference type alone reads as
              // optional, diverging from Hono/Phoenix (which mark it required).
              // Optional params (`kind === "optional"`) stay optional.  Attribute
              // fully-qualified to avoid an unused `using` under /warnaserror.
              const bind =
                p.type.kind === "optional"
                  ? ""
                  : "[Microsoft.AspNetCore.Mvc.ModelBinding.BindRequired] ";
              return `[FromQuery] ${bind}${wireType(p.type, ctx, "request")} ${p.name}`;
            }),
            // Paged finds auto-gain 1-based page/pageSize query params with
            // defaults (P3b), mirroring the Hono/React contract.
            ...(paged ? ["[FromQuery] int page = 1", "[FromQuery] int pageSize = 20"] : []),
          ].join(", "),
          queryConstructorArgs: [
            ...find.params.map((p) => wireToCommandArgument(p.name, p.type, ctx)),
            ...(paged ? ["page", "pageSize"] : []),
          ].join(", "),
          returnShape: (paged
            ? "paged"
            : find.returnType.kind === "array"
              ? "list"
              : find.returnType.kind === "optional"
                ? "optional"
                : "single") as "list" | "optional" | "single" | "paged",
        };
      }),
      extraUsings: [...usings].sort(),
      routePrefix,
      emitTrace,
      usingDapper,
    }),
  );
}

import { emitsRestCreate } from "../../../ir/enrich/wire-projection.js";
import { pagedReturn } from "../../../ir/stdlib/generics.js";
import { unionInstanceName } from "../../../ir/stdlib/unions.js";
import type {
  AggregateIR,
  EnrichedBoundedContextIR,
  OperationIR,
  RepositoryIR,
} from "../../../ir/types/loom-ir.js";
import { operationIsGuarded } from "../../../ir/types/loom-ir.js";
import { aggregateIsVersioned } from "../../../ir/util/versioned-capability.js";
import { defaultErrorStatus, errorTitle, errorTypeUri } from "../../../util/error-defaults.js";
import { plural, upperFirst } from "../../../util/naming.js";
import { findUnionSpec, unionMembers } from "../../_payload/union-wire.js";
import {
  collectWireUsings,
  csIdValueClrType,
  wireToCommandArgument,
  wireType,
} from "../dto-mapping.js";
import type { ControllerShape } from "../emit/api.js";
import { renderController } from "../emit.js";

/** One arm of a return-typed operation's controller translation. */
export interface ReturnUnionArm {
  tag: string;
  isError: boolean;
  /** Error arm: the HTTP status, RFC-7807 title + type URI. */
  status: number;
  title: string;
  typeUri: string;
  /** Success arm: the App-DTO variant constructor args (`v.Id`, `v.Code`, …);
   *  `["v.Value"]` for a scalar, `[]` for `none`. */
  ctorArgs: string[];
}

/** Controller-side translation spec for an exception-less operation return. */
export interface ReturnUnionSpec {
  unionName: string;
  /** Fully-qualified Domain union namespace (the `_mediator.Send` result type)
   *  and Application wire-DTO namespace — both define `<Union>` / `<Union>_<Tag>`,
   *  so the controller spells them out to disambiguate. */
  domainNs: string;
  appNs: string;
  arms: ReturnUnionArm[];
  /** Distinct error statuses → `[ProducesResponseType]` declarations. */
  errorStatuses: number[];
}

/** Build the controller-shape spec for ONE public operation (F5d
 *  decomposition) — the object `renderController`'s `publicOps` array
 *  carries per op, and the input `renderOperationActionBlock` consumes.
 *  The cqrs StyleAdapter's `emitEndpoint(op)` builds a single spec
 *  through this. */
export function buildOperationSpec(
  agg: AggregateIR,
  op: AggregateIR["operations"][number],
  ctx: EnrichedBoundedContextIR,
  ns: string,
): ControllerShape["publicOps"][number] {
  return {
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
    // `when` canCommand gate: 409 on the action + the GET can_<op>
    // companion (criterion.md use site 2).
    whenGated: !!op.when,
    // A versioned aggregate's `update` declares 409 (stale `If-Match` →
    // optimistic-concurrency conflict), mirroring the Hono contract so the
    // conformance error-response dimension compares equal.
    versionedUpdate: op.name === "update" && aggregateIsVersioned(agg),
    // Exception-less return-typed op: the controller-side translation spec
    // (Domain union → ProblemDetails / Ok-wrapped wire DTO).
    returnUnion: buildReturnUnionSpec(op, agg, ctx, ns),
  };
}

function buildReturnUnionSpec(
  op: OperationIR,
  agg: AggregateIR,
  ctx: EnrichedBoundedContextIR,
  ns: string,
): ReturnUnionSpec | undefined {
  if (op.returnType?.kind !== "union") return undefined;
  const variants = op.returnType.variants;
  const members = unionMembers(variants, ctx);
  const isError = (i: number): boolean => {
    const v = variants[i]!;
    return v.kind === "entity" && ctx.payloads.some((p) => p.name === v.name && p.kind === "error");
  };
  const arms: ReturnUnionArm[] = members.map((m, i) => {
    const status = ctx.errorStatusOverrides?.[m.tag] ?? defaultErrorStatus(m.tag);
    const ctorArgs =
      m.shape === "none"
        ? []
        : m.shape === "scalar"
          ? ["v.Value"]
          : m.fields.map((f) => `v.${upperFirst(f.name)}`);
    return {
      tag: m.tag,
      isError: isError(i),
      status,
      title: errorTitle(m.tag),
      typeUri: errorTypeUri(m.tag),
      ctorArgs,
    };
  });
  const errorStatuses = [...new Set(arms.filter((a) => a.isError).map((a) => a.status))].sort(
    (a, b) => a - b,
  );
  return {
    unionName: unionInstanceName(variants),
    domainNs: `${ns}.Domain.${plural(agg.name)}`,
    appNs: `${ns}.Application.${plural(agg.name)}.Responses`,
    arms,
    errorStatuses,
  };
}

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
  /** Force the POST create action on/off.  Defaults to
   *  `emitsRestCreate(agg)` — a canonical `create` (explicit / crudish) for a
   *  state aggregate, or a creation event for an event-sourced one. */
  createActionOverride?: boolean,
  /** Strongly-typed id class for the route id param (default `<Agg>Id`); a TPH
   *  concrete passes its base's `<Base>Id` (the shared inherited key). */
  idClass: string = `${agg.name}Id`,
): void {
  // Namespaces the wire→command conversions below reach into (e.g.
  // System.Globalization for a datetime/money parse); collected over the
  // same types those conversions consume so the controller file imports
  // each once, only when actually needed.
  const publicOps = agg.operations.filter((o) => o.visibility === "public");
  // A synthesized find (paged-run queryHandler support) is never auto-exposed by
  // the aggregate controller — the queryHandler's own route is the exposure — so
  // it drives no action / OpenAPI path here.
  const exposedFinds = (repo?.finds ?? []).filter((f) => !f.synthesized);
  const usings = new Set<string>();
  for (const f of requiredFields) collectWireUsings(f.type, ctx, usings);
  for (const op of publicOps) for (const p of op.params) collectWireUsings(p.type, ctx, usings);
  for (const find of exposedFinds)
    for (const p of find.params) collectWireUsings(p.type, ctx, usings);
  // A paged find's action returns `Paged<…Response>` from the shared runtime.
  if (exposedFinds.some((f) => pagedReturn(f.returnType))) usings.add(`${ns}.Domain.Common`);
  out.set(
    `Api/${upperFirst(plural(agg.name))}Controller.cs`,
    renderController(agg, repo, ns, {
      idClass,
      idClrType: csIdValueClrType(agg.idValueType),
      createAction: createActionOverride ?? emitsRestCreate(agg),
      destroyAction: !!agg.canonicalDestroy,
      createCmdArgs: requiredFields.map((f) =>
        wireToCommandArgument(`request.${upperFirst(f.name)}`, f.type, ctx),
      ),
      publicOps: agg.operations
        .filter((o) => o.visibility === "public")
        .map((op) => buildOperationSpec(agg, op, ctx, ns)),
      finds: exposedFinds.map((find) => {
        const paged = pagedReturn(find.returnType);
        // A single-success union find returns the SUCCESS variant's
        // `<Agg>Response` directly at 200 (exception-less.md §4); the
        // query/handler yield it as an optional twin (`<Agg>Response?`).
        const isUnion = find.returnType.kind === "union";
        // Producer-side absence translation (validator-pinned shape): a null
        // result maps to its HTTP edge — `none` rides the optional-find 404, an
        // `error` payload becomes ProblemDetails at its mapped status (api
        // `httpStatus` override or the stdlib default).  The error variant is
        // NEVER part of the 200 schema.
        const spec = isUnion ? findUnionSpec(find.returnType, agg.name, ctx) : null;
        const unionAbsent = spec
          ? spec.absent.kind === "none"
            ? ({ kind: "none" } as const)
            : ({
                kind: "error",
                status:
                  ctx.errorStatusOverrides?.[spec.absent.tag] ??
                  defaultErrorStatus(spec.absent.tag),
                title: errorTitle(spec.absent.tag),
                typeUri: errorTypeUri(spec.absent.tag),
                // The `resource` extension carries the aggregate name when the
                // error payload declares it — matching the cross-backend absent
                // body (Hono / Python / Java / Phoenix / vanilla all emit it).
                resource: spec.absent.hasResource ? agg.name : undefined,
              } as const)
          : undefined;
        return {
          unionAbsent,
          name: find.name,
          isRoot: find.name === "all",
          responseType: isUnion ? `${agg.name}Response` : undefined,
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
            // Paged finds auto-gain 1-based page/pageSize + sort/dir query
            // params with defaults (P3b / M-T2.6), mirroring the Hono contract.
            ...(paged
              ? [
                  "[FromQuery] int page = 1",
                  "[FromQuery] int pageSize = 20",
                  '[FromQuery] string sort = "id"',
                  '[FromQuery] string dir = "asc"',
                ]
              : []),
          ].join(", "),
          queryConstructorArgs: [
            ...find.params.map((p) => wireToCommandArgument(p.name, p.type, ctx)),
            ...(paged ? ["page", "pageSize", "sort", "dir"] : []),
          ].join(", "),
          returnShape: (paged
            ? "paged"
            : isUnion
              ? "union"
              : find.returnType.kind === "array"
                ? "list"
                : find.returnType.kind === "optional"
                  ? "optional"
                  : "single") as "list" | "optional" | "single" | "paged" | "union",
        };
      }),
      extraUsings: [...usings].sort(),
      routePrefix,
      emitTrace,
      usingDapper,
      // Structural-conflict `httpStatus` overrides (M-T3.4a) — drives the
      // destroy FK-restrict arm + the per-op when/versioned 409 declarations.
      structuralStatuses: ctx.structuralErrorStatuses,
    }),
  );
}

import { hasCreate } from "../../../ir/enrich/wire-projection.js";
import { pagedReturn } from "../../../ir/stdlib/generics.js";
import { unionInstanceName } from "../../../ir/stdlib/unions.js";
import type {
  AggregateIR,
  EnrichedBoundedContextIR,
  OperationIR,
  RepositoryIR,
} from "../../../ir/types/loom-ir.js";
import { operationIsGuarded } from "../../../ir/types/loom-ir.js";
import { defaultErrorStatus, errorTitle, errorTypeUri } from "../../../util/error-defaults.js";
import { plural, upperFirst } from "../../../util/naming.js";
import { findUnionSpec, unionMembers } from "../../_payload/union-wire.js";
import {
  collectWireUsings,
  csIdValueClrType,
  wireToCommandArgument,
  wireType,
} from "../dto-mapping.js";
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
  /** Force the POST create action on (event-sourced aggregates are
   *  constructible via their `create` action even when `hasCreate` — the
   *  field-set constructibility check — is false).  Defaults to
   *  `hasCreate(agg)`. */
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
      idClass,
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
          // `when` canCommand gate: 409 on the action + the GET can_<op>
          // companion (criterion.md use site 2).
          whenGated: !!op.when,
          // Exception-less return-typed op: the controller-side translation spec
          // (Domain union → ProblemDetails / Ok-wrapped wire DTO).
          returnUnion: buildReturnUnionSpec(op, agg, ctx, ns),
        })),
      finds: (repo?.finds ?? []).map((find) => {
        const paged = pagedReturn(find.returnType);
        // Discriminated-union find return (P4c): the controller returns the
        // polymorphic base record directly (no agg-derived wrapper).
        const unionType =
          find.returnType.kind === "union"
            ? unionInstanceName(find.returnType.variants)
            : undefined;
        // Producer-side absence translation (validator-pinned shape): the
        // absent variant record maps to its HTTP edge — `none` rides the
        // optional-find 404, an `error` payload becomes ProblemDetails at its
        // mapped status (api `httpStatus` override or the stdlib default).
        const spec =
          find.returnType.kind === "union" ? findUnionSpec(find.returnType, agg.name, ctx) : null;
        const unionAbsent = spec
          ? spec.absent.kind === "none"
            ? ({ record: `${spec.name}_${spec.absent.tag}`, kind: "none" } as const)
            : ({
                record: `${spec.name}_${spec.absent.tag}`,
                kind: "error",
                status:
                  ctx.errorStatusOverrides?.[spec.absent.tag] ??
                  defaultErrorStatus(spec.absent.tag),
                title: errorTitle(spec.absent.tag),
                typeUri: errorTypeUri(spec.absent.tag),
              } as const)
          : undefined;
        return {
          unionAbsent,
          name: find.name,
          isRoot: find.name === "all",
          responseType: unionType,
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
            : unionType
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
    }),
  );
}

import { forCreateInput } from "../../../ir/enrich/wire-projection.js";
import { pagedReturn } from "../../../ir/stdlib/generics.js";
import { unionInstanceName } from "../../../ir/stdlib/unions.js";
import type {
  AggregateIR,
  EnrichedBoundedContextIR,
  OperationIR,
  RepositoryIR,
} from "../../../ir/types/loom-ir.js";
import { operationIsGuarded } from "../../../ir/types/loom-ir.js";
import {
  type ApiOperationIR,
  apiStatusContext,
  deriveAggregateOperations,
  isAllFind,
} from "../../../ir/util/api-surface.js";
import { aggregateIsVersioned } from "../../../ir/util/versioned-capability.js";
import { defaultErrorStatus, errorTitle, errorTypeUri } from "../../../util/error-defaults.js";
import { plural, upperFirst } from "../../../util/naming.js";
import { isServerSourcedDefault } from "../../_frontend/server-default.js";
import { findUnionSpec, unionMembers } from "../../_payload/union-wire.js";
import {
  collectWireUsings,
  csIdValueClrType,
  wireToCommandArgument,
  wireType,
} from "../dto-mapping.js";
import type { ControllerShape } from "../emit/api.js";
import { renderController } from "../emit.js";
import { AMBIENT_CURRENT_USER, renderCsExpr } from "../render-expr.js";
import { requestVoValidatorName } from "../validator-emit.js";
import { isNullableWireDefault } from "../wire-default.js";

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
  /** ERROR arm: the declared payload fields as `{ wire key, C# accessor }` —
   *  `error NotFound { resource: string }` → `[{ json: "resource",
   *  accessor: "v.Resource" }]`.  They ride the problem body as 7807 extension
   *  members (RS-19); dropping them shipped a 404 with no payload. */
  errorFields: { json: string; accessor: string }[];
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
): Omit<ControllerShape["publicOps"][number], "apiOp" | "probeOp"> {
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
    requestValidator:
      requestVoValidatorName(
        `${upperFirst(op.name)}${agg.name}Request`,
        op.params.map((p) => ({ name: p.name, type: p.type })),
        ctx.valueObjects,
      ) ?? undefined,
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
    // Scalar return-typed op (BUG-003): the value's wire type, driving the
    // `[ProducesResponseType(typeof(<Wire>), 200)]` + `return Ok(result)` path.
    returnScalar: buildReturnScalarSpec(op, ctx),
  };
}

/** Wire type for a SCALAR operation return (`operation describe(): string` —
 *  non-void, non-`or`-union).  `undefined` for a void op (204) or a union op
 *  (handled by `buildReturnUnionSpec`).  The handler already projects the
 *  domain value to this wire type (`projectToResponse`), so the controller
 *  returns it raw at 200 — no Union DTO wrapping. */
function buildReturnScalarSpec(
  op: OperationIR,
  ctx: EnrichedBoundedContextIR,
): { wireType: string } | undefined {
  if (!op.returnType || op.returnType.kind === "union") return undefined;
  return { wireType: wireType(op.returnType, ctx, "response") };
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
      errorFields:
        m.shape === "record"
          ? m.fields.map((f) => ({ json: f.name, accessor: `v.${upperFirst(f.name)}` }))
          : [],
    };
  });
  return {
    unionName: unionInstanceName(variants),
    domainNs: `${ns}.Domain.${plural(agg.name)}`,
    appNs: `${ns}.Application.${plural(agg.name)}.Responses`,
    arms,
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
  // THE UNIFICATION SEAM (api-surface.ts): the aggregate's HTTP surface —
  // which routes exist, at which method + path, declaring which error
  // statuses — comes from the shared derivation.  This file keeps what is
  // genuinely .NET's: DTO/command names, binding, handler bodies, the
  // union-absent ProblemDetails payload.  The entity-history action stays a
  // named local extra (`apiSurfaceCoverage.notLifted` documents it).
  const derivedOps = deriveAggregateOperations(agg, repo, apiStatusContext(ctx));
  const opEntries = derivedOps.filter((o) => o.kind === "operation");
  const probeByOp = new Map<unknown, ApiOperationIR>(
    derivedOps.filter((o) => o.kind === "gateProbe").map((o) => [o.operation, o]),
  );
  // The derivation registers the auto-`all` LAST (Hono's shadowing order);
  // .NET has always emitted it first (enrichment prepends it to `repo.finds`),
  // and ASP.NET attribute routing is registration-order-free — so keep the
  // historical order rather than churn every controller's method layout.
  const findEntries = [
    ...derivedOps.filter((o) => isAllFind(o)),
    ...derivedOps.filter((o) => o.kind === "find" && !isAllFind(o)),
  ];
  const publicOps = opEntries.map((o) => o.operation!);
  const exposedFinds = findEntries.map((o) => o.find!);
  const usings = new Set<string>();
  for (const f of requiredFields) collectWireUsings(f.type, ctx, usings);
  for (const op of publicOps) for (const p of op.params) collectWireUsings(p.type, ctx, usings);
  for (const find of exposedFinds)
    for (const p of find.params) collectWireUsings(p.type, ctx, usings);
  // A paged find's action returns `Paged<…Response>` from the shared runtime.
  if (exposedFinds.some((f) => pagedReturn(f.returnType))) usings.add(`${ns}.Domain.Common`);
  // A server-sourced field default (`now()` / `currentUser.*`) is applied
  // per-request in the create command construction (the field is a nullable
  // optional request param): `request.X is null ? <default> : <parse>`.  A
  // `currentUser.*` default binds the ambient principal via RequestContext
  // (Domain.Common); a bare now() does not.
  if (
    requiredFields.some(
      (f) =>
        f.default !== undefined &&
        isServerSourcedDefault(f.default) &&
        !(f.default.kind === "literal" && f.default.lit === "now"),
    )
  )
    usings.add(`${ns}.Domain.Common`);
  out.set(
    `Api/${upperFirst(plural(agg.name))}Controller.cs`,
    renderController(agg, repo, ns, {
      idClass,
      idClrType: csIdValueClrType(agg.idValueType),
      createAction: createActionOverride ?? derivedOps.some((o) => o.kind === "create"),
      destroyAction: derivedOps.some((o) => o.kind === "destroy"),
      createApiOp: derivedOps.find((o) => o.kind === "create"),
      getByIdApiOp: derivedOps.find((o) => o.kind === "getById")!,
      destroyApiOp: derivedOps.find((o) => o.kind === "destroy"),
      // Entity history (docs/audit.md): the derived read sits BESIDE `finds`
      // (see `RepositoryIR.historyFind`), so it drives its own action rather
      // than riding the `exposedFinds` loop.  `guarded` is the gate the find
      // inherited from the aggregate's list read — declared so the action's
      // OpenAPI 403 matches what the handler can actually throw.
      historyAction: repo?.historyFind ? { guarded: !!repo.historyFind.requires } : undefined,
      createRequestValidator:
        requestVoValidatorName(
          `Create${agg.name}Request`,
          forCreateInput(agg.fields).map((f) => ({ name: f.name, type: f.type })),
          ctx.valueObjects,
        ) ?? undefined,
      createCmdArgs: requiredFields.map((f) => {
        const wireArg = wireToCommandArgument(`request.${upperFirst(f.name)}`, f.type, ctx);
        // Widened to VALUE-OBJECT defaults alongside the server-sourced ones:
        // both are emitted as a NULLABLE request param (neither is a C#
        // compile-time constant), so both coalesce here.  `renderCsExpr` yields
        // the DOMAIN value in each case — `DateTime.UtcNow` / the ambient claim
        // / `new Money(0m, "USD")` — which is exactly the command's param type.
        if (isNullableWireDefault(f.default)) {
          // The nullable request field coalesces to the per-request default.
          // `renderCsExpr` yields the DOMAIN value (`DateTime.UtcNow`, the
          // ambient claim) matching the command's param type; in the `: <parse>`
          // arm C# flow-narrows `request.X` to non-null, so the parse is clean.
          const dflt = renderCsExpr(f.default, {
            thisName: "this",
            currentUserExpr: AMBIENT_CURRENT_USER,
          });
          return `request.${upperFirst(f.name)} is null ? ${dflt} : ${wireArg}`;
        }
        return wireArg;
      }),
      publicOps: opEntries.map((o) => ({
        ...buildOperationSpec(agg, o.operation!, ctx, ns),
        apiOp: o,
        probeOp: probeByOp.get(o.operation),
      })),
      finds: findEntries.map((entry) => {
        const find = entry.find!;
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
          isRoot: isAllFind(entry),
          apiOp: entry,
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
          guarded: find.requires !== undefined,
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

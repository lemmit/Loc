import {
  createInputFields,
  emitsRestCreate,
  wireCreateDefault,
} from "../../../ir/enrich/wire-projection.js";
import { isServerSourcedDefault } from "../../_frontend/server-default.js";
import { unionInstanceName } from "../../../ir/stdlib/unions.js";
import type {
  AggregateIR,
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  RepositoryIR,
  TypeIR,
} from "../../../ir/types/loom-ir.js";
import { lines } from "../../../util/code-builder.js";
import { plural, upperFirst } from "../../../util/naming.js";
import { type UnionMemberField, unionMembers } from "../../_payload/union-wire.js";
import {
  aggregateResponseParams,
  csIdValueClrType,
  dtoParam,
  entityExposesProvenance,
  entityResponseParams,
  responseParamsFromPayload,
  valueObjectsUsedBy,
  wireType,
} from "../dto-mapping.js";
import { renderRequestDtos, renderResponseDtos } from "../emit.js";
import { renderCsExpr } from "../render-expr.js";

// ---------------------------------------------------------------------------
// Response DTOs — value objects first (so subsequent records can reference
// them), then parts, then the root, then the create-response.
// ---------------------------------------------------------------------------

export function emitResponseDtos(
  agg: EnrichedAggregateIR,
  ctx: EnrichedBoundedContextIR,
  ns: string,
  aggFolder: string,
  out: Map<string, string>,
): void {
  const records: { name: string; params: string }[] = [];
  for (const vo of valueObjectsUsedBy(agg, ctx)) {
    records.push({
      name: `${vo.name}Response`,
      params: vo.fields
        .map((f) => dtoParam(wireType(f.type, ctx, "response"), upperFirst(f.name)))
        .join(", "),
    });
  }
  for (const part of agg.parts) {
    records.push({
      name: `${part.name}Response`,
      params: entityResponseParams(part, ctx),
    });
  }
  // M-T5.10: when the context declares a `response <Agg>Response` record
  // (spliced by `scaffoldHandlers`), READ that record's fields instead of
  // re-deriving from `wireShape` — byte-identical for the scaffolded form,
  // authoritative for a hand-declared divergent one.  Non-scaffolded
  // aggregates have no declared record and keep the wireShape path.
  const declaredResponse = ctx.payloads.find(
    (p) => p.kind === "response" && p.name === `${agg.name}Response`,
  );
  records.push({
    name: `${agg.name}Response`,
    params: declaredResponse
      ? responseParamsFromPayload(agg, declaredResponse, ctx)
      : aggregateResponseParams(agg, ctx),
  });
  // Create-response (the new id) only when the aggregate exposes a REST
  // create surface (an explicit / crudish canonical create, or an ES
  // creation event) — the SAME gate as the Create command / controller
  // action, so the response DTO is never orphaned.
  if (emitsRestCreate(agg)) {
    records.push({
      name: `Create${agg.name}Response`,
      params: dtoParam(csIdValueClrType(agg.idValueType), "Id"),
    });
  }
  // Provenance (provenance.md): a response carrying any provenanced field's
  // `ProvLineage?` lineage needs `<ns>.Domain.Common` in scope.  Covers the
  // root and any provenanced containment part.
  const exposesProvenance =
    entityExposesProvenance(agg) || agg.parts.some((p) => entityExposesProvenance(p));
  out.set(
    `Application/${aggFolder}/Responses/${agg.name}Responses.cs`,
    renderResponseDtos({
      ns,
      aggName: agg.name,
      records,
      extraUsings: exposesProvenance ? [`${ns}.Domain.Common`] : undefined,
    }),
  );
}

// ---------------------------------------------------------------------------
// Discriminated-union response DTOs (payload-transport-layer.md, P4c).
//
// A `find x(): A or B` emits one polymorphic base record per distinct union,
// `[JsonPolymorphic(TypeDiscriminatorPropertyName = "type")]` with one
// `[JsonDerivedType(typeof(Variant), "Tag")]` per variant.  System.Text.Json
// serializes a variant as `{ "type": "Tag", …fields }` — byte-identical to the
// TS/Hono `z.discriminatedUnion("type", …)`.  Variant fields come from the
// shared `unionMembers` resolver (entity → wire shape, scalar → `Value`, the
// `none` unit → an empty record).
// ---------------------------------------------------------------------------

/** Every distinct union return reaching this aggregate: repository find returns
 *  plus exception-less operation returns (`operation foo(): X or NotFound`).
 *  Both wire the same tagged DTO, so they share one emission path. */
function aggregateUnionReturns(
  agg: AggregateIR,
  _repo: RepositoryIR | undefined,
): { name: string; variants: import("../../../ir/types/loom-ir.js").TypeIR[] }[] {
  const out: { name: string; variants: import("../../../ir/types/loom-ir.js").TypeIR[] }[] = [];
  const seen = new Set<string>();
  const add = (variants: import("../../../ir/types/loom-ir.js").TypeIR[]): void => {
    const name = unionInstanceName(variants);
    if (seen.has(name)) return;
    seen.add(name);
    out.push({ name, variants });
  };
  // Only exception-less OPERATION returns need a tagged union DTO.  A union
  // FIND returns the success variant's `<Agg>Response` directly at 200 (the
  // error/absent variant is a status response), so it names no union DTO
  // (exception-less.md §4).
  for (const op of agg.operations) if (op.returnType?.kind === "union") add(op.returnType.variants);
  return out;
}

export function emitUnionDtos(
  agg: AggregateIR,
  repo: RepositoryIR | undefined,
  ctx: EnrichedBoundedContextIR,
  ns: string,
  aggFolder: string,
  out: Map<string, string>,
): void {
  for (const u of aggregateUnionReturns(agg, repo)) {
    out.set(
      `Application/${aggFolder}/Responses/${u.name}.cs`,
      renderUnionDto(u.name, unionMembers(u.variants, ctx), ns, aggFolder, ctx),
    );
  }
}

/** Pure Domain union types for exception-less operation returns: the aggregate
 *  method produces them, so they live in the Domain layer (which can't see the
 *  Application wire DTO above).  No serialization attributes — the controller
 *  maps a success variant to the Application DTO before serializing, keeping
 *  Domain transport-agnostic (exception-less.md, "Pure Domain + mapping"). */
export function domainUnionFiles(
  agg: AggregateIR,
  ctx: EnrichedBoundedContextIR,
  ns: string,
): { name: string; content: string }[] {
  const files: { name: string; content: string }[] = [];
  const seen = new Set<string>();
  for (const op of agg.operations) {
    if (op.returnType?.kind !== "union") continue;
    const name = unionInstanceName(op.returnType.variants);
    if (seen.has(name)) continue;
    seen.add(name);
    files.push({
      name: `${name}.cs`,
      content: renderDomainUnion(name, unionMembers(op.returnType.variants, ctx), agg, ns, ctx),
    });
  }
  return files;
}

function renderDomainUnion(
  name: string,
  members: ReturnType<typeof unionMembers>,
  agg: AggregateIR,
  ns: string,
  ctx: EnrichedBoundedContextIR,
): string {
  const memberParams = (m: (typeof members)[number]): string => {
    if (m.shape === "none") return "";
    if (m.shape === "scalar") return `${wireType(m.type, ctx, "response")} Value`;
    return m.fields
      .map((f: UnionMemberField) => `${wireType(f.type, ctx, "response")} ${upperFirst(f.name)}`)
      .join(", ");
  };
  // A containment field flattens to its `<Part>Response` wire record, which
  // lives in the owning aggregate's Application Responses namespace — one
  // using per owner referenced (the layers share a csproj, so this compiles;
  // the controller maps these fields 1:1 into the Application union DTO).
  const responseUsings = new Set<string>();
  const visitEntityRefs = (t: TypeIR): void => {
    if (t.kind === "array") {
      visitEntityRefs(t.element);
      return;
    }
    if (t.kind === "optional") {
      visitEntityRefs(t.inner);
      return;
    }
    if (t.kind !== "entity") return;
    const owner = ctx.aggregates.find(
      (a) => a.name === t.name || a.parts.some((p) => p.name === t.name),
    );
    if (owner) responseUsings.add(`using ${ns}.Application.${plural(owner.name)}.Responses;`);
  };
  for (const m of members) {
    if (m.shape === "record") for (const f of m.fields) visitEntityRefs(f.type);
    else if (m.shape === "scalar") visitEntityRefs(m.type);
  }
  return lines(
    "// Auto-generated.",
    "using System;",
    "using System.Collections.Generic;",
    `using ${ns}.Domain.Enums;`,
    ...[...responseUsings].sort(),
    "",
    `namespace ${ns}.Domain.${plural(agg.name)};`,
    "",
    `public abstract record ${name};`,
    "",
    ...members.map((m) => `public sealed record ${name}_${m.tag}(${memberParams(m)}) : ${name};`),
  );
}

function renderUnionDto(
  name: string,
  members: ReturnType<typeof unionMembers>,
  ns: string,
  aggFolder: string,
  ctx: EnrichedBoundedContextIR,
): string {
  const variantRecord = (tag: string): string => `${name}_${tag}`;
  const memberParams = (m: (typeof members)[number]): string => {
    if (m.shape === "none") return "";
    if (m.shape === "scalar") return dtoParam(wireType(m.type, ctx, "response"), "Value");
    return m.fields
      .map((f: UnionMemberField) => dtoParam(wireType(f.type, ctx, "response"), upperFirst(f.name)))
      .join(", ");
  };
  return lines(
    "// Auto-generated.",
    "using System;",
    "using System.Collections.Generic;",
    "using System.ComponentModel.DataAnnotations;",
    "using System.Text.Json.Serialization;",
    `using ${ns}.Domain.Enums;`,
    "",
    `namespace ${ns}.Application.${aggFolder}.Responses;`,
    "",
    '[JsonPolymorphic(TypeDiscriminatorPropertyName = "type")]',
    ...members.map((m) => `[JsonDerivedType(typeof(${variantRecord(m.tag)}), "${m.tag}")]`),
    `public abstract record ${name};`,
    "",
    ...members.map(
      (m) => `public sealed record ${variantRecord(m.tag)}(${memberParams(m)}) : ${name};`,
    ),
  );
}

// ---------------------------------------------------------------------------
// Request DTOs — value objects first, then create + per-operation.
// ---------------------------------------------------------------------------

export function emitRequestDtos(
  agg: AggregateIR,
  ctx: EnrichedBoundedContextIR,
  ns: string,
  aggFolder: string,
  out: Map<string, string>,
  /** Event-sourced create-input override (appliers A2.2b): when present,
   *  the CreateRequest is built from these (the `create` action's params,
   *  the command shape) and force-emitted, instead of the field set gated
   *  on `hasCreate`. */
  createInputOverride?: AggregateIR["fields"],
): void {
  const records: { name: string; params: string }[] = [];
  for (const vo of valueObjectsUsedBy(agg, ctx)) {
    records.push({
      name: `${vo.name}Request`,
      params: vo.fields
        .map((f) => dtoParam(wireType(f.type, ctx, "request"), upperFirst(f.name), "request"))
        .join(", "),
    });
  }
  // Create-request payload: required + access-permitted client input.
  // `forCreateInput` excludes `managed` / `token` / `internal` (server-
  // owned or domain-only), keeps `immutable` (settable at creation) and
  // `secret` (client supplies password hashes / API keys).  Gated on
  // `emitsRestCreate`: an aggregate with no canonical create emits no
  // CreateRequest.
  if (createInputOverride || emitsRestCreate(agg)) {
    const requiredFields = createInputOverride ?? createInputFields(agg);
    const rendered = requiredFields.map((f) => {
      // Explicit `= default` → optional request field via a record default
      // value, dropping its `[Required]` (see `wireCreateDefault`).  A
      // `bool = true` now reaches here (was previously dropped), so the record
      // can carry an optional param mid-list — invalid C# (CS1737: optional
      // params must follow required ones).  STJ binds by JSON name and the
      // controller reads `request.<Name>` by name, so reordering the RECORD's
      // params is wire- and call-safe; sort the defaulted (optional) params
      // after the required ones so the record always compiles.
      const d = wireCreateDefault(f);
      // A SERVER-SOURCED default (`now()` / `currentUser.*`) is NOT a
      // compile-time-constant record default — `renderCsExpr(now())` is
      // `DateTime.UtcNow`, which C# rejects as a default parameter value
      // (CS1736).  Emit the field as a NULLABLE optional param (`Type? Name =
      // null`) instead; the create command construction coalesces the
      // per-request value (`request.Name is null ? <now()/currentUser.*> :
      // <parse>`) — the .NET twin of the Hono optional-wire + coalesce.
      const serverSourced = d !== undefined && isServerSourcedDefault(d);
      if (serverSourced) {
        const wt = wireType(f.type, ctx, "request");
        return {
          hasDefault: true,
          s: dtoParam(wt.endsWith("?") ? wt : `${wt}?`, upperFirst(f.name), "request", "null"),
        };
      }
      return {
        hasDefault: d !== undefined,
        s: dtoParam(
          wireType(f.type, ctx, "request"),
          upperFirst(f.name),
          "request",
          d ? renderCsExpr(d) : undefined,
        ),
      };
    });
    const ordered = [
      ...rendered.filter((p) => !p.hasDefault),
      ...rendered.filter((p) => p.hasDefault),
    ];
    records.push({
      name: `Create${agg.name}Request`,
      params: ordered.map((p) => p.s).join(", "),
    });
  }
  for (const op of agg.operations.filter((o) => o.visibility === "public")) {
    records.push({
      name: `${upperFirst(op.name)}${agg.name}Request`,
      params: op.params
        .map((p) => dtoParam(wireType(p.type, ctx, "request"), upperFirst(p.name), "request"))
        .join(", "),
    });
  }
  out.set(
    `Application/${aggFolder}/Requests/${agg.name}Requests.cs`,
    renderRequestDtos({ ns, aggName: agg.name, records }),
  );
}

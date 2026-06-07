import {
  createInputFields,
  hasCreate,
  wireCreateDefault,
} from "../../../ir/enrich/wire-projection.js";
import { unionInstanceName } from "../../../ir/stdlib/unions.js";
import type {
  AggregateIR,
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  RepositoryIR,
} from "../../../ir/types/loom-ir.js";
import { lines } from "../../../util/code-builder.js";
import { upperFirst } from "../../../util/naming.js";
import { type UnionMemberField, unionMembers } from "../../_payload/union-wire.js";
import {
  aggregateResponseParams,
  csIdValueClrType,
  dtoParam,
  entityResponseParams,
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
  records.push({
    name: `${agg.name}Response`,
    params: aggregateResponseParams(agg, ctx),
  });
  // Create-response (the new id) only when the aggregate is constructible.
  if (hasCreate(agg)) {
    records.push({
      name: `Create${agg.name}Response`,
      params: dtoParam(csIdValueClrType(agg.idValueType), "Id"),
    });
  }
  out.set(
    `Application/${aggFolder}/Responses/${agg.name}Responses.cs`,
    renderResponseDtos({ ns, aggName: agg.name, records }),
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

export function emitUnionDtos(
  repo: RepositoryIR | undefined,
  ctx: EnrichedBoundedContextIR,
  ns: string,
  aggFolder: string,
  out: Map<string, string>,
): void {
  const seen = new Set<string>();
  for (const find of repo?.finds ?? []) {
    if (find.returnType.kind !== "union") continue;
    const name = unionInstanceName(find.returnType.variants);
    if (seen.has(name)) continue;
    seen.add(name);
    out.set(
      `Application/${aggFolder}/Responses/${name}.cs`,
      renderUnionDto(name, unionMembers(find.returnType.variants, ctx), ns, aggFolder, ctx),
    );
  }
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
  // `hasCreate`: a non-constructible aggregate emits no CreateRequest.
  if (createInputOverride || hasCreate(agg)) {
    const requiredFields = createInputOverride ?? createInputFields(agg);
    records.push({
      name: `Create${agg.name}Request`,
      params: requiredFields
        .map((f) => {
          // Explicit `= default` → optional request field via a record
          // default value, dropping its `[Required]` (see `wireCreateDefault`).
          const d = wireCreateDefault(f);
          return dtoParam(
            wireType(f.type, ctx, "request"),
            upperFirst(f.name),
            "request",
            d ? renderCsExpr(d) : undefined,
          );
        })
        .join(", "),
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

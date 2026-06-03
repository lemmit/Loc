import {
  createInputFields,
  hasCreate,
  wireCreateDefault,
} from "../../../ir/enrich/wire-projection.js";
import type {
  AggregateIR,
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
} from "../../../ir/types/loom-ir.js";
import { upperFirst } from "../../../util/naming.js";
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

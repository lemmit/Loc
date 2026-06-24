// ---------------------------------------------------------------------------
// Inspect-protocol redaction for sensitive fields (vanilla Phoenix/Ecto).
//
// A field tagged `sensitive(...)` must NOT leak its value into a struct's
// debug/inspect output (logs, IEx, `inspect/1`).  In Elixir this is done by
// overriding the `Inspect` protocol for the schema module:
//
//   defimpl Inspect, for: MyApp.People.Person do
//     import Inspect.Algebra
//     def inspect(record, _opts) do
//       string("Person(id: " <> ... <> ", ssn: " <> "<redacted>" <> ...)
//     end
//   end
//
// The structural string is NOT hand-rolled here: the IR enrichment phase
// already synthesizes a `derived inspect: string` member on every aggregate
// (`src/ir/enrich/enrichments.ts` `synthesizeInspect`) whose sensitive leaves
// are replaced by the literal `<redacted>` — the SAME member TS (`get inspect()`)
// and .NET (`Inspect` property) emit.  We render that one expression through the
// shared `ELIXIR_TARGET` (render-expr.ts), so the redaction contract is
// guaranteed identical to the other backends.
//
// Gate: emit the impl ONLY for an aggregate that actually carries a sensitive
// leaf (a top-level field OR a field inside an embedded value object).  An
// aggregate with no sensitive field emits no impl — byte-identical to before.
// ---------------------------------------------------------------------------

import type {
  BoundedContextIR,
  EnrichedAggregateIR,
  ValueObjectIR,
} from "../../../ir/types/loom-ir.js";
import { upperFirst } from "../../../util/naming.js";
import { type RenderCtx, renderExpr } from "../render-expr.js";

/** True when the field's declared `sensitivity` marks it as a sensitive leaf
 *  to redact. */
function fieldIsSensitive(f: { sensitivity?: readonly string[] }): boolean {
  return !!f.sensitivity && f.sensitivity.length > 0;
}

/** True when the aggregate has any sensitive leaf — a top-level field, or a
 *  field inside an embedded value object — so an Inspect redaction impl is
 *  warranted.  Mirrors what `synthesizeInspect` actually redacts. */
export function aggHasSensitiveLeaf(agg: EnrichedAggregateIR, ctx?: BoundedContextIR): boolean {
  if (agg.fields.some(fieldIsSensitive)) return true;
  if (!ctx) return false;
  const voByName = new Map<string, ValueObjectIR>(ctx.valueObjects.map((v) => [v.name, v]));
  for (const f of agg.fields) {
    if (f.type.kind === "valueobject") {
      const vo = voByName.get(f.type.name);
      if (vo?.fields.some(fieldIsSensitive)) return true;
    }
  }
  return false;
}

/** The `defimpl Inspect, for: <Module>` block for an aggregate that carries a
 *  sensitive leaf, or `null` when none does (so the caller emits nothing).
 *  Renders the IR's synthesized `inspect` derived expression via ELIXIR_TARGET,
 *  with the struct itself (`record`) as the receiver for `this-prop`/`id`. */
export function renderInspectImpl(
  appModule: string,
  ctxModule: string,
  agg: EnrichedAggregateIR,
  ctx?: BoundedContextIR,
): string | null {
  if (!aggHasSensitiveLeaf(agg, ctx)) return null;
  // `inspectDerived` is synthesized by enrichment (and falls back to the
  // `derived` list lookup); if absent (un-enriched IR) there's nothing to
  // redact through, so emit no impl.
  const inspectDerived = agg.inspectDerived ?? agg.derived.find((d) => d.name === "inspect");
  if (!inspectDerived) return null;
  const moduleName = `${appModule}.${ctxModule}.${upperFirst(agg.name)}`;
  // The receiver for the inspect expression's `this-prop`/`id` accesses is the
  // inspected struct, bound as `record`.
  const renderCtx: RenderCtx = {
    thisName: "record",
    contextModule: `${appModule}.${ctxModule}`,
    foundation: "vanilla",
    agg,
  };
  const body = renderExpr(inspectDerived.expr, renderCtx);
  return `# Auto-generated.
defimpl Inspect, for: ${moduleName} do
  import Inspect.Algebra

  def inspect(record, _opts) do
    string(${body})
  end
end
`;
}

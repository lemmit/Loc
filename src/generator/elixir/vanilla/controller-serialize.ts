// ---------------------------------------------------------------------------
// Vanilla (plain Ecto/Phoenix) DEPLOYABLE-LEVEL controller `serialize/1` —
// the multi-aggregate sibling of `wire-serialize.ts`.
//
// The WorkflowsController (one per deployable, over every hosted context's
// command workflows) and each `<Api>RoutesController` (explicit
// `route … -> <Ctx>.<Handler>` bindings) hand their result straight to Jason.
// Both project through the aggregate's `wireShape`, NOT a raw-struct dump:
//
//   defp serialize(%_{} = struct), do: struct |> Map.from_struct() |> Map.drop(…)
//
// is exactly the divergence `wire-serialize.ts` exists to close — snake_case
// keys and leaked `inserted_at`/`updated_at`, where node/.NET/Java/Python
// project the wire shape.  A `POST /workflows/<wf>` returning a created
// aggregate would otherwise ship a DIFFERENT body from the
// `GET /<aggs>/{id}` for the same row on the same backend.
//
// These controllers are not per-aggregate, so they dispatch: one struct-typed
// `defp serialize(%<App>.<Ctx>.<Agg>{} = record)` clause per hosted aggregate
// delegating to that aggregate's own suffix-scoped wireShape serializer
// (`renderWireSerialize`'s `nameSuffix` — several aggregates, and several
// contexts, may declare same-named parts / value objects), then — for the
// NON-aggregate results a handler can declare — the struct-shaped scalar
// clauses (`%DateTime{}` / `%Decimal{}`, which the raw dump destroys), then the
// `%_{}` raw-struct clause for any other struct, then the bare value-object map
// clauses, then the `serialize(other)` pass-through.
//
// Clause order is load-bearing throughout: `%_{}` matches ANY struct, so the
// scalar clauses must precede it and the aggregate heads must precede those; a
// STRUCT also matches a bare map pattern, so the value-object clauses go BEHIND
// `%_{}`.
// ---------------------------------------------------------------------------

import type { BoundedContextIR, SystemIR, TypeIR } from "../../../ir/types/loom-ir.js";
import { isTpcBase } from "../../../ir/util/inheritance.js";
import { snake, upperFirst } from "../../../util/naming.js";
import { MONEY_WIRE_SCALE } from "../../money-scale.js";
import { isVanillaDocAgg } from "./document-emit.js";
import { renderWireSerialize } from "./wire-serialize.js";

/** The `serialize/1` clause set + helper defs for a deployable-level controller.
 *  Both members are already module-indented; splice them where the
 *  controller's `serialize` block goes. */
export interface ControllerSerialize {
  /** The contiguous `defp serialize(...)` clauses — per-aggregate struct heads,
   *  then the `%_{}` raw-struct fallback, then `serialize(other)`. */
  clauses: string;
  /** The per-aggregate wire serializers + their nested part/VO helpers, deduped
   *  by exact text (the shared `__money_round` / `__decimal_num` helpers are
   *  emitted identically per aggregate).  Empty string when no aggregate is
   *  dispatchable. */
  helpers: string;
}

/** Build the dispatching `serialize/1` for a controller hosting `contexts`.
 *  `extraClauses` are emitted BEFORE the aggregate clauses (the
 *  `<Api>RoutesController`'s `serialize(list) when is_list(list)` arm, which must
 *  win over every struct head).  `sys` resolves each aggregate's effective saving
 *  shape (a `document` aggregate's wire fields live on the `:data` embed); omit
 *  it and the aggregate header alone decides, matching `isVanillaDocAgg`.
 *
 *  `unmasked` routes a `mask unless` aggregate to its `serialize_unmasked_<sfx>`
 *  projection instead of the redacting one — the AUDIT snapshot shape
 *  (authorization.md §5: an audit row records the REAL before/after value, the
 *  same choice `api-emit`'s create/destroy capture makes).  The redacting
 *  `serialize_<sfx>` is then NOT emitted at all: nothing would call it, and an
 *  unreferenced private function fails `mix compile --warnings-as-errors`. */
export function renderControllerSerialize(
  appModule: string,
  contexts: readonly BoundedContextIR[],
  extraClauses: readonly string[] = [],
  sys?: SystemIR,
  unmasked = false,
): ControllerSerialize {
  const clauses: string[] = [...extraClauses];
  // Deduped by exact TEXT, not by name: the suffix makes every `serialize_*`
  // name unique, while `__money_round` / `__decimal_num` repeat byte-identically
  // across aggregates and must be defined once (Elixir groups clauses by name).
  const helperTexts = new Set<string>();

  for (const ctx of contexts) {
    const ctxModule = upperFirst(ctx.name);
    for (const agg of ctx.aggregates) {
      // A TPC (`ownTable`) abstract base owns no Ecto schema module at all
      // (schema-emit skips it), so there is no struct to pattern-match on.
      if (isTpcBase(agg, ctx.aggregates)) continue;
      const aggModule = `${appModule}.${ctxModule}.${upperFirst(agg.name)}`;
      // Suffix scopes every emitted function name to this (context, aggregate)
      // pair — two contexts may each declare an `Order`, and two aggregates may
      // each contain a `Line` part.
      const suffix = `${snake(ctx.name)}_${snake(agg.name)}`;
      const isDoc = isVanillaDocAgg(agg, ctx, sys);
      const wire = isDoc
        ? renderWireSerialize(agg, ctx, {
            headVar: "row",
            bind: "    record = row.data",
            idExpr: "row.id",
            versionExpr: "row.version",
            contextModule: `${appModule}.${ctxModule}`,
            nameSuffix: suffix,
          })
        : renderWireSerialize(agg, ctx, {
            contextModule: `${appModule}.${ctxModule}`,
            nameSuffix: suffix,
          });
      const entry =
        unmasked && wire.masked ? `serialize_unmasked_${suffix}` : `serialize_${suffix}`;
      clauses.push(`  defp serialize(%${aggModule}{} = record), do: ${entry}(record)`);
      // In unmasked mode the redacting `serialize_<sfx>` is dropped (see the
      // `unmasked` doc above); `wire.helpers` already carries
      // `serialize_unmasked_<sfx>` when the aggregate is masked.
      if (!(unmasked && wire.masked)) helperTexts.add(wire.serialize);
      for (const h of wire.helpers) helperTexts.add(h);
    }
  }

  // `X id[]` reference collections project to an id array through `__ref_ids/1`
  // (the same helper `api-emit` emits per aggregate controller).  A workflow
  // result carries the association unloaded unless the read preloaded it, and
  // `%Ecto.Association.NotLoaded{}` is not Jason-encodable — the raw-struct
  // fallback 500'd on exactly that shape.
  //
  // Gated on the rendered text CALLING it, not on `hasRefColls`: the API-read
  // projection drops `access: internal`/`secret` fields, so a declared
  // ref-collection may not reach the wire map at all — and an unreferenced
  // private helper fails `mix compile --warnings-as-errors`.
  if ([...helperTexts].some((h) => h.includes("__ref_ids("))) {
    helperTexts.add(
      `  defp __ref_ids(%Ecto.Association.NotLoaded{}), do: []\n` +
        `  defp __ref_ids(records) when is_list(records), do: Enum.map(records, & &1.id)\n` +
        `  defp __ref_ids(_), do: []`,
    );
  }

  // --- non-aggregate declared results ---------------------------------------
  // A `commandHandler` / `queryHandler` may `return` something that is not an
  // aggregate — a bare scalar or a value object — and that value lands on this
  // same `serialize/1`.  The `%_{}` clause below dumps ANY struct, which is not
  // a projection for the two struct-shaped scalars Ecto hands back:
  //
  //   * `%DateTime{}` / `%NaiveDateTime{}` → `Map.from_struct` yields the
  //     calendar internals, including the `microsecond: {0, 6}` TUPLE, which
  //     Jason cannot encode at all — the route 500s.  Handed to Jason untouched
  //     they encode ISO-8601, which is what the aggregate read path
  //     (`"placedAt" => record.placed_at`) and all four other backends send.
  //   * `%Decimal{}` → `Map.from_struct` yields `%{coef:, exp:, sign:}` where
  //     every other backend sends the number (a plain `decimal`, RS-24) or the
  //     fixed-scale string (`money`, RS-12).
  //
  // Emitted only for a result type actually DECLARED by a hosted handler, so a
  // system without one stays byte-identical.
  const declared = declaredBareResultTypes(contexts);
  const scalarClauses: string[] = [];
  const temporal = ["DateTime", "NaiveDateTime"].filter((st) => declared.calendar.has(st));
  if (temporal.length > 0) {
    scalarClauses.push(
      `  # A bare temporal result rides Jason's ISO-8601 encoding — \`Map.from_struct\`` +
        `\n  # would explode it into non-encodable calendar internals.\n` +
        temporal.map((st) => `  defp serialize(%${st}{} = value), do: value`).join("\n"),
    );
  }
  // ONE `%Decimal{}` clause (a second would be unreachable), so a system that
  // declares both a bare `decimal` and a bare `money` result takes the
  // `decimal` reading — the JSON number.  Splitting them needs the DECLARED
  // type at the call site, which lives in the per-route action, not here.
  if (declared.decimal) {
    scalarClauses.push(
      `  # A plain \`decimal\` is a JSON NUMBER on every other backend.` +
        `\n  defp serialize(%Decimal{} = value), do: Decimal.to_float(value)`,
    );
  } else if (declared.money) {
    scalarClauses.push(
      `  # Money rides the wire at the fixed \`NUMERIC(19,4)\` scale (Jason` +
        `\n  # encodes a \`%Decimal{}\` as the string the other backends send).` +
        `\n  defp serialize(%Decimal{} = value), do: Decimal.round(value, ${MONEY_WIRE_SCALE})`,
    );
  }
  clauses.push(...scalarClauses);

  clauses.push(
    "  defp serialize(%_{} = struct), do: struct |> Map.from_struct() |> Map.drop([:__meta__, :__struct__])",
  );

  // A bare VALUE-OBJECT result is a plain jsonb map (VOs are schemaless on this
  // backend), so it fell through to `serialize(other)` and shipped its STORED
  // keys — `currency_code` where the aggregate read, and every other backend,
  // ship `currencyCode`.  Dispatch it to the VO's own wireShape serializer,
  // matched on its stored key set (atom-keyed from a struct field read,
  // string-keyed straight off jsonb).  These clauses sit AFTER `%_{}` on
  // purpose: a struct matches a bare map pattern too, and the aggregate heads
  // must keep winning.
  //
  // Gated on the VO helper HAVING BEEN EMITTED above (some hosted aggregate
  // carries a field of that type) — same discipline as `__ref_ids` — rather
  // than on the declaration alone, which would emit a call to a function that
  // does not exist.
  const voClauses: string[] = [];
  for (const voName of [...declared.valueObjects].sort()) {
    const vo = contexts.flatMap((c) => c.valueObjects).find((v) => v.name === voName);
    if (!vo || vo.fields.length === 0) continue;
    const helper = [...helperTexts]
      .flatMap((h) => [...h.matchAll(/defp (serialize_[a-z0-9_]+)\(record\) do/g)])
      .map((m) => m[1]!)
      .find((n) => n.startsWith(`serialize_${snake(voName)}_`));
    if (!helper) continue;
    const keys = vo.fields.map((f) => snake(f.name));
    voClauses.push(
      `  defp serialize(%{${keys.map((k) => `${k}: _`).join(", ")}} = value), do: ${helper}(value)`,
      `  defp serialize(%{${keys.map((k) => `${JSON.stringify(k)} => _`).join(", ")}} = value), do: ${helper}(value)`,
    );
  }
  clauses.push(...voClauses);

  clauses.push("  defp serialize(other), do: other");
  return {
    clauses: clauses.join("\n"),
    helpers: helperTexts.size > 0 ? `\n\n${[...helperTexts].join("\n\n")}` : "",
  };
}

/** The non-aggregate result types a hosted `commandHandler`/`queryHandler`
 *  DECLARES — the values that reach the deployable controller's `serialize/1`
 *  without an aggregate struct head to catch them.  Collections and optionals
 *  are unwrapped (a `Money[]` result serializes element-by-element through the
 *  `is_list` arm).  Workflows are deliberately NOT scanned: this backend's
 *  workflow emitter returns the last AGGREGATE bind (an `expr-let` never wins
 *  the `{:ok, …}` slot), so a workflow can't put a bare scalar here. */
function declaredBareResultTypes(contexts: readonly BoundedContextIR[]): {
  calendar: Set<string>;
  decimal: boolean;
  money: boolean;
  valueObjects: Set<string>;
} {
  const calendar = new Set<string>();
  const valueObjects = new Set<string>();
  let decimal = false;
  let money = false;
  const visit = (t: TypeIR | undefined): void => {
    if (!t) return;
    if (t.kind === "optional") {
      visit(t.inner);
      return;
    }
    if (t.kind === "array") {
      visit(t.element);
      return;
    }
    if (t.kind === "valueobject") {
      valueObjects.add(t.name);
      return;
    }
    if (t.kind !== "primitive") return;
    switch (t.name) {
      case "datetime":
        // `:utc_datetime` loads a `%DateTime{}`; a `:naive_datetime` column a
        // `%NaiveDateTime{}`.  Both spellings can reach one handler result, so
        // both clauses ride the same declaration.
        calendar.add("DateTime");
        calendar.add("NaiveDateTime");
        break;
      case "decimal":
        decimal = true;
        break;
      case "money":
        money = true;
        break;
      default:
        break;
    }
  };
  for (const ctx of contexts) {
    for (const h of ctx.commandHandlers ?? []) visit(h.returnType);
    for (const h of ctx.queryHandlers ?? []) visit(h.returnType);
  }
  return { calendar, decimal, money, valueObjects };
}

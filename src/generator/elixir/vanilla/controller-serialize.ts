// ---------------------------------------------------------------------------
// Vanilla (plain Ecto/Phoenix) DEPLOYABLE-LEVEL controller `serialize/1` —
// the multi-aggregate sibling of `wire-serialize.ts`.
//
// The WorkflowsController (one per deployable, over every hosted context's
// command workflows) and each `<Api>RoutesController` (explicit
// `route … -> <Ctx>.<Handler>` bindings) hand their result straight to Jason.
// Both used to serialize an aggregate result with the legacy raw-struct dump:
//
//   defp serialize(%_{} = struct), do: struct |> Map.from_struct() |> Map.drop(…)
//
// which is exactly the divergence `wire-serialize.ts` exists to close — snake_case
// keys and leaked `inserted_at`/`updated_at`, while node/.NET/Java/Python all
// project the aggregate's `wireShape`.  A `POST /workflows/<wf>` returning a
// created aggregate therefore shipped a DIFFERENT body from the `GET /<aggs>/{id}`
// for the same row on the same backend.
//
// These controllers are not per-aggregate, so they dispatch: one struct-typed
// `defp serialize(%<App>.<Ctx>.<Agg>{} = record)` clause per hosted aggregate
// delegating to that aggregate's own suffix-scoped wireShape serializer
// (`renderWireSerialize`'s `nameSuffix` — several aggregates, and several
// contexts, may declare same-named parts / value objects), then the pre-existing
// `%_{}` raw-struct clause for a struct that is NOT a hosted aggregate (a
// workflow state struct, a value object returned bare), then the `serialize(other)`
// pass-through.  Clause order is load-bearing: `%_{}` matches ANY struct.
// ---------------------------------------------------------------------------

import type { BoundedContextIR, SystemIR } from "../../../ir/types/loom-ir.js";
import { isTpcBase } from "../../../ir/util/inheritance.js";
import { snake, upperFirst } from "../../../util/naming.js";
import { isVanillaDocAgg } from "./document-emit.js";
import { renderWireSerialize } from "./wire-serialize.js";

/** The `serialize/1` clause set + helper defs for a deployable-level controller.
 *  Both members are already module-indented; splice them where the old two-clause
 *  `serialize` block sat. */
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
 *  it and the aggregate header alone decides, matching `isVanillaDocAgg`. */
export function renderControllerSerialize(
  appModule: string,
  contexts: readonly BoundedContextIR[],
  extraClauses: readonly string[] = [],
  sys?: SystemIR,
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
      clauses.push(`  defp serialize(%${aggModule}{} = record), do: serialize_${suffix}(record)`);
      helperTexts.add(wire.serialize);
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

  clauses.push(
    "  defp serialize(%_{} = struct), do: struct |> Map.from_struct() |> Map.drop([:__meta__, :__struct__])",
    "  defp serialize(other), do: other",
  );
  return {
    clauses: clauses.join("\n"),
    helpers: helperTexts.size > 0 ? `\n\n${[...helperTexts].join("\n\n")}` : "",
  };
}

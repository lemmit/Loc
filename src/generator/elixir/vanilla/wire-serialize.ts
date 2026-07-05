// ---------------------------------------------------------------------------
// Vanilla (plain Ecto/Phoenix) aggregate REST-controller `serialize/1` —
// the wireShape-driven success-path serializer.
//
// The legacy serializer dumped the raw Ecto struct:
//
//   record |> Map.from_struct() |> Map.drop([:__meta__, :__struct__])
//
// which diverged from the canonical cross-backend wire (Hono/.NET/Java/Python
// all project from `wireShape` with the field name AS WRITTEN in the `.ddd`
// source) in two ways:
//   1. snake_case keys — a multi-word field shipped `commit_sha`/`build_state`
//      instead of the canonical `commitSha`/`buildState`.
//   2. leaked `inserted_at`/`updated_at` — `Map.from_struct` includes Ecto's
//      auto-`timestamps()` columns, which are NOT in `wireShape` and no other
//      backend emits.
//
// This module rebuilds `serialize/1` from the aggregate's enriched `wireShape`
// (each `WireField.name` is the JSON key verbatim, already camelCase; the Ecto
// column read resolves `snake(name)`), plus a set of nested private helper
// serializers (`serialize_<part|vo>/1`) for contained entities / value objects
// reachable through the wire shape.  Derived fields are skipped (vanilla never
// projected them — they aren't Ecto columns).  Reference collections
// (`X id[]`) keep the existing `__ref_ids/1` projection (helper emitted by
// api-emit when the aggregate has ref-collection fields).
// ---------------------------------------------------------------------------

import type {
  AggregateIR,
  BoundedContextIR,
  EnrichedAggregateIR,
  TypeIR,
  WireField,
} from "../../../ir/types/loom-ir.js";
import { snake } from "../../../util/naming.js";

export interface WireSerializeResult {
  /** The `serialize/1` function definition (module-indented) — an untyped
   *  `defp serialize(record)` head, used by the single-aggregate REST/ES
   *  controllers. */
  serialize: string;
  /** Just the `%{ … }` wire-map body (indented for a function body), for a
   *  caller that needs its own function head — e.g. the ViewsController, which
   *  dispatches per aggregate with a struct-typed head
   *  (`defp serialize(%Agg{} = record)`). */
  body: string;
  /** Nested `serialize_<part|vo>/1` private helper defs, deduped by name,
   *  in completion order.  Empty when the wire shape references no contained
   *  entities / value objects. */
  helpers: string[];
}

function unwrapOptional(t: TypeIR): TypeIR {
  return t.kind === "optional" ? t.inner : t;
}

/** Build the wireShape-driven `serialize/1` + nested helper serializers for a
 *  vanilla aggregate REST controller.  `agg` / `ctx` are the enriched IR nodes
 *  (typed loosely so the call site in `api-emit.ts` — which holds the
 *  non-enriched surface types — needs no cast); `wireShape` is always present
 *  after enrichment. */
/** Options for rooting the serializer somewhere other than a bare `record`
 *  struct.  The Route A document controller roots it at the rehydrated embed:
 *  `defp serialize(row) do; record = row.data; …` — the wire fields read off the
 *  `%<Agg>.Data{}` embed (`record`), but `id` lives on the root row
 *  (`@primary_key false` on the embed), so `idExpr` overrides just that field. */
export interface WireSerializeOpts {
  /** Function-head parameter name (default `"record"`). */
  headVar?: string;
  /** A prelude line inserted before the wire map (e.g. `"    record = row.data"`). */
  bind?: string;
  /** Expression for the `source: "id"` wire field (default `"record.id"`). */
  idExpr?: string;
}

export function renderWireSerialize(
  agg: AggregateIR,
  ctx: BoundedContextIR,
  opts: WireSerializeOpts = {},
): WireSerializeResult {
  const headVar = opts.headVar ?? "record";
  const idExpr = opts.idExpr ?? "record.id";
  const wireShape = (agg as EnrichedAggregateIR).wireShape ?? [];
  const parts = new Map<string, WireField[]>(agg.parts.map((p) => [p.name, p.wireShape ?? []]));
  const vos = new Map<string, WireField[]>(
    ctx.valueObjects.map((v) => [v.name, v.wireShape ?? []]),
  );

  const helpers = new Map<string, string>();
  const building = new Set<string>();

  // Value expression for one wire field over the `record` var.  `source: "id"`
  // and `source: "derived"` are handled by the caller (id → `record.id`,
  // derived → skipped), so this only sees property / containment fields.
  // Field access for a wire field over the `record` var.  Inside a VALUE-OBJECT
  // serializer helper (`isVo`), `record` is the VO value, which at runtime may be
  // a STRING-keyed jsonb map (a single VO field) OR an ATOM-keyed struct (a VO
  // collection element / freshly-built ctor) — plain struct-dot `record.amount`
  // crashes with `KeyError` on the string-keyed case (issue #1660).  Read via a
  // key-type-agnostic fallback there (atom key, then string key).  Everywhere
  // else `record` is a real struct → struct-dot stays (byte-identical output).
  const fieldAccess = (name: string, isVo: boolean): string =>
    isVo
      ? `Map.get(record, :${snake(name)}, Map.get(record, ${JSON.stringify(snake(name))}))`
      : `record.${snake(name)}`;

  function valueExpr(wf: WireField, isVo: boolean): string {
    const t = unwrapOptional(wf.type);
    const col = fieldAccess(wf.name, isVo);
    switch (t.kind) {
      case "valueobject":
        ensureVoHelper(t.name);
        return `serialize_${snake(t.name)}(${col})`;
      case "entity":
        ensurePartHelper(t.name);
        return `serialize_${snake(t.name)}(${col})`;
      case "array": {
        const el = unwrapOptional(t.element);
        if (el.kind === "id") return `__ref_ids(${col})`;
        if (el.kind === "valueobject") {
          ensureVoHelper(el.name);
          return `Enum.map(${col} || [], &serialize_${snake(el.name)}/1)`;
        }
        if (el.kind === "entity") {
          ensurePartHelper(el.name);
          return `Enum.map(${col} || [], &serialize_${snake(el.name)}/1)`;
        }
        // Array of primitive / enum — Jason encodes the list of scalars.
        return col;
      }
      default:
        // primitive / enum / id / guid / datetime / decimal / money / bool /
        // int / string / json — Jason handles DateTime/Decimal natively.
        return col;
    }
  }

  // Render a `%{ "<name>" => <expr>, ... }` map for a wire shape (order =
  // wireShape order), skipping derived fields.  `isVo` = the map is a value
  // object's own body (string/atom-key-agnostic field access).  `baseIndent` is
  // the indentation of the `%{` opener; entries indent one step (2 spaces) more.
  function renderMap(
    shape: WireField[],
    baseIndent: string,
    isVo: boolean,
    idExprLocal = "record.id",
  ): string {
    const entries: string[] = [];
    for (const wf of shape) {
      if (wf.source === "derived") continue;
      const ve = wf.source === "id" ? idExprLocal : valueExpr(wf, isVo);
      entries.push(`${baseIndent}  "${wf.name}" => ${ve}`);
    }
    if (entries.length === 0) return `${baseIndent}%{}`;
    return `${baseIndent}%{\n${entries.join(",\n")}\n${baseIndent}}`;
  }

  function buildHelper(name: string, shape: WireField[], isVo: boolean): void {
    const hname = `serialize_${snake(name)}`;
    if (helpers.has(hname) || building.has(hname)) return;
    building.add(hname);
    const body = renderMap(shape, "    ", isVo);
    helpers.set(
      hname,
      `  defp ${hname}(nil), do: nil\n\n  defp ${hname}(record) do\n${body}\n  end`,
    );
    building.delete(hname);
  }

  function ensurePartHelper(name: string): void {
    const shape = parts.get(name);
    if (shape) buildHelper(name, shape, /* isVo */ false);
  }

  function ensureVoHelper(name: string): void {
    const shape = vos.get(name);
    if (shape) buildHelper(name, shape, /* isVo */ true);
  }

  const body = renderMap(wireShape, "    ", /* isVo */ false, idExpr);
  const preludeBind = opts.bind ? `${opts.bind}\n` : "";
  const serialize = `  defp serialize(${headVar}) do\n${preludeBind}${body}\n  end`;
  return { serialize, body, helpers: [...helpers.values()] };
}

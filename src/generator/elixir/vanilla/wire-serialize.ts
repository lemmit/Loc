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
// reachable through the wire shape.  Derived fields are COMPUTED from their
// `DerivedIR` expression against the loaded `record` (parity with the other
// backends, which the served OpenAPI marks required) when that expression is
// `record`-evaluable; a derived that isn't (references another derived, a
// helper, `currentUser`, …) stays skipped.  Reference collections (`X id[]`)
// keep the existing `__ref_ids/1` projection (helper emitted by api-emit when
// the aggregate has ref-collection fields).
// ---------------------------------------------------------------------------

import {
  wireFieldsForAggregate,
  wireFieldsForPart,
  wireFieldsForValueObject,
} from "../../../ir/enrich/wire-projection.js";
import type {
  AggregateIR,
  BoundedContextIR,
  DerivedIR,
  EnrichedAggregateIR,
  ExprIR,
  TypeIR,
  WireField,
} from "../../../ir/types/loom-ir.js";
import { snake } from "../../../util/naming.js";
import { type RenderCtx, renderExpr } from "../render-expr.js";

/** A derived wire field is projected only when its expression evaluates cleanly
 *  off the LOADED `record` struct (+ its already-serialized containments) — the
 *  in-memory Elixir the serializer runs.  A `this-derived` ref (not a stored
 *  column), a `helper-fn` / free `call` (needs a domain seam the serializer
 *  doesn't host), `currentUser` (no actor here), or a resource handle does not —
 *  those derived fall back to being SKIPPED (status quo, no regression, no
 *  codegen crash) rather than emitting a `KeyError`-raising `record.<derived>`. */
function derivedRenderable(e: ExprIR, scope: ReadonlySet<string> = new Set()): boolean {
  switch (e.kind) {
    case "literal":
    case "id":
      return true;
    case "this":
    case "call": // free / function / private-op / VO-ctor — needs a domain seam
    case "action-ref":
      return false;
    case "ref":
      switch (e.refKind) {
        case "this-prop":
        case "this-vo-prop":
        case "enum-value":
          return true;
        case "let":
        case "lambda":
          return scope.has(e.name);
        default:
          // this-derived (not a column), helper-fn, current-user, resource,
          // param, unknown, match-binding.
          return false;
      }
    case "member":
      return derivedRenderable(e.receiver, scope);
    case "method-call":
      return (
        derivedRenderable(e.receiver, scope) && e.args.every((a) => derivedRenderable(a, scope))
      );
    case "lambda": {
      if (!e.body) return false;
      const inner = new Set(scope);
      inner.add(e.param);
      return derivedRenderable(e.body, inner);
    }
    case "paren":
      return derivedRenderable(e.inner, scope);
    case "unary":
      return derivedRenderable(e.operand, scope);
    case "convert":
      return derivedRenderable(e.value, scope);
    case "binary":
      return derivedRenderable(e.left, scope) && derivedRenderable(e.right, scope);
    case "duration":
      // A5 temporal — a duration constructor renders in-memory (integer ms /
      // the calendar-shift count; see render-expr.ts), so a temporal derived
      // (`derived due: datetime = createdAt + days(30)`) projects cleanly.
      return derivedRenderable(e.amount, scope);
    case "ternary":
      return (
        derivedRenderable(e.cond, scope) &&
        derivedRenderable(e.then, scope) &&
        derivedRenderable(e.otherwise, scope)
      );
    case "new":
    case "object":
      return e.fields.every((f) => derivedRenderable(f.value, scope));
    case "match":
      return (
        e.arms.every(
          (a) => derivedRenderable(a.cond, scope) && derivedRenderable(a.value, scope),
        ) &&
        (e.otherwise === undefined || derivedRenderable(e.otherwise, scope))
      );
    case "list":
      return e.elements.every((el) => derivedRenderable(el, scope));
    default:
      return false;
  }
}

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
  /** `<App>.<Ctx>` module prefix for the `renderExpr` context used to project
   *  derived wire fields.  Only consulted for a derived that references a
   *  context-qualified name; omit for the (common) scalar-prop derived. */
  contextModule?: string;
}

export function renderWireSerialize(
  agg: AggregateIR,
  ctx: BoundedContextIR,
  opts: WireSerializeOpts = {},
): WireSerializeResult {
  const headVar = opts.headVar ?? "record";
  const idExpr = opts.idExpr ?? "record.id";
  const wireShape = wireFieldsForAggregate(agg);
  const parts = new Map<string, WireField[]>(agg.parts.map((p) => [p.name, wireFieldsForPart(p)]));
  const vos = new Map<string, WireField[]>(
    ctx.valueObjects.map((v) => [v.name, wireFieldsForValueObject(v)]),
  );

  // Derived wire fields are COMPUTED (not stored columns) — every other backend
  // computes + emits them, so vanilla must too or the served response omits an
  // OpenAPI-required key (the audit's self-contradicting contract).  Look up the
  // `DerivedIR` per shape: the aggregate's own for the root map, each part's for
  // its nested serializer.  Value objects declare no derived, so their helpers
  // get an empty map (unchanged behaviour).
  const aggDerived = new Map<string, DerivedIR>(agg.derived.map((d) => [d.name, d]));
  const partDerived = new Map<string, Map<string, DerivedIR>>(
    agg.parts.map((p) => [p.name, new Map(p.derived.map((d) => [d.name, d]))]),
  );
  const emptyDerived = new Map<string, DerivedIR>();
  const derivedRc: RenderCtx = {
    thisName: "record",
    contextModule: opts.contextModule ?? "App",
    foundation: "vanilla",
    agg: agg as EnrichedAggregateIR,
  };

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
  // wireShape order).  A derived field is COMPUTED from its `DerivedIR`
  // expression against the loaded `record` (parity with the other backends)
  // when that expression is `record`-evaluable; a derived that isn't (references
  // another derived, a helper, `currentUser`, …) is still skipped.  `isVo` = the
  // map is a value object's own body (string/atom-key-agnostic field access).
  // `baseIndent` is the indentation of the `%{` opener; entries indent one step
  // (2 spaces) more.
  function renderMap(
    shape: WireField[],
    baseIndent: string,
    isVo: boolean,
    derived: Map<string, DerivedIR>,
    idExprLocal = "record.id",
  ): string {
    const entries: string[] = [];
    for (const wf of shape) {
      let ve: string;
      if (wf.source === "derived") {
        const d = derived.get(wf.name);
        if (!d || !derivedRenderable(d.expr)) continue;
        ve = renderExpr(d.expr, derivedRc);
      } else {
        ve = wf.source === "id" ? idExprLocal : valueExpr(wf, isVo);
      }
      entries.push(`${baseIndent}  "${wf.name}" => ${ve}`);
    }
    if (entries.length === 0) return `${baseIndent}%{}`;
    return `${baseIndent}%{\n${entries.join(",\n")}\n${baseIndent}}`;
  }

  function buildHelper(
    name: string,
    shape: WireField[],
    isVo: boolean,
    derived: Map<string, DerivedIR>,
  ): void {
    const hname = `serialize_${snake(name)}`;
    if (helpers.has(hname) || building.has(hname)) return;
    building.add(hname);
    const body = renderMap(shape, "    ", isVo, derived);
    helpers.set(
      hname,
      `  defp ${hname}(nil), do: nil\n\n  defp ${hname}(record) do\n${body}\n  end`,
    );
    building.delete(hname);
  }

  function ensurePartHelper(name: string): void {
    const shape = parts.get(name);
    if (shape) buildHelper(name, shape, /* isVo */ false, partDerived.get(name) ?? emptyDerived);
  }

  function ensureVoHelper(name: string): void {
    const shape = vos.get(name);
    if (shape) buildHelper(name, shape, /* isVo */ true, emptyDerived);
  }

  const body = renderMap(wireShape, "    ", /* isVo */ false, aggDerived, idExpr);
  const preludeBind = opts.bind ? `${opts.bind}\n` : "";
  const serialize = `  defp serialize(${headVar}) do\n${preludeBind}${body}\n  end`;
  return { serialize, body, helpers: [...helpers.values()] };
}

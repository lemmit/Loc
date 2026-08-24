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
  forApiRead,
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
  FieldIR,
  TypeIR,
  WireField,
} from "../../../ir/types/loom-ir.js";
import { snake } from "../../../util/naming.js";
import { MONEY_WIRE_SCALE } from "../../money-scale.js";
import { type RenderCtx, renderExpr } from "../render-expr.js";
import { provColumn } from "./provenance-emit.js";

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
   *  controllers.  When the aggregate declares a `mask unless` field this is the
   *  REDACTING serializer (delegates to `serialize_unmasked/1`, then nils each
   *  masked key unless the ambient principal — `Process.get(:loom_current_user)`,
   *  stashed by the Auth plug — satisfies its predicate, fail-closed); the raw
   *  map moves to the `serialize_unmasked/1` helper for audit snapshots. */
  serialize: string;
  /** Just the `%{ … }` wire-map body (indented for a function body), for a
   *  caller that needs its own function head — e.g. the ViewsController, which
   *  dispatches per aggregate with a struct-typed head
   *  (`defp serialize(%Agg{} = record)`).  Always the UNMASKED map. */
  body: string;
  /** Nested `serialize_<part|vo>/1` private helper defs, deduped by name,
   *  in completion order.  Empty when the wire shape references no contained
   *  entities / value objects.  Includes `serialize_unmasked/1` when the
   *  aggregate is masked. */
  helpers: string[];
  /** True iff the aggregate declares at least one `mask unless` field — the
   *  gate the controllers read to route audit snapshots through the unmasked
   *  `serialize_unmasked/1` (responses keep calling `serialize/1`). */
  masked: boolean;
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
  /** Expression for the optimistic-concurrency `version` wire field (a
   *  `source: "property"`, `access: "token"` field).  The Route A document
   *  controller stores `version` on the ROOT row, not inside the `:data` embed
   *  (`record`), so it overrides just that field to `"row.version"`; omit to read
   *  it off `record` like any other property (the relational default). */
  versionExpr?: string;
  /** `<App>.<Ctx>` module prefix for the `renderExpr` context used to project
   *  derived wire fields.  Only consulted for a derived that references a
   *  context-qualified name; omit for the (common) scalar-prop derived. */
  contextModule?: string;
  /** Snake-cased suffix appended to `serialize` and every nested
   *  `serialize_<part|vo>` / `serialize_unmasked` name, so SEVERAL aggregates'
   *  serializers can live in ONE module: the deployable-level WorkflowsController
   *  / `<Api>RoutesController` dispatch across every hosted aggregate, and two
   *  aggregates (or two contexts) may declare same-named parts / value objects.
   *  Those callers emit their own `defp serialize(%<Agg>{} = r), do:
   *  serialize_<suffix>(r)` dispatch clause.  Omit for a single-aggregate module
   *  (byte-identical to before). */
  nameSuffix?: string;
}

export function renderWireSerialize(
  agg: AggregateIR,
  ctx: BoundedContextIR,
  opts: WireSerializeOpts = {},
): WireSerializeResult {
  const headVar = opts.headVar ?? "record";
  const idExpr = opts.idExpr ?? "record.id";
  // Name suffix that scopes EVERY emitted function name (see `nameSuffix`) so
  // several aggregates' serializers coexist in one module.  Empty by default —
  // the single-aggregate controllers stay byte-identical.
  const sfx = opts.nameSuffix ? `_${snake(opts.nameSuffix)}` : "";
  // RS-25 — the API-read projection, NOT the raw wire shape.  `forApiRead`
  // drops `access: internal` / `access: secret` fields; every other backend
  // applies it on the read boundary (and vanilla's own OpenAPI emitter already
  // did), so skipping it here leaked exactly the fields the modifier exists to
  // hide.  `tenantOwned`'s `tenantId`/`dataKey` are `internal`, so a
  // multi-tenant aggregate shipped its tenant key to the client on every GET —
  // and the SERVED SPEC said it wouldn't.  A `secret` field (password hash,
  // API key) leaked the same way.
  const wireShape = forApiRead(wireFieldsForAggregate(agg));
  const parts = new Map<string, WireField[]>(
    agg.parts.map((p) => [p.name, forApiRead(wireFieldsForPart(p))]),
  );
  const vos = new Map<string, WireField[]>(
    ctx.valueObjects.map((v) => [v.name, forApiRead(wireFieldsForValueObject(v))]),
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
    agg: agg as EnrichedAggregateIR,
  };

  const helpers = new Map<string, string>();
  const building = new Set<string>();
  // Set when any money field is projected — gates the `__money_round/1` helper
  // that pins money to the FIXED wire scale (RS-12).
  let usedMoney = false;
  // Set when any plain-`decimal` field is projected — gates `__decimal_num/1`
  // (RS-24).  Jason encodes a bare `%Decimal{}` as a JSON *string*, which is
  // exactly what money wants (RS-12's fixed-scale `"19.5000"`) and exactly what
  // a plain `decimal` must NOT be: node/.NET/Java/Python all ship it as a JSON
  // number.
  let usedDecimal = false;

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
        return `serialize_${snake(t.name)}${sfx}(${col})`;
      case "entity":
        ensurePartHelper(t.name);
        return `serialize_${snake(t.name)}${sfx}(${col})`;
      case "array": {
        const el = unwrapOptional(t.element);
        if (el.kind === "id") return `__ref_ids(${col})`;
        if (el.kind === "valueobject") {
          ensureVoHelper(el.name);
          return `Enum.map(${col} || [], &serialize_${snake(el.name)}${sfx}/1)`;
        }
        if (el.kind === "entity") {
          ensurePartHelper(el.name);
          return `Enum.map(${col} || [], &serialize_${snake(el.name)}${sfx}/1)`;
        }
        // Array of primitive / enum — Jason encodes the list of scalars, except
        // a `decimal[]`, whose elements need the same number coercion a scalar
        // decimal does (RS-24).
        if (el.kind === "primitive" && el.name === "decimal") {
          usedDecimal = true;
          return `Enum.map(${col} || [], &__decimal_num/1)`;
        }
        return col;
      }
      default:
        // primitive / enum / id / guid / datetime / decimal / money / bool /
        // int / string / json — Jason handles DateTime natively; the scalar
        // money / decimal coercions are applied by `renderMap` (so a DERIVED
        // decimal, which never reaches this function, gets them too).
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
    /** The entity's `provenanced` fields, whose co-located lineage rides the
     *  wire after the shape (RS-18).  Empty for value objects. */
    provFields: readonly FieldIR[] = [],
  ): string {
    const entries: string[] = [];
    for (const wf of shape) {
      let ve: string;
      if (wf.source === "derived") {
        const d = derived.get(wf.name);
        if (!d || !derivedRenderable(d.expr)) continue;
        ve = renderExpr(d.expr, derivedRc);
      } else if (wf.source === "id") {
        ve = idExprLocal;
      } else if (
        opts.versionExpr !== undefined &&
        wf.source === "property" &&
        wf.access === "token"
      ) {
        // The concurrency `version` token lives on the document root row, not the
        // `:data` embed (`record`) — read it off the caller-supplied root expr.
        ve = opts.versionExpr;
      } else {
        ve = valueExpr(wf, isVo);
      }
      // Money → FIXED wire scale (RS-12): a bare `%Decimal{}` Jason-encodes at
      // its own scale (a DB-stored `12.5`, a derived `Decimal.new("0.00")`), so
      // round every money-typed entry — regular OR derived — to the canonical
      // `NUMERIC(19,4)` scale for a wire value byte-consistent with the other
      // backends.  The `__money_round/1` helper is nil-safe for `money?`.
      const innerMoney = unwrapOptional(wf.type);
      if (innerMoney.kind === "primitive" && innerMoney.name === "money") {
        usedMoney = true;
        ve = `__money_round(${ve})`;
      } else if (innerMoney.kind === "primitive" && innerMoney.name === "decimal") {
        // RS-24 — a plain `decimal` is a JSON NUMBER on every other backend.
        usedDecimal = true;
        ve = `__decimal_num(${ve})`;
      }
      entries.push(`${baseIndent}  "${wf.name}" => ${ve}`);
    }
    // RS-18 — co-located provenance rides the wire so any GET surfaces the
    // current lineage inline, under the snake_case `<field>_provenance` key the
    // other four backends use (and the scaffolded frontend reads).  It is NOT a
    // `wireShape` member on any backend: node appends it the same way, after the
    // shape.
    for (const f of provFields) {
      entries.push(`${baseIndent}  "${f.name}_provenance" => record.${provColumn(f.name)}`);
    }
    if (entries.length === 0) return `${baseIndent}%{}`;
    return `${baseIndent}%{\n${entries.join(",\n")}\n${baseIndent}}`;
  }

  function buildHelper(
    name: string,
    shape: WireField[],
    isVo: boolean,
    derived: Map<string, DerivedIR>,
    provFields: readonly FieldIR[] = [],
  ): void {
    const hname = `serialize_${snake(name)}${sfx}`;
    if (helpers.has(hname) || building.has(hname)) return;
    building.add(hname);
    const body = renderMap(shape, "    ", isVo, derived, "record.id", provFields);
    helpers.set(
      hname,
      `  defp ${hname}(nil), do: nil\n\n  defp ${hname}(record) do\n${body}\n  end`,
    );
    building.delete(hname);
  }

  function ensurePartHelper(name: string): void {
    const shape = parts.get(name);
    if (!shape) return;
    const part = agg.parts.find((p) => p.name === name);
    buildHelper(
      name,
      shape,
      /* isVo */ false,
      partDerived.get(name) ?? emptyDerived,
      (part?.fields ?? []).filter((f) => f.provenanced),
    );
  }

  function ensureVoHelper(name: string): void {
    const shape = vos.get(name);
    if (shape) buildHelper(name, shape, /* isVo */ true, emptyDerived);
  }

  const body = renderMap(
    wireShape,
    "    ",
    /* isVo */ false,
    aggDerived,
    idExpr,
    agg.fields.filter((f) => f.provenanced),
  );
  const preludeBind = opts.bind ? `${opts.bind}\n` : "";

  // RS-12 money-scale helper — emitted once when the wire shape carries money.
  // `Decimal.round/2` defaults to `:half_up` (matching node/.NET/Java/Python)
  // and sets the exponent to `-scale`, so trailing zeros are preserved
  // (`Decimal.round(Decimal.new("12.5"), 4)` → `"12.5000"`).
  if (usedMoney) {
    helpers.set(
      "__money_round",
      `  defp __money_round(nil), do: nil\n\n` +
        `  defp __money_round(%Decimal{} = dec), do: Decimal.round(dec, ${MONEY_WIRE_SCALE})`,
    );
  }

  // RS-24 plain-decimal helper.  Jason's `Decimal` encoder emits a JSON STRING;
  // node/.NET/Java/Python all put a plain `decimal` on the wire as a NUMBER.
  // `Decimal.to_float/1` reproduces the ORACLE exactly — node's value is a
  // float64 to begin with — so this is the coercion that closes the gap rather
  // than merely narrowing it.  Nil-safe (an optional decimal), and passes a
  // non-Decimal through untouched (a jsonb-sourced value may already be a
  // float/integer).
  if (usedDecimal) {
    // The BINARY clause is not defensive padding — it is the second writer.
    // A value object persists as a plain `:map` (jsonb), and the two paths that
    // write one disagree about the encoding of a decimal field:
    //
    //   - CREATE goes through the changeset cast, so the raw JSON number the
    //     client sent (`100`) is what lands in the column;
    //   - an OPERATION computes (`Decimal.add(...)`) and `force_change`s the
    //     resulting map, so a `%Decimal{}` reaches Jason, which encodes a
    //     Decimal as a STRING — the column then holds `"125"`.
    //
    // On the way back out the jsonb value is already a bare string, so the
    // `%Decimal{}` clause never matches and the wire shipped `"125"` where the
    // other four backends ship `125` — an RS-24 break visible only AFTER an
    // operation had written the value.  Parsing the binary here reproduces the
    // oracle from either storage form.  Scoped by TYPE: this helper is only
    // applied to entries the emitter already typed as a plain `decimal`, so
    // `money` (which must stay a fixed-scale string, RS-12) is untouched — it
    // rides `__money_round/1` instead.
    //
    // Found 2026-08-05 by the caller-census drain: `corpus/domain-services`'
    // `deposit`/`withdraw` were driven for the first time and the balance came
    // back quoted.
    helpers.set(
      "__decimal_num",
      `  defp __decimal_num(nil), do: nil\n\n` +
        `  defp __decimal_num(%Decimal{} = dec), do: Decimal.to_float(dec)\n\n` +
        `  defp __decimal_num(bin) when is_binary(bin) do\n` +
        `    case Decimal.parse(bin) do\n` +
        `      {dec, ""} -> Decimal.to_float(dec)\n` +
        `      _ -> bin\n` +
        `    end\n` +
        `  end\n\n` +
        `  defp __decimal_num(other), do: other`,
    );
  }

  // `mask unless` read redaction (authorization.md §5): the masked root wire
  // fields, projected fail-closed against the ambient principal.  When present,
  // the raw map moves to `serialize_unmasked/1` (audit snapshots project through
  // it, unredacted) and `serialize/1` delegates to it, then nils each masked key
  // unless the caller satisfies its predicate.  A mask-free aggregate keeps the
  // single unmasked `serialize/1` verbatim (byte-identical).
  const maskedFields = wireShape.filter((wf) => wf.maskUnless !== undefined);
  if (maskedFields.length === 0) {
    const serialize = `  defp serialize${sfx}(${headVar}) do\n${preludeBind}${body}\n  end`;
    return { serialize, body, helpers: [...helpers.values()], masked: false };
  }
  const redactLines = maskedFields
    .map((wf) => {
      // The predicate is `currentUser`-only (validated); render it in-memory
      // (`filterArgs` unset) against the `current_user` local bound below.  The
      // `current_user != nil` guard short-circuits so an unauthenticated request
      // (nil principal) redacts without a `nil.<claim>` crash.
      const pred = renderExpr(wf.maskUnless!, derivedRc);
      return `    wire = if current_user != nil and (${pred}), do: wire, else: Map.put(wire, "${wf.name}", nil)`;
    })
    .join("\n");
  const serialize =
    `  defp serialize${sfx}(${headVar}) do\n` +
    `    current_user = Process.get(:loom_current_user)\n` +
    `    wire = serialize_unmasked${sfx}(${headVar})\n` +
    `${redactLines}\n` +
    `    wire\n` +
    `  end`;
  const serializeUnmasked = `  defp serialize_unmasked${sfx}(${headVar}) do\n${preludeBind}${body}\n  end`;
  return {
    serialize,
    body,
    helpers: [serializeUnmasked, ...helpers.values()],
    masked: true,
  };
}

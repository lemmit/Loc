// F# wire layer for the Feliz frontend — the parallel of
// `src/generator/_frontend/` (zod + TanStack), rendered as F# instead of TS.
//
// Three pieces, all derived from the ENRICHED IR (never recomputed):
//   1. Domain records — one F# record per aggregate / part / value-object
//      wire shape (`agg.wireShape`, the canonical ordered field list).
//   2. Thoth.Json decoders — one `Decode.object` per record, field-by-field
//      off the same wire shape, so decode order == wire order.
//   3. Reads — the `<param>.<agg>.all` query sites a page's `view` issues,
//      projected to the MVU quadruple (Model field + init `Cmd` + `Loaded`
//      `Msg` + `update` arm).  The api module fetches over `Fable.SimpleHttp`
//      + decodes with (2), returning `Result<'T, string>`.
//
// F# record fields keep the EXACT wire-shape names (lowercase as written), so
// a page-body member access (`p.name`, rendered verbatim by the shared walker)
// lands on the record field with no casing seam, and Thoth's `Decode.field
// "name"` maps the JSON key straight onto it.

import { forApiRead } from "../../ir/enrich/wire-projection.js";
import type {
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  ExprIR,
  PageIR,
  TypeIR,
} from "../../ir/types/loom-ir.js";
import { API_BASE_PATH } from "../../util/api-base.js";
import { lines } from "../../util/code-builder.js";
import { lowerFirst, plural, snake, upperFirst } from "../../util/naming.js";
import { tryDetectApiHook } from "../_walker/api-hook-detector.js";
import { typeToFs } from "./type-fs.js";

/** A read the page view issues (`<param>.<agg>.all`), projected to everything
 *  the MVU wiring + api module need.  v1 covers list reads (`.all`); single
 *  (`byId`) reads are a follow-up (they carry route-`id` args + `option`
 *  data). */
export interface FelizRead {
  /** Pascal Model field holding the remote data (`AllOrders`). */
  field: string;
  /** `Msg` case carrying the decoded `Result` (`AllOrdersLoaded`). */
  msgCase: string;
  /** F# api function name (`allOrders`). */
  apiFn: string;
  /** The aggregate read (`Order`). */
  aggregate: string;
  /** F# type of the loaded value (`Order list`). */
  resultType: string;
  /** Thoth decoder expression for the loaded value
   *  (`(Decode.list Decoders.order)`). */
  decoderExpr: string;
  /** Relative fetch route (`/api/orders`). */
  route: string;
  /** The match-arm binding the `data:` lambda param resolves to
   *  (`allOrders` — camelCase of `field`). */
  binding: string;
}

/** The Model field name for an aggregate list read. */
export function readFieldName(aggregate: string): string {
  return `All${plural(upperFirst(aggregate))}`;
}

/** Build the `FelizRead` for a `.all` read of `aggregate`. */
export function felizAllRead(aggregate: string): FelizRead {
  const field = readFieldName(aggregate);
  return {
    field,
    msgCase: `${field}Loaded`,
    apiFn: lowerFirst(field),
    aggregate,
    resultType: `${upperFirst(aggregate)} list`,
    decoderExpr: `(Decode.list Decoders.${lowerFirst(aggregate)})`,
    route: `${API_BASE_PATH}/${snake(plural(aggregate))}`,
    binding: lowerFirst(field),
  };
}

// ---------------------------------------------------------------------------
// Read collection — scan a page body for the `.all` query sites its view issues
// ---------------------------------------------------------------------------

/** Direct child expressions of `e` (expression positions only — lambda-block
 *  statements are action bodies, never a `QueryView` host, so they're skipped). */
function exprChildren(e: ExprIR): ExprIR[] {
  switch (e.kind) {
    case "member":
      return [e.receiver];
    case "method-call":
      return [e.receiver, ...e.args];
    case "call":
      return e.args;
    case "lambda":
      return e.body ? [e.body] : [];
    case "object":
    case "new":
      return e.fields.map((f) => f.value);
    case "list":
      return e.elements;
    case "paren":
      return [e.inner];
    case "unary":
      return [e.operand];
    case "binary":
      return [e.left, e.right];
    case "ternary":
      return [e.cond, e.then, e.otherwise];
    case "convert":
      return [e.value];
    default:
      return [];
  }
}

/** Every `QueryView(of: <expr>)` `of:` argument in a page body, in tree order. */
function queryViewOfArgs(body: ExprIR): ExprIR[] {
  const out: ExprIR[] = [];
  const walk = (e: ExprIR): void => {
    if (e.kind === "call" && e.name === "QueryView") {
      const names = e.argNames ?? [];
      const idx = names.indexOf("of");
      if (idx >= 0 && e.args[idx]) out.push(e.args[idx]);
    }
    for (const c of exprChildren(e)) walk(c);
  };
  walk(body);
  return out;
}

/** Collect the `.all` reads a page issues — deduped by Model field.  Detection
 *  reuses the shared `tryDetectApiHook`, so the reads collected here name the
 *  same aggregates the view walk resolves through the `buildHookUse` seam. */
export function collectPageReads(
  page: PageIR,
  apiParamNames: ReadonlySet<string>,
  aggregatesByName: ReadonlySet<string>,
): FelizRead[] {
  if (!page.body) return [];
  const detCtx = { apiParamNames, aggregatesByName };
  const out: FelizRead[] = [];
  const seen = new Set<string>();
  for (const ofArg of queryViewOfArgs(page.body)) {
    const detected = tryDetectApiHook(ofArg, detCtx);
    // v1 wire layer: aggregate list reads only.
    if (detected?.kind !== "aggregate" || detected.operation !== "all") continue;
    const read = felizAllRead(detected.aggregateName);
    if (seen.has(read.field)) continue;
    seen.add(read.field);
    out.push(read);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Domain records + Thoth decoders (off wireShape)
// ---------------------------------------------------------------------------

/** F# type spelling of a wire field's declared type, honouring the wire
 *  contract: an enum value arrives as its string name, so it decodes to a
 *  plain `string` (a proper DU decoder is a follow-up). */
function wireFieldType(t: TypeIR): string {
  switch (t.kind) {
    case "enum":
      return "string";
    case "array":
      return `${wireFieldType(t.element)} list`;
    case "optional":
      return `${wireFieldType(t.inner)} option`;
    default:
      return typeToFs(t);
  }
}

/** Thoth decoder expression for a wire field's declared type. */
function decoderExprFor(t: TypeIR): string {
  switch (t.kind) {
    case "primitive":
      switch (t.name) {
        case "int":
        case "long":
          return "Decode.int";
        case "decimal":
        case "money":
          return "Decode.decimal";
        case "bool":
          return "Decode.bool";
        case "datetime":
          return "Decode.datetimeUtc";
        default:
          return "Decode.string"; // string, json
      }
    case "id":
      return "Decode.string";
    case "enum":
      return "Decode.string"; // wire carries the enum's string name
    case "valueobject":
    case "entity":
      return `Decoders.${lowerFirst(t.name)}`;
    case "array":
      return `(Decode.list ${decoderExprFor(t.element)})`;
    case "optional":
      return decoderExprFor(t.inner); // handled at the field via get.Optional
    default:
      return "Decode.string";
  }
}

/** A record + decoder the emitted wire layer needs — an aggregate, one of its
 *  entity parts, or a value object, keyed by its F# type name. */
interface WireRecord {
  typeName: string;
  decoderName: string;
  fields: { name: string; type: TypeIR; optional: boolean }[];
}

/** The F# type name a wire field references (an entity part / value object),
 *  peeling arrays + optionals; undefined for scalar/enum leaves. */
function namedRecord(t: TypeIR): string | undefined {
  if (t.kind === "valueobject" || t.kind === "entity") return t.name;
  if (t.kind === "array") return namedRecord(t.element);
  if (t.kind === "optional") return namedRecord(t.inner);
  return undefined;
}

/** Collect every record the read aggregates transitively need — the
 *  aggregate itself plus any entity part / value object referenced through a
 *  wire field (containments, VO-typed properties). */
function collectRecords(
  aggregates: EnrichedAggregateIR[],
  contexts: EnrichedBoundedContextIR[],
): WireRecord[] {
  const out: WireRecord[] = [];
  const seen = new Set<string>();

  const partByName = new Map<string, EnrichedAggregateIR["parts"][number]>();
  const voWireByName = new Map<string, { name: TypeIR; fields: WireRecord["fields"] }>();
  for (const c of contexts) {
    for (const a of c.aggregates) for (const p of a.parts) partByName.set(p.name, p);
    for (const vo of c.valueObjects) {
      voWireByName.set(vo.name, {
        name: { kind: "valueobject", name: vo.name },
        fields: (vo.wireShape ?? []).map((w) => ({
          name: w.name,
          type: w.type,
          optional: w.optional,
        })),
      });
    }
  }

  const emit = (typeName: string, wire: WireRecord["fields"]): void => {
    if (seen.has(typeName)) return;
    seen.add(typeName);
    out.push({ typeName: upperFirst(typeName), decoderName: lowerFirst(typeName), fields: wire });
    for (const f of wire) {
      const n = namedRecord(f.type);
      if (!n || seen.has(n)) continue;
      const part = partByName.get(n);
      if (part) {
        emit(
          n,
          forApiRead(part.wireShape ?? []).map((w) => ({
            name: w.name,
            type: w.type,
            optional: w.optional,
          })),
        );
        continue;
      }
      const vo = voWireByName.get(n);
      if (vo) emit(n, vo.fields);
    }
  };

  for (const agg of aggregates) {
    emit(
      agg.name,
      forApiRead(agg.wireShape).map((w) => ({ name: w.name, type: w.type, optional: w.optional })),
    );
  }
  return out;
}

/** Emit the `Domain` record types + `Decoders` module for the given read
 *  aggregates.  Returns the two F# blocks (records first, then decoders —
 *  F# is order-sensitive, and a decoder references its record). */
export function renderWireTypes(
  reads: FelizRead[],
  contexts: EnrichedBoundedContextIR[],
): { domain: string; decoders: string } {
  const byName = new Map<string, EnrichedAggregateIR>();
  for (const c of contexts) for (const a of c.aggregates) byName.set(a.name, a);
  const readAggs = [...new Set(reads.map((r) => r.aggregate))]
    .map((n) => byName.get(n))
    .filter((a): a is EnrichedAggregateIR => !!a);

  const records = collectRecords(readAggs, contexts);
  if (records.length === 0) return { domain: "", decoders: "" };

  const domain = lines(
    "// Domain records — one per aggregate / part / value-object wire shape.",
    ...records.flatMap((rec) => [
      `type ${rec.typeName} =`,
      "  {",
      ...rec.fields.map(
        (f) =>
          `    ${f.name}: ${f.optional ? `${wireFieldType(f.type)} option` : wireFieldType(f.type)}`,
      ),
      "  }",
    ]),
  );

  const decoders = lines(
    "// Thoth.Json decoders — decode order mirrors the wire shape.",
    "module Decoders =",
    ...records.flatMap((rec, i) => [
      i > 0 ? "" : undefined,
      `  let ${rec.decoderName} : Decoder<${rec.typeName}> =`,
      "    Decode.object (fun get ->",
      "      {",
      ...rec.fields.map(
        (f) =>
          `        ${f.name} = ${
            f.optional
              ? `get.Optional.Field "${f.name}" ${decoderExprFor(f.type)}`
              : `get.Required.Field "${f.name}" ${decoderExprFor(f.type)}`
          }`,
      ),
      "      })",
    ]),
  );

  return { domain, decoders };
}

/** Emit the `Api` module — one `Cmd`-issuing async read per `FelizRead`,
 *  fetching over `Fable.SimpleHttp` and decoding with the Thoth decoders. */
export function renderApiModule(reads: FelizRead[]): string {
  if (reads.length === 0) return "";
  return lines(
    "// Api — Cmd-based reads (Fable.SimpleHttp + Thoth → Result).",
    "module Api =",
    ...reads.flatMap((r, i) => [
      i > 0 ? "" : undefined,
      `  let ${r.apiFn} () : Async<Result<${r.resultType}, string>> =`,
      "    async {",
      `      let! (status, body) = Http.get "${r.route}"`,
      "      if status = 200 then",
      `        match Decode.fromString ${r.decoderExpr} body with`,
      "        | Ok data -> return Ok data",
      "        | Error e -> return Error e",
      "      else",
      '        return Error (sprintf "HTTP %d" status)',
      "    }",
    ]),
  );
}

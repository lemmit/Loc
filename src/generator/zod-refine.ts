import type { BinOp, ExprIR, InvariantIR } from "../ir/types/loom-ir.js";
import {
  type ClassifyContext,
  classifyForWire,
  pickErrorPath,
  type SingleFieldPattern,
  singleFieldShape,
} from "../ir/validate/invariant-classify.js";
import { messageCode } from "../util/message-code.js";

// ---------------------------------------------------------------------------
// Zod-refine renderer for wire-boundary validators (frontend forms +
// Hono per-route schemas).  Two surface APIs:
//
//  - `chainSingleFieldNative(inner, pattern)` — append idiomatic chain
//    methods (`.min(N)`, `.max(N)`, `.length(N)`, …) to a base zod
//    schema.  Used inside `z.object({ field: <chained> })` emission.
//
//  - `refineClauseFor(inv, ctx)` — produce a `.refine(d => …, { path,
//    message })` chain for an invariant; returns null when the
//    invariant doesn't translate to a wire validator.  Used as the
//    fallback for cross-field / non-recognised-pattern rules.
//
// The renderer mirrors `renderTsExpr` but treats refs to request-body
// fields (`this-prop`, `this-vo-prop`, `param`) as `data.<name>`
// instead of `this._<name>`.  A separate, smaller switch keeps the
// two renderers from drifting into each other.
// ---------------------------------------------------------------------------

/** Chain idiomatic native zod methods onto a base inner schema for a
 *  recognised single-field pattern.  Caller picks the base
 *  (`z.string()`, `z.number()`, etc.); we just chain. */
export function chainSingleFieldNative(inner: string, pattern: SingleFieldPattern): string {
  switch (pattern.kind) {
    case "min":
      // Exclusive (`weight > 0.5` on a decimal/money field) → zod's `.gt`;
      // inclusive keeps `.min` byte-for-byte.
      return `${inner}.${pattern.exclusive ? "gt" : "min"}(${pattern.n})`;
    case "max":
      return `${inner}.${pattern.exclusive ? "lt" : "max"}(${pattern.n})`;
    case "between":
      return `${inner}.min(${pattern.lo}).max(${pattern.hi})`;
    case "len-min":
      return `${inner}.min(${pattern.n})`;
    case "len-max":
      return `${inner}.max(${pattern.n})`;
    case "len-eq":
      return `${inner}.length(${pattern.n})`;
    case "len-range":
      return `${inner}.min(${pattern.lo}).max(${pattern.hi})`;
    case "regex":
      // The pattern is a JavaScript-compatible regex source (validated
      // at parse time via `new RegExp(...)`).  Render as a `/.../` literal
      // by escaping forward slashes; everything else stays verbatim
      // because the source string is already a JS regex source.
      return `${inner}.regex(/${pattern.pattern.replace(/\//g, "\\/")}/)`;
  }
}

/** When an invariant has a single-field shape AND the field is in
 *  `available`, return the field name + pattern so the schema
 *  emitter can chain it onto the inner field's zod base.  Removes
 *  the invariant from the refine list — it's been "absorbed" into
 *  the native chain. */
export function takeSingleFieldChain(
  inv: InvariantIR,
  ctx: ClassifyContext,
): { field: string; pattern: SingleFieldPattern } | null {
  if (!classifyForWire(inv, ctx)) return null;
  const single = singleFieldShape(inv);
  if (!single) return null;
  if (!ctx.available.has(single.field)) return null;
  return single;
}

/** Render a `.refine((d) => <predicate>, { path, message })` clause
 *  for an invariant — returns null when the invariant should NOT
 *  contribute a refine (server-only, references state outside the
 *  request body, etc.).  Single-field-shape invariants are ALSO
 *  filtered out here so they aren't double-applied; the schema
 *  emitter consumes them via `takeSingleFieldChain` first. */
export function refineClauseFor(inv: InvariantIR, ctx: ClassifyContext): string | null {
  if (!classifyForWire(inv, ctx)) return null;
  // A messaged single-field invariant is deliberately kept OUT of the native
  // chain (which has no message slot) so its refine survives — only suppress the
  // refine for a message-less shape the chain already absorbed.
  if (!inv.message && takeSingleFieldChain(inv, ctx)) return null;
  const body = renderRefineExpr(inv.expr);
  const guarded = inv.guard ? `!(${renderRefineExpr(inv.guard)}) || (${body})` : body;
  // Author `message "..."` wins over the derived "Invariant violated: <src>"
  // default; when present it also carries a stable content-hash `loomCode` in the
  // zod issue `params` so the route's `defaultHook` can surface it on
  // `errors[].code` (a runtime-body extension — not part of the OpenAPI
  // component schema, so cross-backend OpenAPI parity is unaffected).
  const message = JSON.stringify(
    inv.message ? inv.message.text : `Invariant violated: ${inv.source}`,
  );
  const code = inv.message
    ? `, params: { loomCode: ${JSON.stringify(messageCode(inv.message.text))} }`
    : "";
  const path = pickErrorPath(inv);
  const opts = path
    ? `{ path: [${JSON.stringify(path)}], message: ${message}${code} }`
    : `{ message: ${message}${code} }`;
  return `.refine((data) => ${guarded}, ${opts})`;
}

// ---------------------------------------------------------------------------
// Predicate-body renderer — walks ExprIR producing a JS expression
// that runs against a `data` object representing the request body.
// ---------------------------------------------------------------------------

function renderRefineExpr(e: ExprIR): string {
  switch (e.kind) {
    case "literal":
      return renderLiteral(e.lit, e.value);
    case "ref":
      return renderRef(e);
    case "member":
      return renderMember(e);
    case "method-call":
      return renderMethodCall(e);
    case "paren":
      return `(${renderRefineExpr(e.inner)})`;
    case "unary":
      return `${e.op}${renderRefineExpr(e.operand)}`;
    case "binary":
      return renderBinary(e.op, e.left, e.right);
    case "ternary":
      return `${renderRefineExpr(e.cond)} ? ${renderRefineExpr(e.then)} : ${renderRefineExpr(e.otherwise)}`;
    case "lambda":
      // Lambda body is now optional.  Wire-boundary refines
      // never see block-body lambdas (`classifyForWire` only admits
      // single-expression predicates), so falling back to the
      // unrenderable placeholder is correct.
      if (e.body) return `(${e.param}) => ${renderRefineExpr(e.body)}`;
      return `(/*UNRENDERABLE:lambda-block*/ false)`;
    case "object":
      return `({ ${e.fields.map((f) => `${f.name}: ${renderRefineExpr(f.value)}`).join(", ")} })`;
    case "this":
    case "id":
    case "call":
    case "new":
    case "convert":
    case "duration":
    case "match":
    case "list":
    case "action-ref":
    case "authz-filter":
      // `classifyForWire` excludes these; reaching the renderer
      // means a bug upstream — emit a placeholder so a failing
      // build is louder than a silently-wrong refine.  (An
      // `authz-filter` sentinel is a query-filter node, never a
      // wire-boundary invariant.)
      return `(/*UNRENDERABLE:${e.kind}*/ false)`;
  }
}

type Lit = ExprIR & { kind: "literal" };

function renderLiteral(lit: Lit["lit"], value: string): string {
  if (lit === "string") return JSON.stringify(value);
  if (lit === "now") return "new Date()";
  if (lit === "null") return "null";
  return value; // int, decimal, bool — already a JS-compatible literal
}

function renderRef(e: Extract<ExprIR, { kind: "ref" }>): string {
  switch (e.refKind) {
    case "param":
    case "this-prop":
    case "this-vo-prop":
      // Wire-validator refs read off the request body / form data.
      return `data.${e.name}`;
    case "let":
    case "lambda":
      return e.name;
    case "enum-value":
      // Enums on the wire travel as their string form; `.parse`d
      // request bodies have already been narrowed by the enum
      // schema, so the bare value is enough.
      return JSON.stringify(e.name);
    default:
      // current-user / this-derived / helper-fn / unknown — caller
      // should have filtered these out via `classifyForWire`.
      return `(/*UNRENDERABLE:${e.refKind}*/ false)`;
  }
}

function renderMember(e: Extract<ExprIR, { kind: "member" }>): string {
  const recv = renderRefineExpr(e.receiver);
  // `lines.count` style — collection length on an array-typed receiver.
  if (e.receiverType.kind === "array" && e.member === "count") {
    return `${recv}.length`;
  }
  return `${recv}.${e.member}`;
}

function renderMethodCall(e: Extract<ExprIR, { kind: "method-call" }>): string {
  const recv = renderRefineExpr(e.receiver);
  const args = e.args.map(renderRefineExpr);
  if (e.isCollectionOp) {
    return renderCollectionOp(`(${recv})`, e.member, args);
  }
  // `string.matches(literal)` — when it falls through to a
  // `.refine` predicate (e.g. cross-field), render as the same JS
  // RegExp call the domain layer uses.
  if (
    e.member === "matches" &&
    e.receiverType.kind === "primitive" &&
    e.receiverType.name === "string" &&
    args.length === 1
  ) {
    const arg0 = e.args[0];
    if (arg0?.kind === "literal" && arg0.lit === "string") {
      return `/${arg0.value.replace(/\//g, "\\/")}/.test(${recv})`;
    }
    return `new RegExp(${args[0]}).test(${recv})`;
  }
  return `${recv}.${e.member}(${args.join(", ")})`;
}

function renderCollectionOp(recv: string, name: string, args: string[]): string {
  switch (name) {
    case "count":
      return `${recv}.length`;
    case "sum":
      return args.length === 1
        ? `${recv}.reduce((acc, x) => acc + (${args[0]})(x), 0)`
        : `${recv}.reduce((acc, x) => acc + x, 0)`;
    case "all":
      return `${recv}.every(${args[0] ?? "() => true"})`;
    case "any":
      return `${recv}.some(${args[0] ?? "() => true"})`;
    case "contains":
      return `${recv}.includes(${args[0] ?? "undefined"})`;
    case "where":
      return `${recv}.filter(${args[0] ?? "() => true"})`;
    case "first":
      return `${recv}[0]`;
    case "firstOrNull":
      return `(${recv}[0] ?? null)`;
    default:
      return `${recv}.${name}(${args.join(", ")})`;
  }
}

function renderBinary(op: BinOp, left: ExprIR, right: ExprIR): string {
  const opPrint = op === "==" ? "===" : op === "!=" ? "!==" : op;
  return `${renderRefineExpr(left)} ${opPrint} ${renderRefineExpr(right)}`;
}

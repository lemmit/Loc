import type { BinOp, ExprIR, InvariantIR } from "../ir/types/loom-ir.js";
import {
  type ClassifyContext,
  classifyForWire,
  pickErrorPath,
  type SingleFieldPattern,
  singleFieldShape,
} from "../ir/validate/invariant-classify.js";
import { intrinsicKey } from "../util/intrinsics.js";
import { messageCode } from "../util/message-code.js";
import { escapeTsIdent } from "../util/naming.js";
import { tsCodePointLength as codePointLength } from "./_expr/code-point.js";
import { JS_INTRINSIC_RENDERERS } from "./_expr/js-intrinsics.js";
import { asRegexLiteral } from "./_expr/regex-literal.js";

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
//
// THE SWITCH IS NARROWER THAN `classifyForWire`.  `classifyForWire` is the
// CROSS-BACKEND admission gate (it also drives .NET FluentValidation, Java,
// Python, and the i18n validation catalog), so it admits shapes this
// browser-JS renderer has no faithful arm for — every collection op, and
// every scalar intrinsic.  `refineRenderable` below is the SECOND, local gate
// that closes that gap: `refineClauseFor` returns null (the invariant stays
// server-side, enforced by `_assertInvariants`) rather than emitting
// not-quite-JS.  The renderer then THROWS `UNRENDERABLE_MARKER` on anything
// the screen should have caught, so a future widening of either gate is a
// loud generation failure instead of a silently-armed broken arm
// (generator-code-review 2026-08-17, C3).
// ---------------------------------------------------------------------------

/** Prefix of the error thrown when the predicate renderer reaches a node it
 *  has no browser-JS arm for.  `refineRenderable` screens every such node out
 *  first, so the throw is unreachable by construction — it exists so a
 *  widening that forgets to update the screen fails loudly, and so a test can
 *  assert the two sets agree. */
export const UNRENDERABLE_MARKER = "UNRENDERABLE";

function unrenderable(what: string): never {
  throw new Error(
    `${UNRENDERABLE_MARKER}: zod-refine has no browser-JS renderer for ${what}. ` +
      "`refineRenderable` must exclude it before `refineClauseFor` renders " +
      "(src/generator/zod-refine.ts).",
  );
}

/** The collection ops `renderCollectionOp` can render as browser JS.  The
 *  remainder of `COLLECTION_OP_SIGNATURES` (`map` / `sortBy` / `distinct` /
 *  `take` / `skip` / `join` / `min` / `max` / `avg`) has no faithful
 *  one-liner here — several would need money-aware (decimal.js) comparison —
 *  so an invariant using one stays server-side rather than emitting a
 *  `.take(2)` that is not a JS array method at all. */
export const REFINE_RENDERABLE_COLLECTION_OPS: ReadonlySet<string> = new Set([
  "count",
  "sum",
  "all",
  "any",
  "contains",
  "where",
  "first",
  "firstOrNull",
]);

/** True when a scalar (non-collection) method call has a JS arm — either the
 *  `matches` regex special case or a row in the shared JS intrinsic table. */
function scalarMethodRenderable(e: Extract<ExprIR, { kind: "method-call" }>): boolean {
  if (
    e.member === "matches" &&
    e.receiverType.kind === "primitive" &&
    e.receiverType.name === "string"
  ) {
    return true;
  }
  return (
    e.receiverType.kind === "primitive" &&
    JS_INTRINSIC_RENDERERS[intrinsicKey(e.receiverType.name, e.member)] !== undefined
  );
}

/** Second admission gate (after `classifyForWire`): can THIS renderer produce
 *  browser JS for the whole expression?  Mirrors `renderRefineExpr`'s arms —
 *  every `false` here corresponds to a node the renderer would otherwise have
 *  to guess at. */
export function refineRenderable(e: ExprIR): boolean {
  switch (e.kind) {
    case "literal":
    case "ref":
      // Non-renderable ref KINDS (current-user / this-derived / helper-fn /
      // resource / unknown) are already excluded by `classifyForWire`.
      return true;
    case "member":
      return refineRenderable(e.receiver);
    case "method-call": {
      const ok = e.isCollectionOp
        ? REFINE_RENDERABLE_COLLECTION_OPS.has(e.member)
        : scalarMethodRenderable(e);
      return ok && refineRenderable(e.receiver) && e.args.every(refineRenderable);
    }
    case "paren":
      return refineRenderable(e.inner);
    case "unary":
      return refineRenderable(e.operand);
    case "binary":
      return refineRenderable(e.left) && refineRenderable(e.right);
    case "ternary":
      return refineRenderable(e.cond) && refineRenderable(e.then) && refineRenderable(e.otherwise);
    case "lambda":
      return e.body !== undefined && refineRenderable(e.body);
    case "object":
      return e.fields.every((f) => refineRenderable(f.value));
    case "i18nFormat":
      return refineRenderable(e.inner);
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
      return false;
  }
}

/** Chain idiomatic native zod methods onto a base inner schema for a
 *  recognised single-field pattern.  Caller picks the base
 *  (`z.string()`, `z.number()`, etc.); we just chain.
 *
 *  The `len-*` arms do NOT use zod's `.min`/`.max`/`.length`: those count
 *  UTF-16 code units, while the `minLength`/`maxLength` this same constraint
 *  publishes into the emitted JSON Schema are code points (see
 *  `_expr/code-point.ts`).  They render an explicit code-point predicate
 *  instead; a caller that also PUBLISHES a schema re-attaches the declaration
 *  from `openapiLengthMeta` so the published bound survives the switch. */
export function chainSingleFieldNative(inner: string, pattern: SingleFieldPattern): string {
  switch (pattern.kind) {
    case "min":
      // Exclusive (`weight > 0.5` on a DECIMAL field) → zod's `.gt`; inclusive
      // keeps `.min` byte-for-byte.  `singleFieldShape` also sets `exclusive`
      // for a strict bound on a MONEY field, but that case cannot reach this
      // chain: `classifyForWire` refuses both money literals and any binary
      // with a money operand (`invariant-classify.ts`), so a money invariant
      // never becomes a wire validator at all.
      return `${inner}.${pattern.exclusive ? "gt" : "min"}(${pattern.n})`;
    case "max":
      return `${inner}.${pattern.exclusive ? "lt" : "max"}(${pattern.n})`;
    case "between":
      return `${inner}.min(${pattern.lo}).max(${pattern.hi})`;
    case "len-min":
      return `${inner}.refine((s) => ${codePointLength("s")} >= ${pattern.n})`;
    case "len-max":
      return `${inner}.refine((s) => ${codePointLength("s")} <= ${pattern.n})`;
    case "len-eq":
      return `${inner}.refine((s) => ${codePointLength("s")} === ${pattern.n})`;
    case "len-range":
      return `${inner}.refine((s) => ${codePointLength("s")} >= ${pattern.lo} && ${codePointLength("s")} <= ${pattern.hi})`;
    case "regex":
      // The pattern is a JavaScript-compatible regex source (validated at parse
      // time via `new RegExp(...)`).  `asRegexLiteral` renders the `/.../` form
      // and falls back to `new RegExp("…")` for the two sources that cannot sit
      // in a literal — an EMPTY pattern (bare `//` is a line comment, which
      // would comment out the rest of the chain) and a dangling-backslash /
      // newline source.  Shared with the domain-layer renderer and Angular's
      // `Validators.pattern`.
      return `${inner}.regex(${asRegexLiteral(pattern.pattern)})`;
  }
}

/** Native-chain patterns first, code-point `len-*` refines LAST.
 *
 *  zod 3 (which `platform: node@v4` and the v1 react stack still pin) types
 *  `.refine()` as a `ZodEffects` WRAPPER that no longer exposes `.regex` /
 *  `.min` / `.max`.  A field carrying both a regex and a length bound —
 *  `invariant email.matches("…") && email.length <= 120`, the very example
 *  `singleFieldConstraints` documents — would then emit
 *  `z.string().refine(…).regex(/…/)`, a type error under that major.  zod 4
 *  keeps the `ZodString` type through `.refine`, so the ordering is a no-op
 *  there; the emitter is shared, so it orders for the stricter of the two. */
export function orderSingleFieldPatterns(
  patterns: readonly SingleFieldPattern[],
): SingleFieldPattern[] {
  const isLen = (p: SingleFieldPattern) => p.kind.startsWith("len-");
  return [...patterns.filter((p) => !isLen(p)), ...patterns.filter(isLen)];
}

/** The JSON-Schema length declaration a field's `len-*` patterns imply, or
 *  null when it has none.  `chainSingleFieldNative` renders the `len-*` CHECK
 *  as a code-point refine, which zod cannot describe — so a caller whose zod
 *  schema is also published as OpenAPI (the Hono routes; NOT the frontend
 *  forms) re-attaches the declaration with `.openapi({...})`.  Merged across
 *  every pattern on the field so `min` and `max` land in ONE metadata call —
 *  two chained `.openapi()`s would not reliably merge. */
export function openapiLengthMeta(
  patterns: readonly SingleFieldPattern[],
): { minLength?: number; maxLength?: number } | null {
  const meta: { minLength?: number; maxLength?: number } = {};
  let any = false;
  for (const p of patterns) {
    switch (p.kind) {
      case "len-min":
        meta.minLength = p.n;
        any = true;
        break;
      case "len-max":
        meta.maxLength = p.n;
        any = true;
        break;
      case "len-eq":
        meta.minLength = p.n;
        meta.maxLength = p.n;
        any = true;
        break;
      case "len-range":
        meta.minLength = p.lo;
        meta.maxLength = p.hi;
        any = true;
        break;
      default:
        break;
    }
  }
  return any ? meta : null;
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
  // Every recognised single-field shape is comparison / `.length` / `matches`
  // — all renderable — but screen anyway so the two gates can never disagree.
  if (!refineRenderable(inv.expr)) return null;
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
  // Local (browser-JS) admission — see the header note.  An invariant this
  // renderer cannot spell keeps its server-side enforcement instead of
  // shipping a broken refine.
  if (!refineRenderable(inv.expr)) return null;
  if (inv.guard && !refineRenderable(inv.guard)) return null;
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
  // The explicit `any` isn't a type-safety regression: zod 4's `.refine<Ch
  // extends (arg: core.output<this>) => …>` constrains its generic FROM the
  // callback, which needs the callback's parameter type BEFORE it can be
  // inferred — a circularity plain contextual typing doesn't resolve under
  // the pinned TypeScript version, so `data` fell back to an IMPLICIT any
  // (TS7006 under `strict`) with no annotation at all. Naming it explicitly
  // restores exactly that same effective type while satisfying `noImplicitAny`.
  return `.refine((data: any) => ${guarded}, ${opts})`;
}

// ---------------------------------------------------------------------------
// Predicate-body renderer — walks ExprIR producing a JS expression
// that runs against a `data` object representing the request body.
// ---------------------------------------------------------------------------

/** The predicate-body renderer.  Exported for the renderability gate in
 *  `test/generator/zod-refine-renderable.test.ts`, which drives it WITHOUT the
 *  `refineRenderable` screen to prove the `UNRENDERABLE` backstop actually
 *  fires; production callers must go through `refineClauseFor`, which screens
 *  first. */
export function renderRefineExpr(e: ExprIR): string {
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
      // Lambda body is optional.  Wire-boundary refines never see block-body
      // lambdas — `classifyForWire` only admits single-expression predicates,
      // and `refineRenderable` re-checks — so the throw is unreachable.
      if (e.body) return `(${escapeTsIdent(e.param)}) => ${renderRefineExpr(e.body)}`;
      return unrenderable("a block-bodied lambda");
    case "object":
      return `({ ${e.fields.map((f) => `${f.name}: ${renderRefineExpr(f.value)}`).join(", ")} })`;
    case "i18nFormat":
      // Transparent i18n wrapper — render the wrapped operand (format dropped).
      return renderRefineExpr(e.inner);
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
      // `classifyForWire` excludes these AND `refineRenderable` re-checks, so
      // reaching the renderer means a bug upstream — fail generation loudly
      // rather than shipping a refine that is wrong.  (An `authz-filter`
      // sentinel is a query-filter node, never a wire-boundary invariant.)
      return unrenderable(`the \`${e.kind}\` expression kind`);
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
      // Same escaping the domain renderer applies — a `let`/lambda name that
      // collides with a JS reserved word (`new`, `class`, `default`, …) is a
      // legal Loom identifier but a syntax error inside the refine body.
      return escapeTsIdent(e.name);
    case "enum-value":
      // Enums on the wire travel as their string form; `.parse`d
      // request bodies have already been narrowed by the enum
      // schema, so the bare value is enough.
      return JSON.stringify(e.name);
    default:
      // current-user / this-derived / helper-fn / resource / unknown — caller
      // filtered these out via `classifyForWire`.
      return unrenderable(`a \`${e.refKind}\` reference`);
  }
}

function renderMember(e: Extract<ExprIR, { kind: "member" }>): string {
  const recv = renderRefineExpr(e.receiver);
  // `lines.count` style — collection length on an array-typed receiver.
  if (e.receiverType.kind === "array" && e.member === "count") {
    return `${recv}.length`;
  }
  // String `.length` is CODE POINTS, not UTF-16 code units — see
  // `codePointLength` below.
  if (
    e.receiverType.kind === "primitive" &&
    e.receiverType.name === "string" &&
    e.member === "length"
  ) {
    return codePointLength(recv);
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
      return `${asRegexLiteral(arg0.value)}.test(${recv})`;
    }
    return `new RegExp(${args[0]}).test(${recv})`;
  }
  // Scalar intrinsics (`trim` / `toUpper` / `substring` / …) go through the
  // SHARED JS table the domain renderer and the four JSX walkers use — the
  // Loom spelling is NOT the JS spelling for several of them (`toUpper` →
  // `.toUpperCase()`, `contains` → `.includes()`, `replace` → `.replaceAll()`,
  // `substring(start, len)` → `.slice(start, start + len)`), so pasting
  // `.${member}(...)` verbatim was either a TS2339 or silently wrong.
  if (e.receiverType.kind === "primitive") {
    const intrinsic = JS_INTRINSIC_RENDERERS[intrinsicKey(e.receiverType.name, e.member)];
    if (intrinsic) return intrinsic(recv, args);
  }
  return unrenderable(`the scalar method \`${e.member}\``);
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
      // `map` / `sortBy` / `distinct` / `take` / `skip` / `join` / `min` /
      // `max` / `avg` — not JS array methods (or not with these semantics).
      // `refineRenderable` keeps them out; the throw is the backstop.
      return unrenderable(`the collection op \`${name}\``);
  }
}

function renderBinary(op: BinOp, left: ExprIR, right: ExprIR): string {
  const opPrint = op === "==" ? "===" : op === "!=" ? "!==" : op;
  return `${renderRefineExpr(left)} ${opPrint} ${renderRefineExpr(right)}`;
}

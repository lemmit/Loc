// F# expression rendering for the Feliz frontend target.
//
// Two consumers share ONE set of leaf formatters (`FS_LEAVES`):
//   1. The view path — `felizTarget`'s expr-leaf seam methods delegate here
//      (walker-core resolves refs/state/hooks and hands already-rendered
//      children to the leaf).
//   2. The MVU `update` path — `renderFsExpr` (below) owns its own dispatch +
//      ref resolution (state → `model.<Field>`) and delegates syntax to the
//      SAME leaves, so the two paths can never diverge on operator/literal/
//      list/lambda spelling.
//
// The leaf formatters are pure string→string: they receive already-rendered
// sub-expressions, exactly like the backend `ExprTarget` leaves in
// src/generator/_expr/target.ts.  This is the frontend's F# leaf table; the
// JS leaf table (React/Vue/Svelte/Angular) stays inline in walker-core until
// the seam extraction (slice 4) converts it.

import type { BinOp, ExprIR, LiteralKind, PrimitiveName } from "../../ir/types/loom-ir.js";
import { upperFirst } from "../../util/naming.js";

/** F# spelling of a Loom binary operator. */
function fsBinOp(op: BinOp): string {
  switch (op) {
    case "==":
      return "=";
    case "!=":
      return "<>";
    default:
      return op; // + - * / % < <= > >= && || are spelled identically in F#
  }
}

/** F# string literal — double-quoted with the F#-significant escapes. */
export function fsString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\t/g, "\\t")}"`;
}

/** Pure F# leaf formatters — one per divergent expression arm.  Sub-expressions
 *  arrive already rendered.  Signatures match the optional `WalkerTarget`
 *  expr-leaf seam so `felizTarget` can forward straight to these. */
export const FS_LEAVES = {
  literal(lit: LiteralKind, value: string): string {
    if (lit === "string") return fsString(value);
    if (lit === "bool") return value; // true/false spelled the same
    if (lit === "null") return "None"; // F# absence is the option None
    // int / long / decimal / money / now → numeric literal verbatim
    return value;
  },
  binary(left: string, right: string, op: BinOp): string {
    return `(${left} ${fsBinOp(op)} ${right})`;
  },
  unary(op: "-" | "!", operand: string): string {
    return op === "!" ? `(not ${operand})` : `(-${operand})`;
  },
  ternary(cond: string, then: string, otherwise: string): string {
    return `(if ${cond} then ${then} else ${otherwise})`;
  },
  convert(value: string, target: PrimitiveName, from: PrimitiveName | undefined): string {
    void from;
    if (target === "string") return `(string ${value})`;
    if (target === "long" || target === "int") return `(int ${value})`;
    if (target === "decimal" || target === "money") return `(decimal ${value})`;
    return value;
  },
  list(elements: string[]): string {
    return `[ ${elements.join("; ")} ]`;
  },
  object(fields: { name: string; value: string }[]): string {
    // F# anonymous record — the closest analogue of a JS object literal.
    return `{| ${fields.map((f) => `${f.name} = ${f.value}`).join("; ")} |}`;
  },
  lambda(param: string, body: string | undefined): string {
    return `(fun ${param} -> ${body ?? "()"})`;
  },
};

/** Resolution context for the standalone update-path renderer. */
export interface FsExprCtx {
  /** State field names — a ref resolves to `model.<Pascal(name)>`. */
  stateNames: ReadonlySet<string>;
  /** Lambda / action param names in scope — a ref resolves to the bare name. */
  locals: ReadonlySet<string>;
  /** When rendering a STORE action body, the store's own fields bind as `let`
   *  locals at lowering (`count := 0` → a bare `count`), so a bare ref to one
   *  resolves to the namespaced Model field `model.<Store><Field>` (stores
   *  compose into the single Elmish Model).  Absent for page/component bodies. */
  storeScope?: { store: string; fields: ReadonlySet<string> };
}

/** The single-program Elmish Model field a store field folds into
 *  (`Cart` + `count` → `CartCount`).  Stores share the one `Model`; flat
 *  namespacing avoids a nested-record type and collisions with page state. */
export function storeModelField(store: string, field: string): string {
  return `${upperFirst(store)}${upperFirst(field)}`;
}

/** The Elmish `Msg` case a store action folds into (`Cart` + `clear` →
 *  `CartClear`). */
export function storeMsgCase(store: string, action: string): string {
  return `${upperFirst(store)}${upperFirst(action)}`;
}

/** Render a method-call to idiomatic F# for the update/action path.  Frontend
 *  page logic reaches a small, well-defined set — collection membership on the
 *  F# `list` (`List.contains`/`List.isEmpty`) and .NET-string ops that Fable
 *  maps natively (`.ToUpper()`/`.Contains(..)`/…).  An unrecognised method fails
 *  fast (mirrors the backends' bounded-intrinsic + error design) rather than
 *  emitting a `.member(args)` call that would not compile under Fable. */
function renderFsMethodCall(
  e: Extract<ExprIR, { kind: "method-call" }>,
  recv: string,
  args: string[],
): string {
  const a0 = args[0] ?? "";
  if (e.isCollectionOp || e.receiverType.kind === "array") {
    switch (e.member) {
      case "contains":
        return `(List.contains ${a0} ${recv})`;
      case "isEmpty":
        return `(List.isEmpty ${recv})`;
      case "count":
        return `(List.length ${recv})`;
    }
  }
  // String receiver (or generic scalar) → .NET string members Fable supports.
  switch (e.member) {
    case "toUpper":
      return `(${recv}.ToUpper())`;
    case "toLower":
      return `(${recv}.ToLower())`;
    case "trim":
      return `(${recv}.Trim())`;
    case "contains":
      return `(${recv}.Contains(${a0}))`;
    case "startsWith":
      return `(${recv}.StartsWith(${a0}))`;
    case "endsWith":
      return `(${recv}.EndsWith(${a0}))`;
    case "length":
      return `(${recv}.Length)`;
  }
  throw new Error(
    `feliz: method '${e.member}' is not implemented on the F# action/update path — ` +
      `the Feliz frontend renders a bounded set of collection/string methods here. ` +
      `Add a '${e.member}' arm in fs-expr.ts (renderFsMethodCall) if it is needed.`,
  );
}

/** Render an `ExprIR` to F# for a NON-view position (the MVU `update` arm
 *  bodies).  Resolves refs itself; delegates syntax to `FS_LEAVES`.  Covers
 *  scalar/collection state writes, `let` bindings, predicate `match`, single-
 *  expression lambdas, and a bounded collection/string method set. */
export function renderFsExpr(e: ExprIR, ctx: FsExprCtx): string {
  const r = (x: ExprIR): string => renderFsExpr(x, ctx);
  switch (e.kind) {
    case "literal":
      return FS_LEAVES.literal(e.lit, e.value);
    case "ref":
      // A dotted `<Store>.<field>` read (page/component body) — resolved to the
      // namespaced Model field regardless of scope.
      if (e.refKind === "store-field" && e.storeName) {
        return `model.${storeModelField(e.storeName, e.name)}`;
      }
      // Inside a store action body the store's own fields are `let` locals; a
      // bare ref to one resolves to its namespaced Model field.
      if (ctx.storeScope?.fields.has(e.name)) {
        return `model.${storeModelField(ctx.storeScope.store, e.name)}`;
      }
      if (ctx.locals.has(e.name)) return e.name;
      if (ctx.stateNames.has(e.name)) return `model.${upperFirst(e.name)}`;
      return e.name;
    case "binary":
      return FS_LEAVES.binary(r(e.left), r(e.right), e.op);
    case "unary":
      return FS_LEAVES.unary(e.op, r(e.operand));
    case "ternary":
      return FS_LEAVES.ternary(r(e.cond), r(e.then), r(e.otherwise));
    case "convert":
      return FS_LEAVES.convert(r(e.value), e.target, e.from);
    case "list":
      return FS_LEAVES.list(e.elements.map(r));
    case "object":
      return FS_LEAVES.object(e.fields.map((f) => ({ name: f.name, value: r(f.value) })));
    case "member":
      // Record-field access — the receiver is a wire record (an async-effect
      // success binding `p`, a read row) whose F# fields keep the EXACT lowercase
      // wire-shape names (`type Project = { name: string }`).  Render the field
      // VERBATIM — the shared view walker does the same (walker-core `p.name`), so
      // the MVU update path and the view path land on the same field with no
      // casing seam.  (`upperFirst` here was a latent bug — no member access
      // reached this arm until the async-effect renderer landed.)
      return `${r(e.receiver)}.${e.member}`;
    case "call":
      return `${e.name}(${e.args.map(r).join(", ")})`;
    case "method-call":
      return renderFsMethodCall(e, r(e.receiver), e.args.map(r));
    case "match": {
      // Predicate-arm form only (`match { cond => value }`) — an F#
      // `if/elif/else` chain.  A value-position match needs a total `else`;
      // the variant-discriminating form (`match subject { … }`) belongs to the
      // union/async subsystem and is gated at validation, not reached here.
      if (e.subject) {
        throw new Error(
          "feliz: variant-match expression in an F# action body is not rendered here — " +
            "it is gated at validation (loom.feliz-async-effect-unsupported).",
        );
      }
      if (e.otherwise === undefined) {
        throw new Error(
          "feliz: a `match` in a value position needs an `otherwise` arm to render a total " +
            "F# if/elif/else expression.",
        );
      }
      const chain = e.arms.map(
        (a, i) => `${i === 0 ? "if" : "elif"} ${r(a.cond)} then ${r(a.value)}`,
      );
      return chain.length === 0
        ? `(${r(e.otherwise)})`
        : `(${chain.join(" ")} else ${r(e.otherwise)})`;
    }
    case "lambda":
      // Single-expression form (`x => expr`) → the shared F# lambda leaf.  A
      // block-body lambda (`x => { … }`) carries statements, not a value, and
      // has no update-arm rendering — fail fast.
      if (e.block) {
        throw new Error(
          "feliz: block-body lambda (`x => { … }`) is not rendered in an F# action body.",
        );
      }
      return FS_LEAVES.lambda(e.param, e.body ? r(e.body) : undefined);
    case "paren":
      return `(${r(e.inner)})`;
    default:
      // Fail fast rather than silently substituting `(* unsupported *) ()`.
      // The remaining kinds are backend-only or subsystem-gated in a frontend
      // value position: `this`/`id` (domain-body receivers), `action-ref` (a
      // handler reference, bound by the view walker, never a value here), and
      // `new` (part/VO construction — a domain concern).  Unreachable on valid
      // frontend `.ddd`; a defensive fail-fast, not a silent drop.
      throw new Error(
        `feliz: unsupported expression '${e.kind}' in an F# action/update body — ` +
          `it has no meaning in a frontend value position. Rework the ` +
          `expression, or implement the '${e.kind}' arm in fs-expr.ts.`,
      );
  }
}

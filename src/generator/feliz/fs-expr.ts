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
}

/** Render an `ExprIR` to F# for a NON-view position (the MVU `update` arm
 *  bodies).  Resolves refs itself; delegates syntax to `FS_LEAVES`.  Covers the
 *  arm set an action body reaches today (`:=`/`+=` values, `let` bindings). */
export function renderFsExpr(e: ExprIR, ctx: FsExprCtx): string {
  const r = (x: ExprIR): string => renderFsExpr(x, ctx);
  switch (e.kind) {
    case "literal":
      return FS_LEAVES.literal(e.lit, e.value);
    case "ref":
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
      return `${r(e.receiver)}.${upperFirst(e.member)}`;
    case "call":
      return `${e.name}(${e.args.map(r).join(", ")})`;
    case "paren":
      return `(${r(e.inner)})`;
    default:
      // Fail fast rather than silently substituting `(* unsupported *) ()`
      // (unit), which compiles but drops the expression's value on the floor —
      // a silent, wrong-but-compiling F# output.  The Feliz expr path renders
      // literal/ref/binary/unary/ternary/convert/list/object/member/call/paren;
      // every other kind (`this`/`id`/`method-call`/`action-ref`/`lambda`/
      // `new`/`match`) is genuinely not implemented on the F# update/expr path.
      // Tracked in docs/new-plan/T6-backend-parity.md M-T6.15.
      throw new Error(
        `feliz: unsupported expression '${e.kind}' in an F# action/update body — ` +
          `the Feliz frontend does not render it here yet (M-T6.15). Rework the ` +
          `expression, or implement the '${e.kind}' arm in fs-expr.ts.`,
      );
  }
}

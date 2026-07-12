// Shared JavaScript expression-leaf table for the JSX-family frontends
// (React / Vue / Svelte / Angular).  Every one of those frontends embeds
// JavaScript in its markup, so the pure-syntax `ExprIR` arms (operators,
// literals, list/object spelling, the `convert` cast) render identically —
// they were a single hardcoded block inside `emitExpr` until Feliz (the first
// non-JS-embedding frontend) forced the `WalkerTarget` expr-leaf seam.
//
// This is the JS half of that seam: the four JS targets spread it in, Feliz
// supplies `FS_LEAVES` (F#).  `emitExpr` now delegates every divergent arm to
// the target with NO fallback — one dispatcher, one leaf table per embedded
// language, mirroring the backend `_expr/target.ts` design.  The strings below
// are byte-for-byte what `emitExpr` produced inline before the extraction.

import type { BinOp, LiteralKind, PrimitiveName } from "../../ir/types/loom-ir.js";
import type { WalkerTarget } from "./target.js";

/** The seven expression-leaf methods every `WalkerTarget` supplies. */
type ExprLeaves = Pick<
  WalkerTarget,
  | "exprLiteral"
  | "exprBinary"
  | "exprUnary"
  | "exprTernary"
  | "exprConvert"
  | "exprList"
  | "exprObject"
>;

/** The JS leaf formatters — pure string→string, sub-expressions pre-rendered. */
export const jsExprLeaves: ExprLeaves = {
  exprLiteral(lit: LiteralKind, value: string): string {
    if (lit === "string") return JSON.stringify(value);
    if (lit === "bool") return value;
    if (lit === "null") return "null";
    // int / decimal / now → emit as numeric literal verbatim.
    return String(value);
  },
  exprBinary(left: string, right: string, op: BinOp | string): string {
    // Strict equality on the wire — mirrors the backend renderer and keeps
    // emitted TSX clean under Biome's `noDoubleEquals`.
    const o = op === "==" ? "===" : op === "!=" ? "!==" : op;
    return `(${left} ${o} ${right})`;
  },
  exprUnary(op: string, operand: string): string {
    return `(${op}${operand})`;
  },
  exprTernary(cond: string, then: string, otherwise: string): string {
    return `(${cond} ? ${then} : ${otherwise})`;
  },
  exprConvert(
    value: string,
    target: PrimitiveName | string,
    from: PrimitiveName | string | undefined,
  ): string {
    // Mirrors `generator/typescript/render-expr.ts`'s renderTsConvert.
    if (target === "string") {
      if (from === "money") return `${value}.toString()`;
      return `String(${value})`;
    }
    if (target === "long" || target === "decimal") {
      if (from === "money") return `${value}.toNumber()`;
      return value;
    }
    if (target === "money") {
      if (from === "money") return value;
      return `new Decimal(${value})`;
    }
    return value;
  },
  exprList(elements: string[]): string {
    return `[${elements.join(", ")}]`;
  },
  exprObject(fields: ReadonlyArray<{ name: string; value: string }>): string {
    return `{ ${fields.map((f) => `${f.name}: ${f.value}`).join(", ")} }`;
  },
};

/** Fail-loud expression leaves for a target that FORKS `emitExpr` (HEEx runs a
 *  parallel walker and never reaches the shared dispatcher).  Satisfies the
 *  required interface while asserting the fork invariant: if one is ever
 *  called, the fork regressed and the output would be wrong — throw instead. */
const unreachedExprLeaf = (name: string) => (): never => {
  throw new Error(
    `${name}: this target forks emitExpr (parallel walker) and must never reach the shared expression dispatcher`,
  );
};
export const unreachableExprLeaves: ExprLeaves = {
  exprLiteral: unreachedExprLeaf("exprLiteral"),
  exprBinary: unreachedExprLeaf("exprBinary"),
  exprUnary: unreachedExprLeaf("exprUnary"),
  exprTernary: unreachedExprLeaf("exprTernary"),
  exprConvert: unreachedExprLeaf("exprConvert"),
  exprList: unreachedExprLeaf("exprList"),
  exprObject: unreachedExprLeaf("exprObject"),
};

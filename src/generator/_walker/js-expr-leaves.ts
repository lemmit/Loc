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

import type { BinOp, ExprIR, LiteralKind, PrimitiveName } from "../../ir/types/loom-ir.js";
import { JS_COLLECTION_RENDERERS } from "../_expr/js-collection-ops.js";
import { renderJsIntrinsic } from "../_expr/js-intrinsics.js";
import type { WalkerTarget } from "./target.js";

/** The seven expression-leaf methods every `WalkerTarget` supplies, plus the
 *  optional scalar-intrinsic and collection-op seams — the JS family shares
 *  the TypeScript backend's snippet tables, since it emits the same language. */
type ExprLeaves = Pick<
  WalkerTarget,
  | "exprLiteral"
  | "exprBinary"
  | "exprUnary"
  | "exprTernary"
  | "exprConvert"
  | "exprList"
  | "exprObject"
  | "renderIntrinsic"
  | "renderCollectionOp"
>;

/** Collection ops the FRONTEND walkers render.  A strict subset of the
 *  `JS_COLLECTION_RENDERERS` table, and the reason is not JavaScript — the
 *  table's JS arms are all correct — but the OTHER frontends, since
 *  `loom.frontend-collection-op-unsupported` is target-agnostic: an op is
 *  ungated only where every frontend renders it right.  The eight excluded
 *  here are excluded for two reasons, both about representation rather than
 *  effort:
 *
 *    • `sum` / `min` / `max` / `avg` fold ARITHMETIC over the projected
 *      values, and `money` is a decimal.js `Decimal` on this surface but a
 *      native `decimal` on Feliz and a `double` on Flutter — one table cannot
 *      be right on all three without per-target money work.
 *    • `first` / `firstOrNull` / `distinct` / `contains` diverge on
 *      PARTIALITY and EQUALITY: `first` yields `undefined` here but THROWS on
 *      F# `List.head` / Dart `.first`; `firstOrNull` is `T | null` here and
 *      `'T option` on F#; and Flutter's wire models declare no
 *      `operator ==`, so `toSet()` / `.contains` there are identity-based and
 *      would silently return duplicates and `false` for a value-object
 *      element — the exact defect this table's own `receiverElementEqMethod`
 *      exists to prevent on the JS side.
 *
 *  Each is still refused by the gate, with the remainder named in the
 *  `unsupported-register.ts` row.  Declining them HERE as well keeps this
 *  list the single readable statement of what the frontends render — and, if
 *  the gate ever regressed, keeps the failure a declined seam rather than a
 *  verbatim emit. */
const FRONTEND_RENDERED_OPS: ReadonlySet<string> = new Set([
  "count",
  "where",
  "any",
  "all",
  "map",
  "sortBy",
  "take",
  "skip",
  "join",
]);

/** The JS leaf formatters — pure string→string, sub-expressions pre-rendered. */
export const jsExprLeaves: ExprLeaves = {
  exprLiteral(lit: LiteralKind, value: string): string {
    if (lit === "string") return JSON.stringify(value);
    if (lit === "bool") return value;
    if (lit === "null") return "null";
    // `money` is a decimal.js `Decimal` on this surface, NOT a number — the
    // same representation the TS backend uses (`typescript/render-expr.ts`'s
    // `renderLiteral`), and the one `exprConvert` below already assumes when it
    // emits `new Decimal(…)` for a cast to money.  This leaf had diverged and
    // emitted the bare numeric literal, so a money `state {}` field seeded with
    // `money("12.50")` produced `ref(12.50)` / `$state<Decimal>(12.50)` — a
    // type error on Vue and Svelte.  (React never reaches here: its state-init
    // path renders the money literal itself, which is why the divergence hid.)
    // Quoted, so the decimal string is parsed exactly rather than round-tripped
    // through a float.
    if (lit === "money") return `new Decimal(${JSON.stringify(value)})`;
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
  // The JS frontends and the Hono/TypeScript backend emit the SAME language,
  // so they share ONE intrinsic snippet table — that shared table is what makes
  // `s.replace(a, b)` mean replace-ALL in a page body exactly as it does in an
  // aggregate `derived`.  See `_expr/js-intrinsics.ts`.
  renderIntrinsic: renderJsIntrinsic,
  // …and ONE collection-op table, for the same reason: `orders.where(o =>
  // o.open).count` means what it means in an aggregate `derived`, money and
  // value-object equality special-cases included.  See
  // `_expr/js-collection-ops.ts`.
  renderCollectionOp: renderJsCollectionOp,
};

/** Render a collection op to JavaScript, or `undefined` when the frontends
 *  don't render this op (see `FRONTEND_RENDERED_OPS`).  The receiver is
 *  parenthesised exactly as the TypeScript backend parenthesises it before
 *  calling the same table, so a page body and a `derived` produce the same
 *  string for the same node. */
export function renderJsCollectionOp(spec: {
  op: string;
  recv: string;
  args: readonly string[];
  call?: Extract<ExprIR, { kind: "method-call" }>;
}): string | undefined {
  if (!FRONTEND_RENDERED_OPS.has(spec.op)) return undefined;
  const render = JS_COLLECTION_RENDERERS[spec.op];
  return render?.(`(${spec.recv})`, [...spec.args], spec.call);
}

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
  // HEEx forks the dispatcher entirely; it renders intrinsics and collection
  // ops in its own engine, so it never consults either seam.
  renderIntrinsic: undefined,
  renderCollectionOp: undefined,
  exprLiteral: unreachedExprLeaf("exprLiteral"),
  exprBinary: unreachedExprLeaf("exprBinary"),
  exprUnary: unreachedExprLeaf("exprUnary"),
  exprTernary: unreachedExprLeaf("exprTernary"),
  exprConvert: unreachedExprLeaf("exprConvert"),
  exprList: unreachedExprLeaf("exprList"),
  exprObject: unreachedExprLeaf("exprObject"),
};

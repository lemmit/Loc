// ---------------------------------------------------------------------------
// Origin capture helper — bridges the macro-origin token (phase ②, dropped
// by lowering today) and `$cstNode` source spans into the shared `OriginRef`
// chain (`src/ir/types/origin.ts`) consumed by phase ⑤ lowering.
//
// The token contract (`OriginToken` / `originOf`) lives at the language/AST
// layer (`src/language/macro-origin.ts`), not under `src/macros/` — so this
// stays an `ir/` → `language/` import, same as every other lowering module,
// with no `ir/` → `macros/` edge.  See
// docs/old/plans/source-map-debug-kickoff.md §3-4.
// ---------------------------------------------------------------------------

import type { AstNode } from "langium";
import { AstUtils } from "langium";
import { type OriginToken, originOf } from "../../language/macro-origin.js";
import type { OriginRef, SourceRef } from "../types/origin.js";

/** Build a `SourceRef` from an AST node's `$cstNode`, if it has one.
 *  Wrapped defensively: a detached / synthetic node can throw out of
 *  `AstUtils.getDocument`, and lowering must never crash on that. */
function sourceRefFor(node: AstNode): SourceRef | undefined {
  const cst = node.$cstNode;
  if (!cst) return undefined;
  try {
    const path = AstUtils.getDocument(node).uri.path;
    return {
      kind: "source",
      path,
      span: { start: cst.offset, end: cst.offset + cst.length },
    };
  } catch {
    return undefined;
  }
}

function macroOriginFor(token: OriginToken): OriginRef {
  const call = sourceRefFor(token.callNode);
  if (call) return { kind: "macro", macro: token.macroName, call };
  return { kind: "derived", reason: `macro:${token.macroName}` };
}

/** Capture the origin of a lowered IR node's originating AST node.
 *
 *  - `undefined` node → `undefined`.
 *  - A macro-synthesized node (tagged via `$origin` by the expander, found
 *    by walking the `$container` chain) → a `MacroRef` pointing at the
 *    `with <macro>(...)` call site, or a bare `DerivedRef` when the call
 *    site itself has no CST (e.g. a nested macro invocation).
 *  - Otherwise, a real `.ddd` node with a `$cstNode` → a `SourceRef`.
 *  - Otherwise → `undefined`. */
export function originFor(node: AstNode | undefined): OriginRef | undefined {
  if (!node) return undefined;
  const macroToken = originOf(node);
  if (macroToken) return macroOriginFor(macroToken);
  return sourceRefFor(node);
}

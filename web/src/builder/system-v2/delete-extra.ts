// Construct / invariant deletion for the v2 canvas, keyed the same way the
// rename siblings are (`rename-extra.ts` by AST `$type`, `renameMember` by
// owner + name).  Both were inline in `SystemBuilderV2Pane` and carried two
// bugs the pane can't express safely:
//
//   1. They located the node in the pane's *memoised* parse but spliced into
//      `ctx.getSource()` — two different strings whenever the source moved
//      under the 350 ms debounce, so the CST offsets addressed the wrong text.
//   2. The splice committed unvalidated: deleting a member can leave a source
//      the parser rejects, and the builders then refuse to open their own
//      output.  (`docs/audits/playground-file-mgmt-review-2026-07.md` #12.)
//
// Both take `source` and re-parse it themselves, so the node they address and
// the text they edit are the same snapshot, and both return null rather than
// commit a non-parsing result.

import { AstUtils } from "langium";
import type { Aggregate } from "../../../../src/language/generated/ast.js";
import { spliceNodeIfParses } from "../edit-engine";
import { parseDdd } from "../parse";

/**
 * Delete the construct of `astType` named `name`.  Returns the new source, or
 * null when there's no such construct or the deletion wouldn't parse.
 */
export function deleteByAstType(source: string, astType: string, name: string): string | null {
  for (const node of AstUtils.streamAst(parseDdd(source).ast)) {
    if (node.$type === astType && (node as { name?: string }).name === name) {
      return spliceNodeIfParses(source, node, "");
    }
  }
  return null;
}

/**
 * Delete the `index`-th `invariant` of aggregate `aggName`.  Invariants are
 * unnamed, so the view-graph keys them positionally and so does this.
 */
export function deleteInvariant(source: string, aggName: string, index: number): string | null {
  const parsed = parseDdd(source);
  let agg: Aggregate | undefined;
  for (const node of AstUtils.streamAst(parsed.ast)) {
    if (node.$type === "Aggregate" && (node as Aggregate).name === aggName) {
      agg = node as Aggregate;
      break;
    }
  }
  if (!agg) return null;
  let i = 0;
  for (const member of agg.members) {
    if (member.$type !== "Invariant") continue;
    if (i === index) return spliceNodeIfParses(source, member, "");
    i++;
  }
  return null;
}

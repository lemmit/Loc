import { CstUtils, type AstNode } from "langium";

// ---------------------------------------------------------------------------
// CST/text edit engine for the visual Builders.
//
// The `.ddd` text stays the source of truth.  Builders never reprint a whole
// file; they regenerate just the construct the user changed (via the
// `src/language/print` printer) and splice it over that node's CST range, so
// everything outside — comments, blank lines, hand-spacing — is byte-preserved.
// ---------------------------------------------------------------------------

export interface TextEdit {
  /** Inclusive start offset into the source string. */
  offset: number;
  /** Exclusive end offset. */
  end: number;
  newText: string;
}

// Apply edits to a source string.  Edits are applied last-to-first so an
// earlier edit's length change can't invalidate a later edit's offsets;
// callers must ensure edits don't overlap.
export function applyEdits(source: string, edits: readonly TextEdit[]): string {
  const ordered = [...edits].sort((a, b) => b.offset - a.offset);
  let out = source;
  for (const e of ordered) out = out.slice(0, e.offset) + e.newText + out.slice(e.end);
  return out;
}

export interface NodeRangeOptions {
  /** Extend the start to swallow the node's leading `//`/`/* *\/` comment. */
  includeLeadingComment?: boolean;
}

// The source span an edit to `node` should target.  Returns null for a node
// with no CST (e.g. one constructed in memory, not parsed).
export function nodeEditRange(
  node: AstNode,
  options: NodeRangeOptions = {},
): { offset: number; end: number } | null {
  const cst = node.$cstNode;
  if (!cst) return null;
  let offset = cst.offset;
  if (options.includeLeadingComment) {
    const comment = CstUtils.findCommentNode(cst, ["ML_COMMENT", "SL_COMMENT"]);
    if (comment && comment.offset < offset) offset = comment.offset;
  }
  return { offset, end: cst.end };
}

export interface DiffHunk {
  /** 0-based line index where the change begins (after the common prefix). */
  atLine: number;
  /** Lines removed (present in `before`, gone in `after`). */
  removed: string[];
  /** Lines added (present in `after`, new vs `before`). */
  added: string[];
}

// Line-level diff of two source strings as a single contiguous hunk. Builder
// edits are localised CST splices, so trimming the common leading + trailing
// lines yields a tight, accurate before→after hunk (no full LCS needed). An
// empty hunk (`removed` and `added` both empty) means the strings are equal.
export function lineDiff(before: string, after: string): DiffHunk {
  const b = before.split("\n");
  const a = after.split("\n");
  let p = 0;
  while (p < b.length && p < a.length && b[p] === a[p]) p++;
  let s = 0;
  while (s < b.length - p && s < a.length - p && b[b.length - 1 - s] === a[a.length - 1 - s]) s++;
  return { atLine: p, removed: b.slice(p, b.length - s), added: a.slice(p, a.length - s) };
}

// Replace the source text of `node` with `newText` (regenerate-and-splice).
// `node` must come from parsing `source`.
export function spliceNode(
  source: string,
  node: AstNode,
  newText: string,
  options?: NodeRangeOptions,
): string {
  const range = nodeEditRange(node, options);
  if (!range) throw new Error("spliceNode: node has no CST range (not parsed from this source?)");
  return applyEdits(source, [{ ...range, newText }]);
}

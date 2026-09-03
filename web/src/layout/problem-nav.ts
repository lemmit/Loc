// Pure half of `F8` / `Shift+F8` (M-T8.18): the problems in document order
// and the index the cursor steps to.  React-free so
// `test/playground/problems-fix.test.ts` can pin the wrap-around.

import type { EditorRange } from "../editor/editor-handle";
import type { Diagnostic } from "../lsp/protocol";

/** Diagnostics sorted by position — the order F8 walks and the Problems
 *  list renders.  Stable for equal positions. */
export function inDocumentOrder(items: readonly Diagnostic[]): Diagnostic[] {
  return [...items].sort(
    (a, b) =>
      a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character,
  );
}

/** The next index in `[0, count)` after stepping `dir` from `current`
 *  (`-1` = no cursor yet), wrapping at both ends; `-1` when there is nothing
 *  to step to. */
export function stepIndex(current: number, count: number, dir: 1 | -1): number {
  if (count <= 0) return -1;
  if (current < 0) return dir === 1 ? 0 : count - 1;
  return (current + dir + count) % count;
}

/** The LSP range (0-based) as the editor's 1-based range.  A zero-width
 *  diagnostic (the build worker reports a point) still selects one
 *  column so the reveal has something to land on. */
export function toEditorRange(d: Diagnostic): EditorRange {
  const start = { line: d.range.start.line + 1, col: d.range.start.character + 1 };
  const end = { line: d.range.end.line + 1, col: d.range.end.character + 1 };
  const zeroWidth = start.line === end.line && start.col === end.col;
  return {
    startLineNumber: start.line,
    startColumn: start.col,
    endLineNumber: end.line,
    endColumn: zeroWidth ? end.col + 1 : end.col,
  };
}

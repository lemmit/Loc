// Pure text-edit application for the editors that have no model of their own
// (the mobile `PlainEditor`) — the Problems panel's Fix action hands both
// editors the same Monaco-shaped edits (1-based, end-exclusive ranges);
// Monaco applies them through `pushEditOperations`, the textarea through
// this.  React-free so `test/playground/hotkeys.test.ts`'s sibling can pin
// the offset arithmetic without a DOM.

import type { EditorRange, EditorTextEdit } from "./editor-handle";

/** Offset of a 1-based (line, column) in `text`.  A line past the end clamps
 *  to the text length; a column past the line's end clamps to the line's end. */
export function offsetAt(text: string, lineNumber: number, column: number): number {
  let offset = 0;
  let line = 1;
  while (line < lineNumber) {
    const nl = text.indexOf("\n", offset);
    if (nl < 0) return text.length;
    offset = nl + 1;
    line++;
  }
  const lineEnd = text.indexOf("\n", offset);
  const end = lineEnd < 0 ? text.length : lineEnd;
  return Math.min(offset + Math.max(0, column - 1), end);
}

/** Apply `edits` to `text`.  Edits are applied last-to-first by start offset
 *  so earlier offsets stay valid — the same convention Monaco uses for a batch
 *  of `IIdentifiedSingleEditOperation`s against the pre-edit document. */
export function applyTextEdits(text: string, edits: readonly EditorTextEdit[]): string {
  const resolved = edits
    .map((e) => ({
      start: offsetAt(text, e.range.startLineNumber, e.range.startColumn),
      end: offsetAt(text, e.range.endLineNumber, e.range.endColumn),
      text: e.text,
    }))
    .sort((a, b) => b.start - a.start || b.end - a.end);
  let out = text;
  for (const e of resolved) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

/** Selection offsets for `range` in `text` — what a textarea's
 *  `setSelectionRange` wants when revealing a diagnostic. */
export function selectionFor(text: string, range: EditorRange): { start: number; end: number } {
  const start = offsetAt(text, range.startLineNumber, range.startColumn);
  const end = Math.max(start, offsetAt(text, range.endLineNumber, range.endColumn));
  return { start, end };
}

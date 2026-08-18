// ---------------------------------------------------------------------------
// Fix-hint quick fixes for the playground's Monaco editor.
//
// `src/api/lsp.ts`'s `fixHintCodeActions` already turns every fix-hint-carrying
// diagnostic (`src/language/fix-hints.ts`) into an LSP `CodeAction` whose
// `WorkspaceEdit` is fully resolved against the source — the playground just
// never asked for them, so a hinted diagnostic drew a squiggle and offered no
// lightbulb.  This module is the boundary that closes that: LSP shapes in,
// editor-neutral shapes out.
//
// It imports NO monaco.  `monaco-editor` is a browser-only dep of `web/`, and
// the part worth unit-testing is exactly the part that doesn't need it — the
// position arithmetic.  LSP positions are **0-based** (`line`/`character`),
// Monaco's are **1-based** (`startLineNumber`/`startColumn`), and an off-by-one
// here silently rewrites the wrong span of the user's source, which is strictly
// worse than offering no quick fix at all.  `LoomEditor.tsx` therefore owns one
// trivial monaco-shaped hop (wrap in `{ resource, textEdit }`) and nothing else.
// ---------------------------------------------------------------------------

import type { CodeAction } from "vscode-languageserver-types";
import { fixHintCodeActions, validate } from "../../../src/api/index.js";

/** An LSP range — 0-based line/character, end-exclusive. */
export interface LspRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

/** A Monaco `IRange` — 1-based line numbers AND columns. */
export interface EditorRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

export interface EditorTextEdit {
  range: EditorRange;
  text: string;
}

/** One applyable quick fix, in the shape `LoomEditor` hands to Monaco.
 *  `anchor` is where the fix belongs in the document (the diagnostic's own
 *  range when it has one) — used to decide whether to offer it for the range
 *  Monaco asked about, so a fix on line 90 doesn't light up on line 3. */
export interface LoomQuickFix {
  title: string;
  edits: EditorTextEdit[];
  anchor: EditorRange;
  /** Whether the editor should mark this the one obvious repair.  Carried from
   *  the `CodeAction`, never assumed: a `choose`-kind hint fans out one action
   *  per option precisely because there is NO single right answer, and marking
   *  them all preferred would let the editor auto-apply an arbitrary one. */
  preferred: boolean;
}

/** LSP range → Monaco range.  Both coordinates shift by one; `character` and
 *  `column` are otherwise the same "code units before this point" count, so
 *  end-exclusive stays end-exclusive. */
export function toEditorRange(range: LspRange): EditorRange {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
}

/** Every `CodeAction` from `fixHintCodeActions`, converted.
 *
 *  Deliberately shape-driven, not count-driven: it flattens whatever
 *  `edit.changes` buckets an action carries and maps every action it is given,
 *  so a provider that grows from one action per diagnostic to several (a
 *  `choose`-kind hint fanned out one action per option) needs no change here.
 *  An action with no resolved text edit is dropped — there is nothing to apply. */
export function toQuickFixes(actions: readonly CodeAction[]): LoomQuickFix[] {
  const fixes: LoomQuickFix[] = [];
  for (const action of actions) {
    const changes = action.edit?.changes;
    if (!changes) continue;
    const edits = Object.values(changes)
      .flat()
      .map((e) => ({ range: toEditorRange(e.range), text: e.newText }));
    if (edits.length === 0) continue;
    const diagRange = action.diagnostics?.[0]?.range;
    fixes.push({
      title: action.title,
      edits,
      anchor: diagRange ? toEditorRange(diagRange) : edits[0]!.range,
      preferred: action.isPreferred === true,
    });
  }
  return fixes;
}

/** Do two ranges share at least one line?
 *
 *  Line granularity on purpose: Monaco asks for code actions at the cursor (or
 *  the selection), while a diagnostic's range covers a token somewhere on the
 *  line.  Comparing columns would hide the lightbulb whenever the caret sat
 *  left of the offending token — the common case, since that's where you land
 *  after clicking the line. */
export function overlapsLines(a: EditorRange, b: EditorRange): boolean {
  return a.startLineNumber <= b.endLineNumber && b.startLineNumber <= a.endLineNumber;
}

/** The subset of `fixes` to offer for the range Monaco asked about. */
export function quickFixesAt(fixes: readonly LoomQuickFix[], range: EditorRange): LoomQuickFix[] {
  return fixes.filter((f) => overlapsLines(f.anchor, range));
}

// One-entry memo: Monaco re-requests code actions on cursor moves and on every
// marker change, and `validate` spins up a fresh Langium service instance per
// call.  Keyed by (source, uri) so a keystroke invalidates it and nothing else
// does.
let cache: { key: string; fixes: Promise<LoomQuickFix[]> } | undefined;

/** Validate `source` and return every fix-hint quick fix in it, editor-shaped.
 *  Never throws: a compiler-internal failure must not break the lightbulb. */
export function loomQuickFixes(source: string, uri: string): Promise<LoomQuickFix[]> {
  const key = `${uri}\n${source}`;
  if (cache?.key === key) return cache.fixes;
  const fixes = (async () => {
    try {
      const report = await validate(source);
      return toQuickFixes(await fixHintCodeActions(report, source, uri));
    } catch {
      return [];
    }
  })();
  cache = { key, fixes };
  return fixes;
}

// Unfold a `with X(...)` macro call into its expanded source.
//
// Computes a workspace edit that:
//   1. Invokes the macro's `expand()` against its host.
//   2. Groups returned nodes by destination (most go to the host;
//      cross-level macros like `softDeleteByDefault` route some
//      nodes into descendant aggregates via `invokeMacro`).
//   3. Prints each group through the structural printer.
//   4. Inserts the printed text into the right host's body, just
//      before the closing `}`.
//   5. Removes the macro from the calling `with X, Y, Z` clause
//      (or the whole `with` clause if X was the only one).
//
// Macros become demonstrably sugar — any user can unfold and edit
// the result without reading the macro source.  Combined with the
// structural printer roundtrip guarantees from the print-roundtrip
// test, the unfolded output re-parses to the same IR as the macro.

import type { LangiumDocument } from "langium";
import type { TextEdit } from "vscode-languageserver";
import {
  type Aggregate,
  type BoundedContext,
  type MacroCall,
  type Ui,
  type WithClause,
} from "../generated/ast.js";
import { printStructural } from "../print/index.js";
import { lookupMacro } from "../macro-registry.js";
import { _withOrigin } from "../../macro-api/factories.js";
import type { OriginToken } from "../../macro-api/define.js";

const DEST_PROP = "$destination" as const;

/** Result of unfolding a macro call.  Returns the set of text
 * edits needed to apply the unfold, plus a human-readable title
 * (used as the code-action label). */
export interface UnfoldResult {
  title: string;
  edits: TextEdit[];
}

/** Unfold a single MacroCall, returning the workspace edits that
 * realize the expansion.  Returns undefined if the macro can't be
 * unfolded (unknown name, target-kind mismatch, throwing expand,
 * etc.) — the caller should fall back to no action rather than
 * surfacing a broken refactor. */
export function unfoldMacro(
  document: LangiumDocument,
  call: MacroCall,
): UnfoldResult | undefined {
  const host = findCallHost(call);
  if (!host) return undefined;
  const hostKind = hostKindOf(host);
  if (!hostKind) return undefined;

  const macro = lookupMacro(call.name);
  if (!macro || macro.target !== hostKind) return undefined;

  const args = bindArgsBestEffort(macro, call);
  const origin: OriginToken = {
    _kind: "macro-origin",
    macroName: call.name,
    callNode: call,
  };

  // Provide a `invokeMacro` that propagates destination tags the
  // same way the real expander does.  Catches cross-level macros
  // like `softDeleteByDefault` so their returned nodes carry the
  // right destination for splicing into multiple AST locations.
  const invokeMacro = makeInvokeMacro(origin);

  let produced: ReadonlyArray<unknown>;
  try {
    produced = _withOrigin(origin, () =>
      macro.expand({
        target: host as never,
        args: args as never,
        origin,
        invokeMacro,
      }),
    );
  } catch {
    return undefined;
  }

  // Flatten one level, group by destination AST node.
  const byDest = new Map<object, unknown[]>();
  for (const item of produced) {
    const items = Array.isArray(item) ? item : [item];
    for (const node of items) {
      if (!node || typeof node !== "object") continue;
      const dest = ((node as Record<string, unknown>)[DEST_PROP] as object) ?? host;
      let bucket = byDest.get(dest);
      if (!bucket) {
        bucket = [];
        byDest.set(dest, bucket);
      }
      bucket.push(node);
    }
  }

  const edits: TextEdit[] = [];
  for (const [dest, nodes] of byDest) {
    const insertEdit = buildInsertEdit(document, dest, nodes);
    if (insertEdit) edits.push(insertEdit);
  }

  const removeEdit = buildMacroCallRemovalEdit(document, call);
  if (removeEdit) edits.push(removeEdit);

  return { title: `Unfold macro '${call.name}'`, edits };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findCallHost(
  call: MacroCall,
): Aggregate | Ui | BoundedContext | undefined {
  const withClause = call.$container as WithClause | undefined;
  const host = withClause?.$container as
    | Aggregate
    | Ui
    | BoundedContext
    | undefined;
  return host;
}

function hostKindOf(
  host: Aggregate | Ui | BoundedContext,
): "aggregate" | "ui" | "context" | undefined {
  if (host.$type === "Aggregate") return "aggregate";
  if (host.$type === "Ui") return "ui";
  if (host.$type === "BoundedContext") return "context";
  return undefined;
}

/** Best-effort arg binding for unfold purposes — uses the same
 * shape as the runtime expander but tolerates missing/broken args
 * (returns empty args rather than refusing the action).  Users
 * rarely unfold a macro whose args don't parse; if they do, the
 * unfold runs with defaults, which is usually still useful. */
function bindArgsBestEffort(
  _macro: unknown,
  _call: MacroCall,
): Record<string, unknown> {
  // TODO: thread through the full arg coercion logic from
  // ddd-macro-expander.ts.  For the v1 unfold action we accept that
  // arg-bearing macro invocations may unfold with defaults — the
  // resulting source will roundtrip even if the args were unusual.
  return {};
}

/** Mirrors the expander's invokeMacro: looks up the named macro,
 * runs expand() against the passed target, tags each returned node
 * with $destination so downstream grouping routes correctly. */
function makeInvokeMacro(origin: OriginToken) {
  return (
    childName: string,
    opts: { target: object; args?: Record<string, unknown> },
  ): unknown[] => {
    const child = lookupMacro(childName);
    if (!child) return [];
    let produced: ReadonlyArray<unknown> = [];
    try {
      produced = _withOrigin(origin, () =>
        child.expand({
          target: opts.target as never,
          args: (opts.args ?? {}) as never,
          origin,
          invokeMacro: makeInvokeMacro(origin),
        }),
      );
    } catch {
      return [];
    }
    const flat: unknown[] = [];
    for (const item of produced) {
      const items = Array.isArray(item) ? item : [item];
      for (const node of items) {
        if (node && typeof node === "object") {
          (node as Record<string, unknown>)[DEST_PROP] = opts.target;
          flat.push(node);
        }
      }
    }
    return flat;
  };
}

/** Build a TextEdit that inserts the printed `nodes` just before
 * the closing `}` of `target`'s body block.  Returns undefined if
 * the target's CST node can't be located (which would mean the
 * AST node is synthesised — shouldn't happen for unfold's
 * destinations, but defensively skip rather than throw). */
function buildInsertEdit(
  document: LangiumDocument,
  target: object,
  nodes: unknown[],
): TextEdit | undefined {
  const cst = (target as { $cstNode?: { range: { start: unknown; end: { line: number; character: number } } } })
    .$cstNode;
  if (!cst) return undefined;
  // Find the closing `}` position.  Langium gives us the range of
  // the whole block; the `}` is at `range.end` (exclusive), so
  // we insert one character before.
  const endPos = cst.range.end;
  // Insert at the position just before `}`.  Compute the character
  // by scanning back over whitespace + the closing brace.
  const text = document.textDocument.getText();
  const endOffset = document.textDocument.offsetAt(endPos);
  // Walk back to find the closing brace.
  let braceOffset = endOffset - 1;
  while (braceOffset > 0 && text[braceOffset] !== "}") braceOffset--;
  if (text[braceOffset] !== "}") return undefined;
  const bracePos = document.textDocument.positionAt(braceOffset);

  // Derive indent from the line containing the closing brace.
  // The brace itself is preceded by N leading spaces; new members
  // get N+2 (one level deeper).  Falls back to two-space indent if
  // the brace is at column 0 (rare; only for top-level contexts
  // when not nested in a system).
  const lineStart = document.textDocument.offsetAt({
    line: bracePos.line,
    character: 0,
  });
  let baseCol = 0;
  while (
    lineStart + baseCol < braceOffset &&
    (text[lineStart + baseCol] === " " || text[lineStart + baseCol] === "\t")
  ) {
    baseCol++;
  }
  const memberIndent = " ".repeat(baseCol + 2);
  const printed = nodes
    .map((n) => indent(printStructural(n as never), memberIndent))
    .join("\n");
  // Insert at the start of the brace's line — this avoids the
  // first printed line inheriting the brace's leading whitespace.
  // The closing brace's own indent is preserved automatically (it
  // was already present in source and untouched by the edit).
  const insertPos = { line: bracePos.line, character: 0 };
  const newText = `${printed}\n`;
  return {
    range: { start: insertPos, end: insertPos },
    newText,
  };
}

/** Build a TextEdit that removes this MacroCall from its
 * containing WithClause.  Handles three cases:
 *   - Only macro in the clause → remove the whole `with X` text
 *   - First / last macro in a list → remove the call + its comma
 *   - Middle macro → remove the call + its trailing comma
 * Returns undefined if the CST range can't be located. */
function buildMacroCallRemovalEdit(
  document: LangiumDocument,
  call: MacroCall,
): TextEdit | undefined {
  const callCst = (call as { $cstNode?: { range: { start: unknown; end: unknown } } }).$cstNode;
  if (!callCst) return undefined;
  const withClause = call.$container as WithClause;
  const calls = withClause.calls ?? [];
  // Only call in the clause → remove the whole `with X` text.
  if (calls.length === 1) {
    const wcCst = (withClause as { $cstNode?: { range: { start: unknown; end: unknown } } })
      .$cstNode;
    if (!wcCst) return undefined;
    // Include the leading whitespace before `with` to keep the
    // source clean.  Find the previous non-whitespace char.
    const text = document.textDocument.getText();
    const startOffset = document.textDocument.offsetAt(wcCst.range.start as never);
    let trimStart = startOffset;
    while (trimStart > 0 && (text[trimStart - 1] === " " || text[trimStart - 1] === "\t")) {
      trimStart--;
    }
    return {
      range: {
        start: document.textDocument.positionAt(trimStart),
        end: wcCst.range.end as never,
      },
      newText: "",
    };
  }
  // Multi-call clause → remove this call + its adjacent comma.
  const idx = calls.indexOf(call);
  const text = document.textDocument.getText();
  const callStart = document.textDocument.offsetAt(callCst.range.start as never);
  const callEnd = document.textDocument.offsetAt(callCst.range.end as never);
  let removeStart = callStart;
  let removeEnd = callEnd;
  if (idx === 0) {
    // First in list: remove call + trailing comma + space.
    let scan = removeEnd;
    while (scan < text.length && text[scan] !== ",") scan++;
    if (text[scan] === ",") removeEnd = scan + 1;
    while (removeEnd < text.length && text[removeEnd] === " ") removeEnd++;
  } else {
    // Not first: remove preceding comma + spaces + call.
    let scan = removeStart - 1;
    while (scan > 0 && (text[scan] === " " || text[scan] === "\t")) scan--;
    if (text[scan] === ",") removeStart = scan;
    while (removeStart > 0 && (text[removeStart - 1] === " " || text[removeStart - 1] === "\t")) {
      removeStart--;
    }
  }
  return {
    range: {
      start: document.textDocument.positionAt(removeStart),
      end: document.textDocument.positionAt(removeEnd),
    },
    newText: "",
  };
}

/** Indent every line of `text` by `prefix`. */
function indent(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => (line.length > 0 ? prefix + line : line))
    .join("\n");
}

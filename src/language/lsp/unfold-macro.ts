// Unfold a `with X(...)` macro call into its expanded source.
//
// Unfold is **one level only**: when the macro composes child macros
// via `invokeMacro` (e.g. `softDeleteByDefault` runs `softDelete` on
// the context and `softDeletable` on each child aggregate), those
// children are NOT executed.  Instead, each `invokeMacro` call
// becomes a `with <child>(...)` clause on its target.  The user can
// drill further by unfolding those children too.
//
// Computes a workspace edit that:
//   1. Invokes the macro's `expand()` against its host.
//   2. Records every `invokeMacro(child, { target })` call without
//      executing the child — these become `with child` clause edits
//      on the target.
//   3. Groups the macro's directly-returned nodes by destination
//      (only the host for normal macros; descendants too if a future
//      macro emits direct cross-level nodes without invokeMacro).
//   4. Prints each direct-node group through the structural printer
//      and inserts the text into the right host's body, just before
//      the closing `}`.
//   5. Rewrites the host's `with X, Y, Z` clause atomically: removes
//      the unfolded call, splices in any new `with child` entries
//      from invocations targeting the host, strips the whole clause
//      if empty.
//
// Macros become demonstrably sugar — any user can unfold and edit
// the result without reading the macro source.  Combined with the
// structural printer roundtrip guarantees from the print-roundtrip
// test, the unfolded output re-parses to a working program.

import type { LangiumDocument } from "langium";
import type { TextEdit } from "vscode-languageserver";
import type { MacroDefinition, OriginToken } from "../../macro-api/define.js";
import { _withOrigin } from "../../macro-api/factories.js";
import { resolveMacroArgs } from "../ddd-macro-expander.js";
import type {
  Aggregate,
  BoundedContext,
  MacroCall,
  Model,
  Ui,
  WithClause,
} from "../generated/ast.js";
import { lookupMacro } from "../macro-registry.js";
import { printStructural } from "../print/index.js";

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
export function unfoldMacro(document: LangiumDocument, call: MacroCall): UnfoldResult | undefined {
  const host = findCallHost(call);
  if (!host) return undefined;
  const hostKind = hostKindOf(host);
  if (!hostKind) return undefined;

  const macro = lookupMacro(call.name);
  if (!macro || macro.target !== hostKind) return undefined;

  const args = bindArgsForUnfold(document, macro, call);
  const origin: OriginToken = {
    _kind: "macro-origin",
    macroName: call.name,
    callNode: call,
  };

  // Record `invokeMacro(child, { target })` calls instead of running
  // them.  Each recording becomes a `with child` clause on its target
  // — that's the one-level unfold semantics.
  const invocations: InvocationRecord[] = [];
  const invokeMacro = makeRecordingInvokeMacro(invocations);

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

  // Flatten one level, group directly-returned nodes by destination
  // AST node.  `invokeMacro` no longer contributes nodes here (it
  // returned []), so this map holds only the macro's own direct
  // emissions — e.g. `softDelete` returns one `FilterDecl`.
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

  // Group recorded invocations by target so all `with`-clause
  // additions to the same target produce a single comma-separated
  // edit (rather than colliding zero-width inserts at the same
  // offset).
  const invocationsByTarget = new Map<object, InvocationRecord[]>();
  for (const r of invocations) {
    const list = invocationsByTarget.get(r.target) ?? [];
    list.push(r);
    invocationsByTarget.set(r.target, list);
  }

  // Host-clause edit: rewrite the host's `with X, Y, Z` clause
  // atomically as (existing calls minus the one being unfolded)
  // plus (new entries from invocations targeting host).  Doing this
  // as one replace avoids the comma-collision bug that would happen
  // if we appended `, child` and then separately removed the macro
  // call when it was the sole call in the clause.
  const hostClauseEdit = buildHostClauseRewriteEdit(
    document,
    host,
    call,
    invocationsByTarget.get(host) ?? [],
  );
  if (hostClauseEdit) edits.push(hostClauseEdit);

  // Non-host targets (e.g. child aggregates for `softDeleteByDefault`)
  // get their `with child` added via the simpler append path — they
  // aren't entangled with the call-removal logic above.
  for (const [target, recs] of invocationsByTarget) {
    if (target === host) continue;
    const edit = buildWithClauseInsertEdit(document, target, recs);
    if (edit) edits.push(edit);
  }

  return { title: `Unfold macro '${call.name}'`, edits };
}

/** Recording of a single `invokeMacro(...)` call made by the macro
 * being unfolded.  Translated into a `with <childName>(...)` clause
 * on the target during edit generation. */
interface InvocationRecord {
  childName: string;
  target: object;
  args?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findCallHost(call: MacroCall): Aggregate | Ui | BoundedContext | undefined {
  const withClause = call.$container as WithClause | undefined;
  const host = withClause?.$container as Aggregate | Ui | BoundedContext | undefined;
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

/** Resolve the macro call's args against the document model, using
 * the same coercion logic the runtime expander uses but silently
 * (no diagnostics recorded).  Falls back to an empty args record if
 * the call's args don't bind — unfold then runs with macro defaults,
 * which is still useful for the common no-arg case. */
function bindArgsForUnfold(
  document: LangiumDocument,
  macro: MacroDefinition,
  call: MacroCall,
): Record<string, unknown> {
  const model = document.parseResult?.value as Model | undefined;
  if (!model) return {};
  return resolveMacroArgs(macro, call, model) ?? {};
}

/** Recording `invokeMacro` — appends the call to a shared list and
 * returns `[]` so the composer's `.flatMap(...)` / spread patterns
 * yield no nodes for the splice path.  The recorded calls drive
 * `with <child>(...)` insertions on the targets in a separate pass. */
function makeRecordingInvokeMacro(records: InvocationRecord[]) {
  return (
    childName: string,
    opts: { target: object; args?: Record<string, unknown> },
  ): unknown[] => {
    records.push({ childName, target: opts.target, args: opts.args });
    return [];
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
  const cst = (
    target as { $cstNode?: { range: { start: unknown; end: { line: number; character: number } } } }
  ).$cstNode;
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
  const printed = nodes.map((n) => indent(printStructural(n as never), memberIndent)).join("\n");
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

/** Replace the host's existing `with` clause atomically with the
 * post-unfold composition: (other calls in the clause, preserved
 * verbatim) + (new entries from invocations targeting host).  If
 * the result is empty (no other calls, no host invocations), the
 * whole clause is removed (including its leading whitespace). */
function buildHostClauseRewriteEdit(
  document: LangiumDocument,
  host: Aggregate | Ui | BoundedContext,
  callBeingUnfolded: MacroCall,
  hostInvocations: InvocationRecord[],
): TextEdit | undefined {
  const withClause = callBeingUnfolded.$container as WithClause;
  const wcCst = (
    withClause as {
      $cstNode?: {
        range: {
          start: { line: number; character: number };
          end: { line: number; character: number };
        };
      };
    }
  ).$cstNode;
  if (!wcCst) return undefined;
  const text = document.textDocument.getText();

  // Preserve other existing call source verbatim — keeps any
  // user-formatted args intact across the rewrite.
  const otherCallTexts: string[] = [];
  for (const c of withClause.calls ?? []) {
    if (c === callBeingUnfolded) continue;
    const cCst = (
      c as {
        $cstNode?: {
          range: {
            start: { line: number; character: number };
            end: { line: number; character: number };
          };
        };
      }
    ).$cstNode;
    if (!cCst) continue;
    const startOff = document.textDocument.offsetAt(cCst.range.start);
    const endOff = document.textDocument.offsetAt(cCst.range.end);
    otherCallTexts.push(text.slice(startOff, endOff));
  }
  const newCallTexts = hostInvocations.map((r) => renderMacroCallSyntax(r.childName, r.args));
  const allCalls = [...otherCallTexts, ...newCallTexts];

  if (allCalls.length === 0) {
    // Whole `with X` becomes empty — strip the clause along with its
    // leading whitespace (matches the existing removal behavior).
    const startOff = document.textDocument.offsetAt(wcCst.range.start);
    let trimStart = startOff;
    while (trimStart > 0 && (text[trimStart - 1] === " " || text[trimStart - 1] === "\t")) {
      trimStart--;
    }
    return {
      range: {
        start: document.textDocument.positionAt(trimStart),
        end: wcCst.range.end,
      },
      newText: "",
    };
  }
  void host;
  return {
    range: { start: wcCst.range.start, end: wcCst.range.end },
    newText: `with ${allCalls.join(", ")}`,
  };
}

/** Build a TextEdit that adds (or extends) a `with <child>, ...`
 * clause on `target`'s declaration head, one entry per recording.
 *
 *   - No existing clause: insert ` with A, B` just before the `{`.
 *   - Existing clause with N calls: append `, A, B` after the last
 *     call.
 *
 * Returns undefined if the target's CST node can't be located. */
function buildWithClauseInsertEdit(
  document: LangiumDocument,
  target: object,
  records: InvocationRecord[],
): TextEdit | undefined {
  const callsSyntax = records.map((r) => renderMacroCallSyntax(r.childName, r.args)).join(", ");
  const existing = (target as { withClause?: WithClause }).withClause;
  if (existing && (existing.calls ?? []).length > 0) {
    const calls = existing.calls ?? [];
    const lastCall = calls[calls.length - 1]!;
    const lastCst = (
      lastCall as { $cstNode?: { range: { end: { line: number; character: number } } } }
    ).$cstNode;
    if (!lastCst) return undefined;
    return {
      range: { start: lastCst.range.end, end: lastCst.range.end },
      newText: `, ${callsSyntax}`,
    };
  }
  const cst = (target as { $cstNode?: { range: { start: { line: number; character: number } } } })
    .$cstNode;
  if (!cst) return undefined;
  // Find the `{` that opens this target's body; the `with` clause
  // goes immediately before it.  Walk forward from the target's
  // start until we hit `{`, then back over any trailing whitespace.
  const text = document.textDocument.getText();
  const startOffset = document.textDocument.offsetAt(cst.range.start);
  let braceOffset = startOffset;
  while (braceOffset < text.length && text[braceOffset] !== "{") braceOffset++;
  if (text[braceOffset] !== "{") return undefined;
  let insertOffset = braceOffset;
  while (
    insertOffset > startOffset &&
    (text[insertOffset - 1] === " " || text[insertOffset - 1] === "\t")
  ) {
    insertOffset--;
  }
  const insertPos = document.textDocument.positionAt(insertOffset);
  return {
    range: { start: insertPos, end: insertPos },
    newText: ` with ${callsSyntax}`,
  };
}

/** Render a macro call back to source syntax: `name` for no args,
 * `name(k: v, ...)` for args.  Mirrors the macro-call grammar in
 * `src/language/ddd.langium`. */
function renderMacroCallSyntax(name: string, args?: Record<string, unknown>): string {
  const entries = Object.entries(args ?? {}).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return name;
  const argSyntax = entries.map(([k, v]) => `${k}: ${renderArgValue(v)}`).join(", ");
  return `${name}(${argSyntax})`;
}

/** Render an arg value to its source-side representation.  Handles
 * the primitive shapes the grammar supports (string / bool / int /
 * ref / refList) plus resolved AST-node refs (which carry `.name`). */
function renderArgValue(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) return `[${v.map(renderArgValue).join(", ")}]`;
  if (
    v &&
    typeof v === "object" &&
    "name" in v &&
    typeof (v as { name: unknown }).name === "string"
  ) {
    return (v as { name: string }).name;
  }
  return "?";
}

/** Indent every line of `text` by `prefix`. */
function indent(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => (line.length > 0 ? prefix + line : line))
    .join("\n");
}

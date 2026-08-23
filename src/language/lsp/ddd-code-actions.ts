import { AstUtils, CstUtils, type LangiumDocument } from "langium";
import type { CodeActionProvider } from "langium/lsp";
import {
  type CodeAction,
  CodeActionKind,
  type CodeActionParams,
  type Command,
  type Diagnostic,
  type TextEdit,
} from "vscode-languageserver";
import type { ModelPatch } from "../../diagnostics/contract.js";
import { fixHintFor } from "../fix-hints.js";
import { isMacroCall, type MacroCall } from "../generated/ast.js";
import { type PatchTextEdit, resolvePatchEdits } from "../model-patch.js";
import { enumerateScaffoldPageUnfolds, unfoldMacro } from "./unfold-macro.js";

// ---------------------------------------------------------------------------
// DddCodeActionProvider — the editor half of the fix-hint bridge.
//
// Quick-fixes are NOT hand-rolled per diagnostic code here: every repair lives
// once in the `src/language/fix-hints.ts` provider registry as a node-addressed
// `ModelPatch` (the same hint the agent loop consumes off `ddd parse --json`).
// This provider resolves the diagnostic's AST node, asks the registry for a
// hint, and turns the hint's patch(es) into LSP `TextEdit`s via
// `resolvePatchEdits` — so a new fix is a one-entry change in `fix-hints.ts`
// and lights up in the editor for free.
//
// Layering: `fix-hints.ts` and `model-patch.ts` are both `src/language/`, so
// there is no `src/api/` edge here (`src/api/lsp.ts`'s `fixHintCodeActions` is
// the report-shaped twin for the playground / CLI transports).
//
// Refactor actions (macro unfold) are cursor-driven, not diagnostic-driven, and
// stay as they were.
// ---------------------------------------------------------------------------

/** One candidate quick fix: a patch plus how to present it. */
interface Candidate {
  diag: Diagnostic;
  title: string;
  patch: ModelPatch;
  /** A single-patch hint is THE repair; a `choose` option is one of several. */
  preferred: boolean;
}

export class DddCodeActionProvider implements CodeActionProvider {
  async getCodeActions(
    document: LangiumDocument,
    params: CodeActionParams,
  ): Promise<Array<Command | CodeAction> | undefined> {
    const actions: CodeAction[] = [];
    // Refactor: unfold a `with X(...)` macro call into its expanded
    // source.  Offered whenever the cursor sits inside a MacroCall
    // AST node (independent of any diagnostic).
    const call = this.locateMacroCall(document, params);
    if (call) {
      // Whole-macro unfold (one level): "Unfold macro 'X'".
      const result = unfoldMacro(document, call);
      if (result) {
        actions.push({
          title: result.title,
          kind: CodeActionKind.RefactorRewrite,
          edit: { changes: { [document.textDocument.uri]: result.edits } },
        });
      }
      // Per-page unfold (M-T1.5): "Unfold page 'Orders / Detail'" — eject one
      // scaffolded page, leaving its siblings under the macro.
      for (const opt of enumerateScaffoldPageUnfolds(document, call)) {
        actions.push({
          title: opt.result.title,
          kind: CodeActionKind.RefactorRewrite,
          edit: { changes: { [document.textDocument.uri]: opt.result.edits } },
        });
      }
    }

    for (const action of await this.fixHintActions(document, params)) actions.push(action);
    return actions;
  }

  /** Quick fixes for the request's diagnostics, sourced from the shared
   *  fix-hint provider registry. */
  private async fixHintActions(
    document: LangiumDocument,
    params: CodeActionParams,
  ): Promise<CodeAction[]> {
    const candidates: Candidate[] = [];
    for (const diag of params.context.diagnostics) {
      const node = this.locateDiagnosticNode(document, diag);
      if (!node) continue;
      const hint = fixHintFor(diag, document, node);
      if (!hint) continue;
      if (hint.patch) {
        // A single patch is the unambiguous repair — mark it preferred so the
        // editor can auto-apply it (`Fix all` / the default lightbulb pick).
        candidates.push({ diag, title: title(hint.summary), patch: hint.patch, preferred: true });
        continue;
      }
      // `choose`: several equally valid repairs — one action each, none
      // preferred (there is no single right answer).
      for (const opt of hint.options ?? []) {
        if (!opt.patch) continue;
        candidates.push({ diag, title: title(opt.summary), patch: opt.patch, preferred: false });
      }
    }
    if (candidates.length === 0) return [];

    const source = document.textDocument.getText();
    const resolved = await resolveEach(
      source,
      candidates.map((c) => c.patch),
    );
    const actions: CodeAction[] = [];
    for (const [i, c] of candidates.entries()) {
      const edits = resolved[i];
      if (!edits || edits.length === 0) continue; // unresolvable patch — skip it
      actions.push({
        title: c.title,
        kind: CodeActionKind.QuickFix,
        diagnostics: [c.diag],
        ...(c.preferred ? { isPreferred: true } : {}),
        edit: { changes: { [document.textDocument.uri]: edits as TextEdit[] } },
      });
    }
    return actions;
  }

  /** The AST node a diagnostic was attached to — the node the fix-hint
   *  providers expect.  Mirrors `src/api/report.ts`'s `locate`, so the editor
   *  and the JSON report feed the registry the same node. */
  private locateDiagnosticNode(document: LangiumDocument, diag: Diagnostic) {
    try {
      const rootCst = document.parseResult?.value?.$cstNode;
      if (!rootCst) return undefined;
      const offset = document.textDocument.offsetAt(diag.range.start);
      return CstUtils.findLeafNodeAtOffset(rootCst, offset)?.astNode;
    } catch {
      return undefined;
    }
  }

  /** Locate the `MacroCall` AST node the cursor sits inside, if any — the
   * anchor for both whole-macro unfold and per-page unfold.  The heavy lifting
   * lives in `unfold-macro.ts`; this just resolves the call from the cursor. */
  private locateMacroCall(
    document: LangiumDocument,
    params: CodeActionParams,
  ): MacroCall | undefined {
    const rootCst = document.parseResult?.value?.$cstNode;
    if (!rootCst) return undefined;
    const offset = document.textDocument.offsetAt(params.range.start);
    const leaf = CstUtils.findLeafNodeAtOffset(rootCst, offset);
    return AstUtils.getContainerOfType(leaf?.astNode, isMacroCall) as MacroCall | undefined;
  }
}

/** A fix-hint `summary` is a sentence ("Reference the aggregate by id."); a code
 *  action title is a label, so the trailing period is dropped. */
function title(summary: string): string {
  return summary.replace(/\.$/, "");
}

/**
 * Resolve every patch to its own edit list, indexed alongside `patches`.
 *
 * `resolvePatchEdits` is ATOMIC (one bad target empties the whole batch) and it
 * re-parses the source per call, so the happy path is a single batched call —
 * with a per-patch fallback so one unresolvable patch doesn't suppress the
 * fixes that would have worked.
 */
async function resolveEach(
  source: string,
  patches: ModelPatch[],
): Promise<(PatchTextEdit[] | undefined)[]> {
  const batch = await resolvePatchEdits(source, patches);
  // One patch → one edit for every op a fix hint uses (only `rename` fans out,
  // and no provider emits one), so a length match makes the index mapping safe.
  if (batch.ok && batch.edits.length === patches.length) {
    return batch.edits.map((e) => [e]);
  }
  return Promise.all(
    patches.map(async (p) => {
      const one = await resolvePatchEdits(source, [p]);
      return one.ok ? one.edits : undefined;
    }),
  );
}

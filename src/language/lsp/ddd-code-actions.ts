import { AstUtils, CstUtils, type LangiumDocument, type MaybePromise } from "langium";
import type { CodeActionProvider } from "langium/lsp";
import {
  type CodeAction,
  CodeActionKind,
  type CodeActionParams,
  type Command,
  type Diagnostic,
  TextEdit,
} from "vscode-languageserver";
import { isMacroCall, type MacroCall } from "../generated/ast.js";
import { unfoldMacro } from "./unfold-macro.js";

// ---------------------------------------------------------------------------
// DddCodeActionProvider — quick-fixes for validator diagnostics tagged with a
// stable `code`.  Each fix is a localized text edit; the diagnostic itself
// carries everything the fix needs (its range, plus `data` for computed
// values like the expected framework).
// ---------------------------------------------------------------------------

export class DddCodeActionProvider implements CodeActionProvider {
  getCodeActions(
    document: LangiumDocument,
    params: CodeActionParams,
  ): MaybePromise<Array<Command | CodeAction> | undefined> {
    const actions: CodeAction[] = [];
    // Refactor: unfold a `with X(...)` macro call into its expanded
    // source.  Offered whenever the cursor sits inside a MacroCall
    // AST node (independent of any diagnostic).
    const unfoldAction = this.maybeOfferUnfold(document, params);
    if (unfoldAction) actions.push(unfoldAction);
    for (const diag of params.context.diagnostics) {
      switch (diag.code) {
        case "loom.framework-mismatch": {
          const expected = (diag.data as { expected?: string } | undefined)?.expected;
          if (expected) {
            actions.push(
              quickFix(
                `Set framework to '${expected}'`,
                document,
                diag,
                TextEdit.replace(diag.range, expected),
              ),
            );
          }
          break;
        }
        case "loom.bare-aggregate-in-type": {
          // Editor-native twin of the fix-hints.ts provider (which emits the
          // same change as a node-addressed ModelPatch for the agent loop): the
          // diagnostic range ends just after the bare aggregate type name, so
          // inserting ' id' there yields `Customer id` (and `Customer id[]` for
          // a collection ref).
          actions.push(
            quickFix(
              "Reference the aggregate by id",
              document,
              diag,
              TextEdit.insert(diag.range.end, " id"),
            ),
          );
          break;
        }
      }
    }
    return actions;
  }

  /** When the cursor sits inside a `MacroCall` AST node, offer a
   * refactor that unfolds the macro into its expanded source.  The
   * heavy lifting is in `unfold-macro.ts`; this method just locates
   * the call from the cursor position and packages the result as a
   * Refactor code action. */
  private maybeOfferUnfold(
    document: LangiumDocument,
    params: CodeActionParams,
  ): CodeAction | undefined {
    const rootCst = document.parseResult?.value?.$cstNode;
    if (!rootCst) return undefined;
    const offset = document.textDocument.offsetAt(params.range.start);
    const leaf = CstUtils.findLeafNodeAtOffset(rootCst, offset);
    const call = AstUtils.getContainerOfType(leaf?.astNode, isMacroCall) as MacroCall | undefined;
    if (!call) return undefined;
    const result = unfoldMacro(document, call);
    if (!result) return undefined;
    return {
      title: result.title,
      kind: CodeActionKind.RefactorRewrite,
      edit: {
        changes: { [document.textDocument.uri]: result.edits },
      },
    };
  }
}

function quickFix(
  title: string,
  document: LangiumDocument,
  diag: Diagnostic,
  edit: TextEdit,
): CodeAction {
  return {
    title,
    kind: CodeActionKind.QuickFix,
    diagnostics: [diag],
    isPreferred: true,
    edit: { changes: { [document.textDocument.uri]: [edit] } },
  };
}

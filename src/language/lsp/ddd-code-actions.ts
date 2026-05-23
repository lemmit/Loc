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
import { isMacroCall, isProperty, type MacroCall } from "../generated/ast.js";
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
        case "loom.display-not-string": {
          const edit = this.setDisplayTypeToString(document, diag);
          if (edit) actions.push(quickFix("Change type to 'string'", document, diag, edit));
          break;
        }
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

  /** The diagnostic sits on the `display` keyword; navigate to the owning
   *  property's declared type and replace it with `string`. */
  private setDisplayTypeToString(
    document: LangiumDocument,
    diag: Diagnostic,
  ): TextEdit | undefined {
    const rootCst = document.parseResult?.value?.$cstNode;
    if (!rootCst) return undefined;
    const offset = document.textDocument.offsetAt(diag.range.start);
    const leaf = CstUtils.findLeafNodeAtOffset(rootCst, offset);
    const prop = AstUtils.getContainerOfType(leaf?.astNode, isProperty);
    const typeCst = prop?.type?.$cstNode;
    return typeCst ? TextEdit.replace(typeCst.range, "string") : undefined;
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

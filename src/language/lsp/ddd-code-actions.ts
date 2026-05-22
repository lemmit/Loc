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
import { isProperty } from "../generated/ast.js";

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

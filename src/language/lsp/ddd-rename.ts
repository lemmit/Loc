import { type AstNode, CstUtils, type LangiumDocument, type MaybePromise } from "langium";
import { DefaultRenameProvider, type LangiumServices } from "langium/lsp";
import {
  type Position,
  type Range,
  type RenameParams,
  type TextDocumentPositionParams,
  TextEdit,
  type WorkspaceEdit,
} from "vscode-languageserver";
import { collectMemberUsages, isRenameableMember, memberDeclAt } from "./member-refs.js";

// ---------------------------------------------------------------------------
// DddRenameProvider — cross-reference renames (aggregate / value-object /
// enum / event / module / deployable / repository names) flow through the
// Langium default via the index.  Member declarations (property /
// containment / derived / function) are referenced through string tokens the
// index can't see, so we rewrite the declaration name plus every usage site
// computed by the shared `member-refs` resolver (which honours `ddd-scope`'s
// same-aggregate constraint and local-binding shadowing).
// ---------------------------------------------------------------------------

export class DddRenameProvider extends DefaultRenameProvider {
  constructor(services: LangiumServices) {
    super(services);
  }

  override async rename(
    document: LangiumDocument,
    params: RenameParams,
  ): Promise<WorkspaceEdit | undefined> {
    const target = this.targetAt(document, params.position);
    if (target && isRenameableMember(target)) {
      return this.renameMember(document, target, params.newName);
    }
    return super.rename(document, params);
  }

  override prepareRename(
    document: LangiumDocument,
    params: TextDocumentPositionParams,
  ): MaybePromise<Range | undefined> {
    const fromDefault = super.prepareRename(document, params);
    if (fromDefault) return fromDefault;
    const leaf = this.leafAt(document, params.position);
    if (!leaf) return undefined;
    const decl = memberDeclAt(leaf);
    return decl && isRenameableMember(decl) ? leaf.range : undefined;
  }

  private renameMember(document: LangiumDocument, target: AstNode, newName: string): WorkspaceEdit {
    const uri = document.textDocument.uri;
    const edits: TextEdit[] = [];
    const nameNode = this.nameProvider.getNameNode(target);
    if (nameNode) edits.push(TextEdit.replace(nameNode.range, newName));
    for (const cst of collectMemberUsages(document, target)) {
      edits.push(TextEdit.replace(cst.range, newName));
    }
    return { changes: { [uri]: dedupeEdits(edits) } };
  }

  private leafAt(document: LangiumDocument, position: Position) {
    const rootCst = document.parseResult?.value?.$cstNode;
    if (!rootCst) return undefined;
    const offset = document.textDocument.offsetAt(position);
    return CstUtils.findDeclarationNodeAtOffset(rootCst, offset, this.grammarConfig.nameRegexp);
  }

  private targetAt(document: LangiumDocument, position: Position): AstNode | undefined {
    const leaf = this.leafAt(document, position);
    if (!leaf) return undefined;
    const declared = this.references.findDeclaration(leaf);
    if (declared && declared.$type !== "MemberAccess") return declared;
    return memberDeclAt(leaf);
  }
}

function dedupeEdits(edits: TextEdit[]): TextEdit[] {
  const seen = new Set<string>();
  const out: TextEdit[] = [];
  for (const e of edits) {
    const r = e.range;
    const key = `${r.start.line}:${r.start.character}:${r.end.line}:${r.end.character}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

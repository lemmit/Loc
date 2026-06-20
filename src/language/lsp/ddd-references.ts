import {
  type AstNode,
  AstUtils,
  CstUtils,
  GrammarUtils,
  type LangiumDocument,
  type LangiumDocuments,
  type MaybePromise,
} from "langium";
import { DefaultReferencesProvider, type LangiumServices } from "langium/lsp";
import { Location, type Position, type ReferenceParams } from "vscode-languageserver";
import { isCapability, isImplementsDecl, isMacroCall, type Model } from "../generated/ast.js";
import { collectMemberUsages, memberDeclAt } from "./member-refs.js";

// ---------------------------------------------------------------------------
// DddReferencesProvider — extends the default with member-access find-all.
// Cross-reference usages (aggregates, X id, named types, repository-for,
// emit, modules/targets) come free from Langium's index.  Member accesses
// (`order.lines`, bare `customerId`) are string tokens the index can't see,
// so we add them via the shared `member-refs` resolver.  Purely additive.
// ---------------------------------------------------------------------------

export class DddReferencesProvider extends DefaultReferencesProvider {
  private readonly documents: LangiumDocuments;

  constructor(services: LangiumServices) {
    super(services);
    this.documents = services.shared.workspace.LangiumDocuments;
  }

  override findReferences(
    document: LangiumDocument,
    params: ReferenceParams,
  ): MaybePromise<Location[]> {
    const fromDefault = super.findReferences(document, params) as Location[];
    const target = this.targetAt(document, params.position);
    if (!target) return fromDefault;

    // Find-implementors for a `capability` declaration: every `with <Cap>` /
    // `implements <Cap>` use across the workspace (these resolve by name through
    // the expander inventory, so the cross-reference index never sees them).
    if (isCapability(target)) {
      const refs = this.capabilityUsages(target.name);
      if (params.context?.includeDeclaration) {
        const nameNode = this.nameProvider.getNameNode(target);
        if (nameNode) {
          refs.push(Location.create(AstUtils.getDocument(target).textDocument.uri, nameNode.range));
        }
      }
      return dedupe([...fromDefault, ...refs]);
    }

    const uri = document.textDocument.uri;
    const extra: Location[] = collectMemberUsages(document, target).map((cst) =>
      Location.create(uri, cst.range),
    );
    if (params.context?.includeDeclaration) {
      const nameNode = this.nameProvider.getNameNode(target);
      if (nameNode) extra.push(Location.create(uri, nameNode.range));
    }
    return dedupe([...fromDefault, ...extra]);
  }

  private targetAt(document: LangiumDocument, position: Position): AstNode | undefined {
    const rootCst = document.parseResult?.value?.$cstNode;
    if (!rootCst) return undefined;
    const offset = document.textDocument.offsetAt(position);
    const leaf = CstUtils.findDeclarationNodeAtOffset(
      rootCst,
      offset,
      this.grammarConfig.nameRegexp,
    );
    if (!leaf) return undefined;
    // Cursor on a `capability <Name>` declaration name (not a cross-reference,
    // so `findDeclaration` won't return it).
    if (isCapability(leaf.astNode) && leaf.text === leaf.astNode.name) return leaf.astNode;
    const declared = this.references.findDeclaration(leaf);
    if (declared && declared.$type !== "MemberSuffix") return declared;
    return memberDeclAt(leaf);
  }

  /** Every `with <name>` / `implements <name>` capability application across the
   *  workspace — the find-implementors result for a capability declaration. */
  private capabilityUsages(name: string): Location[] {
    const out: Location[] = [];
    for (const doc of this.documents.all) {
      const root = doc.parseResult?.value as Model | undefined;
      if (!root) continue;
      const uri = doc.textDocument.uri;
      for (const node of AstUtils.streamAllContents(root)) {
        if (isMacroCall(node) && node.name === name) {
          const cst = GrammarUtils.findNodeForProperty(node.$cstNode, "name") ?? node.$cstNode;
          if (cst) out.push(Location.create(uri, cst.range));
        } else if (isImplementsDecl(node) && node.cap === name) {
          const cst = GrammarUtils.findNodeForProperty(node.$cstNode, "cap") ?? node.$cstNode;
          if (cst) out.push(Location.create(uri, cst.range));
        }
      }
    }
    return out;
  }
}

function dedupe(locations: Location[]): Location[] {
  const seen = new Set<string>();
  const out: Location[] = [];
  for (const loc of locations) {
    const key = `${loc.uri}:${loc.range.start.line}:${loc.range.start.character}:${loc.range.end.line}:${loc.range.end.character}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(loc);
  }
  return out;
}

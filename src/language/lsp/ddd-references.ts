import { DefaultReferencesProvider, type LangiumServices } from "langium/lsp";
import {
  CstUtils,
  type AstNode,
  type LangiumDocument,
  type MaybePromise,
} from "langium";
import { Location, type Position, type ReferenceParams } from "vscode-languageserver";
import { collectMemberUsages, memberDeclAt } from "./member-refs.js";

// ---------------------------------------------------------------------------
// DddReferencesProvider — extends the default with member-access find-all.
// Cross-reference usages (aggregates, Id<X>, named types, repository-for,
// emit, modules/targets) come free from Langium's index.  Member accesses
// (`order.lines`, bare `customerId`) are string tokens the index can't see,
// so we add them via the shared `member-refs` resolver.  Purely additive.
// ---------------------------------------------------------------------------

export class DddReferencesProvider extends DefaultReferencesProvider {
  constructor(services: LangiumServices) {
    super(services);
  }

  override findReferences(
    document: LangiumDocument,
    params: ReferenceParams,
  ): MaybePromise<Location[]> {
    const fromDefault = super.findReferences(document, params) as Location[];
    const target = this.targetAt(document, params.position);
    if (!target) return fromDefault;

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
    const leaf = CstUtils.findDeclarationNodeAtOffset(rootCst, offset, this.grammarConfig.nameRegexp);
    if (!leaf) return undefined;
    const declared = this.references.findDeclaration(leaf);
    if (declared && declared.$type !== "MemberAccess") return declared;
    return memberDeclAt(leaf);
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

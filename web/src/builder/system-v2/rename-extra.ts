// Construct rename keyed directly by AST `$type` (not v1's NodeKind union),
// so v2 can rename kinds v1's `renameConstruct` doesn't cover — system,
// bounded context, operation, function. Mirrors `renameConstruct`'s logic
// almost verbatim: build a linked document, find the target node by $type +
// name, rewrite the declared name span and every reference via Langium's
// NameProvider + References (same machinery as the language server's Rename).

import { AstUtils, type AstNode } from "langium";
import { applyEdits, type TextEdit } from "../edit-engine";
import { buildLinkedDocument } from "../system/linked-doc";

export async function renameByAstType(
  source: string,
  astType: string,
  oldName: string,
  newName: string,
): Promise<string | null> {
  const linked = await buildLinkedDocument(source, "memory:///v2-rename.ddd");
  if (!linked) return null;
  const { model, services, uri } = linked;
  let target: AstNode | undefined;
  for (const n of AstUtils.streamAst(model)) {
    if (n.$type === astType && (n as { name?: unknown }).name === oldName) {
      target = n;
      break;
    }
  }
  if (!target) return null;

  const edits: TextEdit[] = [];
  const push = (offset: number, end: number): void => {
    // Defensive: only rewrite spans that literally read `oldName`.
    if (source.slice(offset, end) === oldName) edits.push({ offset, end, newText: newName });
  };

  const nameNode = services.references.NameProvider.getNameNode(target);
  if (nameNode) push(nameNode.offset, nameNode.end);
  for (const ref of services.references.References.findReferences(target, {
    documentUri: uri,
    includeDeclaration: false,
  })) {
    push(ref.segment.offset, ref.segment.end);
  }
  // De-dupe (a name node can also surface as a reference).
  const seen = new Set<string>();
  const unique = edits.filter((e) => {
    const key = `${e.offset}:${e.end}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return applyEdits(source, unique);
}

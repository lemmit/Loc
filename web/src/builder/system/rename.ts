import { AstUtils, type AstNode } from "langium";
import { applyEdits, type TextEdit } from "../edit-engine";
import { buildLinkedDocument } from "./linked-doc";
import type { NodeKind } from "./model";

// Rename a structural construct *and every reference to it*.
//
// The playground's main-thread parse (web/src/builder/parse.ts) runs only the
// Langium parser — no linking — so `.ref` targets aren't resolved and we can't
// see who points at a node.  Renaming therefore needs a fully-built document:
// we spin up a throwaway Langium instance, build (link) the source, then ask
// `References.findReferences` for the exact CST segment of every cross-reference
// and rewrite each alongside the declaration's name token.  Returns the new
// source, or null if the construct can't be found.

const KIND_TO_TYPE: Record<NodeKind, string> = {
  module: "Module",
  aggregate: "Aggregate",
  valueobject: "ValueObject",
  event: "EventDecl",
  repository: "Repository",
  view: "View",
  workflow: "Workflow",
  deployable: "Deployable",
  api: "Api",
  storage: "Storage",
  ui: "Ui",
};

export const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export async function renameConstruct(
  source: string,
  kind: NodeKind,
  oldName: string,
  newName: string,
): Promise<string | null> {
  const linked = await buildLinkedDocument(source, "memory:///loom-rename.ddd");
  if (!linked) return null;
  const { model, services, uri } = linked;
  const wantType = KIND_TO_TYPE[kind];
  let target: AstNode | undefined;
  for (const n of AstUtils.streamAst(model)) {
    if (n.$type === wantType && (n as { name?: unknown }).name === oldName) {
      target = n;
      break;
    }
  }
  if (!target) return null;

  const edits: TextEdit[] = [];
  const push = (offset: number, end: number): void => {
    // Defensive: only rewrite spans that literally read `oldName` today, so a
    // stray segment (e.g. from a synthesized scaffold node) can't corrupt the
    // source.
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

  // Drop duplicate spans (a name node can also surface as a reference).
  const seen = new Set<string>();
  const unique = edits.filter((e) => {
    const key = `${e.offset}:${e.end}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return applyEdits(source, unique);
}

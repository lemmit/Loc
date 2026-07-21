import { AstUtils, type AstNode, type Reference } from "langium";
import type { Api, Model, Repository } from "../../../../src/language/generated/ast.js";
import { applyEdits } from "../edit-engine";
import { parseDdd } from "../parse";
import type { NodeKind } from "./model";

// ---------------------------------------------------------------------------
// Rebind a construct's single outgoing reference from the inspector:
//   repository … for <Aggregate>     (repository → aggregate)
//   api …        from <Subdomain>     (api → subdomain)
//
// A reference's `$refNode` is the CST node of the referenced *name token* (set
// by the parser, no linking needed), so a rebind is a single targeted text edit
// over that span — safe, and the graph edge re-derives from the new $refText on
// the next parse.  Other reference kinds (deployable bindings/serves/ui) are
// multi-valued and out of scope here.
// ---------------------------------------------------------------------------

export type RebindKind = "repository" | "api";

const REBINDABLE: RebindKind[] = ["repository", "api"];
export const isRebindKind = (kind: NodeKind): kind is RebindKind =>
  (REBINDABLE as NodeKind[]).includes(kind);

const KIND_TO_TYPE: Record<RebindKind, string> = {
  repository: "Repository",
  api: "Api",
};

/** What the reference points at — drives both the option list and the label. */
export function targetKindOf(kind: RebindKind): "aggregate" | "subdomain" {
  return kind === "api" ? "subdomain" : "aggregate";
}

function refOf(node: AstNode, kind: RebindKind): Reference | undefined {
  switch (kind) {
    case "repository":
      return (node as Repository).aggregate;
    case "api":
      return (node as Api).source;
  }
}

function findConstruct(ast: Model, kind: RebindKind, name: string): AstNode | null {
  const wantType = KIND_TO_TYPE[kind];
  for (const n of AstUtils.streamAst(ast)) {
    if (n.$type === wantType && (n as { name?: unknown }).name === name) return n;
  }
  return null;
}

/** Current reference target's name (for the Select's value), or null. */
export function currentTarget(node: AstNode, kind: RebindKind): string | null {
  return refOf(node, kind)?.$refText ?? null;
}

/** Candidate target names for the rebind Select. */
export function rebindTargets(ast: Model, kind: RebindKind): string[] {
  const wantType = targetKindOf(kind) === "subdomain" ? "Subdomain" : "Aggregate";
  const out = new Set<string>();
  for (const n of AstUtils.streamAst(ast)) {
    const name = (n as { name?: unknown }).name;
    if (n.$type === wantType && typeof name === "string") out.add(name);
  }
  return [...out].sort();
}

export function rebindReference(
  source: string,
  kind: RebindKind,
  name: string,
  newTarget: string,
): string | null {
  const fresh = parseDdd(source);
  if (fresh.parserErrors.length > 0) return null;
  const node = findConstruct(fresh.ast, kind, name);
  if (!node) return null;
  const ref = refOf(node, kind);
  if (!ref?.$refNode) return null;
  return applyEdits(source, [{ offset: ref.$refNode.offset, end: ref.$refNode.end, newText: newTarget }]);
}

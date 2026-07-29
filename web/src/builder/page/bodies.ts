import { AstUtils } from "langium";
import type { BodyProp, Component, Expression, Page } from "../../../../src/language/generated/ast.js";

// Collecting the editable page/component bodies out of a parsed `.ddd` AST.
// Lives apart from `BuilderPane.tsx` so it stays a pure, testable module (the
// pane itself pulls in craft.js + Mantine).

export interface BodyEntry {
  name: string;
  /** The body expression (its CST range is the splice target). */
  expr: Expression;
  /** The owning `Page` (absent for `component` bodies) — drives the state editor. */
  page?: Page;
}

// Every editable body: a `page`'s `body:` and a `component`'s `body:` both
// project a single expression onto the canvas.
//
// The builder re-parses on a 350 ms debounce while the user types in the
// Source tab, so it sees partially-recovered ASTs constantly: Langium error
// recovery keeps a `BodyProp` whose expression it couldn't parse, with
// `expr === undefined`.  Such a body isn't projectable, so it's dropped here
// rather than dereferenced by the pane's memos (which run before the
// `parserErrors` guard — React hooks must run unconditionally).
export function collectBodies(ast: unknown): BodyEntry[] {
  const out: BodyEntry[] = [];
  for (const node of AstUtils.streamAst(ast as Parameters<typeof AstUtils.streamAst>[0])) {
    if (node.$type === "Page") {
      const body = (node as Page).props?.find((p): p is BodyProp => p.$type === "BodyProp");
      if (body?.expr) out.push({ name: (node as Page).name, expr: body.expr, page: node as Page });
    } else if (node.$type === "Component") {
      // Extern components have no `body:` (their rendering lives in a
      // hand-written module), so there's nothing to project onto the canvas.
      const comp = node as Component;
      if (comp.body) out.push({ name: comp.name, expr: comp.body });
    }
  }
  return out;
}

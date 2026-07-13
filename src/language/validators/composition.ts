// Project composition — top-level system declarations (a `subdomain`, or
// the deployment shape: `deployable` / `storage` / `resource` / `ui` /
// `theme` / `user` / `api` / `layout` / `test e2e`) fold into the project's
// single `system { }` block (docs/old/proposals/implicit-system-composition.md).
// This check enforces the "exactly one system" precondition so a stray
// top-level declaration fails with a friendly message instead of silently
// generating nothing.
//
// A bare top-level `context` is intentionally NOT flagged here: with zero
// systems it keeps its legacy single-deployable meaning (loose context).

import { type AstNode, AstUtils, type URI, UriUtils, type ValidationAcceptor } from "langium";
import type { DddServices } from "../ddd-module.js";
import type { Model } from "../generated/ast.js";
import {
  isApi,
  isChannelSource,
  isDeployable,
  isLayout,
  isResource,
  isStorage,
  isSubdomain,
  isSystem,
  isTestE2E,
  isThemeBlock,
  isUi,
  isUserBlock,
} from "../generated/ast.js";

/** URI strings of every document in the import-connected component of
 *  `model`'s document — following `import "…"` edges in BOTH directions (a
 *  `system` may live in a file that imports this one, or one this one imports).
 *  Documents in an UNRELATED project (no import path connecting them) are
 *  excluded, so two independent single-system projects loaded into the same
 *  LSP workspace don't spuriously count each other's `system` (C12). */
function importClosure(model: Model, services: DddServices): Set<string> {
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    (adj.get(a) ?? adj.set(a, new Set()).get(a)!).add(b);
    (adj.get(b) ?? adj.set(b, new Set()).get(b)!).add(a);
  };
  for (const doc of services.shared.workspace.LangiumDocuments.all) {
    const root = doc.parseResult?.value as Model | undefined;
    const fromKey = doc.uri.toString();
    if (!adj.has(fromKey)) adj.set(fromKey, new Set());
    for (const imp of root?.imports ?? []) {
      if (!imp.path) continue;
      let to: URI;
      try {
        to = UriUtils.resolvePath(UriUtils.dirname(doc.uri), imp.path);
      } catch {
        continue;
      }
      link(fromKey, to.toString());
    }
  }
  const start = AstUtils.getDocument(model).uri.toString();
  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const nb of adj.get(cur) ?? []) {
      if (!seen.has(nb)) {
        seen.add(nb);
        queue.push(nb);
      }
    }
  }
  return seen;
}

/** The `Model` roots of every OTHER document that composes with `model` — its
 *  import closure (C12).  Empty in the single-document path (`services`
 *  absent), so unit-test callers keep the local-only count. */
function composedRoots(model: Model, services: DddServices | undefined): Model[] {
  if (!services) return [];
  const closure = importClosure(model, services);
  const out: Model[] = [];
  for (const doc of services.shared.workspace.LangiumDocuments.all) {
    const root = doc.parseResult?.value as Model | undefined;
    if (!root || root === model) continue;
    if (!closure.has(doc.uri.toString())) continue;
    out.push(root);
  }
  return out;
}

/** The keyword a foldable top-level member reads as in source — used to
 *  phrase the diagnostic.  Returns undefined for a node that is not a
 *  composition-requiring top-level system member. */
function foldableKeyword(m: AstNode): string | undefined {
  if (isSubdomain(m)) return "subdomain";
  if (isDeployable(m)) return "deployable";
  if (isStorage(m)) return "storage";
  if (isResource(m)) return "resource";
  if (isChannelSource(m)) return "channelSource";
  if (isUi(m)) return "ui";
  if (isThemeBlock(m)) return "theme";
  if (isUserBlock(m)) return "user";
  if (isApi(m)) return "api";
  if (isLayout(m)) return "layout";
  if (isTestE2E(m)) return "test e2e";
  return undefined;
}

export function checkTopLevelDomainComposition(
  model: Model,
  accept: ValidationAcceptor,
  services?: DddServices,
): void {
  const foldable = model.members.filter((m) => foldableKeyword(m) !== undefined);
  if (foldable.length === 0) return;

  // Count `system { }` blocks across the project's IMPORT CLOSURE (this
  // document plus every other document reachable through `import` edges) —
  // NOT every loaded document, which would fold in an unrelated project's
  // system in a multi-project workspace (C12).  Composition needs exactly
  // one — it is the fold target.
  let systemCount = model.members.filter(isSystem).length;
  for (const root of composedRoots(model, services)) {
    systemCount += root.members.filter(isSystem).length;
  }
  if (systemCount === 1) return;

  const reason =
    systemCount === 0
      ? "the project declares no 'system { ... }' block"
      : `the project declares ${systemCount} 'system { ... }' blocks`;
  for (const node of foldable) {
    const kw = foldableKeyword(node);
    accept(
      "error",
      `A top-level '${kw}' composes into the project's single 'system', but ${reason}. ` +
        "Declare exactly one 'system { ... }' across the import graph (it may hold just the name, theme, user and deployment), or nest this declaration inside it.",
      { node, code: "loom.top-level-domain-needs-single-system" },
    );
  }
}

/** `user { }` / `theme { }` blocks reachable in a document — at file top
 *  level (a `ModelMember`) or nested directly in a `system { }`.  Those are
 *  the only two positions the grammar admits them. */
function collectBlocks<T extends AstNode>(model: Model, pred: (n: AstNode) => n is T): T[] {
  const out: T[] = [];
  for (const m of model.members) {
    if (pred(m)) out.push(m);
    else if (isSystem(m)) for (const sm of m.members) if (pred(sm)) out.push(sm);
  }
  return out;
}

/** A composed project has exactly one `system`, so it admits at most one
 *  `user { }` and one `theme { }` — whether written nested in the system or
 *  at file top level, in any file of the import graph.  The lowering pre-pass
 *  would otherwise silently keep only the last; flag the duplicates instead.
 *  Skipped for zero- or multi-system projects (a multi-system project gives
 *  each system its own singletons; that case is out of composition scope). */
export function checkProjectSingletons(
  model: Model,
  accept: ValidationAcceptor,
  services?: DddServices,
): void {
  const localUser = collectBlocks(model, isUserBlock);
  const localTheme = collectBlocks(model, isThemeBlock);
  if (localUser.length === 0 && localTheme.length === 0) return;

  let systemCount = model.members.filter(isSystem).length;
  let userCount = localUser.length;
  let themeCount = localTheme.length;
  // Scope to the import closure, not every loaded document (C12).
  for (const root of composedRoots(model, services)) {
    systemCount += root.members.filter(isSystem).length;
    userCount += collectBlocks(root, isUserBlock).length;
    themeCount += collectBlocks(root, isThemeBlock).length;
  }
  if (systemCount !== 1) return;

  if (userCount > 1) {
    for (const node of localUser) {
      accept(
        "error",
        `The project declares ${userCount} 'user { ... }' blocks, but a system admits at most one. ` +
          "Keep a single user block (it may live in any file that composes into the system).",
        { node, code: "loom.duplicate-user-block" },
      );
    }
  }
  if (themeCount > 1) {
    for (const node of localTheme) {
      accept(
        "error",
        `The project declares ${themeCount} 'theme { ... }' blocks, but a system admits at most one. ` +
          "Keep a single theme block (it may live in any file that composes into the system).",
        { node, code: "loom.duplicate-theme-block" },
      );
    }
  }
}

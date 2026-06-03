// Project composition — top-level system declarations (a `subdomain`, or
// the deployment shape: `deployable` / `storage` / `resource` / `ui` /
// `theme` / `user` / `api` / `layout` / `test e2e`) fold into the project's
// single `system { }` block (docs/proposals/implicit-system-composition.md).
// This check enforces the "exactly one system" precondition so a stray
// top-level declaration fails with a friendly message instead of silently
// generating nothing.
//
// A bare top-level `context` is intentionally NOT flagged here: with zero
// systems it keeps its legacy single-deployable meaning (loose context).

import type { AstNode, ValidationAcceptor } from "langium";
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

  // Count `system { }` blocks across the whole project (this document plus
  // every other loaded document in the import graph).  Composition needs
  // exactly one — it is the fold target.
  let systemCount = model.members.filter(isSystem).length;
  if (services) {
    for (const doc of services.shared.workspace.LangiumDocuments.all) {
      const root = doc.parseResult?.value as Model | undefined;
      if (!root || root === model) continue;
      systemCount += root.members.filter(isSystem).length;
    }
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

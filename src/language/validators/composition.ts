// Project composition — top-level `subdomain` declarations fold into the
// project's single `system { }` block (see
// docs/proposals/implicit-system-composition.md).  This check enforces the
// "exactly one system" precondition so a stray top-level subdomain fails
// with a friendly message instead of silently generating nothing (it would
// land in the legacy loose-context bucket no deployable hosts).

import type { ValidationAcceptor } from "langium";
import type { DddServices } from "../ddd-module.js";
import type { Model } from "../generated/ast.js";
import { isSubdomain, isSystem } from "../generated/ast.js";

export function checkTopLevelDomainComposition(
  model: Model,
  accept: ValidationAcceptor,
  services?: DddServices,
): void {
  const topLevelSubdomains = model.members.filter(isSubdomain);
  if (topLevelSubdomains.length === 0) return;

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
  for (const sd of topLevelSubdomains) {
    accept(
      "error",
      `A top-level 'subdomain' composes into the project's single 'system', but ${reason}. ` +
        "Declare exactly one 'system { ... }' across the import graph (it may hold just the name, theme, user and deployment), or nest this subdomain inside it.",
      { node: sd, property: "name", code: "loom.top-level-domain-needs-single-system" },
    );
  }
}

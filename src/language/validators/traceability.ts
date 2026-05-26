// Traceability artifact validators — `requirement` declarations.
// Validates allowed property keys / required props / enum values,
// and detects parent-chain cycles.

import type { ValidationAcceptor } from "langium";
import type { Model, Requirement } from "../generated/ast.js";

/** Validate `requirement` traceability artifacts: the `type`,
 *  `title`, `status` and `priority` keys, and that each declared
 *  `type`/`status` is one of the known enum values. */
export function checkTraceability(model: Model, accept: ValidationAcceptor): void {
  const ALLOWED_KEYS = new Set(["type", "title", "status", "priority"]);
  const TYPES = new Set(["UserStory", "UseCase", "AcceptanceCriteria", "BusinessReq"]);
  const STATUSES = new Set(["Draft", "Approved", "InProgress", "Done"]);

  const requirements = model.members.filter((m): m is Requirement => m.$type === "Requirement");

  for (const req of requirements) {
    const seen = new Set<string>();
    let hasType = false;
    let hasTitle = false;
    for (const p of req.props) {
      if (!ALLOWED_KEYS.has(p.name)) {
        accept(
          "error",
          `Unknown requirement property '${p.name}'; expected one of type, title, status, priority.`,
          { node: p, property: "name" },
        );
        continue;
      }
      if (seen.has(p.name)) {
        accept("error", `Duplicate requirement property '${p.name}'.`, {
          node: p,
          property: "name",
        });
      }
      seen.add(p.name);

      const v = p.value;
      if (p.name === "type") {
        hasType = true;
        const name = v?.$type === "NameRef" ? (v as { name: string }).name : undefined;
        if (!name || !TYPES.has(name)) {
          accept(
            "error",
            `requirement type must be one of UserStory, UseCase, AcceptanceCriteria, BusinessReq.`,
            { node: p, property: "value" },
          );
        }
      } else if (p.name === "status") {
        const name = v?.$type === "NameRef" ? (v as { name: string }).name : undefined;
        if (!name || !STATUSES.has(name)) {
          accept("error", `requirement status must be one of Draft, Approved, InProgress, Done.`, {
            node: p,
            property: "value",
          });
        }
      } else if (p.name === "title") {
        hasTitle = true;
        if (v?.$type !== "StringLit") {
          accept("error", `requirement title must be a string literal.`, {
            node: p,
            property: "value",
          });
        }
      } else if (p.name === "priority") {
        if (v?.$type !== "IntLit") {
          accept("error", `requirement priority must be an integer.`, {
            node: p,
            property: "value",
          });
        }
      }
    }
    if (!hasType) {
      accept("error", `requirement '${req.name}' is missing the required 'type' property.`, {
        node: req,
        property: "name",
      });
    }
    if (!hasTitle) {
      accept("error", `requirement '${req.name}' is missing the required 'title' property.`, {
        node: req,
        property: "name",
      });
    }
  }

  // Parent acyclicity — walk the parent chain from each requirement
  // and flag the first node that re-enters a requirement already on
  // its own path.
  for (const req of requirements) {
    const path = new Set<string>([req.name]);
    let cur = req.parent?.ref;
    while (cur) {
      if (path.has(cur.name)) {
        accept("error", `requirement '${req.name}' has a cyclic parent chain.`, {
          node: req,
          property: "parent",
        });
        break;
      }
      path.add(cur.name);
      cur = cur.parent?.ref;
    }
  }
}

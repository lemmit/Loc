// Builder-call resolution (BuilderCall.type is a bare string, not a
// cross-reference) and v2 legacy `Name(args)` rejection for VOs /
// EntityParts.

import { AstUtils, type ValidationAcceptor } from "langium";
import type { DddServices } from "../ddd-module.js";
import type { BuilderCall, EntityPart, Model, NameRef, Ui } from "../generated/ast.js";
import {
  isAggregate,
  isBoundedContext,
  isCallSuffix,
  isComponent,
  isPayloadDecl,
  isPostfixChain,
  isValueObject,
} from "../generated/ast.js";
import { isWalkerPrimitive } from "../walker-stdlib.js";

/** v2 hard cut: reject `Name(args)` invocation forms that v2 replaces
 *  with BuilderCall.  Post grammar flatten, the AST shape is a
 *  `PostfixChain` whose first suffix is a `CallSuffix` and whose head
 *  is a bare `NameRef`.  When `Name` resolves to a ValueObject or
 *  EntityPart in the enclosing context, those constructions must use
 *  `Name { slot: value, ... }` syntax now. */
export function checkLegacyConstructorCalls(model: Model, accept: ValidationAcceptor): void {
  for (const node of AstUtils.streamAllContents(model)) {
    if (!isPostfixChain(node)) continue;
    const first = node.suffixes[0];
    if (!first || !isCallSuffix(first)) continue;
    const head = node.head;
    if (head.$type !== "NameRef") continue;
    const name = (head as NameRef).name;
    const ctx = AstUtils.getContainerOfType(node, isBoundedContext);
    if (!ctx) continue;
    for (const m of ctx.members) {
      if (isValueObject(m) && m.name === name) {
        accept(
          "error",
          `v2 syntax: construct '${name}' with builder-call form '${name} { ... }', not '${name}(...)'.`,
          { node, code: "loom.legacy-vo-call" },
        );
        break;
      }
      if (isAggregate(m)) {
        for (const inner of m.members) {
          if (inner.$type === "EntityPart" && (inner as EntityPart).name === name) {
            accept(
              "error",
              `v2 syntax: construct entity part '${name}' with builder-call form '${name} { ... }', not '${name}(...)'.`,
              { node, code: "loom.legacy-part-call" },
            );
            break;
          }
        }
      }
    }
  }
}

/** v2 BuilderCall type names are bare strings (no cross-reference) —
 *  resolve them at validation time and reject unknown names with a
 *  diagnostic listing the four admissible categories.
 *
 *  When `services` is provided the lookup falls through to the
 *  workspace-wide index for top-level components declared in
 *  another `.ddd` document; without it (single-document path,
 *  e.g. unit tests) only the document under validation is consulted. */
export function checkBuilderCallType(
  model: Model,
  accept: ValidationAcceptor,
  services?: DddServices,
): void {
  for (const node of AstUtils.streamAllContents(model)) {
    if (node.$type !== "BuilderCall") continue;
    const bc = node as BuilderCall;
    const name = bc.type;
    // 1. Walker primitive (stdlib).
    if (isWalkerPrimitive(name)) continue;
    // 2. VO / EntityPart in enclosing context.
    const ctx = AstUtils.getContainerOfType(bc, isBoundedContext);
    if (ctx) {
      let resolved = false;
      for (const m of ctx.members) {
        if (isValueObject(m) && m.name === name) {
          resolved = true;
          break;
        }
        // A record payload (`payload`/`command`/`query`/`response`/`error` with
        // fields, not a named `= A | B` union) is a structural record, so it's
        // constructible by the same builder-call form — `NotFound { resource:
        // … }`.  This is the producer-side surface for exception-less returns
        // (exception-less.md); lowering routes the name to an `object` ExprIR.
        if (isPayloadDecl(m) && m.name === name && m.variants.length === 0) {
          resolved = true;
          break;
        }
        if (isAggregate(m)) {
          for (const inner of m.members) {
            if (inner.$type === "EntityPart" && (inner as EntityPart).name === name) {
              resolved = true;
              break;
            }
          }
          if (resolved) break;
        }
      }
      if (resolved) continue;
    }
    // 2b. Root-level value object declared at the top of the SAME document
    //     (the ambient shared kernel — `valueobject` outside any context).
    //     The enclosing context's VOs are checked above; this adds the
    //     file-level ones so `Money { … }` resolves when `Money` is
    //     declared at model scope.  Cross-document root VOs are not
    //     constructible by bare name (the builder-call type is a plain
    //     string, not a linked reference), so only the local document is
    //     consulted — matching the lowering resolver
    //     (`findValueObjectByName` in src/ir/lower/lower-types.ts).
    if (model.members.some((m) => isValueObject(m) && (m as { name: string }).name === name)) {
      continue;
    }
    // 3. User-defined component in enclosing UI (ui-scope wins on
    //    name collision with a top-level component declared in the
    //    same workspace).
    const ui = AstUtils.getContainerOfType(bc, (n): n is Ui => n.$type === "Ui");
    if (ui) {
      const userComp = ui.members.some(
        (m) => m.$type === "Component" && (m as { name: string }).name === name,
      );
      if (userComp) continue;
    }
    // 4. Top-level component (declared as a `ModelMember` rather than
    //    inside a `ui { … }`).  Workspace-wide via the import-graph
    //    walk; matches by bare name.  Local document checked first
    //    (avoids paying for index lookup when the call lives in the
    //    same file as the declaration); if missing, the workspace
    //    index is consulted so a multi-file project sees a component
    //    declared in any imported sibling.
    const localTopLevel = (model as Model).members.some(
      (m) => isComponent(m) && (m as { name: string }).name === name,
    );
    if (localTopLevel) continue;
    if (services) {
      const index = services.shared.workspace.IndexManager;
      // Don't filter by node type at the index level: a typo-tolerant
      // lookup keeps the surface honest even if the description's
      // `type` doesn't match exactly.  Component descriptions exported
      // by `DddScopeComputation.computeExports` carry the bare name,
      // so a name match is sufficient (the corresponding node is
      // checked below to be a Component).
      let workspaceTopLevel = false;
      for (const desc of index.allElements()) {
        if (desc.name !== name) continue;
        if (desc.type === "Component") {
          workspaceTopLevel = true;
          break;
        }
      }
      if (workspaceTopLevel) continue;
    }
    accept(
      "error",
      `Unknown builder type '${name}'. Expected a ValueObject, EntityPart, user-defined component, or stdlib walker primitive (e.g., Stack, Form, Card).`,
      { node: bc, property: "type", code: "loom.unknown-builder-type" },
    );
  }
}

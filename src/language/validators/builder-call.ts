// Builder-call resolution (BuilderCall.type is a bare string, not a
// cross-reference) and v2 legacy `Name(args)` rejection for VOs /
// EntityParts.

import { AstUtils, type ValidationAcceptor } from "langium";
import type {
  BuilderCall,
  EntityPart,
  Model,
  NameRef,
  Ui,
} from "../generated/ast.js";
import {
  isAggregate,
  isBoundedContext,
  isCallSuffix,
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
 *  diagnostic listing the four admissible categories. */
export function checkBuilderCallType(model: Model, accept: ValidationAcceptor): void {
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
    // 3. User-defined component in enclosing UI.
    const ui = AstUtils.getContainerOfType(bc, (n): n is Ui => n.$type === "Ui");
    if (ui) {
      const userComp = ui.members.some(
        (m) => m.$type === "Component" && (m as { name: string }).name === name,
      );
      if (userComp) continue;
    }
    accept(
      "error",
      `Unknown builder type '${name}'. Expected a ValueObject, EntityPart, user-defined component, or stdlib walker primitive (e.g., Stack, Form, Card).`,
      { node: bc, property: "type", code: "loom.unknown-builder-type" },
    );
  }
}

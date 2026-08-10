// Payload-declaration checks (payload-transport-layer.md, phase P1).
//
// Model-level so the name-collision rule can see a context's payloads
// alongside its value objects and events — all three are structural type
// names that share a namespace and would be ambiguous if duplicated.
// P1 payloads are flat structural records; union / generic rules arrive
// with P3 / P4, so the checks here are deliberately narrow: name
// uniqueness and well-formed field lists.

import { AstUtils, type ValidationAcceptor } from "langium";
import { diagMessage } from "../../diagnostics/messages.js";
import type { BoundedContext, Model } from "../generated/ast.js";
import { isBoundedContext, isEventDecl, isPayloadDecl, isValueObject } from "../generated/ast.js";

export function checkPayloads(model: Model, accept: ValidationAcceptor): void {
  for (const node of AstUtils.streamAllContents(model)) {
    if (isBoundedContext(node)) checkContextPayloads(node, accept);
  }
}

function checkContextPayloads(ctx: BoundedContext, accept: ValidationAcceptor): void {
  // Names already taken by value objects / events in this context — a
  // payload may not collide with them (shared structural-type namespace).
  const peerNames = new Map<string, string>();
  for (const m of ctx.members) {
    if (isValueObject(m)) peerNames.set(m.name, "value object");
    else if (isEventDecl(m)) peerNames.set(m.name, "event");
  }

  const seen = new Set<string>();
  for (const m of ctx.members) {
    if (!isPayloadDecl(m)) continue;

    // Rule 1 — no two payloads in a context share a name, and a payload
    // may not shadow a value object / event of the same name.
    if (seen.has(m.name)) {
      accept(
        "error",
        diagMessage("loom.payload-name-conflict#duplicate-payload-in-context", {
          name: m.name,
          ctxName: ctx.name,
        }),
        {
          node: m,
          property: "name",
          code: "loom.payload-name-conflict",
        },
      );
    } else if (peerNames.has(m.name)) {
      accept(
        "error",
        diagMessage("loom.payload-name-conflict#payload-collides-with-a", {
          name: m.name,
          peerNames: peerNames.get(m.name),
          ctxName: ctx.name,
        }),
        { node: m, property: "name", code: "loom.payload-name-conflict" },
      );
    }
    seen.add(m.name);

    // Rule 2 — field names within a payload must be distinct.
    const fieldNames = new Set<string>();
    for (const f of m.fields) {
      if (fieldNames.has(f.name)) {
        accept(
          "error",
          diagMessage("loom.payload-duplicate-field", { name: f.name, mName: m.name }),
          {
            node: f,
            property: "name",
            code: "loom.payload-duplicate-field",
          },
        );
      }
      fieldNames.add(f.name);
    }
  }
}

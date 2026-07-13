// Feliz frontend — fail-fast on unrenderable action/update constructs
// (M-T6.15, docs/new-plan/T6-backend-parity.md).
//
// The MVU `update` arm (update-emit.ts) and the F# expression renderer
// (fs-expr.ts) used to SILENTLY drop what they couldn't render: an action
// statement kind they didn't handle became `// TODO feliz update: <kind>`
// (control flow vanishes) and an expression kind they didn't handle became
// `(* unsupported *) ()` (the value is discarded to unit).  Both compile —
// producing a wrong-but-compiling F# app.  This pins that both now throw a
// fail-fast error naming the construct instead, matching the Feliz backend's
// existing fail-fast idiom (index.ts) and the shared walker-core.

import { describe, expect, it } from "vitest";
import { renderFsExpr } from "../../../src/generator/feliz/fs-expr.js";
import { renderUpdate } from "../../../src/generator/feliz/update-emit.js";
import type { ActionIR, ExprIR, StateFieldIR } from "../../../src/ir/types/loom-ir.js";

describe("feliz fail-fast (M-T6.15)", () => {
  it("throws on an unsupported expression kind instead of emitting `(* unsupported *) ()`", () => {
    // `new` is a real ExprIR kind the F# update/expr path does not render.
    const expr = {
      kind: "new",
      typeName: "Money",
      args: [],
    } as unknown as ExprIR;
    expect(() => renderFsExpr(expr, { stateNames: new Set(), locals: new Set() })).toThrow(
      /unsupported expression 'new'/,
    );
  });

  it("throws on an unsupported action statement instead of emitting a `// TODO` comment", () => {
    // An `emit` statement in an action body reaches the update-arm default.
    const state: StateFieldIR[] = [{ name: "count", type: { kind: "primitive", name: "int" } }];
    const action = {
      name: "fire",
      params: [],
      body: [{ kind: "emit", eventName: "Pinged", fields: [] }],
    } as unknown as ActionIR;
    expect(() => renderUpdate([action], state)).toThrow(/unsupported action statement 'emit'/);
  });

  it("still renders the supported update arms (`:=` / `let`) without throwing", () => {
    const state: StateFieldIR[] = [{ name: "count", type: { kind: "primitive", name: "int" } }];
    const action = {
      name: "inc",
      params: [],
      body: [
        {
          kind: "assign",
          target: { segments: ["count"] },
          value: {
            kind: "binary",
            op: "+",
            left: { kind: "ref", name: "count", refKind: "state" },
            right: { kind: "literal", lit: "int", value: "1" },
          },
          targetType: { kind: "primitive", name: "int" },
        },
      ],
    } as unknown as ActionIR;
    const out = renderUpdate([action], state);
    expect(out).toContain("| Inc ->");
    expect(out).toContain("{ model with Count = (model.Count + 1) }");
    expect(out).not.toContain("// TODO feliz update");
  });
});

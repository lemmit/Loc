// Named-action lowering (named-actions-and-stores.md, Proposal A Stage 1).
// `action name(p: T) { … }` lowers to an `ActionIR` on the page/component
// (name + ParamIR[] + StmtIR[] body, the same statement set an anonymous
// handler block lowers to).  A bare handler-arg reference (`onSubmit: setName`)
// lowers to a fully-resolved `action-ref` ExprIR carrying the resolved action
// name + its declared payload param type — so backends never re-resolve.

import { describe, expect, it } from "vitest";
import type { ExprIR } from "../../src/ir/types/loom-ir.js";
import { buildLoomModel } from "../_helpers/ir.js";

const SYS = `
  system Demo {
    subdomain S { context C { aggregate Customer { name: string } } }
    ui Web {
      page NewCustomer {
        route: "/new"
        state { step: int = 0  draft: string = "" }
        action next() { step := step + 1 }
        action setName(c: Customer) { draft := c.name }
        body: Stack {
          Table { onRowClick: setName }
        }
      }
      component Counter() {
        state { n: int = 0 }
        action bump() { n := n + 1 }
        body: Stack { Button { "Bump", onClick: bump } }
      }
    }
    deployable api { platform: node, contexts: [C], port: 3000 }
    deployable web { platform: react, targets: api, ui: Web, port: 3001 }
  }
`;

/** Find the first `action-ref` ExprIR anywhere in a body tree. */
function findActionRef(e: ExprIR | undefined): (ExprIR & { kind: "action-ref" }) | undefined {
  if (!e) return undefined;
  if (e.kind === "action-ref") return e;
  const kids: (ExprIR | undefined)[] = [];
  if ("args" in e && Array.isArray(e.args)) kids.push(...e.args);
  if ("receiver" in e) kids.push(e.receiver as ExprIR);
  if ("elements" in e && Array.isArray(e.elements)) kids.push(...(e.elements as ExprIR[]));
  for (const k of kids) {
    const hit = findActionRef(k);
    if (hit) return hit;
  }
  return undefined;
}

describe("named-action lowering", () => {
  it("populates `actions` on the lowered Page and Component", async () => {
    const model = await buildLoomModel(SYS);
    const ui = model.systems[0]!.uis[0]!;
    const page = ui.pages.find((p) => p.name === "NewCustomer")!;
    expect(page.actions.map((a) => a.name)).toEqual(["next", "setName"]);
    // Nullary vs single-payload arity; the body is a StmtIR[].
    expect(page.actions[0]!.params).toHaveLength(0);
    expect(page.actions[0]!.body[0]!.kind).toBe("assign");
    expect(page.actions[1]!.params[0]!.type).toEqual({ kind: "entity", name: "Customer" });

    const comp = ui.components.find((c) => c.name === "Counter")!;
    expect(comp.actions.map((a) => a.name)).toEqual(["bump"]);
  });

  it("lowers a bare `onRowClick: setName` to a resolved action-ref carrying the param type", async () => {
    const model = await buildLoomModel(SYS);
    const page = model.systems[0]!.uis[0]!.pages.find((p) => p.name === "NewCustomer")!;
    const ref = findActionRef(page.body);
    expect(ref).toBeDefined();
    expect(ref!.actionName).toBe("setName");
    // The action's declared payload type rides on the ref — backends + the
    // validator read it directly rather than re-resolving the name.
    expect(ref!.paramType).toEqual({ kind: "entity", name: "Customer" });
  });

  it("lowers a bare `onClick: bump` (nullary) to an action-ref with no param type", async () => {
    const model = await buildLoomModel(SYS);
    const comp = model.systems[0]!.uis[0]!.components.find((c) => c.name === "Counter")!;
    const ref = findActionRef(comp.body);
    expect(ref).toBeDefined();
    expect(ref!.actionName).toBe("bump");
    expect(ref!.paramType).toBeUndefined();
  });
});

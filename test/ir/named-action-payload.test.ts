// Named-action payload conformance (named-actions-and-stores.md, Proposal A
// Stage 1).  A bare action reference in a handler slot must match (arity)
// what the call-site primitive supplies.  One stable code:
// `loom.action-payload-mismatch`.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

async function payloadErrors(uiBody: string): Promise<string[]> {
  const source = `
    system Demo {
      subdomain S { context C { aggregate Customer { name: string } } }
      ui Web { ${uiBody} }
      deployable api { platform: node, contexts: [C], port: 3000 }
      deployable web { platform: react, targets: api, ui: Web, port: 3001 }
    }
  `;
  const { model } = await parseString(source, { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model)))
    .filter((d) => d.severity === "error" && d.code === "loom.action-payload-mismatch")
    .map((d) => d.message);
}

describe("named-action payload conformance (`loom.action-payload-mismatch`)", () => {
  it("flags a `Form { into:, onSubmit: <arity-1 action> }` — a two-way binding supplies no payload", async () => {
    const errs = await payloadErrors(`
      page P {
        route: "/p"
        state { draft: Customer = {} }
        action save(c: Customer) { draft := c }
        body: Stack { CreateForm { of: Customer, into: draft, onSubmit: save } }
      }
    `);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("save");
    expect(errs[0]).toContain("nullary");
  });

  it("flags a `Form` (no `into:`) bound to a nullary action — the supplied value has nowhere to land", async () => {
    const errs = await payloadErrors(`
      page P {
        route: "/p"
        state { done: bool = false }
        action finish() { done := true }
        body: Stack { CreateForm { of: Customer, onSubmit: finish } }
      }
    `);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("finish");
  });

  it("accepts a conformant pairing — `into:` two-way binding with a nullary action", async () => {
    const errs = await payloadErrors(`
      page P {
        route: "/p"
        state { draft: Customer = {}  step: int = 0 }
        action next() { step := step + 1 }
        body: Stack { CreateForm { of: Customer, into: draft, onSubmit: next } }
      }
    `);
    expect(errs).toHaveLength(0);
  });
});

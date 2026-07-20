// Feliz frontend — nested page-state writes (`draft.address.zip := v`).
//
// Previously the MVU `update` arm read only `segments[0]` and emitted the
// silently-wrong `{ model with Draft = z }` (a string assigned to a record
// field).  Now a multi-segment target folds into a nested F# record `with`
// update — the ROOT segment is the Model field (PascalCase, via
// `targetModelField`), NESTED segments are wire-record fields (exact lowercase
// source names).  The Feliz twin of React's inside-out spread / Flutter's
// `copyWith` chain.
//
// NOTE: record-typed page state is otherwise not yet end-to-end functional on
// Feliz (the referenced value-object records are only emitted when reachable via
// a read, and the no-init default is a placeholder) — this pins the WRITE
// emission, the same way React's walker-multiseg-state test pins the `.tsx`
// output without a full compile.

import { describe, expect, it } from "vitest";
import { generateFelizForContexts } from "../../../src/generator/feliz/index.js";
import { buildLoomModel } from "../../_helpers/ir.js";

const SYS = `
system P {
  subdomain S { context C {
    valueobject Address { zip: string  city: string }
    valueobject Shipping { address: Address  method: string }
  } }
  ui WebApp {
    page Edit {
      route: "/edit"
      state { draft: Shipping }
      action setZip(z: string) { draft.address.zip := z }
      action setMethod(m: string) { draft.method := m }
      body: Stack { Heading { "H", level: 1 }, Button { "b", onClick: setMethod } }
    }
  }
  deployable api { platform: node contexts: [C] port: 3000 }
  deployable web { platform: feliz targets: api ui: WebApp port: 3005 }
}`;

async function app(): Promise<string> {
  const model = await buildLoomModel(SYS);
  const sys = model.systems[0]!;
  const web = sys.deployables.find((d) => d.name === "web")!;
  return generateFelizForContexts([], sys, web).get("src/App.fs")!;
}

describe("feliz nested page-state writes", () => {
  it("folds a 3-segment write into a nested record `with` chain", async () => {
    const fs = await app();
    // draft.address.zip := z → nested `with`, root Model field PascalCase, nested
    // wire fields lowercase.
    expect(fs).toContain(
      "{ model with Draft = { model.Draft with address = { model.Draft.address with zip = z } } }",
    );
    // A 2-segment write is a one-level nested `with`.
    expect(fs).toContain("{ model with Draft = { model.Draft with method = m } }");
    // The old root-only (silently-wrong) form is gone.
    expect(fs).not.toContain("{ model with Draft = z }");
  });
});

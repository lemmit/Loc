// node/Hono — an aggregate OPERATION body that calls a domain service has to
// import the service namespace (F2-CB-C8).
//
// The call itself always rendered (`Rules.clamp(…)` — TS_TARGET's
// domain-service arm), and the workflow emitter has always imported the
// namespaces its bodies call.  The aggregate class emitter never did, so a
// service call from an OPERATION body emitted `this._quantity =
// Rules.clamp(…)` into a file whose whole import block was `Ids` + `Events`:
// TS2304 `Cannot find name 'Rules'`, i.e. an uncompilable project.  The corpus
// fixture only ever calls services from workflow bodies, so this site had never
// been compiled.  The other four backends import at this site.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SOURCE = `
system D {
  subdomain S {
    context C {
      domainService Rules { operation clamp(q: int): int { return q } }
      domainService Unused { operation noop(q: int): int { return q } }
      aggregate Order with crudish {
        quantity: int
        operation restock(by: int) { quantity := Rules.clamp(quantity + by) }
      }
      aggregate Plain with crudish { label: string }
      repository Orders for Order { }
      repository Plains for Plain { }
    }
  }
  api DApi from S
  storage pg { type: postgres }
  resource st { for: C, kind: state, use: pg }
  deployable d {
    platform: node
    contexts: [C]
    dataSources: [st]
    serves: DApi
    port: 4000
  }
}`;

describe("node aggregate class — domain-service import at the op-body site", () => {
  it("imports exactly the service namespaces the operation bodies call", async () => {
    const files = await generateSystemFiles(SOURCE);
    const order = files.get("d/domain/order.ts")!;
    // The call is there…
    expect(order).toContain("Rules.clamp(this._quantity + by)");
    // …and so is the import that makes it resolve.
    expect(order).toContain('import { Rules } from "./services";');
    // Narrowed to what the body actually calls — a declared-but-uncalled
    // service must not ride along (the generated-code lint gate rejects dead
    // names, and the VO/enum imports beside it are narrowed the same way).
    expect(order).not.toContain("Unused");

    // The CONTROL: an aggregate that calls no service keeps its header free of
    // the services module entirely.
    const plain = files.get("d/domain/plain.ts")!;
    expect(plain).not.toContain('from "./services"');
  });
});

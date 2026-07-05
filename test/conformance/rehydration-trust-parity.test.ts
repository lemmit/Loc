// RS-10 · Rehydration trusts the store — invariants guard transitions only.
//
// S6 of `docs/audits/generated-code-ddd-review-2026-07.md`: node and python
// construct domain objects on load, and their repositories used to hydrate
// through the invariant-asserting constructor — so tightening an invariant
// made every pre-existing row unreadable (every GET/findAll threw), including
// the fix-it update path.  Reconstituted state was valid when stored;
// invariants gate transitions.
//
// The fix is a NAMED non-asserting path, not a flag on `_create`: `_create`
// is also the in-operation part-construction call (`lines += Line{…}` renders
// `Line._create({…})`), which must keep asserting.  Repositories hydrate via
// `_rehydrate`; `create()` and every mutator assert as before.
//
// .NET/Java materialize via EF/JPA and elixir loads Ecto structs — those load
// paths never ran invariants, so the static pin covers the two constructing
// backends.  (The registry entry: test/conformance/semantics-rules.ts RS-10.)

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/generate.js";

/** An invariant-carrying aggregate with a mutator — the S6 shape. */
function system(platform: string): string {
  return `
system PS {
  subdomain D {
    context Shop {
      aggregate Order with crudish {
        code: string
        qty: int
        invariant qty >= 1
        operation bump(n: int) { qty := qty + n }
      }
      repository Orders for Order { }
    }
  }
  api A from D
  storage primary { type: postgres }
  resource st { for: Shop, kind: state, use: primary }
  deployable d { platform: ${platform}, contexts: [Shop], dataSources: [st], serves: A, port: 8080 }
}`;
}

describe("RS-10 · rehydration trusts the store (static, node + python)", () => {
  it("node: repo hydrates via non-asserting _rehydrate; create/ops still assert", async () => {
    const files = await generateSystemFiles(system("node"));
    const domain = files.get("d/domain/order.ts");
    const repo = files.get("d/db/repositories/order-repository.ts");
    expect(domain).toBeDefined();
    expect(repo).toBeDefined();
    // The repository's row→domain path uses _rehydrate, never the asserting
    // constructor path.
    expect(repo).toMatch(/Order\._rehydrate\(/);
    expect(repo).not.toMatch(/Order\._create\(/);
    // _rehydrate bypasses the invariant run (trust marker on the ctor)…
    expect(domain).toMatch(
      /_rehydrate\(state:.*\): Order \{\s*\n\s*return new Order\(state, true\)/,
    );
    expect(domain).toMatch(/if \(!trustStore\) \{\s*\n\s*this\._assertInvariants\(\)/);
    // …while the create factory and the mutating op still assert.
    expect(domain).toMatch(/static create\(/);
    const opBody = domain!.slice(domain!.indexOf("bump("));
    expect(opBody).toMatch(/_assertInvariants\(\)/);
  });

  it("python: repo hydrates via non-asserting _rehydrate; create/ops still assert", async () => {
    const files = await generateSystemFiles(system("python"));
    const domain = files.get("d/app/domain/order.py");
    const repo = files.get("d/app/db/repositories/order_repository.py");
    expect(domain).toBeDefined();
    expect(repo).toBeDefined();
    expect(repo).toMatch(/Order\._rehydrate\(/);
    expect(repo).not.toMatch(/Order\._create\(/);
    expect(domain).toMatch(/def _rehydrate\(/);
    expect(domain).toMatch(/_trust_store=True/);
    expect(domain).toMatch(/if not _trust_store:\s*\n\s*self\._assert_invariants\(\)/);
    expect(domain).toMatch(/def create\(/);
    const opBody = domain!.slice(domain!.indexOf("def bump("));
    expect(opBody).toMatch(/_assert_invariants\(\)/);
  });

  it("in-operation part construction keeps the asserting _create path (node)", async () => {
    const files = await generateSystemFiles(`
system PS {
  subdomain D {
    context Shop {
      aggregate Order {
        code: string
        contains lines: Line[]
        entity Line { sku: string }
        operation addLine(sku: string) { lines += Line { sku: sku } }
      }
      repository Orders for Order { }
    }
  }
  api A from D
  storage primary { type: postgres }
  resource st { for: Shop, kind: state, use: primary }
  deployable d { platform: node, contexts: [Shop], dataSources: [st], serves: A, port: 8080 }
}`);
    const domain = files.get("d/domain/order.ts");
    expect(domain).toBeDefined();
    // The op body builds the new part via the ASSERTING _create — a freshly
    // constructed part is a transition, not a load.
    expect(domain).toMatch(/Line\._create\(\{/);
  });
});

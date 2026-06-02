// Hono emission for the workflow `for` loop + `Repo.run` (PR3-B): the
// loop renders a `for…of` over the run-method result, mutating each
// element and saving it inside the loop.

import { describe, expect, it } from "vitest";
import { generateHono } from "../../_helpers/generate.js";
import { parseString } from "../../_helpers/parse.js";

const SRC = `
  context Sales {
    aggregate Customer {
      active: bool
      region: string
      name: string
      operation deactivate() { active := false }
    }
    repository Customers for Customer { }
    criterion InRegion(rgn: string) of Customer = region == rgn
    retrieval ByRegion(rgn: string) of Customer { where: InRegion(rgn) sort: [name asc] }

    workflow deactivateRegion(rgn: string) {
      let matched = Customers.run(ByRegion(rgn), page: { offset: 0, limit: 100 })
      for c in matched {
        c.deactivate()
      }
    }
  }
`;

describe("typescript generator — workflow for-loop + Repo.run", () => {
  it("renders Repo.run as the run method call with a page argument", async () => {
    const { model, errors } = await parseString(SRC);
    expect(errors).toEqual([]);
    const wf = generateHono(model).get("http/workflows.ts")!;
    expect(wf).toMatch(
      /const matched = await \w+\.runByRegion\(rgn, \{ offset: 0, limit: 100 \}\);/,
    );
  });

  it("renders the loop as for…of with a per-iteration save inside the body", async () => {
    const { model } = await parseString(SRC);
    const wf = generateHono(model).get("http/workflows.ts")!;
    // for (const c of matched) { c.deactivate(); await <repo>.save(c); }
    expect(wf).toMatch(/for \(const c of matched\) \{/);
    expect(wf).toMatch(/c\.deactivate\(\);/);
    expect(wf).toMatch(/await \w+\.save\(c\);/);
  });
});

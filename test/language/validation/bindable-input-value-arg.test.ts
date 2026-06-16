import { NodeFileSystem } from "langium/node";
import { parseHelper } from "langium/test";
import { describe, expect, it } from "vitest";
import { createDddServices } from "../../../src/language/ddd-module.js";

// A bindable input (Field/NumberField/Toggle/…) binds to page state via
// `bind:`.  Passing `value:` instead (the React habit) is silently ignored by
// the walker — the input renders uncontrolled and the state never wires up.
// Warn and suggest `bind:` so the silent no-op can't recur.

async function parse(source: string) {
  const services = createDddServices(NodeFileSystem);
  const doc = await parseHelper(services.Ddd)(source, { validation: true });
  const diags = doc.diagnostics ?? [];
  return {
    errors: diags.filter((d) => d.severity === 1).map((d) => d.message),
    warnings: diags.filter((d) => d.severity === 2).map((d) => d.message),
  };
}

const sys = (input: string) => `
system S {
  subdomain M { context C { aggregate Order { sku: string } repository Orders for Order { } } }
  api SalesApi from M
  ui WebApp {
    page P {
      route: "/p"
      state { draftName: string = "" }
      body: ${input}
    }
  }
  deployable api { platform: hono, contexts: [C], port: 3000 }
}
`;

describe("bindable input — value: vs bind:", () => {
  it("warns on `Field { value: <state> }` and suggests bind:", async () => {
    const { errors, warnings } = await parse(sys(`Field { "Name", value: draftName }`));
    expect(errors).toEqual([]);
    expect(warnings.some((w) => /bind/.test(w) && /value/.test(w))).toBe(true);
  });

  it("does not warn when bound correctly with `bind:`", async () => {
    const { warnings } = await parse(sys(`Field { "Name", bind: draftName }`));
    expect(warnings.some((w) => /Field.*bind.*value|value.*bind/.test(w))).toBe(false);
  });
});

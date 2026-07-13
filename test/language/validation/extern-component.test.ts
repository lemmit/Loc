import { describe, expect, it } from "vitest";
import { parseString } from "../../_helpers/parse.js";

// ---------------------------------------------------------------------------
// Extern component — the UI escape hatch (docs/old/proposals/
// extern-component-escape-hatch.md, Tier 1).  A
// `component X(...) extern from "<path>"` declares a typed param
// contract but no `body:`; the generator imports the hand-written
// module at call sites.  The grammar admits the `extern from` clause
// and an optional body; `checkComponent` pins the exclusivity:
//   - extern component MUST NOT declare a `body:`
//   - non-extern component MUST declare a `body:`
// ---------------------------------------------------------------------------

const wrap = (component: string) => `
  system S {
    subdomain M { context C { aggregate Order { customerId: string } } }
    ui WebApp {
      ${component}
      page Home { route: "/" body: Heading { "hi" } }
    }
    deployable api { platform: node, contexts: [C], port: 3000 }
    deployable web { platform: static, targets: api, ui: WebApp, port: 3001 }
  }
`;

describe("validator: extern component", () => {
  it("accepts an extern component with no body", async () => {
    const { errors } = await parseString(
      wrap(`component Chart(order: Order, height: int) extern from "widgets/chart"`),
    );
    expect(errors, errors.join("\n")).toEqual([]);
  });

  it("rejects an extern component that declares a body (loom.extern-component-has-body)", async () => {
    const { errors } = await parseString(
      wrap(`component Chart(height: int) extern from "widgets/chart" { body: Heading { "x" } }`),
    );
    expect(
      errors.some((e) => /Extern component 'Chart' must not declare a 'body:'/.test(e)),
      errors.join("\n"),
    ).toBe(true);
  });

  it("rejects a non-extern component with no body (loom.component-missing-body)", async () => {
    const { errors } = await parseString(wrap(`component Chart(height: int) { }`));
    expect(
      errors.some((e) => /Component 'Chart' requires a 'body:'/.test(e)),
      errors.join("\n"),
    ).toBe(true);
  });

  it("admits a slot param on an extern component", async () => {
    const { errors } = await parseString(
      wrap(`component Chart(order: Order, aside: slot?) extern from "widgets/chart"`),
    );
    expect(errors, errors.join("\n")).toEqual([]);
  });
});

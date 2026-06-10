// Multi-segment page-state mutation in event handlers.  Previously
// `order.shipping.zip := v` threw at generation ("only single-segment
// page-state fields"); now it lowers to the standard immutable
// nested-spread update — React state must be replaced, not mutated in
// place, or the component won't re-render.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const sys = (stateDecl: string, handler: string): string => `
  system S {
    subdomain M { context C { valueobject Address { city: string  zip: string } } }
    ui WebApp {
      page Form {
        route: "/form"
        state { ${stateDecl} }
        body: Stack {
          Button { "Go", onClick: e => { ${handler} } }
        }
      }
    }
    deployable api { platform: hono, contexts: [C], port: 3000 }
    deployable web { platform: static
      targets: api
      ui: WebApp
      port: 3001 }
  }
`;

describe("page handlers — multi-segment state mutation", () => {
  it("two segments: nested spread on the state root", async () => {
    const files = await generateSystemFiles(
      sys(`shipping: Address = Address { city: "", zip: "" }`, `shipping.zip := "10001"`),
    );
    const page = files.get("web/src/pages/form.tsx")!;
    expect(page).toContain('setShipping({ ...shipping, zip: "10001" });');
  });

  it("compound `+=` on a nested target reads the member chain", async () => {
    const files = await generateSystemFiles(
      sys(
        `shipping: Address = Address { city: "", zip: "" }`,
        `shipping.zip := shipping.zip + "!"`,
      ),
    );
    const page = files.get("web/src/pages/form.tsx")!;
    expect(page).toContain('setShipping({ ...shipping, zip: (shipping.zip + "!") });');
  });

  it("single segment keeps the plain setter (regression)", async () => {
    const files = await generateSystemFiles(sys(`count: int = 0`, `count += 1`));
    const page = files.get("web/src/pages/form.tsx")!;
    expect(page).toContain("setCount(count + 1);");
  });
});

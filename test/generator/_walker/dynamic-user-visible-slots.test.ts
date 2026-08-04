// A DYNAMIC user-visible slot binds; it does not vanish.
//
// Every named user-visible slot (`Alert.title`, `Divider.label`, `Button.label`
// → aria) was read with `literalString`, and a non-literal fell through to "no
// slot": `hasLabel`/`hasTitle` went false and the attribute fragment came back
// empty.  So `Divider { label: someState }` rendered a bare rule and
// `Button { icon: "trash", label: row.name }` rendered NO accessible name at
// all — on a control whose a11y contract says `needsName` (WCAG 4.1.2), with
// `loom.a11y-icon-only-no-name` staying quiet precisely BECAUSE a `label:` is
// present.  Nothing else caught it.
//
// A dynamic slot has no stable source string, so it is never translated — but
// it is still the author's user-visible text, so it binds as an expression.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const SYSTEM = (body: string, platform: string, pack: string): string => `
  system Shop {
    api ShopApi from Catalog
    subdomain Catalog {
      context Cat {
        aggregate Product { name: string }
        repository Products for Product { }
      }
    }
    storage db { type: postgres }
    resource s { for: Cat, kind: state, use: db }
    ui WebApp {
      api Shop: ShopApi
      page Home {
        route: "/"
        state { caption: string = "hi" }
        body: ${body}
      }
    }
    deployable api { platform: node contexts: [Cat] dataSources: [s] serves: ShopApi port: 3000 }
    deployable web {
      platform: ${platform} design: "${pack}" targets: api ui: WebApp { Shop: api } port: 3005
    }
  }
`;

async function pageOf(body: string, platform = "static", pack = "mantine"): Promise<string> {
  const files = await generateSystemFiles(SYSTEM(body, platform, pack));
  const entry = [...files].find(([p]) => /\/(pages|routes)\//.test(p) && !/\.spec\./.test(p));
  if (!entry) throw new Error("no page emitted");
  return entry[1];
}

describe("dynamic user-visible slots bind rather than vanish", () => {
  it("Divider: a dynamic label: still reaches the pack (mantine, attribute slot)", async () => {
    const page = await pageOf(`Divider { label: caption }`);
    expect(page).toMatch(/label=\{caption\}/);
  });

  it("Divider: a dynamic label: still reaches a TEXT-slot pack (mui)", async () => {
    const page = await pageOf(`Divider { label: caption }`, "static", "mui");
    expect(page).toContain("<Divider");
    expect(page).toContain("caption");
    // Not the unlabelled branch.
    expect(page).not.toMatch(/<Divider[^>]*\/>/);
  });

  it("Button: a dynamic label: is the accessible name (WCAG 4.1.2)", async () => {
    const page = await pageOf(`Button { icon: "trash", label: caption }`);
    expect(page).toMatch(/aria-label=\{caption\}/);
  });

  it("Button: a dynamic label: binds through Angular's attr. prefix", async () => {
    const page = await pageOf(
      `Button { icon: "trash", label: caption }`,
      "angular",
      "angularMaterial",
    );
    // Angular binds a plain HTML attribute as `[attr.aria-label]`; a bare
    // `[aria-label]` targets a non-existent property and fails `ng build`.
    expect(page).toMatch(/\[attr\.aria-label\]=/);
  });

  it("Alert: a dynamic title: still renders", async () => {
    const page = await pageOf(`Alert { "boom", title: caption }`);
    expect(page).toMatch(/title=\{caption\}/);
  });

  it("a dynamic slot is never translated — no stable source string", async () => {
    const page = await pageOf(`Divider { label: caption }`);
    expect(page).not.toContain("dividerLabel");
  });

  it("an ABSENT slot still renders the unlabelled branch (byte-identical)", async () => {
    const page = await pageOf(`Stack { Heading { "x" }, Divider { } }`);
    expect(page).toMatch(/<Divider[^>]*\/>/);
    expect(page).not.toContain("label=");
  });
});

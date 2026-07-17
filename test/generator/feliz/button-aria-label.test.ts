// Feliz Button — `label:` supplies an explicit accessible name, emitted as
// `prop.ariaLabel` (the F# analogue of aria-label).  The command's a11y
// contract needs a name; the visible text can be an unhelpful glyph or the
// default when the button leads with an `icon:`.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

async function appFs(body: string): Promise<string> {
  const files = await generateSystemFiles(`
    system Demo {
      subdomain S { context C { } }
      ui WebApp {
        framework: feliz
        page Home { route: "/" body: ${body} }
      }
      deployable api { platform: node contexts: [C] port: 3000 }
      deployable web { platform: feliz targets: api ui: WebApp port: 3005 }
    }
  `);
  return [...files.entries()].find(([p]) => p.endsWith("src/App.fs"))![1];
}

describe("feliz Button — label: → prop.ariaLabel (a11y)", () => {
  it("emits prop.ariaLabel from a Button label: hint", async () => {
    const app = await appFs(`Button { icon: "trash", label: "Delete item" }`);
    expect(app).toContain('prop.ariaLabel "Delete item"');
  });

  it("a plain text Button gets no ariaLabel (its text is the name)", async () => {
    const app = await appFs(`Button { "Save" }`);
    expect(app).not.toContain("prop.ariaLabel");
    expect(app).toContain('prop.text "Save"');
  });
});

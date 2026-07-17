import { NodeFileSystem } from "langium/node";
import { parseHelper } from "langium/test";
import { describe, expect, it } from "vitest";
import { createDddServices } from "../../../src/language/ddd-module.js";

// accessibility.md Phase 3 — a command `Button` whose only content is an
// `icon:` (no visible text, no `label:`) renders a bare glyph, so a screen
// reader announces the meaningless default "Button".  The button's a11y
// contract needs a name; the name is human content Loom can't derive, so warn
// (`loom.a11y-icon-only-no-name`, WCAG 4.1.2).  Visible text OR an explicit
// `label:` (emitted as aria-label) both satisfy it.

async function parse(source: string) {
  const services = createDddServices(NodeFileSystem);
  const doc = await parseHelper(services.Ddd)(source, { validation: true });
  const diags = doc.diagnostics ?? [];
  return {
    warnings: diags.filter((d) => d.severity === 2).map((d) => d.message),
    errors: diags.filter((d) => d.severity === 1).map((d) => d.message),
  };
}

const sys = (input: string) => `
system S {
  subdomain M { context C { } }
  ui WebApp {
    page P {
      route: "/p"
      body: ${input}
    }
  }
  deployable api { platform: node, contexts: [C], port: 3000 }
  deployable web { platform: static, targets: api, ui: WebApp, port: 3001 }
}
`;

const iconOnly = (msgs: string[]) =>
  msgs.some((m) => /no accessible name|WCAG 4\.1\.2/.test(m));

describe("a11y — icon-only Button accessible name (loom.a11y-icon-only-no-name)", () => {
  it("warns on a Button with only an icon (no text, no label)", async () => {
    const { warnings } = await parse(sys(`Button { icon: "trash" }`));
    expect(iconOnly(warnings)).toBe(true);
  });

  it("warns on an icon Button carrying a to: nav but still no name", async () => {
    const { warnings } = await parse(sys(`Button { icon: "settings", to: "/settings" }`));
    expect(iconOnly(warnings)).toBe(true);
  });

  it("warns on a Button with only an inline iconSvg", async () => {
    const { warnings } = await parse(sys(`Button { iconSvg: "<svg></svg>" }`));
    expect(iconOnly(warnings)).toBe(true);
  });

  it("accepts an icon Button that also carries visible text", async () => {
    const { warnings } = await parse(sys(`Button { "Delete", icon: "trash" }`));
    expect(iconOnly(warnings)).toBe(false);
  });

  it("accepts an icon Button with an explicit accessible name (label:)", async () => {
    const { warnings } = await parse(sys(`Button { icon: "trash", label: "Delete order" }`));
    expect(iconOnly(warnings)).toBe(false);
  });

  it("does not flag a plain text Button with no icon", async () => {
    const { warnings } = await parse(sys(`Button { "Save" }`));
    expect(iconOnly(warnings)).toBe(false);
  });
});

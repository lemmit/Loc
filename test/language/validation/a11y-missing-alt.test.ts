import { NodeFileSystem } from "langium/node";
import { parseHelper } from "langium/test";
import { describe, expect, it } from "vitest";
import { createDddServices } from "../../../src/language/ddd-module.js";

// accessibility.md Phase 3 — `Image`/`Avatar` that render an image must carry a
// text alternative (`alt:` or `decorative: true`).  Alt text is human content
// Loom can't derive; a missing alt is a WCAG 1.1.1 failure
// (`loom.a11y-missing-alt`), fail-fast at validate time — never a silent gap.

async function parse(source: string) {
  const services = createDddServices(NodeFileSystem);
  const doc = await parseHelper(services.Ddd)(source, { validation: true });
  const diags = doc.diagnostics ?? [];
  return {
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

const missingAlt = (errs: string[]) => errs.some((e) => /no text alternative|WCAG 1\.1\.1/.test(e));

describe("a11y — Image/Avatar text alternative (loom.a11y-missing-alt)", () => {
  it("errors on an Image with a src but no alt", async () => {
    const { errors } = await parse(sys(`Image { "/logo.png" }`));
    expect(missingAlt(errors)).toBe(true);
  });

  it("errors on an Avatar with a src but no alt", async () => {
    const { errors } = await parse(sys(`Avatar { src: "/u.png" }`));
    expect(missingAlt(errors)).toBe(true);
  });

  it("accepts an Image with alt", async () => {
    const { errors } = await parse(sys(`Image { "/logo.png", alt: "Acme logo" }`));
    expect(missingAlt(errors)).toBe(false);
  });

  it("accepts an Image marked decorative: true", async () => {
    const { errors } = await parse(sys(`Image { "/spacer.png", decorative: true }`));
    expect(missingAlt(errors)).toBe(false);
  });

  it("does not flag an Avatar with no src (renders an initials/glyph fallback)", async () => {
    const { errors } = await parse(sys(`Avatar { "P" }`));
    expect(missingAlt(errors)).toBe(false);
  });
});

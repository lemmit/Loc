// Feliz design system — the emitted project ships a real Tailwind + daisyUI
// build so the daisyUI component classes the pack renders (`btn` / `card` /
// `table` / `badge` / …) actually resolve to styles.  This pins the build
// wiring (config files, devDeps, the index.html stylesheet link + theme) that
// `generated-feliz-build.yml` proves end-to-end via `vite build`.

import { describe, expect, it } from "vitest";
import { generateFelizForContexts } from "../../../src/generator/feliz/index.js";
import { buildLoomModel } from "../../_helpers/ir.js";

const APP = `
system ShopApp {
  subdomain S { context C { } }
  ui WebApp {
    framework: feliz
    page Home { route: "/"  body: Heading { "Home", level: 1 } }
  }
  deployable api { platform: node contexts: [C] port: 3000 }
  deployable web { platform: feliz targets: api ui: WebApp port: 3005 }
}
`;

async function felizFiles(): Promise<Map<string, string>> {
  const model = await buildLoomModel(APP);
  const sys = model.systems[0]!;
  const web = sys.deployables.find((d) => d.name === "web")!;
  return generateFelizForContexts([], sys, web);
}

describe("feliz design system", () => {
  it("ships the Tailwind + daisyUI build files", async () => {
    const files = await felizFiles();
    // The three Vite/Tailwind config files.
    const styles = files.get("styles.css")!;
    expect(styles).toContain("@tailwind base;");
    expect(styles).toContain("@tailwind components;");
    expect(styles).toContain("@tailwind utilities;");

    const tw = files.get("tailwind.config.js")!;
    expect(tw).toContain('import daisyui from "daisyui"');
    expect(tw).toContain("plugins: [daisyui]");
    // Scans index.html + the Fable-compiled JS (where className literals live).
    expect(tw).toContain('content: ["./index.html", "./out/**/*.js"]');
    // The default theme + a dark sibling.
    expect(tw).toContain('themes: ["corporate", "business"]');

    const pc = files.get("postcss.config.js")!;
    expect(pc).toContain("tailwindcss: {}");
    expect(pc).toContain("autoprefixer: {}");
  });

  it("declares the Tailwind/daisyUI devDependencies", async () => {
    const files = await felizFiles();
    const pkg = JSON.parse(files.get("package.json")!);
    expect(pkg.devDependencies).toMatchObject({
      tailwindcss: expect.stringContaining("3"),
      daisyui: expect.stringContaining("4"),
      autoprefixer: expect.any(String),
      postcss: expect.any(String),
    });
  });

  it("links the stylesheet + sets the daisyUI theme in index.html", async () => {
    const files = await felizFiles();
    const html = files.get("index.html")!;
    expect(html).toContain('<html lang="en" data-theme="corporate">');
    expect(html).toContain('<link rel="stylesheet" href="./styles.css" />');
    expect(html).toContain('<body class="bg-base-100 text-base-content">');
  });

  it("the pack renders daisyUI component classes on the primitives", async () => {
    const files = await felizFiles();
    const app = files.get("src/App.fs")!;
    // The heading rides the daisyUI/Tailwind type ramp — a class-based, not
    // unstyled, element (the whole point of the design system).
    expect(app).toContain('prop.className "text-3xl font-bold"');
  });
});

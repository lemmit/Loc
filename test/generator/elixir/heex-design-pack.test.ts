// ---------------------------------------------------------------------------
// HEEx design packs are WIRED — `design:` on `platform: elixir` must change
// the output.
//
// The packs were once inert: the generator never called `pack.render`, so
// `design: daisyui` and `design: coreComponents` produced byte-identical
// projects while both packs' templates sat unrendered on disk.  This suite
// pins the wiring end to end:
//
//   1. the pack owns the design-vocabulary shell surface (core_components.ex,
//      layouts, sidebar) — the two packs genuinely diverge there;
//   2. the assets pipeline exists (app.css / app.js / tailwind.config.js /
//      assets/package.json are emitted, and the root layout's links resolve
//      to files the project actually builds);
//   3. daisyui's tailwind config loads the daisyui plugin — the thing that
//      makes its class vocabulary render;
//   4. a JSON-API-only deployable ships none of it (strict additivity).
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const SYSTEM = (design: string) => `
system PackWire {
  subdomain Sales {
    context Sales {
      aggregate Customer {
        name: string
        derived display: string = name
      }
      repository Customers for Customer { }
    }
  }
  api SalesApi from Sales
  ui Admin with scaffold(subdomains: [Sales]) { }
  storage primary { type: postgres }
  resource salesState { for: Sales, kind: state, use: primary }
  deployable phoenixApp {
    platform: elixir
    ${design}
    contexts: [Sales]
    dataSources: [salesState]
    serves: SalesApi
    ui: Admin
    port: 4000
  }
}
`;

const API_ONLY = `
system PackWireApi {
  subdomain Sales {
    context Sales {
      aggregate Customer {
        name: string
      }
      repository Customers for Customer { }
    }
  }
  api SalesApi from Sales
  storage primary { type: postgres }
  resource salesState { for: Sales, kind: state, use: primary }
  deployable api {
    platform: elixir
    contexts: [Sales]
    dataSources: [salesState]
    serves: SalesApi
    port: 4000
  }
}
`;

async function generate(source: string): Promise<Map<string, string>> {
  return await generateSystemFiles(source);
}

describe("HEEx design-pack wiring", () => {
  it("coreComponents and daisyui genuinely diverge on the design surface", async () => {
    const core = await generate(SYSTEM("design: coreComponents"));
    const daisy = await generate(SYSTEM("design: daisyui"));

    for (const file of [
      "phoenix_app/lib/phoenix_app_web/components/core_components.ex",
      "phoenix_app/lib/phoenix_app_web/components/sidebar.ex",
      "phoenix_app/lib/phoenix_app_web/components/layouts/root.html.heex",
      "phoenix_app/assets/tailwind.config.js",
      "phoenix_app/assets/package.json",
    ]) {
      expect(core.get(file), `${file} missing under coreComponents`).toBeDefined();
      expect(daisy.get(file), `${file} missing under daisyui`).toBeDefined();
      expect(daisy.get(file), `${file} identical across packs — pack is inert`).not.toBe(
        core.get(file),
      );
    }

    // The vocabulary itself: daisyui components, coreComponents utilities.
    expect(daisy.get("phoenix_app/lib/phoenix_app_web/components/core_components.ex")).toContain(
      "btn btn-primary",
    );
    expect(core.get("phoenix_app/lib/phoenix_app_web/components/core_components.ex")).toContain(
      "bg-zinc-900",
    );
  });

  it("bareword default is coreComponents — `design:` omitted ≡ design: coreComponents", async () => {
    const bare = await generate(SYSTEM(""));
    const core = await generate(SYSTEM("design: coreComponents"));
    expect(bare.get("phoenix_app/lib/phoenix_app_web/components/core_components.ex")).toBe(
      core.get("phoenix_app/lib/phoenix_app_web/components/core_components.ex"),
    );
  });

  it("emits the full assets pipeline and links only files that exist", async () => {
    const files = await generate(SYSTEM("design: coreComponents"));

    expect(files.get("phoenix_app/assets/css/app.css")).toContain("@tailwind base;");
    expect(files.get("phoenix_app/assets/js/app.js")).toContain("new LiveSocket(");
    expect(files.get("phoenix_app/assets/tailwind.config.js")).toContain(
      '"../lib/phoenix_app_web/**/*.*ex"',
    );
    const pkg = JSON.parse(files.get("phoenix_app/assets/package.json")!);
    expect(pkg.scripts["build:css"]).toContain("../priv/static/assets/app.css");
    expect(pkg.scripts["build:js"]).toContain("../priv/static/assets/app.js");

    // Every stylesheet/script the root layout links is either emitted
    // directly (theme.css) or produced by the assets build (app.css/app.js).
    const root = files.get("phoenix_app/lib/phoenix_app_web/components/layouts/root.html.heex")!;
    expect(root).toContain('href={~p"/assets/theme.css"}');
    expect(root).toContain('href={~p"/assets/app.css"}');
    expect(root).toContain('src={~p"/assets/app.js"}');
    expect(files.get("phoenix_app/priv/static/assets/theme.css")).toContain("--color-brand-6");

    // Docker builds the assets; host dev gets the mix alias.
    expect(files.get("phoenix_app/Dockerfile")).toContain("AS assets-build");
    expect(files.get("phoenix_app/mix.exs")).toContain('"assets.build"');
  });

  it("daisyui's tailwind config loads the daisyui plugin", async () => {
    const files = await generate(SYSTEM("design: daisyui"));
    expect(files.get("phoenix_app/assets/tailwind.config.js")).toContain('require("daisyui")');
    const pkg = JSON.parse(files.get("phoenix_app/assets/package.json")!);
    expect(pkg.devDependencies.daisyui).toBeDefined();
    // The daisyui root layout pins a theme so component colors resolve.
    expect(
      files.get("phoenix_app/lib/phoenix_app_web/components/layouts/root.html.heex"),
    ).toContain('data-theme="light"');
  });

  it("a JSON-API-only deployable ships no ui shell and no assets pipeline", async () => {
    const files = await generate(API_ONLY);
    const paths = [...files.keys()];
    expect(paths.filter((p) => p.includes("/assets/"))).toEqual([]);
    expect(paths.find((p) => p.endsWith("core_components.ex"))).toBeUndefined();
    expect(files.get("api/mix.exs")).not.toContain('"assets.build"');
    expect(files.get("api/Dockerfile")).not.toContain("assets-build");
  });
});

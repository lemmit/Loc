import { describe, expect, it } from "vitest";
import { parseString } from "../../_helpers/parse.js";

// ---------------------------------------------------------------------------
// `platform: feliz` / `platform: flutter` — the two SELF-HOSTING frontends
// (they build through `dotnet fable` + vite / the Flutter SDK rather than the
// shared static-bundle pipeline).  Rule 4b — "a frontend deployable must
// declare a `ui:`" — used to have arms for react/svelte/vue/angular ONLY, so
// these two passed validation with no `ui:` and failed downstream instead:
//
//   feliz   → codegen threw a raw `Error: Feliz deployable 'web' has no ui
//             binding (uiName).` (`src/generator/feliz/index.ts`)
//   flutter → a degenerate placeholder app (bare `ListTile` home) at exit 0
//             (`src/generator/flutter/index.ts`)
//
// Rule 3's menu ("platforms that mount a UI") is exercised here too: it is now
// DERIVED from the platform descriptor table's `mountsUi` flag, where the
// inline literal it replaced omitted `angular`, `feliz` and `python`.
// ---------------------------------------------------------------------------

const BASE = `
  subdomain M { context C { aggregate A { x: int } } }
`;

describe("validator: self-hosting frontend deployables require `ui:`", () => {
  it("emits `loom.feliz-deployable-missing-ui` on a feliz deployable with no ui binding", async () => {
    const { errors } = await parseString(`
      system S {
        ${BASE}
        deployable api { platform: node, contexts: [C], port: 3000 }
        deployable web { platform: feliz, targets: api, port: 3005 }
      }
    `);
    expect(
      errors.some(
        (e) => /Feliz deployable 'web' must declare a 'ui:' binding/.test(e) && /scaffold/.test(e),
      ),
      errors.join("\n"),
    ).toBe(true);
  });

  it("emits `loom.flutter-deployable-missing-ui` on a flutter deployable with no ui binding", async () => {
    const { errors } = await parseString(`
      system S {
        ${BASE}
        deployable api { platform: node, contexts: [C], port: 3000 }
        deployable web { platform: flutter, targets: api, port: 3006 }
      }
    `);
    expect(
      errors.some(
        (e) =>
          /Flutter deployable 'web' must declare a 'ui:' binding/.test(e) && /scaffold/.test(e),
      ),
      errors.join("\n"),
    ).toBe(true);
  });

  it("accepts a feliz deployable with `targets:` + `ui:`", async () => {
    const { errors } = await parseString(`
      system S {
        ${BASE}
        ui WebApp { }
        deployable api { platform: node, contexts: [C], port: 3000 }
        deployable web { platform: feliz, targets: api, ui: WebApp, port: 3005 }
      }
    `);
    expect(errors, errors.join("\n")).toEqual([]);
  });

  it("accepts a flutter deployable with `targets:` + `ui:`", async () => {
    const { errors } = await parseString(`
      system S {
        ${BASE}
        ui WebApp { }
        deployable api { platform: node, contexts: [C], port: 3000 }
        deployable web { platform: flutter, targets: api, ui: WebApp, port: 3006 }
      }
    `);
    expect(errors, errors.join("\n")).toEqual([]);
  });
});

describe("validator: Rule 3 ui-mount menu is derived from the descriptor table", () => {
  it("rejects `ui:` on a platform that mounts no UI, listing every platform that does", async () => {
    const { errors } = await parseString(`
      system S {
        ${BASE}
        ui WebApp { }
        deployable api { platform: node, contexts: [C], ui: WebApp, port: 3000 }
      }
    `);
    const rule3 = errors.find((e) => /only valid on platforms that mount a UI/.test(e));
    expect(rule3, errors.join("\n")).toBeDefined();
    // The menu the inline literal had drifted away from: angular, feliz and
    // python all carry `mountsUi: true` yet went unlisted for as long as they
    // existed.  `node` (the only `mountsUi: false` platform) stays out of it.
    for (const p of [
      "angular",
      "dotnet",
      "elixir",
      "feliz",
      "flutter",
      "java",
      "python",
      "react",
      "static",
      "svelte",
      "vue",
    ]) {
      expect(rule3, `menu should list '${p}'`).toContain(`'${p}'`);
    }
    expect(rule3).not.toMatch(/\('node'|, 'node'/);
    expect(rule3).toContain("got 'node'");
  });
});

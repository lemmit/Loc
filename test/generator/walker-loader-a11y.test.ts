// Loader `role="status"` on the RAW-element packs (M-T1.12 follow-up).
//
// The Loader primitive's a11y contract is `{ role: "status", live: "polite" }`.
// The library-backed packs get status semantics free from their spinner
// component (Mantine `<Loader>`, MUI `<CircularProgress>`, Chakra `<Spinner>`,
// vuetify/Angular progress components), but the packs that render a RAW element
// — shadcn/shadcnVue's lucide `<Loader2>` SVG icon and shadcnSvelte's `<span>` —
// carry no role or accessible name, so a screen reader gets nothing. These now
// spell out `role="status" aria-label="Loading"` (matching the spartanNg pack,
// which already did). Feliz's raw daisyUI span is pinned in its own suite
// (feliz/display-primitives.test.ts).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/index.js";

// A one-page ui whose loading branch renders a standalone Loader.
const system = (pack: string, platform: string): string => `
  system Shop {
    api ShopApi from Catalog
    subdomain Catalog {
      context Cat {
        aggregate Product with crudish { name: string }
        repository Products for Product { }
      }
    }
    storage db { type: postgres }
    resource s { for: Cat, kind: state, use: db }
    ui WebApp {
      api Shop: ShopApi
      page Products {
        route: "/"
        body: QueryView {
          of: Shop.Product.all,
          loading: Loader { },
          error: Text { "!" }, empty: Text { "0" },
          data: rows => Stack { For { each: rows, p => Card { p.name } } }
        }
      }
    }
    deployable api { platform: node contexts: [Cat] dataSources: [s] serves: ShopApi port: 3000 }
    deployable web { platform: ${platform} design: "${pack}" targets: api ui: WebApp { Shop: api } port: 3005 }
  }
`;

const RAW_PACKS: ReadonlyArray<{ pack: string; platform: string }> = [
  { pack: "shadcn", platform: "static" }, // react — lucide <Loader2> icon
  { pack: "shadcnVue", platform: "vue" }, // lucide <Loader2> icon
  { pack: "shadcnSvelte", platform: "svelte" }, // raw <span> spinner
];

describe("Loader role=status — raw-element packs", () => {
  for (const { pack, platform } of RAW_PACKS) {
    it(`${pack} (${platform}): the raw spinner carries role=status + an accessible name`, async () => {
      const files = await generateSystemFiles(system(pack, platform));
      const all = [...files.values()].join("\n");
      expect(all).toContain('role="status"');
      expect(all).toContain('aria-label="Loading"');
    });
  }
});

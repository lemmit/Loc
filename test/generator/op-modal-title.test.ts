// The op-dialog Modal's `title:` — authored, honoured, translated.
//
// `Modal { OperationForm(…), trigger: Button(…), title: "…" }` is the scaffold's
// operation dialog.  Its `title:` is a user-visible slot (`modalTitle` in
// `USER_VISIBLE_SLOTS`), so the extraction pass keys it into
// `.loom/messages.en.json` — but EVERY pack rendered the humanized OPERATION
// NAME instead (`{{humanOp}}`), and Angular rendered no title element at all.
// So an authored title was dropped on the floor while its catalog entry stayed
// live: a translator translating text no app ever showed.
//
// (The sibling `user-visible-slot-coverage.test.ts` gates the same slot on the
// STATE-CONTROLLED Modal — `Modal { …, open: <bool> }` — which is a different
// primitive template.  This file covers the op-dialog shape, which needs an
// aggregate operation and so can't ride that generic harness.)
//
// Pinned per target: the authored title reaches the dialog, translated; with no
// authored title the humanized op name is still the fallback (byte-identical to
// the old behaviour); and Angular's dialog now carries an accessible name.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/index.js";

const SYSTEM = (platform: string, pack: string, title: string): string => `
  system Shop {
    api ShopApi from Catalog
    subdomain Catalog {
      context Cat {
        aggregate Product {
          name: string
          operation archive(reason: string) { }
        }
        repository Products for Product { }
      }
    }
    storage db { type: postgres }
    resource s { for: Cat, kind: state, use: db }
    ui WebApp {
      api Shop: ShopApi
      page Detail(id: string) {
        route: "/p/:id"
        body: Modal {
          OperationForm { of: Product, op: archive },
          ${title}
          trigger: Button { "Archive it" }
        }
      }
    }
    deployable api { platform: node contexts: [Cat] dataSources: [s] serves: ShopApi port: 3000 }
    deployable web {
      platform: ${platform} design: "${pack}" targets: api ui: WebApp { Shop: api } port: 3005
    }
  }
`;

/** Everything emitted for the ui, joined — the op-modal module lives beside the
 *  page on React/Svelte and inside the component on Angular. */
async function uiSource(platform: string, pack: string, title: string): Promise<string> {
  const files = await generateSystemFiles(SYSTEM(platform, pack, title));
  return [...files]
    .filter(([p]) => /\/(pages|routes)\//.test(p))
    .map(([, c]) => c)
    .join("\n");
}

const TARGETS: ReadonlyArray<{ id: string; platform: string; pack: string }> = [
  { id: "mantine", platform: "static", pack: "mantine" }, // title in a JS PROP
  { id: "shadcn", platform: "static", pack: "shadcn" }, // title in markup TEXT
  { id: "mui", platform: "static", pack: "mui" },
  { id: "chakra", platform: "static", pack: "chakra" },
  { id: "shadcnSvelte", platform: "svelte", pack: "shadcnSvelte" },
  { id: "flowbite", platform: "svelte", pack: "flowbite" },
  { id: "angularMaterial", platform: "angular", pack: "angularMaterial" },
  { id: "primeng", platform: "angular", pack: "primeng" },
  { id: "spartanNg", platform: "angular", pack: "spartanNg" },
];

describe("op-dialog Modal — the authored title: is the dialog title", () => {
  for (const t of TARGETS) {
    it(`${t.id}: renders the authored title, translated`, async () => {
      const src = await uiSource(t.platform, t.pack, `title: "Archive product",`);
      // Under i18n the title binds through `t(key, default)` keyed to the
      // `modalTitle` catalog slot — the same key the extraction pass emits.
      expect(src).toMatch(/t\("page\.Detail\.modalTitle\.\w+", "Archive product"\)/);
      // …and the humanized op name is no longer standing in for it.  ("Archive"
      // still appears as the submit-button label and the toast, which are pack
      // chrome, not this slot — so assert on the TITLE position specifically.)
      expect(src).not.toMatch(/(?:DialogTitle|ModalHeader|Dialog\.Title)>Archive</);
    });

    it(`${t.id}: falls back to the humanized op name with no title:`, async () => {
      const src = await uiSource(t.platform, t.pack, "");
      expect(src).not.toContain("modalTitle");
      expect(src).toContain("Archive");
    });
  }

  it("angular: the op dialog carries an accessible name", async () => {
    // Angular emitted no title element at all, so its dialog had no accessible
    // name — every other frontend labels its op dialog (M-T1.12 Slice 7's rule
    // for the raw-markup modals).
    const src = await uiSource("angular", "angularMaterial", `title: "Archive product",`);
    expect(src).toContain('role="dialog"');
    expect(src).toContain('aria-modal="true"');
    expect(src).toMatch(/aria-labelledby="products-op-archive-title"/);
    expect(src).toMatch(/<h3 id="products-op-archive-title"/);
  });
});

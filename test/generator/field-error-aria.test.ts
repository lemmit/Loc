// M-T1.12 — a `Field { …, bind: x, error: … }` must ANNOUNCE its error.
//
// The a11y contract for an invalid text input is two attributes on the input:
// `aria-invalid`, and `aria-describedby` pointing at the id of the element
// carrying the message.  Four packs got that for free from their component
// library (Mantine / MUI / Chakra / shadcn all take an `error` prop and wire
// it internally), and five did not — flowbite, shadcnSvelte, primeng,
// spartanNg and angularMaterial each render a RAW `<input>` plus a sibling
// error element with no id on either, so a screen reader announced a valid,
// unexplained field. `grep -rl aria-invalid designs/` matched only
// shadcn/v3, shadcn/v4, coreComponents/v3 and daisyui/v1.
//
// angularMaterial had a second, structural half: its error `<span>` was
// emitted AFTER `</mat-form-field>`, outside the wrapper — so Material could
// neither associate nor style it. It is now a `<mat-error>` inside the field.
//
// The ids are DERIVED from the `bind:` state-field name (unique in a page
// scope), not counted, so they are stable across regenerations.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/index.js";

/** (pack, platform, emitted page path) for the five packs this row covers. */
const PACKS: ReadonlyArray<{ pack: string; platform: string; page: string }> = [
  { pack: "flowbite", platform: "svelte", page: "web/src/routes/(app)/form/+page.svelte" },
  { pack: "shadcnSvelte", platform: "svelte", page: "web/src/routes/(app)/form/+page.svelte" },
  { pack: "primeng", platform: "angular", page: "web/src/app/pages/form.component.ts" },
  { pack: "spartanNg", platform: "angular", page: "web/src/app/pages/form.component.ts" },
  { pack: "angularMaterial", platform: "angular", page: "web/src/app/pages/form.component.ts" },
];

async function formPage(pack: string, platform: string, page: string): Promise<string> {
  const files = await generateSystemFiles(`
    system S {
      subdomain M { context C { } }
      ui WebApp {
        page Form {
          route: "/form"
          state {
            name: string = ""
          }
          body: Field { "Your name", bind: name, error: name == "" ? "Required" : "" }
        }
      }
      deployable api { platform: node, contexts: [C], port: 3000 }
      deployable web {
        platform: ${platform}
        design: "${pack}"
        targets: api
        ui: WebApp
        port: 3001
      }
    }
  `);
  const src = files.get(page);
  if (!src) throw new Error(`no page at ${page} for ${pack}; got ${[...files.keys()].join(", ")}`);
  return src;
}

describe("Field error announces itself (aria-invalid + aria-describedby)", () => {
  for (const { pack, platform, page } of PACKS) {
    it(`${pack}: input carries the id, aria-invalid and aria-describedby`, async () => {
      const src = await formPage(pack, platform, page);
      // The derived id, on the input.
      expect(src).toContain('id="loom-field-name"');
      // Both aria attributes reach the emitted markup.
      expect(src).toContain("aria-invalid");
      expect(src).toContain("aria-describedby");
      // …and the message element carries the id they point at.
      expect(src).toContain('id="loom-field-name-error"');
    });
  }

  it("angularMaterial: the error lives INSIDE <mat-form-field>, as a <mat-error>", async () => {
    const src = await formPage("angularMaterial", "angular", "web/src/app/pages/form.component.ts");
    expect(src).toContain("<mat-error");
    // The old shape closed the wrapper before emitting the message.
    expect(src).not.toMatch(/<\/mat-form-field>[\s\S]*?<span class="loom-error"/);
    // The error markup must appear before the closing tag, not after it.
    const errIdx = src.indexOf("<mat-error");
    const closeIdx = src.indexOf("</mat-form-field>");
    expect(errIdx).toBeGreaterThan(-1);
    expect(closeIdx).toBeGreaterThan(errIdx);
  });

  it("an UNBOUND field emits no dangling aria-describedby", async () => {
    // No `bind:` means no stable name to derive an id from, so the templates
    // fall back to their previous markup rather than pointing
    // `aria-describedby` at an id that is never rendered.
    const files = await generateSystemFiles(`
      system S {
        subdomain M { context C { } }
        ui WebApp {
          page Form { route: "/form" body: Field { "Bare" } }
        }
        deployable api { platform: node, contexts: [C], port: 3000 }
        deployable web { platform: angular, design: "primeng", targets: api, ui: WebApp, port: 3001 }
      }
    `);
    const src = files.get("web/src/app/pages/form.component.ts")!;
    expect(src).not.toContain("aria-describedby");
    // (`loom-field-label` / `loom-field-input` are primeng CSS classes — the
    // assertion is about the derived ID, not the class names.)
    expect(src).not.toContain('id="loom-field-');
  });
});

// An INTERPOLATED user-visible slot in ATTRIBUTE position translates.
//
// The sibling of `dynamic-user-visible-slots.test.ts`, one step along: that file
// pins the BARE dynamic slot (`Button { label: row.name }`), which has no stable
// source string and so is bound but never translated.  This file pins the
// INTERPOLATED one (``Button { label: `Delete {p.name}` }``), which DOES have a
// source string — `"Delete {name}"` — and must therefore resolve through `t()`.
//
// It did not.  The three attribute-position helpers in `i18n-emit.ts`
// (`localizedNamedAttr`, `localizedAriaLabelAttr`, `localizedNamedValue`) each
// had exactly two branches — literal → `t()`, anything else → raw expression —
// while the TEXT-position localizer had three, the middle one being the ICU
// template branch.  So an interpolated attribute fell through to concatenation
// on all six frontends.
//
// Two things made that worse than a missing feature:
//
//  1. The extraction pass still wrote the ICU entry into the catalog, so
//     `.loom/messages.en.json` and the app's own `locales/en.json` both carried
//     `"Delete {arg0}"` under a key nothing ever resolved — a translator
//     translating a string the app could never show.  That is the dead-catalog
//     class, and `user-visible-slot-coverage.test.ts` cannot see it: that gate
//     asks whether the slot RENDERS, and a raw concat renders fine.
//  2. The emitted concatenation is the exact shape `loom.user-visible-concat`
//     REJECTS in `.ddd` source — the generator writing what an author is banned
//     from writing.
//
// HEEx was already correct here (`localizedHeexAttr` funnels both shapes), which
// is why this is pinned across the six that share `i18n-emit.ts`.

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

async function filesOf(body: string, platform: string, pack: string) {
  return await generateSystemFiles(SYSTEM(body, platform, pack));
}

async function pageOf(body: string, platform = "static", pack = "mantine"): Promise<string> {
  const files = await filesOf(body, platform, pack);
  const entry = [...files].find(
    ([p]) => /\/(pages|routes)\//.test(p) && !/\.spec\./.test(p) && !/\.dart$/.test(p),
  );
  if (!entry) throw new Error("no page emitted");
  return entry[1];
}

// A Button whose accessible name is an interpolated template — the icon makes
// the name load-bearing (WCAG 4.1.2), which is why this slot exists at all.
const BUTTON = 'Button { icon: "trash", label: `Delete {caption}` }';

describe("an interpolated attribute slot translates", () => {
  // The four JSX/markup frontends share `localizedAriaLabelAttr` (an attribute
  // FRAGMENT); Feliz and Flutter share `localizedNamedValue` (a target-native
  // VALUE).  Both spellings, one `messageKey()` — D-I18N-ATTR.
  // Feliz emits ONE `App.fs` rather than a page tree, so the render site is
  // located per target rather than by a single path shape.
  const PAGE_FILE = /\/(pages|routes)\/|App\.fs$/;
  const CASES: ReadonlyArray<[string, string, string, RegExp]> = [
    ["react", "static", "mantine", /aria-label=\{t\(/],
    ["vue", "vue", "vuetify", /:aria-label='t\(/],
    ["svelte", "svelte", "flowbite", /aria-label=\{t\(/],
    ["angular", "angular", "angularMaterial", /\[attr\.aria-label\]='t\(/],
    ["feliz", "feliz", "mantine", /prop\.ariaLabel \(I18n\.tf /],
    ["flutter", "flutter", "mantine", /Semantics\(label: t\(/],
  ];

  for (const [name, platform, pack, shape] of CASES) {
    it(`${name}: the aria name resolves through the runtime, not concatenation`, async () => {
      const files = await filesOf(BUTTON, platform, pack);
      const page = [...files].find(([p]) => PAGE_FILE.test(p) && !/\.spec\./.test(p))?.[1];
      if (!page) throw new Error("no page emitted");
      expect(page).toMatch(shape);
      // The banned shape: a literal fragment welded to an expression.
      expect(page).not.toContain('"Delete " + ');
      expect(page).not.toContain("'Delete ' + ");
    });
  }

  it("the emitted key EQUALS the catalog key — no dead entry", async () => {
    const files = await filesOf(BUTTON, "static", "mantine");
    const catalog = files.get(".loom/messages.en.json");
    if (!catalog) throw new Error("no catalog emitted");
    const keys = Object.keys(JSON.parse(catalog)).filter((k) => k.includes("buttonAria"));
    expect(keys).toHaveLength(1);
    // The whole point: the catalog key is REACHED by the page, rather than
    // being written for a slot the page renders some other way.
    const page = [...files].find(([p]) => /\/pages\//.test(p) && !/\.spec\./.test(p))?.[1];
    expect(page).toContain(keys[0]);
  });

  it("the ICU default carries the hole, and the hole is bound", async () => {
    const page = await pageOf(BUTTON);
    // Named placeholder in the default + a values object the shim substitutes.
    expect(page).toMatch(/"Delete \{\w+\}"/);
    expect(page).toMatch(/\{ \w+: caption \}/);
  });

  it("a BARE dynamic slot still binds raw — it has no source string", async () => {
    // The sibling case, re-pinned here so the new ICU branch cannot swallow it:
    // `icuFromConcat` needs literal text AND a hole, so `label: caption` alone
    // is not a message and must keep the pre-existing raw binding.
    const page = await pageOf('Button { icon: "trash", label: caption }');
    expect(page).toMatch(/aria-label=\{caption\}/);
    expect(page).not.toContain("buttonAria");
  });

  it("a STATIC label is unchanged — plain t(), no values object", async () => {
    const page = await pageOf('Button { icon: "trash", label: "Delete" }');
    expect(page).toMatch(/aria-label=\{t\("page\.Home\.buttonAria\.\w+", "Delete"\)\}/);
  });

  it("i18n OFF stays byte-identical — a string-less app never calls t()", async () => {
    // No translatable text anywhere, so the i18n runtime is not emitted and the
    // attribute keeps its pre-i18n raw spelling.
    const page = await pageOf('Button { icon: "trash", label: caption }');
    expect(page).not.toContain("i18n");
  });

  it("Alert.title: the same fix, through the OTHER attribute helper", async () => {
    // `localizedNamedAttr` rather than `localizedAriaLabelAttr` — a different
    // entry point with the identical two-branch bug.
    const page = await pageOf('Alert { "boom", title: `Order {caption}` }');
    expect(page).toMatch(/title=\{t\(/);
    expect(page).not.toContain('"Order " + ');
  });
});

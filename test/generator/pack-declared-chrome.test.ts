// Pack-DECLARED chrome (M-T1.11) — the user-visible English a design pack
// bakes into its own `.hbs` templates ("Remove", "This operation has no
// parameters.", "Yes"/"No", a picker's "Select…").  The content-hash extraction
// pass walks the IR, so it structurally cannot see any of it; a pack declares
// its strings in `pack.json`'s `chrome` map and spells them through the
// `{{{chrome …}}}` / `{{{chromeAttr …}}}` / `{{{chromeValue …}}}` /
// `{{{chromeImport …}}}` helpers (`src/generator/_packs/pack-chrome.ts`).
//
// Four things are gated here, and the last one is the interesting one:
//
//   1. the key shape (`pack.<family>.<role>.<hash>`, D-I18N-KEY) and its
//      non-collision with the other namespaces;
//   2. the i18n-OFF path is BYTE-IDENTICAL — every helper returns exactly the
//      bytes the template used to spell inline;
//   3. the i18n-ON spelling per frontend format, and the catalogs
//      (`.loom/messages.en.json`, each app's `locales/en.json`, the Phoenix
//      `.po`) carrying the same keys the emitters bind;
//   4. COMPLETENESS — a scan of every `.hbs` under `designs/` for user-visible
//      English in a markup text node or a user-facing attribute.  That is the
//      gate that makes this slice hold: without it, the next pack template to
//      hardcode a word ships untranslatable and nothing says so.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadPack, resolvePackDir } from "../../src/generator/_packs/loader-fs.js";
import {
  assertDeclaredChromeIsSane,
  chromeHelpers,
  packChromeCatalog,
  packChromeKey,
} from "../../src/generator/_packs/pack-chrome.js";
import { generateSystemFiles } from "../_helpers/index.js";

// ---------------------------------------------------------------------------
// The pack inventory — every built-in pack directory, read off disk so a new
// pack (or a new version of one) joins every gate below automatically.
// ---------------------------------------------------------------------------

const DESIGNS = "designs";

function packDirs(): Array<{ family: string; version: string; dir: string }> {
  const out: Array<{ family: string; version: string; dir: string }> = [];
  for (const family of readdirSync(DESIGNS)) {
    const fdir = join(DESIGNS, family);
    if (!statSync(fdir).isDirectory()) continue;
    for (const version of readdirSync(fdir)) {
      const dir = join(fdir, version);
      if (existsSync(join(dir, "pack.json"))) out.push({ family, version, dir });
    }
  }
  return out.sort((a, b) => a.dir.localeCompare(b.dir));
}

const PACKS = packDirs();

function hbsFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".hbs"))
    .map((f) => join(dir, f));
}

describe("pack-declared chrome — key shape (D-I18N-KEY)", () => {
  it("keys under `pack.<family>.<role>.<hash>`, colliding with no other namespace", () => {
    const key = packChromeKey("mantine", "removeItem", "Remove");
    expect(key).toMatch(/^pack\.mantine\.removeItem\.[a-z0-9]{6}$/);
    // The four namespaces the catalog carries.  `pack.` is distinct from the
    // authored-string prefixes AND from the curated emitter-side `chrome.`
    // table, so a pack can name a role `loading` without shadowing anything.
    for (const other of ["page.", "component.", "menu.", "chrome."]) {
      expect(key.startsWith(other)).toBe(false);
    }
  });

  it("re-keys on a rephrase, and is stable across pack VERSIONS that agree", () => {
    // A reword is a delete-old + add-new in `ddd i18n sync`, never a silent
    // re-translation of the previous wording.
    expect(packChromeKey("mui", "removeItem", "Remove")).not.toBe(
      packChromeKey("mui", "removeItem", "Delete"),
    );
    // mantine v7 and v9 spell "Remove" identically — one key, one translation.
    const v7 = packChromeCatalog(loadPack(resolvePackDir("mantine@v7")).manifest);
    const v9 = packChromeCatalog(loadPack(resolvePackDir("mantine@v9")).manifest);
    expect(Object.keys(v7)).toEqual(Object.keys(v9));
  });

  it("keeps two packs that genuinely WORD a string differently on separate keys", () => {
    // flowbite's empty picker option is "Select…", chakra's is "— select —".
    // Same role, different message ⇒ different hash ⇒ a translator sees both,
    // which is the whole reason the message is hashed rather than the version.
    const flowbite = packChromeCatalog(loadPack(resolvePackDir("flowbite@v1")).manifest);
    const chakra = packChromeCatalog(loadPack(resolvePackDir("chakra@v3")).manifest);
    const pick = (c: Record<string, string>) =>
      Object.entries(c).find(([k]) => k.includes(".selectEmptyOption."));
    expect(pick(flowbite)?.[1]).toBe("Select…");
    expect(pick(chakra)?.[1]).toBe("— select —");
    expect(pick(flowbite)?.[0]).not.toBe(pick(chakra)?.[0]);
  });
});

describe("pack-declared chrome — the helpers", () => {
  const manifest = {
    name: "demo",
    chrome: { removeItem: "Remove", addItem: "Add {item}", nav: "Primary" },
  };

  it("i18n OFF renders the literal bytes the template used to spell inline", () => {
    const h = chromeHelpers({ ...manifest, format: "tsx" }, false);
    expect(String(h.chrome!("removeItem", { hash: {} } as never))).toBe("Remove");
    expect(String(h.chrome!("addItem", { hash: { item: "Line" } } as never))).toBe("Add Line");
    expect(String(h.chromeAttr!("aria-label", "nav", { hash: {} } as never))).toBe(
      'aria-label="Primary"',
    );
    expect(String(h.chromeValue!("removeItem", { hash: {} } as never))).toBe('"Remove"');
    // The runtime import is the one helper that renders NOTHING when off — a
    // template can place it unconditionally.
    expect(String(h.chromeImport!("../i18n", {} as never))).toBe("");
  });

  it("i18n ON binds `t(key, default, values)` per format", () => {
    const key = packChromeKey("demo", "removeItem", "Remove");
    const tsx = chromeHelpers({ ...manifest, format: "tsx" }, true);
    expect(String(tsx.chrome!("removeItem", { hash: {} } as never))).toBe(
      `{t("${key}", "Remove")}`,
    );
    expect(String(tsx.chromeAttr!("aria-label", "nav", { hash: {} } as never))).toMatch(
      /^aria-label=\{t\(/,
    );
    const vue = chromeHelpers({ ...manifest, format: "vue" }, true);
    expect(String(vue.chrome!("removeItem", { hash: {} } as never))).toBe(
      `{{ t("${key}", "Remove") }}`,
    );
    // Single-quoted: the bound expression carries double-quoted JS literals.
    expect(String(vue.chromeAttr!("aria-label", "nav", { hash: {} } as never))).toMatch(
      /^:aria-label='t\(/,
    );
    const ng = chromeHelpers({ ...manifest, format: "angular" }, true);
    // A hyphenated name is a plain HTML attribute — `[attr.…]`, not `[…]`,
    // which would target a non-existent element property and fail `ng build`.
    expect(String(ng.chromeAttr!("aria-label", "nav", { hash: {} } as never))).toMatch(
      /^\[attr\.aria-label\]='t\(/,
    );
    const heex = chromeHelpers({ ...manifest, format: "heex" }, true);
    expect(String(heex.chrome!("removeItem", { hash: {} } as never))).toBe(
      `<%= pgettext("${key}", "Remove") %>`,
    );
  });

  it("carries ICU hole VALUES into the call, and substitutes them when off", () => {
    const on = chromeHelpers({ ...manifest, format: "tsx" }, true);
    expect(String(on.chrome!("addItem", { hash: { item: "Line" } } as never))).toContain(
      '{ item: "Line" }',
    );
    const off = chromeHelpers({ ...manifest, format: "tsx" }, false);
    expect(String(off.chrome!("addItem", { hash: { item: "Line" } } as never))).toBe("Add Line");
  });

  it("fails loudly on a role the pack never declared", () => {
    const h = chromeHelpers({ ...manifest, format: "tsx" }, true);
    expect(() => h.chrome!("nope", { hash: {} } as never)).toThrow(/no chrome string "nope"/);
  });

  it("rejects a declared message that would break the markup it is spliced into", () => {
    // The i18n-OFF path splices the message UNQUOTED, so a `<` or a `"` would
    // corrupt the template.  Caught at pack LOAD, naming the pack.
    expect(() => assertDeclaredChromeIsSane({ name: "bad", chrome: { x: "<b>" } })).toThrow(
      /significant to the markup/,
    );
    expect(() => assertDeclaredChromeIsSane({ name: "bad", chrome: { x: 'a "b' } })).toThrow(
      /significant to the markup/,
    );
    // Braces are ICU holes and nothing else — a stray one would reach the
    // runtime formatter as a malformed message.
    expect(() => assertDeclaredChromeIsSane({ name: "bad", chrome: { x: "a { b" } })).toThrow(
      /non-ICU brace/,
    );
    expect(() =>
      assertDeclaredChromeIsSane({ name: "ok", chrome: { x: "Add {item}" } }),
    ).not.toThrow();
  });
});

describe("pack-declared chrome — every declared role is actually rendered", () => {
  // The dead-catalog class M-T1.11 already drained once for the authored slots:
  // a key a translator translates and the app never shows.  Here the check is
  // cheap and exact — a role is rendered iff some template in the SAME pack
  // names it in a chrome helper call.
  for (const { family, version, dir } of PACKS) {
    const manifest = JSON.parse(readFileSync(join(dir, "pack.json"), "utf-8")) as {
      chrome?: Record<string, string>;
    };
    const roles = Object.keys(manifest.chrome ?? {});
    if (roles.length === 0) continue;
    it(`${family}@${version} renders each of its ${roles.length} declared roles`, () => {
      const sources = hbsFiles(dir).map((f) => readFileSync(f, "utf-8"));
      for (const role of roles) {
        const used = sources.some((s) => s.includes(`"${role}"`));
        expect(
          used,
          `${family}@${version} declares chrome "${role}" but no template renders it`,
        ).toBe(true);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// The COMPLETENESS gate.
//
// Scans every `.hbs` for English in the two positions a user can read: a markup
// TEXT node, and a user-facing ATTRIBUTE.  A hit that is neither a chrome
// helper call nor a Handlebars expression is an untranslatable string, and it
// fails here rather than shipping.
//
// Mutation-proved: reverting any wired string to its literal form (e.g. putting
// `>Remove<` back in `field-input-array.hbs`) makes this test fail, naming the
// file and the string.  The waiver list below is a RATCHET — an entry that
// stops matching fails the test, so a fix deletes its waiver in the same PR.
// ---------------------------------------------------------------------------

/** Strings the scanner sees that are NOT user-visible text, with the reason.
 *  Each is a fragment of CODE that happens to sit between `>` and `<` (a
 *  TypeScript generic bound, an Elixir expression) or inside a template
 *  placeholder — not something a locale could translate. */
const NOT_USER_VISIBLE: ReadonlyArray<{ text: string; reason: string }> = [
  { text: "%sveltekit.body%", reason: "SvelteKit's own HTML placeholder token" },
  { text: "& VariantProps", reason: "TypeScript intersection in a generic bound" },
  { text: "= FieldPath", reason: "TypeScript default type argument" },
  { text: "`'s `", reason: "a backtick fragment inside a JS/TS comment" },
  { text: "`, not `", reason: "a backtick fragment inside a JS/TS comment" },
  { text: "child", reason: "the `<T,>`-style generic parameter list in chakra's format helpers" },
  {
    text: "if assigns.multiple, do: field.name",
    reason: "Elixir code inside a HEEx attribute expression",
  },
];

/** Attributes whose literal value a user reads (or a screen reader announces). */
const USER_VISIBLE_ATTRS = ["aria-label", "placeholder", "alt", "title"];

function scanUntranslated(): Array<{ file: string; where: string; text: string }> {
  const hits: Array<{ file: string; where: string; text: string }> = [];
  for (const { dir } of PACKS) {
    for (const file of hbsFiles(dir)) {
      const src = readFileSync(file, "utf-8");
      // A markup text node: between `>` and `<`, containing a letter, with no
      // `{`/`}` (which would make it a Handlebars/JSX expression rather than
      // literal text — including every `{{{chrome …}}}` call).
      for (const m of src.matchAll(/>([^<>{}\n]*[A-Za-z][^<>{}\n]*)</g)) {
        const text = m[1]!.trim();
        if (!text || /^[\s.,:;|/&·—–-]*$/.test(text)) continue;
        hits.push({ file, where: "text", text });
      }
      for (const attr of USER_VISIBLE_ATTRS) {
        const re = new RegExp(
          `(?<![\\w:\\[.])${attr}=("([^"{}]*[A-Za-z][^"{}]*)"|'([^'{}]*[A-Za-z][^'{}]*)')`,
          "g",
        );
        for (const m of src.matchAll(re)) {
          hits.push({ file, where: attr, text: (m[2] ?? m[3])! });
        }
      }
    }
  }
  return hits;
}

describe("pack-declared chrome — no untranslatable English left in a template", () => {
  const hits = scanUntranslated();

  it("every user-visible literal in every pack template is either translated or a reasoned waiver", () => {
    const waived = new Set(NOT_USER_VISIBLE.map((w) => w.text));
    const leaked = hits.filter((h) => !waived.has(h.text));
    expect(
      leaked.map((h) => `${h.file} [${h.where}] ${JSON.stringify(h.text)}`),
      "a pack template hardcodes user-visible English — declare it in that pack.json's `chrome` map and render it through {{{chrome …}}} / {{{chromeAttr …}}}",
    ).toEqual([]);
  });

  it("the waiver list ratchets — every entry still matches something", () => {
    const seen = new Set(hits.map((h) => h.text));
    for (const w of NOT_USER_VISIBLE) {
      expect(
        seen.has(w.text),
        `stale waiver ${JSON.stringify(w.text)} (${w.reason}) — delete it`,
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// End-to-end: the catalogs and the emitted bindings agree, and an app that
// opted OUT of i18n carries no pack chrome at all.
// ---------------------------------------------------------------------------

const SYSTEM = (design: string, heading: string) => `
  system Shop {
    subdomain Sales {
      context Sales {
        aggregate Order with crudish { status: string }
        repository Orders for Order { }
      }
    }
    api SalesApi from Sales
    ui Web {
      api Sales: SalesApi
      page Home { route: "/" body: Stack { ${heading}CreateForm { of: Order } } }
    }
    storage primary { type: postgres }
    resource salesState { for: Sales, kind: state, use: primary }
    deployable api {
      platform: node
      contexts: [Sales]
      dataSources: [salesState]
      serves: SalesApi
      port: 3000
    }
    deployable web { platform: react targets: api ui: Web { Sales: api } design: ${design} port: 3100 }
  }
`;

/** The one emitted frontend's file at `<deployable>/<suffix>`. */
function fileEndingWith(files: Map<string, string>, suffix: string): string {
  const entry = [...files].find(([p]) => p.endsWith(suffix));
  if (!entry) throw new Error(`no file emitted ending in ${suffix}`);
  return entry[1];
}

describe("pack-declared chrome — catalogs and emission", () => {
  it("`.loom/messages.en.json` and the app's `locales/en.json` carry the pack's keys", async () => {
    const files = await generateSystemFiles(SYSTEM("mantine", 'Heading { "Orders" }, '));
    const catalog = JSON.parse(files.get(".loom/messages.en.json")!) as Record<string, string>;
    const packKeys = Object.keys(catalog).filter((k) => k.startsWith("pack.mantine."));
    expect(packKeys.length).toBeGreaterThan(0);
    expect(catalog[packChromeKey("mantine", "removeItem", "Remove")]).toBe("Remove");

    const app = JSON.parse(fileEndingWith(files, "src/locales/en.json")) as Record<string, string>;
    for (const k of packKeys) expect(app[k]).toBe(catalog[k]);
  });

  it("binds the same key the catalog carries, and imports the `t` it resolves against", async () => {
    const files = await generateSystemFiles(SYSTEM("mantine", 'Heading { "Orders" }, '));
    const format = fileEndingWith(files, "src/lib/format.tsx");
    expect(format).toContain(`t("${packChromeKey("mantine", "boolTrue", "Yes")}", "Yes")`);
    // `src/lib/format.tsx` is a WHOLE file the pack emits, so the pack places
    // its own import (the `{{{chromeImport}}}` helper) — the walker's import
    // map never sees it.
    expect(format).toContain('import { t } from "../i18n";');
  });

  // An operation dialog is the one pack fragment rendered OUTSIDE the walk —
  // the page shell splices it in, and on React/Svelte it did so AFTER the
  // import block had been serialized.  So the binding and its `t` are asserted
  // together, per frontend, on a scaffolded detail page (where op dialogs
  // actually appear) whose aggregate has an array field.
  const OP_DIALOG_SYSTEM = (platform: string, design: string) => `
  system Shop {
    subdomain Sales {
      context Sales {
        aggregate Order with crudish {
          status: string
          tags: string[]
          operation retag(newTags: string[]) { status := "tagged" }
        }
        repository Orders for Order { }
      }
    }
    api SalesApi from Sales
    ui Web with scaffold(subdomains: [Sales]) { api Sales: SalesApi }
    storage primary { type: postgres }
    resource salesState { for: Sales, kind: state, use: primary }
    deployable api {
      platform: node
      contexts: [Sales]
      dataSources: [salesState]
      serves: SalesApi
      port: 3000
    }
    deployable web { platform: ${platform} targets: api ui: Web { Sales: api } design: ${design} port: 3100 }
  }
`;

  for (const [platform, design, family, suffix, importLine] of [
    ["react", "mantine", "mantine", "pages/orders/detail.tsx", 'from "../../i18n"'],
    ["vue", "vuetify", "vuetify", "pages/orders/detail.vue", 'from "../../i18n"'],
    ["svelte", "flowbite", "flowbite", "orders/[id]/+page.svelte", 'from "$lib/i18n"'],
  ] as const) {
    it(`${platform}: an op dialog's pack chrome binds AND the page imports its \`t\``, async () => {
      const files = await generateSystemFiles(OP_DIALOG_SYSTEM(platform, design));
      const page = fileEndingWith(files, suffix);
      expect(page).toContain(`t("pack.${family}.arrayUnsupported.`);
      expect(page).toContain(importLine);
    });
  }

  it("a string-less UI stays byte-identical — pack chrome never flips i18n on", async () => {
    // No authored text anywhere: the `Heading` is gone, so `collectUiMessages`
    // is empty and the whole translation runtime stays off.  Pack chrome must
    // NOT be what turns it on, or every app would grow an `i18n.ts` and an
    // `intl-messageformat` dependency it has no use for.
    const files = await generateSystemFiles(SYSTEM("mantine", ""));
    expect(files.get(".loom/messages.en.json")).toBe("{}\n");
    expect([...files.keys()].some((p) => p.endsWith("src/i18n.ts"))).toBe(false);
    expect(fileEndingWith(files, "src/lib/format.tsx")).not.toContain('t("pack.');
    expect(fileEndingWith(files, "src/lib/format.tsx")).toContain(">Yes<");
  });
});

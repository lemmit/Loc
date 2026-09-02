// ---------------------------------------------------------------------------
// Cross-target DEAD-CATALOG-KEY gate (audit finding A13).
//
// `user-visible-slot-coverage.test.ts` measures the other direction — a string
// that RENDERS but was never extracted.  This file measures the dead key: an
// entry the extraction pass writes into `.loom/messages.en.json` that no
// emitter ever reads back, so a translator translates text the app keeps
// showing in English at every locale.  Nothing in the pipeline could see it:
// the catalog is complete, the page renders, and the two simply never meet.
//
// Two holes, both closed here:
//
//   (a) THE MODAL TRIGGER LABEL.  `Modal { trigger: Button { "Confirm it" } }`
//       is a `Button` call, so the extractor keys its label `page.<P>.button.
//       <hash>` — and every one of the five modal renderers read it RAW.  On
//       HEEx the raw read sat two lines below the modal TITLE, which IS
//       translated.
//
//   (b) THE SIDEBAR.  `menu { section "Sales" { link Home { label: "All orders" },
//       link "Docs" -> "…" } }` yields `menu.section.<hash>` / `menu.link.<hash>`
//       entries; `menu-emitter.ts` handed the shells a raw string and every pack
//       spelled it `{{label}}`.
//
// The assertions are deliberately KEY-EXACT: each expected key is recomputed
// from the emitted catalog rather than hardcoded, so a change to the hashing or
// to the slot ROLE fails here instead of silently emitting a `t()` call whose
// key resolves to nothing — which is the very failure being fixed.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const UI = `
    ui Web {
      api Ops: DemoApi
      menu {
        section "Sales" {
          link Home { label: "All orders" }
          link "Docs" -> "https://example.com/docs"
        }
      }
      // A DETAIL route: the by-name \`OperationForm { of:, op: }\` targets the
      // record the route \`:id\` names, and \`loom.op-form-needs-route-id\`
      // rejects it on a page that declares none.
      page Home(id: Doc id) {
        route: "/docs/:id"
        body: Stack {
          Heading { "Home" },
          Modal {
            trigger: Button { "Confirm it", testid: "docs-op-approve" },
            title: "Approve order",
            OperationForm { of: Doc, op: approve }
          }
        }
      }
    }`;

const DOMAIN = `
    subdomain S {
      context C {
        aggregate Doc with crudish {
          name: string
          operation approve() { }
        }
        repository Docs for Doc { }
      }
    }
    api DemoApi from S`;

const spa = (platform: string): string => `
  system Demo {${DOMAIN}
    ${UI}
    storage loomDb { type: postgres }
    resource cState { for: C, kind: state, use: loomDb }
    deployable api { platform: node, contexts: [C], dataSources: [cState], serves: DemoApi, port: 3000 }
    deployable web { platform: ${platform}, targets: api, ui: Web { Ops: api }, port: 3001 }
  }
`;

const phoenix = `
  system Demo {${DOMAIN}
    ${UI}
    storage loomDb { type: postgres }
    resource cState { for: C, kind: state, use: loomDb }
    deployable phoenixApp {
      platform: elixir, contexts: [C], dataSources: [cState], serves: DemoApi,
      ui: Web { Ops: phoenixApp }, port: 4000
    }
  }
`;

/** All emitted app source, minus the catalogs themselves (a key "rendering"
 *  because it appears in `messages.en.json` is exactly the vacuous pass this
 *  gate exists to prevent). */
function appSource(files: Map<string, string>): string {
  return [...files]
    .filter(([p]) => !p.startsWith(".loom/") && !p.includes("/locales/"))
    .map(([, c]) => c)
    .join("\n");
}

/** The one catalog key whose message is `message` — asserted UNIQUE, so a test
 *  can't accidentally match a different slot's key. */
function keyFor(files: Map<string, string>, message: string): string {
  const catalog = [...files].find(([p]) => p.endsWith(".loom/messages.en.json"));
  expect(catalog, "no message catalog was emitted — the fixture has no i18n").toBeDefined();
  const entries = Object.entries(JSON.parse(catalog![1]) as Record<string, string>).filter(
    ([, v]) => v === message,
  );
  expect(
    entries.map(([k]) => k),
    `expected exactly one catalog key for ${message}`,
  ).toHaveLength(1);
  return entries[0]![0];
}

/** Each target's `t()` call spelling, given a key + its default message. */
const CALL: Record<string, (key: string, message: string) => string> = {
  react: (k, m) => `t(${JSON.stringify(k)}, ${JSON.stringify(m)})`,
  vue: (k, m) => `t(${JSON.stringify(k)}, ${JSON.stringify(m)})`,
  svelte: (k, m) => `t(${JSON.stringify(k)}, ${JSON.stringify(m)})`,
  angular: (k, m) => `t(${JSON.stringify(k)}, ${JSON.stringify(m)})`,
  feliz: (k, m) => `I18n.t "${k}" "${m}"`,
  flutter: (k, m) => `t('${k}', '${m}')`,
  phoenixLiveView: (k, m) => `pgettext("${k}", "${m}")`,
};

const MODAL_TARGETS = [
  { name: "react", source: () => spa("react") },
  { name: "vue", source: () => spa("vue") },
  { name: "svelte", source: () => spa("svelte") },
  { name: "angular", source: () => spa("angular") },
  { name: "feliz", source: () => spa("feliz") },
  { name: "flutter", source: () => spa("flutter") },
  { name: "phoenixLiveView", source: () => phoenix },
] as const;

describe("A13a — the modal trigger label renders through the catalog key it owns", () => {
  for (const { name, source } of MODAL_TARGETS) {
    it(`${name}: the trigger's label is translated, not raw`, async () => {
      const files = await generateSystemFiles(source());
      const key = keyFor(files, "Confirm it");
      // The key the extractor wrote is a `button` slot on the page — the same
      // role a plain `Button` uses, which is what makes the two agree.
      expect(key).toMatch(/^page\.Home\.button\./);
      expect(appSource(files)).toContain(CALL[name]!(key, "Confirm it"));
    });
  }
});

// Feliz's navbar is derived from the ui's PAGES (not from a `menu { … }`
// block), and Flutter's shell has no sidebar at all, so neither consumes the
// menu-emitter VM this fix routes through.  The five that do:
const MENU_TARGETS = [
  { name: "react", source: () => spa("react") },
  { name: "vue", source: () => spa("vue") },
  { name: "svelte", source: () => spa("svelte") },
  { name: "angular", source: () => spa("angular") },
  { name: "phoenixLiveView", source: () => phoenix },
] as const;

describe("A13b — sidebar section + link labels render through their catalog keys", () => {
  for (const { name, source } of MENU_TARGETS) {
    it(`${name}: an internal link's authored label is translated`, async () => {
      const files = await generateSystemFiles(source());
      const key = keyFor(files, "All orders");
      expect(key).toMatch(/^menu\.link\./);
      expect(appSource(files)).toContain(CALL[name]!(key, "All orders"));
    });

    it(`${name}: an external link's label is translated`, async () => {
      const files = await generateSystemFiles(source());
      const key = keyFor(files, "Docs");
      expect(key).toMatch(/^menu\.link\./);
      expect(appSource(files)).toContain(CALL[name]!(key, "Docs"));
    });
  }

  // The section heading renders on the four JS shells; the HEEx sidebar only
  // emits a heading when there is more than one section, so it is excluded
  // rather than asserted vacuously.
  for (const { name, source } of MENU_TARGETS.filter((t) => t.name !== "phoenixLiveView")) {
    it(`${name}: the section heading is translated`, async () => {
      const files = await generateSystemFiles(source());
      const key = keyFor(files, "Sales");
      expect(key).toMatch(/^menu\.section\./);
      expect(appSource(files)).toContain(CALL[name]!(key, "Sales"));
    });
  }
});

describe("a label with no catalog key stays raw", () => {
  // The DEFAULT sidebar (no `menu { … }` block) labels every entry from the
  // aggregate/workflow names the emitter derives — text no translator ever
  // sees, and text the extraction pass therefore never records.  Binding those
  // through `t()` would emit a key that resolves to nothing, so they must stay
  // the plain attribute even with i18n fully ON.  This is also the invariant
  // that lets the label token be spliced UNESCAPED (`{{{labelText}}}`): with no
  // key the token IS the Handlebars-escaped raw string.
  const defaultSidebar = `
  system Demo {${DOMAIN}
    ui Web {
      api Ops: DemoApi
      page Home { route: "/" body: Stack { Heading { "Welcome aboard" } } }
      page DocList { route: "/docs" body: Stack { Heading { "Docs" } } }
    }
    storage loomDb { type: postgres }
    resource cState { for: C, kind: state, use: loomDb }
    deployable api { platform: node, contexts: [C], dataSources: [cState], serves: DemoApi, port: 3000 }
    deployable web { platform: react, targets: api, ui: Web { Ops: api }, port: 3001 }
  }
`;

  it("react: i18n is on, yet the derived nav labels bind no key", async () => {
    const files = await generateSystemFiles(defaultSidebar);
    const shell = [...files].find(([p]) => p.endsWith("src/App.tsx"))![1];
    // i18n IS on for this ui (the page heading is an authored string)…
    expect(appSource(files)).toContain('"Welcome aboard"');
    // …but no nav label binds a `menu.*` key, because none exists.
    expect(shell).not.toContain('t("menu.');
    expect(shell).toContain('label="Aggregates"');
  });
});

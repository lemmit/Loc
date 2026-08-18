// User-visible slot coverage — "extracted ⇒ rendered", across every pack.
//
// `USER_VISIBLE_SLOTS` (src/util/user-visible-slots.ts) is the single source of
// truth for "which argument of a page primitive holds end-user-facing text".
// Two consumers read it: the `loom.user-visible-concat` validator, and the
// extraction pass that keys each literal into `.loom/messages.en.json`.
//
// Nothing checked the third half of the contract: that a pack actually RENDERS
// the slot.  A pack that silently drops one still contributes the string to the
// catalog — so a translator translates text the app never shows, and the
// mistake is invisible until someone reads the generated output.  That is not
// hypothetical: `Divider { label: … }` was extracted and rendered NOWHERE by
// SIX packs (all three Angular packs, both chakra packs, Feliz, Flutter) until
// #2388, and the two chakra templates had a `hasLabel` branch byte-identical to
// their unlabelled one — a copy-paste no per-pack test could see.
//
// This gate closes that hole (D-I18N-ATTR's corollary in docs/decisions.md: a
// pack that drops a user-visible slot is a bug, not a style choice).  For every
// slot it authors a page carrying a UNIQUE sentinel, generates the system for
// every pack × platform, and asserts the sentinel reaches THAT PAGE'S file.
//
// Two properties make the assertion a plain substring check on every target:
//   * with i18n on, the emitted call carries the source literal as its default
//     (`t("page.Home.badge.a1b2", "SlotBadge")`, `gettext("SlotBadge")`,
//     `I18n.t "…" "SlotBadge"`), so the sentinel is present either way;
//   * the search is scoped to the PAGE file — never the catalog (`en.json`,
//     `i18n.ts`, `lib/i18n.dart`) and never the emitted specs/page-objects,
//     which would make the check vacuously true.
//
// Feliz is the one target whose catalog shares a FILE with its views (the `I18n`
// F# module lives in `App.fs`), so its catalog block is stripped before the
// search — see `pageSourceOf`.
//
// A genuine "this target cannot express this slot" case is a WAIVER with a
// reason, not a silent pass: the waiver list is the honest inventory of what is
// still missing, and it only ever shrinks.
//
// --- and the second half: extracted ⇒ rendered THROUGH THE RUNTIME ----------
//
// The substring check above is deliberately weak — property one is precisely
// that the sentinel is present "either way".  That makes it blind to the defect
// one rung up: a pack that renders the slot as RAW ENGLISH, bypassing `t()`.
// The string reaches the page, so the gate passes; the catalog still carries a
// key nothing resolves, so a translator's work is still dropped on the floor —
// the same dead-catalog class, one level in.
//
// `it("translates …")` closes that: for every slot it looks the sentinel up in
// the EMITTED `.loom/messages.en.json` and asserts the page carries that KEY.
// A raw-English render has no key, so it fails; a translated one carries it on
// every engine (`t("<key>", …)`, `I18n.t "<key>"`, `pgettext("<key>", …)`).
// Reading the key from the emitted catalog rather than re-deriving it is what
// makes "the emitted key equals the catalog key" the thing under test.
//
// It found two defects on its first run, one per engine — each had got the half
// the other missed:
//   * `keyValue` — `KeyValueRow`'s label never touched the i18n seam at all
//     (`emitKeyValueRow` read the raw literal), so eleven JSX packs, Feliz and
//     Flutter shipped it in English at every locale.  It is a POSITIONAL slot
//     rendered in ATTRIBUTE position, which is exactly how it fell between the
//     text-slot work and the D-I18N-ATTR named-slot work.
//   * `toolbarAria` on both HEEx packs — worse than untranslated: `Toolbar`'s
//     spec hardcoded `aria-label="Actions"` and never set `labelAsAriaLabel`,
//     so the authored `label:` landed in a junk `label=` attribute on a `<div>`
//     and the accessible name was the English contract default at every locale.
//     The substring gate passed on that dead attribute.

import { describe, expect, it } from "vitest";
import { USER_VISIBLE_SLOTS } from "../../src/util/user-visible-slots.js";
import { generateSystemFiles } from "../_helpers/index.js";

// --- targets ---------------------------------------------------------------

/** One row per pack the walker renders through, plus the two targets with their
 *  own engines (Feliz's F#, Flutter's Dart) and the HEEx packs. */
interface Target {
  /** Display name — also the vitest case name. */
  readonly id: string;
  /** `design:` value, omitted for the targets with no `.hbs` pack. */
  readonly pack?: string;
  /** `platform:` of the ui deployable. */
  readonly platform: string;
  /** `framework:` on the `ui` block, when it differs from the host default. */
  readonly framework?: string;
  /** Path suffix of the emitted page the slot must reach. */
  readonly pageSuffix: string;
}

const TARGETS: readonly Target[] = [
  { id: "mantine", pack: "mantine", platform: "static", pageSuffix: "pages/home.tsx" },
  { id: "shadcn", pack: "shadcn", platform: "static", pageSuffix: "pages/home.tsx" },
  { id: "mui", pack: "mui", platform: "static", pageSuffix: "pages/home.tsx" },
  { id: "chakra", pack: "chakra", platform: "static", pageSuffix: "pages/home.tsx" },
  { id: "vuetify", pack: "vuetify", platform: "vue", pageSuffix: "pages/home.vue" },
  { id: "shadcnVue", pack: "shadcnVue", platform: "vue", pageSuffix: "pages/home.vue" },
  { id: "shadcnSvelte", pack: "shadcnSvelte", platform: "svelte", pageSuffix: "+page.svelte" },
  { id: "flowbite", pack: "flowbite", platform: "svelte", pageSuffix: "+page.svelte" },
  {
    id: "angularMaterial",
    pack: "angularMaterial",
    platform: "angular",
    pageSuffix: "pages/home.component.ts",
  },
  { id: "primeng", pack: "primeng", platform: "angular", pageSuffix: "pages/home.component.ts" },
  {
    id: "spartanNg",
    pack: "spartanNg",
    platform: "angular",
    pageSuffix: "pages/home.component.ts",
  },
  { id: "feliz", platform: "feliz", framework: "feliz", pageSuffix: "src/App.fs" },
  { id: "flutter", platform: "flutter", framework: "flutter", pageSuffix: "pages/home_page.dart" },
  // Phoenix HEEx — a `ui:` mounted on the elixir backend deployable itself
  // (no separate frontend host), so it needs the other system shape below.
  { id: "coreComponents", pack: "coreComponents", platform: "elixir", pageSuffix: "home_live.ex" },
  { id: "daisyui", pack: "daisyui", platform: "elixir", pageSuffix: "home_live.ex" },
];

// --- the slot probes -------------------------------------------------------

/** A page body exercising one primitive, with a unique sentinel per slot ROLE.
 *  `state` is prepended to the page when the primitive needs one (`Modal.open`).
 *
 *  Every role in `USER_VISIBLE_SLOTS` must appear in exactly one probe — the
 *  completeness check below fails if a new slot is added without one. */
interface Probe {
  readonly primitive: string;
  readonly body: string;
  /** role → the sentinel literal authored in that slot. */
  readonly sentinels: Readonly<Record<string, string>>;
  readonly state?: string;
}

const PROBES: readonly Probe[] = [
  {
    primitive: "Heading",
    body: `Heading { "SlotHeading" }`,
    sentinels: { heading: "SlotHeading" },
  },
  { primitive: "Text", body: `Text { "SlotText" }`, sentinels: { text: "SlotText" } },
  { primitive: "Bold", body: `Bold { "SlotBold" }`, sentinels: { bold: "SlotBold" } },
  { primitive: "Italic", body: `Italic { "SlotItalic" }`, sentinels: { italic: "SlotItalic" } },
  {
    primitive: "InlineCode",
    body: `InlineCode { "SlotCode" }`,
    sentinels: { code: "SlotCode" },
  },
  { primitive: "Empty", body: `Empty { "SlotEmpty" }`, sentinels: { empty: "SlotEmpty" } },
  {
    primitive: "Anchor",
    body: `Anchor { "SlotAnchor", to: "/x" }`,
    sentinels: { anchor: "SlotAnchor" },
  },
  {
    primitive: "KeyValueRow",
    body: `KeyValueRow { "SlotKeyValue", Text { "v" } }`,
    sentinels: { keyValue: "SlotKeyValue" },
  },
  { primitive: "Badge", body: `Badge { "SlotBadge" }`, sentinels: { badge: "SlotBadge" } },
  {
    primitive: "Button",
    body: `Button { "SlotButton", label: "SlotButtonAria", to: "/x" }`,
    sentinels: { button: "SlotButton", buttonAria: "SlotButtonAria" },
  },
  {
    primitive: "Stat",
    body: `Stat { "SlotStatLabel", "SlotStatValue" }`,
    sentinels: { statLabel: "SlotStatLabel", statValue: "SlotStatValue" },
  },
  {
    primitive: "Card",
    body: `Card { "SlotCardTitle", Text { "body" } }`,
    sentinels: { cardTitle: "SlotCardTitle" },
  },
  {
    primitive: "Alert",
    body: `Alert { "SlotAlert", title: "SlotAlertTitle" }`,
    sentinels: { alert: "SlotAlert", alertTitle: "SlotAlertTitle" },
  },
  {
    primitive: "Toolbar",
    body: `Toolbar { label: "SlotToolbarAria", Text { "child" } }`,
    sentinels: { toolbarAria: "SlotToolbarAria" },
  },
  {
    primitive: "Divider",
    body: `Divider { label: "SlotDividerLabel" }`,
    sentinels: { dividerLabel: "SlotDividerLabel" },
  },
  {
    primitive: "Modal",
    body: `Modal { Text { "m" }, open: modalOpen, title: "SlotModalTitle" }`,
    state: `state { modalOpen: bool = false }`,
    sentinels: { modalTitle: "SlotModalTitle" },
  },
  {
    // A meaning-bearing icon opts out of decorative-by-default with `label:`,
    // which becomes its accessible name — user-AUDIBLE text, extracted like any
    // other slot.  `name:` must resolve in the builtin registry or the emitter
    // renders a comment instead of the icon.
    primitive: "Icon",
    body: `Icon { name: "check", label: "SlotIconLabel" }`,
    sentinels: { iconLabel: "SlotIconLabel" },
  },
  {
    primitive: "CodeBlock",
    body: `CodeBlock { "let x = 1", language: "typescript", title: "SlotCodeBlockTitle" }`,
    sentinels: { codeBlockTitle: "SlotCodeBlockTitle" },
  },
  // The seven controlled inputs share one `inputLabel` role, so each needs its
  // own probe: the packs render the label three different ways (a prop, element
  // text, a native-language string), and they do not split along primitive
  // lines — `Toggle` is an attribute where `Field` is text on the same pack.
  {
    primitive: "Field",
    body: `Field { "SlotFieldLabel", bind: name }`,
    state: `state { name: string = "" }`,
    sentinels: { inputLabel: "SlotFieldLabel" },
  },
  {
    primitive: "NumberField",
    body: `NumberField { "SlotNumberFieldLabel", bind: qty }`,
    state: `state { qty: int = 0 }`,
    sentinels: { inputLabel: "SlotNumberFieldLabel" },
  },
  {
    primitive: "PasswordField",
    body: `PasswordField { "SlotPasswordFieldLabel", bind: secret }`,
    state: `state { secret: string = "" }`,
    sentinels: { inputLabel: "SlotPasswordFieldLabel" },
  },
  {
    primitive: "MultilineField",
    body: `MultilineField { "SlotMultilineFieldLabel", bind: notes }`,
    state: `state { notes: string = "" }`,
    sentinels: { inputLabel: "SlotMultilineFieldLabel" },
  },
  {
    primitive: "SelectField",
    body: `SelectField { "SlotSelectFieldLabel", bind: choice, options: ["a", "b"] }`,
    state: `state { choice: string = "" }`,
    sentinels: { inputLabel: "SlotSelectFieldLabel" },
  },
  {
    primitive: "Toggle",
    body: `Toggle { "SlotToggleLabel", bind: flag }`,
    state: `state { flag: bool = false }`,
    sentinels: { inputLabel: "SlotToggleLabel" },
  },
  {
    primitive: "FileUpload",
    body: `FileUpload { "SlotFileUploadLabel", bind: doc }`,
    state: `state { doc: File }`,
    sentinels: { inputLabel: "SlotFileUploadLabel" },
  },
  {
    primitive: "Tab",
    body: `Tabs { Tab { "SlotTabLabel", Text { "panel" } } }`,
    sentinels: { tabLabel: "SlotTabLabel" },
  },
  {
    // `Column` is shared by `Table` and `DataGrid`; the Table path is the one
    // every target renders (Flutter has no grid), so it is what the probe
    // authors.  The grid path has its own per-slot test in the walker suite.
    primitive: "Column",
    body: `QueryView {
      of: Shop.Product.all,
      data: rows => Table { rows: rows, Column { "SlotColumnHeader", o => Text { o.name } } }
    }`,
    sentinels: { columnHeader: "SlotColumnHeader" },
  },
];

// --- waivers ---------------------------------------------------------------

/** `<target>:<role>` → why that target cannot render the slot TODAY.
 *
 *  A waiver is a stated gap, never a silent one, and the list only shrinks.
 *  Deleting a line is how the gap closes. */
const WAIVERS: Readonly<Record<string, string>> = {
  // (empty — every target renders every slot.  Keep the mechanism: a new pack or
  // frontend that can't express one states it here, with a reason.)
};

/** `<target>:<role>` → why that target renders the slot but cannot route it
 *  through the translation runtime TODAY.  Ratchets exactly like `WAIVERS`: a
 *  waived cell must STILL be untranslated, so a fix that lands without deleting
 *  its line fails the gate. */
const TRANSLATION_WAIVERS: Readonly<Record<string, string>> = {
  // (empty — every target translates every slot it renders.)
};

// --- harness ---------------------------------------------------------------

/** Phoenix mounts its `ui:` on the elixir BACKEND deployable — there is no
 *  separate frontend host, so the two-deployable shape below doesn't apply. */
const phoenixSystem = (t: Target, body: string, state: string): string => `
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
        ${state}
        body: ${body}
      }
    }
    deployable phoenixApp {
      platform: elixir, contexts: [Cat], dataSources: [s], serves: ShopApi,
      design: "${t.pack}", ui: WebApp { Shop: phoenixApp }, port: 4000
    }
  }
`;

const system = (t: Target, body: string, state: string): string => `
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
      ${t.framework ? `framework: ${t.framework}` : ""}
      api Shop: ShopApi
      page Home {
        route: "/"
        ${state}
        body: ${body}
      }
    }
    deployable api { platform: node contexts: [Cat] dataSources: [s] serves: ShopApi port: 3000 }
    deployable web {
      platform: ${t.platform}
      ${t.pack ? `design: "${t.pack}"` : ""}
      targets: api
      ui: WebApp { Shop: api }
      port: 3005
    }
  }
`;

/** The emitted page's SOURCE, with any co-located message catalog stripped.
 *
 *  Only Feliz needs the strip: its generated `I18n` module (the catalog as an F#
 *  `Map`) shares `App.fs` with the views, so an unrendered slot would still be
 *  "found" in the file. Every other target keeps its catalog in a separate file
 *  the page matcher never selects. */
function pageSourceOf(files: Map<string, string>, t: Target): string {
  const entry = [...files].find(([p]) => p.endsWith(t.pageSuffix));
  expect(
    entry,
    `${t.id}: no page matching ${t.pageSuffix} in ${[...files.keys()].join(", ")}`,
  ).toBeDefined();
  const src = entry![1];
  if (t.id !== "feliz") return src;
  // Drop `module I18n = … ` up to the next top-level `module`/`let` at col 0.
  const start = src.indexOf("module I18n =");
  if (start < 0) return src;
  const rest = src.slice(start + 1);
  const nextTop = rest.search(/\n(?:module|let|type|open) /);
  return src.slice(0, start) + (nextTop < 0 ? "" : rest.slice(nextTop));
}

describe("user-visible slots — every extracted slot is rendered by every pack", () => {
  it("every role in USER_VISIBLE_SLOTS has a probe (add one when adding a slot)", () => {
    const declared = Object.values(USER_VISIBLE_SLOTS)
      .flat()
      .map((s) => s.role)
      .sort();
    const probed = PROBES.flatMap((p) => Object.keys(p.sentinels)).sort();
    expect(probed).toEqual(declared);
  });

  it("every probe's primitive is a real USER_VISIBLE_SLOTS key", () => {
    for (const p of PROBES) expect(USER_VISIBLE_SLOTS[p.primitive], p.primitive).toBeDefined();
  });

  for (const t of TARGETS) {
    describe(t.id, () => {
      for (const probe of PROBES) {
        it(`renders ${probe.primitive}`, async () => {
          const build = t.platform === "elixir" ? phoenixSystem : system;
          const files = await generateSystemFiles(build(t, probe.body, probe.state ?? ""));
          const page = pageSourceOf(files, t);
          // De-vacuuming guard: a page that came back empty (or a pageSuffix
          // that matched the wrong file) would pass every `toContain` below by
          // accident on a target that renders nothing.
          expect(page.length, `${t.id}: empty page source`).toBeGreaterThan(0);
          for (const [role, sentinel] of Object.entries(probe.sentinels)) {
            const waiver = WAIVERS[`${t.id}:${role}`];
            if (waiver) {
              // A waived slot must STILL be absent — when it starts rendering,
              // the waiver is stale and must be deleted (a ratchet, not a mute).
              expect(page, `${t.id}:${role} now renders — delete the waiver`).not.toContain(
                sentinel,
              );
              continue;
            }
            expect(
              page,
              `${t.id}: the ${role} slot is extracted into the catalog but never rendered — ` +
                `a translator would translate "${sentinel}" for text the app never shows`,
            ).toContain(sentinel);
          }
        });

        it(`translates ${probe.primitive}`, async () => {
          const build = t.platform === "elixir" ? phoenixSystem : system;
          const files = await generateSystemFiles(build(t, probe.body, probe.state ?? ""));
          const page = pageSourceOf(files, t);
          const catalog = catalogOf(files);
          for (const [role, sentinel] of Object.entries(probe.sentinels)) {
            // A slot that isn't rendered at all is the OTHER gate's finding —
            // don't report it twice as a translation failure.
            if (WAIVERS[`${t.id}:${role}`]) continue;
            const key = keyFor(catalog, sentinel);
            const waiver = TRANSLATION_WAIVERS[`${t.id}:${role}`];
            if (waiver) {
              expect(
                page,
                `${t.id}:${role} now translates — delete the translation waiver`,
              ).not.toContain(key);
              continue;
            }
            expect(
              page,
              `${t.id}: the ${role} slot renders as RAW ENGLISH — the catalog carries ` +
                `"${sentinel}" under ${key}, but the page never resolves that key, so a ` +
                `translation of it can never reach the screen`,
            ).toContain(key);
          }
        });
      }
    });
  }
});

/** The emitted source-language catalog — the SAME artefact a translator works
 *  from, so the key asserted below is the key they would translate. */
function catalogOf(files: Map<string, string>): Record<string, string> {
  const entry = [...files].find(([p]) => p.endsWith(".loom/messages.en.json"));
  expect(entry, "no .loom/messages.en.json was emitted").toBeDefined();
  return JSON.parse(entry![1]) as Record<string, string>;
}

/** The catalog key carrying `sentinel` as its source message.  Fails loudly
 *  rather than returning undefined: a sentinel missing from the catalog means
 *  the EXTRACTION half broke, which would otherwise read as a render failure. */
function keyFor(catalog: Record<string, string>, sentinel: string): string {
  const hit = Object.entries(catalog).find(([, message]) => message === sentinel);
  expect(hit, `"${sentinel}" was never extracted into the catalog`).toBeDefined();
  return hit![0];
}

// M-FT.19 — the four ways the `flowbite` (svelte) pack rendered a broken page.
//
// Every assertion here was FALSE on the pack as shipped, and each one names a
// symptom measured in a real browser against the built bundle (chromium, 1366
// wide, the fable v2 model):
//
//   1. `New issue` / `Create` computed to `background: transparent;
//      color: white` — flowbite-svelte's Button theme is
//      `text-white bg-primary-700 …`, a NUMBERED Tailwind palette, but the
//      pack's stylesheet defined only the single `--color-primary` token.  The
//      `bg-primary-700` utility therefore did not exist, Tailwind emitted
//      nothing for it, and the button kept only the `text-white` that did:
//      white text on the page background.
//   2. The list page's document `scrollWidth` was 2520 at a 1366 viewport —
//      `<main class="flex-1">` has `min-width: auto`, so a wide table pushed
//      the whole document sideways instead of scrolling inside the Table's own
//      `overflow-x-auto` box (sidebar and header slid out of view).
//   3. flowbite-svelte's `Card` base class carries NO padding
//      (`w-full flex max-w-sm bg-white border …`), so the form card's first
//      label sat flush against the card border.
//   4. The sidebar listed raw declaration identifiers — `closeProject`,
//      `fileUrgent` — where react and vue both humanise their default sidebar.
//      The defect is in the svelte `defaultNavSections`, so it hit BOTH svelte
//      packs; the assertion is pack-independent.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

/** The flowbite-svelte class names the pack's own components resolve to.  Each
 *  needs a matching `--color-primary-<n>` in the emitted stylesheet or the
 *  utility silently does not exist. */
const FLOWBITE_PRIMARY_SHADES = [
  "50",
  "100",
  "200",
  "300",
  "400",
  "500",
  "600",
  "700",
  "800",
  "900",
  "950",
];

const SRC = `
system Fable {
  subdomain Core { context Tracking {
    enum Status { Open, Closed }
    aggregate Project with crudish {
      name: string
      description: string?
      derived display: string = name
    }
    repository Projects for Project { }
    workflow closeProject {
      create(project: Project id) {
        let p = Projects.getById(project)
      }
    }
  } }
  api CoreApi from Core
  storage pg { type: postgres }
  resource trackingState { for: Tracking, kind: state, use: pg }
  ui WebApp with scaffold(subdomains: [Core]) {
    api Core: CoreApi
  }
  deployable api {
    platform: node
    contexts: [Tracking]
    dataSources: [trackingState]
    serves: CoreApi
    port: 8080
  }
  deployable webApp {
    platform: svelte
    targets: api
    ui: WebApp { Core: api }
    design: flowbite
    port: 3000
  }
}
`;

let cache: Map<string, string> | undefined;
async function files(): Promise<Map<string, string>> {
  cache ??= await generateSystemFiles(SRC);
  return cache;
}

describe("flowbite (svelte) pack — the shell contract a rendered page depends on", () => {
  it("defines the numbered primary palette flowbite's Button colour classes resolve against", async () => {
    const css = (await files()).get("web_app/src/app.css") ?? "";
    expect(css).not.toBe("");
    // The single token alone is what shipped — and is what made the button
    // invisible.  It may stay (other templates use `text-primary`), but the
    // whole ramp must be there beside it.
    for (const shade of FLOWBITE_PRIMARY_SHADES) {
      expect(css, `--color-primary-${shade} missing: bg-primary-${shade} would not exist`).toContain(
        `--color-primary-${shade}:`,
      );
    }
    // Derived from the DSL's own theme token, not a hard-coded flowbite blue —
    // otherwise `theme { primary: … }` would be silently ignored by this pack.
    expect(css).toMatch(/--color-primary-700:[^;]*--loom-primary/);
  });

  it("width-constrains <main> so a wide table scrolls inside itself, not the document", async () => {
    const shell = (await files()).get("web_app/src/routes/(app)/+layout.svelte") ?? "";
    expect(shell).not.toBe("");
    const main = /<main[^>]*id="main-content"[^>]*>/.exec(shell)?.[0] ?? "";
    expect(main, "no <main id=\"main-content\"> in the flowbite app shell").not.toBe("");
    // `flex-1` without `min-w-0` keeps the flex item's automatic minimum size at
    // its content's min-content width — the document bleeds instead.
    expect(main).toContain("flex-1");
    expect(main).toContain("min-w-0");
  });

  it("gives the Card primitive inner padding (flowbite's Card base has none)", async () => {
    const form = (await files()).get("web_app/src/routes/(app)/projects/new/+page.svelte") ?? "";
    expect(form).not.toBe("");
    const card = /<Card[^>]*>/.exec(form)?.[0] ?? "";
    expect(card, "the scaffolded create form does not render a Card").not.toBe("");
    expect(card).toMatch(/class="[^"]*\bp-\d/);
  });

  it("humanises the default sidebar's aggregate and workflow labels", async () => {
    const shell = (await files()).get("web_app/src/routes/(app)/+layout.svelte") ?? "";
    // The raw declaration identifier is what the sidebar used to print.
    expect(shell).not.toContain(">closeProject<");
    expect(shell).toContain(">Close Project<");
    expect(shell).toContain(">Projects<");
  });
});

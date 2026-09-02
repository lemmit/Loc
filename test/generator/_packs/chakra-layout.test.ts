// ---------------------------------------------------------------------------
// Chakra pack layout contract (M-FT.18).
//
// Three defects shipped in BOTH chakra packs and were invisible to every
// existing gate, because each one is a template that renders *something* — just
// not what the author wrote:
//
//   1. `primitive-heading.hbs` compared the NUMERIC `level` against STRING
//      literals (`(eq level "1")`).  Handlebars' `eq` is strict, so all three
//      branches were dead and every heading on every page fell through to
//      `size="sm"` — ~14px, i.e. body size.  Chakra's `Heading` is
//      `withContext("h2")`, so the document outline was flat too: a level-1 and
//      a level-4 heading both rendered `<h2>`.
//   2. `primitive-stack.hbs` emitted a bare `<VStack>`, whose default
//      `align="center"` shrink-wraps and CENTRES the page — tables, toolbars
//      and form inputs alike.  Chakra was the only pack that did this.
//   3. `primitive-grid.hbs` hardcoded `columns={{ base: 1, sm: 2, md: 3 }}` and
//      never read `hasResponsiveCols`, silently discarding `Grid { cols: N }`.
//
// The gate walks a fixture page through BOTH packs (`chakra@v2` renders on
// Chakra UI v2, `chakra@v3` on v3 — different component APIs, the same bug) and
// asserts on the emitted TSX:
//
//   * heading sizes DIFFER by level, and each heading carries `as="h<n>"`;
//   * the page stack is not the centring default (explicit stretch alignment);
//   * the author's grid column counts reach the emitted `SimpleGrid`;
//   * the shell emits a real `<header>` landmark.
//
// It asserts on generated SOURCE, not on rendered pixels: the sizes each token
// resolves to are the library's business, but "level 1, 2 and 3 must not all
// come out the same" is the pack's, and that is exactly what regressed.
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const DESIGNS_DIR = path.resolve(__dirname, "..", "..", "..", "designs", "chakra");

const SRC = (design: string) => `
system ChakraLayout {
  subdomain Sales {
    context Cat {
      aggregate Item { name: string }
      repository Items for Item { }
    }
  }
  ui WebApp {
    framework: react
    page Home {
      route: "/"
      body: Stack {
        Breadcrumbs { Anchor { "Home", to: "/" }, Text { "Here" } },
        Heading { "Level one", level: 1 },
        Heading { "Level two", level: 2 },
        Heading { "Level three", level: 3 },
        Grid { Text { "a" }, Text { "b" }, Text { "c" }, Text { "d" }, cols: [4, 2, 1] },
        testid: "home"
      }
    }
  }
  api CatApi from Sales
  storage primary { type: postgres }
  resource catState { for: Cat, kind: state, use: primary }
  deployable api { platform: node contexts: [Cat] dataSources: [catState] serves: CatApi port: 4400 }
  deployable web { platform: react targets: api ui: WebApp port: 3007 design: ${design} }
}
`;

/** The emitted page + shell for one chakra pack. */
async function emitted(design: string): Promise<{ page: string; shell: string }> {
  const files = await generateSystemFiles(SRC(design));
  const page = files.get("web/src/pages/home.tsx");
  const shell = files.get("web/src/App.tsx");
  expect(page, `no home page emitted for ${design}`).toBeTruthy();
  expect(shell, `no App shell emitted for ${design}`).toBeTruthy();
  return { page: page!, shell: shell! };
}

/** Every `size="…"` on an emitted `<Heading>`, in source order. */
function headingSizes(tsx: string): string[] {
  return [...tsx.matchAll(/<Heading\b[^>]*\bsize="([^"]+)"/g)].map((m) => m[1]!);
}

const PACKS = ['"chakra@v2"', '"chakra@v3"'];

describe.each(PACKS)("chakra pack layout contract — %s", (design) => {
  it("renders a distinct heading size per level, with the matching element", async () => {
    const { page } = await emitted(design);
    // The page body declares levels 1, 2 and 3 in that order.  The bug made all
    // three `size="sm"`.
    const sizes = headingSizes(page).slice(0, 3);
    expect(sizes, "three headings rendered").toHaveLength(3);
    expect(new Set(sizes).size, `level 1/2/3 collapsed to one size: ${sizes.join(", ")}`).toBe(3);
    // Chakra's Heading is `withContext("h2")` — without an explicit `as`, the
    // rank the author asked for never reaches the DOM.
    expect(page).toContain('<Heading as="h1"');
    expect(page).toContain('<Heading as="h2"');
    expect(page).toContain('<Heading as="h3"');
  });

  it("does not centre the page: the root stack aligns stretch", async () => {
    const { page } = await emitted(design);
    expect(page).toMatch(/<VStack align="stretch" gap=\{4\}[^>]*data-testid="home"/);
    // No `VStack` anywhere may fall back to Chakra's centring default.
    const bare = [...page.matchAll(/<VStack(?![^>]*\balign=)/g)];
    expect(bare, "a VStack without an explicit align= centres its children").toHaveLength(0);
  });

  it("honours the author's grid column counts", async () => {
    const { page } = await emitted(design);
    // `cols: [4, 2, 1]` → desktop 4, tablet 2, mobile 1.
    expect(page).toContain("<SimpleGrid columns={{ base: 1, md: 2, lg: 4 }}");
    expect(page, "the hardcoded 1/2/3 fallback discards the author's cols").not.toContain(
      "columns={{ base: 1, sm: 2, md: 3 }}",
    );
  });

  it("emits a header landmark in the app shell", async () => {
    const { shell } = await emitted(design);
    expect(shell).toMatch(/as="header"/);
    expect(shell).toContain('as="main"');
  });

  it("wraps every breadcrumb in its own list item", async () => {
    const { page } = await emitted(design);
    const item = design.includes("v3") ? "<Breadcrumb.Item>" : "<BreadcrumbItem";
    expect(page.split(item).length - 1, "one item per crumb").toBe(2);
  });
});

describe("chakra packs use semantic colour tokens", () => {
  // Raw palette steps were chakra's alone across the fifteen packs; they are
  // the one thing that would not follow a colour-mode switch.
  for (const version of fs.readdirSync(DESIGNS_DIR).sort()) {
    const dir = path.join(DESIGNS_DIR, version);
    if (!fs.statSync(dir).isDirectory()) continue;
    it(`${version} has no raw gray.N palette steps`, () => {
      const offenders = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".hbs"))
        .filter((f) => /\bgray\.\d/.test(fs.readFileSync(path.join(dir, f), "utf-8")));
      expect(offenders).toEqual([]);
    });
  }
});

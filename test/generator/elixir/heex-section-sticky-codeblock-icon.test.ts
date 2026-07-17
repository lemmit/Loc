// HEEx walker — Section / Sticky / CodeBlock / Icon primitive emission.
//
// Phase D Slice A from
// `docs/old/plans/platform-expansion-roadmap.md`.  These four primitives
// were emitted by the TSX walker but missing entirely on the HEEx
// side; the registry's `heex:` field for each was undefined, so they
// produced nothing in Phoenix output.
//
// What this file pins (per primitive):
//   1. The emitted HEEx markup matches the documented shape.
//   2. `testid:` named arg becomes `data-testid="…"` — keeps the
//      Phase A Item 3 testid coverage tripwire (#601) happy and
//      lets Playwright/lvtest assertions target the elements.
//   3. Optional named args (id/top/size/title/language) flow
//      through correctly; defaults match the TSX side.
//
// What it does NOT pin: byte-identical Mantine-vs-coreComponents output
// — the two frameworks emit different markup by design (`<section>`
// is identical, but `<Box pos="sticky">` becomes `<div style="…">`
// in HEEx because LiveView doesn't have a Mantine-equivalent
// component library bundled).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const phoenixSystem = (uiBody: string): string => `
  system Demo {
    subdomain M {
      context C {
        aggregate Doc {
          name: string
          derived display: string = name
        }
        repository Docs for Doc { }
      }
    }
    api DemoApi from M
    ui DemoUi {
      page Landing {
        route: "/"
        body: ${uiBody}
      }
    }
    deployable phoenixApp {
      platform: elixir, contexts: [C], serves: DemoApi,
      ui: DemoUi, port: 4000
    }
  }
`;

function findLandingHeex(files: Map<string, string>): string {
  // The LiveView module's `render(assigns)` heredoc holds the HEEx
  // template — search the .ex file rather than a separate .heex.
  for (const [path, content] of files) {
    if (path.endsWith("/landing_live.ex")) {
      return content;
    }
  }
  throw new Error(
    `Landing LiveView module not found.  Available files: ${[...files.keys()]
      .filter((p) => p.includes("live"))
      .slice(0, 10)
      .join(", ")}`,
  );
}

describe("HEEx primitive — Section", () => {
  it("emits a `<section>` element with the id attr from Section { id: ... }", async () => {
    const files = await generateSystemFiles(
      phoenixSystem(`Section { id: "intro", Text { "Welcome" } }`),
    );
    const heex = findLandingHeex(files);
    expect(heex).toMatch(/<section id="intro"/);
    expect(heex).toMatch(/<\/section>/);
  });

  it("propagates testid: as data-testid", async () => {
    const files = await generateSystemFiles(
      phoenixSystem(`Section { id: "x", testid: "section-x", Text { "body" } }`),
    );
    const heex = findLandingHeex(files);
    expect(heex).toMatch(/<section[^>]*data-testid="section-x"/);
  });
});

describe("HEEx primitive — Sticky", () => {
  it("emits a sticky-positioned div with the top offset", async () => {
    const files = await generateSystemFiles(
      phoenixSystem(`Sticky { top: "20px", Text { "nav" } }`),
    );
    const heex = findLandingHeex(files);
    expect(heex).toMatch(/<div style="position: sticky; top: 20px; z-index: 100"/);
  });

  it("defaults `top` to 0 when omitted", async () => {
    const files = await generateSystemFiles(phoenixSystem(`Sticky { Text { "x" } }`));
    const heex = findLandingHeex(files);
    expect(heex).toMatch(/position: sticky; top: 0;/);
  });

  it("propagates testid: as data-testid", async () => {
    const files = await generateSystemFiles(
      phoenixSystem(`Sticky { top: "0", testid: "nav-sticky", Text { "x" } }`),
    );
    const heex = findLandingHeex(files);
    expect(heex).toMatch(/data-testid="nav-sticky"/);
  });
});

describe("HEEx primitive — CodeBlock", () => {
  it("emits a <pre><code> pair with language class", async () => {
    const files = await generateSystemFiles(
      phoenixSystem(`CodeBlock { "const x = 1", language: "ts" }`),
    );
    const heex = findLandingHeex(files);
    expect(heex).toMatch(/<pre class="loom-code-block"[^>]*><code class="language-ts">/);
    expect(heex).toContain("const x = 1");
    expect(heex).toMatch(/<\/code><\/pre>/);
  });

  it("wraps in a title div when title: is supplied", async () => {
    const files = await generateSystemFiles(
      phoenixSystem(`CodeBlock { "npm install", title: "Setup", language: "bash" }`),
    );
    const heex = findLandingHeex(files);
    expect(heex).toMatch(/<div class="loom-code-block"/);
    expect(heex).toMatch(/<div class="loom-code-block-title">Setup<\/div>/);
  });

  it("propagates testid:", async () => {
    const files = await generateSystemFiles(
      phoenixSystem(`CodeBlock { "x", language: "ts", testid: "snippet" }`),
    );
    const heex = findLandingHeex(files);
    expect(heex).toMatch(/data-testid="snippet"/);
  });

  it("HTML-escapes source content so embedded markup stays literal", async () => {
    const files = await generateSystemFiles(
      phoenixSystem(`CodeBlock { "<script>alert('x')</script>", language: "html" }`),
    );
    const heex = findLandingHeex(files);
    // Source's angle brackets escape; the wrapping <pre> / <code> stay raw.
    expect(heex).toContain("&lt;script&gt;");
    expect(heex).not.toMatch(/<pre[^>]*><code[^>]*><script>/);
  });
});

describe("HEEx primitive — Icon", () => {
  it("emits a <span class='loom-icon'> with raw SVG content from svg:", async () => {
    const files = await generateSystemFiles(
      phoenixSystem(`Icon { svg: "<svg viewBox='0 0 24 24'><path d='M0,0'/></svg>" }`),
    );
    const heex = findLandingHeex(files);
    // Decorative-by-default: the wrapper is hidden from assistive tech (icon
    // a11y contract) — an unlabelled glyph conveys nothing to a screen reader.
    expect(heex).toMatch(/<span class="loom-icon" aria-hidden="true">/);
    expect(heex).toContain("<svg viewBox='0 0 24 24'>");
    expect(heex).toMatch(/<\/span>/);
  });

  it("adds size class when size: is supplied", async () => {
    const files = await generateSystemFiles(phoenixSystem(`Icon { svg: "<svg/>", size: "lg" }`));
    const heex = findLandingHeex(files);
    expect(heex).toMatch(/<span class="loom-icon loom-icon-lg" aria-hidden="true">/);
  });

  it("a labelled icon becomes a named img instead of aria-hidden", async () => {
    const files = await generateSystemFiles(
      phoenixSystem(`Icon { svg: "<svg/>", label: "Search" }`),
    );
    const heex = findLandingHeex(files);
    expect(heex).toMatch(/role="img" aria-label="Search"/);
    expect(heex).not.toContain('aria-hidden="true"');
  });

  it("propagates testid:", async () => {
    const files = await generateSystemFiles(
      phoenixSystem(`Icon { svg: "<svg/>", testid: "icon-x" }`),
    );
    const heex = findLandingHeex(files);
    expect(heex).toMatch(/data-testid="icon-x"/);
  });
});

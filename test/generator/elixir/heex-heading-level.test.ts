// HEEx walker — `Heading` derives its rank from Section/Card nesting depth.
//
// Parity with the JSX frontends (accessibility.md Phase 2): a `Heading` with
// no explicit `level:` computes its rank as `min(6, 2 + headingDepth)`, where
// `headingDepth` is the enclosing Section/Card nesting count.  Phoenix used to
// render every heading through the fixed-level `.header` CoreComponent (always
// an `<h1>`); it now emits a raw `<h{n}>` so the derived rank is observable to
// assistive tech, and ranks never skip.
//
//   depth 0 (page top)            → <h2>
//   inside 1 Section OR Card      → <h3>
//   inside Section > Card         → <h4>
//   inside Section > Card > Sect. → <h5>
//   explicit `level:` wins        → <h{level}>

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const phoenixSystem = (uiBody: string): string => `
  system Demo {
    subdomain M { context C { } }
    ui DemoUi {
      page Landing {
        route: "/"
        body: ${uiBody}
      }
    }
    deployable phoenixApp {
      platform: elixir, contexts: [C], ui: DemoUi, port: 4000
    }
  }
`;

async function landingHeex(uiBody: string): Promise<string> {
  const files = await generateSystemFiles(phoenixSystem(uiBody));
  for (const [path, content] of files) {
    if (path.endsWith("/landing_live.ex")) return content;
  }
  throw new Error("Landing LiveView not found");
}

describe("HEEx Heading — structure-derived rank", () => {
  it("a top-level Heading (depth 0) renders <h2>, never <h1>", async () => {
    const heex = await landingHeex(`Stack { Heading { "Top" } }`);
    expect(heex).toMatch(/<h2 [^>]*>Top<\/h2>/);
    expect(heex).not.toContain(">Top</h1>");
    // Regression guard: no longer routed through the fixed-level `.header`.
    expect(heex).not.toContain("<.header");
  });

  it("a Heading inside one Section renders <h3>", async () => {
    const heex = await landingHeex(`Section { Heading { "Inner" } }`);
    expect(heex).toMatch(/<h3 [^>]*>Inner<\/h3>/);
  });

  it("a Heading inside one Card renders <h3>", async () => {
    const heex = await landingHeex(`Card { Heading { "InCard" } }`);
    expect(heex).toMatch(/<h3 [^>]*>InCard<\/h3>/);
  });

  it("nesting compounds: Section > Card > Section deepens the rank each level", async () => {
    const heex = await landingHeex(`Stack {
      Heading { "L2" },
      Section {
        Heading { "L3" },
        Card {
          Heading { "L4" },
          Section { Heading { "L5" } }
        }
      }
    }`);
    expect(heex).toMatch(/<h2 [^>]*>L2<\/h2>/);
    expect(heex).toMatch(/<h3 [^>]*>L3<\/h3>/);
    expect(heex).toMatch(/<h4 [^>]*>L4<\/h4>/);
    expect(heex).toMatch(/<h5 [^>]*>L5<\/h5>/);
  });

  it("rank is clamped at 6 no matter how deep the nesting", async () => {
    // 5 Sections deep ⇒ 2 + 5 = 7 ⇒ clamped to 6.
    const heex = await landingHeex(
      `Section { Section { Section { Section { Section { Heading { "Deep" } } } } } }`,
    );
    expect(heex).toMatch(/<h6 [^>]*>Deep<\/h6>/);
    expect(heex).not.toContain(">Deep</h7>");
  });

  it("an explicit level: wins over the derived rank", async () => {
    const heex = await landingHeex(`Section { Heading("Pinned", level: 2) }`);
    // depth would derive <h3>, but the explicit level: 2 pins <h2>.
    expect(heex).toMatch(/<h2 [^>]*>Pinned<\/h2>/);
  });
});

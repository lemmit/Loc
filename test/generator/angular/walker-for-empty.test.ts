import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// Regression (docs/audits/repo-code-review-2026-07.md F6): the Angular
// `renderForEach` seam dropped the optional `empty:` arm — its signature omitted
// the `emptyBody` param the contract carries (and `emitFor` passes), so a
// `For { empty: … }` silently rendered nothing when the collection was empty,
// while every other frontend showed the empty state.  Angular's native `@empty`
// block maps the seam directly.

async function pageHtml(body: string): Promise<string> {
  const files = await generateSystemFiles(`
    system S {
      subdomain M { context C { } }
      ui Web {
        page P { route: "/p" body: ${body} }
      }
      deployable api { platform: node, contexts: [C], port: 3000 }
      deployable web { platform: angular, targets: api, ui: Web, port: 3004 }
    }
  `);
  for (const [p, c] of files) {
    if (p.endsWith("pages/p.component.ts")) return c;
  }
  throw new Error(`MISSING p.component.ts; keys = ${[...files.keys()].join(", ")}`);
}

describe("angular walker — For empty: arm", () => {
  it("renders the `empty:` arm through Angular's native `@empty` block", async () => {
    const html = await pageHtml(
      `Stack { For { each: [1, 2, 3], empty: Empty("Nothing here"), n => Heading { "Row" } } }`,
    );
    expect(html).toContain("@for (");
    expect(html).toContain("@empty {");
    expect(html).toContain("Nothing here");
  });

  it("omits `@empty` when there is no `empty:` arm (byte-identical to before)", async () => {
    const html = await pageHtml(`Stack { For { each: [1, 2, 3], n => Heading { "Row" } } }`);
    expect(html).toContain("@for (");
    expect(html).not.toContain("@empty");
  });
});

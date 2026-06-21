import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// HEEx For-comprehension (DEBT-05).  `For` was TSX-only (the Phoenix walker
// fell through to the "not supported" comment); it now renders LiveView's
// `<%= for item <- coll do %> … <% end %>` block, so the heex-parity pin
// stays empty.  The TSX/Vue/Svelte siblings go through the shared
// `renderForEach` target seam; HEEx runs its parallel `renderFor`.
// ---------------------------------------------------------------------------

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

async function landingHeex(uiBody: string): Promise<string> {
  const files = await generateSystemFiles(phoenixSystem(uiBody));
  for (const [path, content] of files) {
    if (path.endsWith("/landing_live.ex")) return content;
  }
  throw new Error("Landing LiveView not found");
}

describe("HEEx For comprehension (DEBT-05)", () => {
  it("renders a `for <item> <- <coll> do … end` block over the `each:` collection", async () => {
    const heex = await landingHeex(`Stack { For { each: [1, 2, 3], n => Bold { "Row" } } }`);
    expect(heex).toMatch(/<%= for n <- \[1, 2, 3\] do %>/);
    expect(heex).toMatch(/<strong[\s\S]*?Row[\s\S]*?<\/strong>/);
    expect(heex).toContain("<% end %>");
    expect(heex).not.toContain("not supported");
  });

  it("the loop variable resolves to a bare local inside the body (no `@` assign prefix)", async () => {
    const heex = await landingHeex(`Stack { For { each: [1, 2], n => Bold { "x=" + n } } }`);
    // `n` is a for-comprehension local, not a socket assign.
    expect(heex).toMatch(/<%= for n <- /);
    expect(heex).toContain('"x=" <> ');
    expect(heex).not.toContain("@n");
  });

  it("wraps the comprehension in an `Enum.empty?/1` guard when `empty:` is given", async () => {
    const heex = await landingHeex(
      `Stack { For { each: [1, 2, 3], empty: Bold { "Nothing here" }, n => Bold { "Row" } } }`,
    );
    expect(heex).toContain("<%= if Enum.empty?([1, 2, 3]) do %>");
    // The empty arm (rendered markup) sits in the `if` branch, before `else`.
    expect(heex).toMatch(/Enum\.empty\?\([\s\S]*Nothing here[\s\S]*<% else %>/);
    expect(heex).toMatch(/<%= for n <- \[1, 2, 3\] do %>/);
  });
});

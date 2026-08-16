// The HEEx fallthrough for a REGISTERED walker primitive that has no `heex`
// renderer (`Tab` outside a `Tabs`, a future `tsx`-only addition).  It used to
// emit an HTML comment — but `isHEExCall` classified exactly that case as an
// EXPRESSION (it gated on `.heex !== undefined`), so `renderChild` wrapped it:
// `<%= <!-- Tab: not supported … --> %>`, which is not valid EEx and
// syntax-errors `mix compile`.  The comment is now the EEx-native
// `<%!-- … --%>` form (inert in both positions) AND every registered primitive
// counts as markup position, so the wrap can't come back.
import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const SRC = `
system Demo {
  subdomain M {
    context C {
      aggregate Doc { name: string }
      repository Docs for Doc { }
    }
  }
  api DemoApi from M
  ui DemoUi {
    page Landing {
      route: "/"
      body: Stack {
        Text { "before" },
        Tab("Stray", Text { "orphan" }),
        Text { "after" }
      }
    }
  }
  deployable phoenixApp {
    platform: elixir, contexts: [C], serves: DemoApi,
    ui: DemoUi, port: 4000
  }
}
`;

async function landingHeex(): Promise<string> {
  const files = await generateSystemFiles(SRC);
  for (const [p, c] of files) {
    if (p.endsWith("/landing_live.ex")) return c;
  }
  throw new Error("landing_live.ex not found");
}

describe("HEEx unsupported-primitive fallthrough", () => {
  it("emits an EEx-native comment, never an EEx-wrapped HTML comment", async () => {
    const heex = await landingHeex();
    expect(heex).toContain("<%!-- Tab: not supported by Phoenix LiveView target --%>");
    // The exact uncompilable shape the old fallthrough produced.
    expect(heex).not.toContain("<%= <!--");
    // And no bare HTML comment form survives to be wrapped by a future caller.
    expect(heex).not.toContain("<!-- Tab:");
    // The comment sits in MARKUP position — a comment of EITHER form nested in
    // an `<%= … %>` is a syntax error, so `isHEExCall` must keep every
    // registered primitive out of expression position, not just the ones with
    // a HEEx renderer.
    expect(heex).not.toContain("<%= <%!--");
    expect(heex).toMatch(/^\s*<%!-- Tab: not supported by Phoenix LiveView target --%>\s*$/m);
    // The surrounding children still render.
    expect(heex).toContain("before");
    expect(heex).toContain("after");
  });
});

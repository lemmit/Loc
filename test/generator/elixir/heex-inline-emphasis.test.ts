import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// HEEx inline-emphasis primitives — Bold / Italic / InlineCode (parity
// finding #5).  These were TSX-only (the Phoenix walker fell through to the
// "not supported" comment); they now render as the plain inline HTML tags
// `<strong>` / `<em>` / `<code>`, matching the TSX `<strong>`/`<em>`/`<code>`
// spans.  The pin for each was removed from heex-parity.test.ts.
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

describe("HEEx inline-emphasis primitives (parity finding #5)", () => {
  it("Bold renders a <strong> element wrapping its text", async () => {
    expect(await landingHeex(`Stack { Bold { "Important" } }`)).toMatch(
      /<strong[\s\S]*?Important[\s\S]*?<\/strong>/,
    );
  });

  it("Italic renders an <em> element wrapping its text", async () => {
    expect(await landingHeex(`Stack { Italic { "Emphasised" } }`)).toMatch(
      /<em[\s\S]*?Emphasised[\s\S]*?<\/em>/,
    );
  });

  it("InlineCode renders a <code> element wrapping its text", async () => {
    expect(await landingHeex(`Stack { InlineCode { "docker compose" } }`)).toMatch(
      /<code[\s\S]*?docker compose[\s\S]*?<\/code>/,
    );
  });

  it("threads testid: to data-testid like every other primitive", async () => {
    expect(await landingHeex(`Bold("Tagged", testid: "b1")`)).toMatch(
      /<strong [^>]*data-testid="b1"/,
    );
  });
});

describe("HEEx simple-display primitives (parity finding #5)", () => {
  it("Divider renders an <hr /> (testid threaded)", async () => {
    expect(await landingHeex(`Stack { Divider(testid: "d1") }`)).toMatch(
      /<hr [^>]*data-testid="d1" \/>/,
    );
  });

  it("Image renders an <img> with literal src/alt", async () => {
    const heex = await landingHeex(`Stack { Image(src: "/logo.png", alt: "Logo") }`);
    expect(heex).toMatch(/<img [^>]*src="\/logo\.png"[^>]*alt="Logo"[^>]*\/>/);
  });

  it("Stat renders a label + value block", async () => {
    const heex = await landingHeex(`Stack { Stat("Total", "42") }`);
    expect(heex).toMatch(/class="stat"/);
    expect(heex).toMatch(/Total/);
    expect(heex).toMatch(/42/);
  });

  it("Avatar with src renders a circle <img>", async () => {
    const heex = await landingHeex(`Stack { Avatar(src: "/me.png", alt: "Me") }`);
    expect(heex).toMatch(/<img class="[^"]*rounded-full[^"]*"[^>]*src="\/me\.png"[^>]*alt="Me"/);
  });

  it("Avatar without src renders a neutral circle placeholder", async () => {
    const heex = await landingHeex(`Stack { Avatar(testid: "av") }`);
    expect(heex).toMatch(/<span class="[^"]*rounded-full[^"]*"[^>]*data-testid="av"/);
  });

  it("Loader renders an animated spinner", async () => {
    const heex = await landingHeex(`Stack { Loader(testid: "ld") }`);
    expect(heex).toMatch(/<div class="[^"]*animate-spin[^"]*"[^>]*data-testid="ld"/);
  });
});

describe("HEEx Money primitive (parity finding #5)", () => {
  it("renders the amount via Decimal.to_string, with an optional currency prefix", async () => {
    const heex = await landingHeex(`Stack { Money(value: 9.99, currency: "USD", testid: "m1") }`);
    expect(heex).toMatch(/<span class="money"[^>]*data-testid="m1">USD <%= Decimal\.to_string\(/);
  });
});

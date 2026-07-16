// Feliz display / layout primitives — the pack grew example-by-example and
// left a batch of primitives unrendered (they emitted a `(* no renderer *)`
// comment, which breaks `dotnet fable`).  This pins that the prose / data-
// display / layout primitives now render real daisyUI markup.  The emitted F#
// is proven to compile via `dotnet fable`.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const APP = `
system Demo {
  subdomain S { context C { } }
  ui WebApp {
    framework: feliz
    page Home {
      route: "/"
      body: Container { Stack {
        Bold { "b" }, Italic { "i" }, InlineCode { "c" },
        CodeBlock { "let x = 1", title: "sample" },
        Image { src: "/a.png", alt: "a" },
        Avatar { src: "/u.png", alt: "u" },
        Money { 42, currency: "USD" },
        DateDisplay { "2026-01-01" },
        EnumBadge { "active" },
        Stat { label: "Users", value: "10" },
        Loader { },
        Grid { Card { "c1" } },
        Section { Text { "s" } },
        Sticky { Text { "st" } }
      } }
    }
  }
  deployable api { platform: node contexts: [C] port: 3000 }
  deployable web { platform: feliz targets: api ui: WebApp port: 3005 }
}
`;

async function appFs(): Promise<string> {
  const files = await generateSystemFiles(APP);
  return [...files.entries()].find(([p]) => p.endsWith("src/App.fs"))![1];
}

describe("feliz display / layout primitives", () => {
  it("renders every primitive — no `no renderer` placeholders leak", async () => {
    const app = await appFs();
    expect(app).not.toContain("no renderer");
  });

  it("renders the prose primitives as semantic F# elements", async () => {
    const app = await appFs();
    expect(app).toContain("Html.strong [ Html.text");
    expect(app).toContain("Html.em [ Html.text");
    expect(app).toContain('Html.code [ prop.className "rounded bg-base-200 px-1 text-sm"');
    expect(app).toContain("Html.pre [ prop.className");
  });

  it("renders the data-display primitives with daisyUI classes", async () => {
    const app = await appFs();
    // Money — currency-prefixed tabular amount.
    expect(app).toContain(
      'Html.span [ prop.className "tabular-nums"; prop.text ("USD" + " " + string (42))',
    );
    expect(app).toContain(
      'Html.time [ prop.className "whitespace-nowrap text-sm text-base-content/70"',
    );
    expect(app).toContain('Html.span [ prop.className "badge badge-outline"');
    expect(app).toContain('prop.className "stats"');
    expect(app).toContain('prop.className "stat-value tabular-nums"');
    expect(app).toContain('prop.className "loading loading-spinner loading-lg text-primary"');
    expect(app).toContain('Html.img [ prop.className "rounded"; prop.src "/a.png"; prop.alt "a" ]');
    expect(app).toContain('prop.className "avatar"');
  });

  it("renders the layout containers", async () => {
    const app = await appFs();
    expect(app).toContain('prop.className "grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3"');
    expect(app).toContain('prop.className "mx-auto max-w-4xl px-4"');
    expect(app).toContain("Html.section [");
    expect(app).toContain('prop.className "sticky top-0 z-10"');
  });
});

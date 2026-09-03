// ---------------------------------------------------------------------------
// HEEx `Button` — the `icon:` / `iconSvg:` / `iconPosition:` glyph slot and the
// `loading:` busy state (ledger G2667-C7).
//
// Both were DROPPED on Phoenix while every JSX target rendered them, and the
// drop was rationalised in a code comment rather than tracked: `<.button>`
// declares neither attribute, and an undeclared attribute on a Phoenix function
// component is a compile warning — a build failure under
// `mix compile --warnings-as-errors`.  Neither knob has to be an attribute:
// the glyph is markup inside the button's inner block, and `loading:` is the
// ARIA global `aria-busy`, which Phoenix's `:global` attr accepts on any
// component.  So the pack templates stay untouched.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const src = (buttons: string) => `
system Btn {
  subdomain M { context C { } }
  api A from M
  ui U {
    page Landing {
      route: "/"
      body: Stack {
${buttons}
      }
    }
  }
  storage db { type: postgres }
  resource st { for: C, kind: state, use: db }
  deployable p { platform: elixir, contexts: [C], dataSources: [st], serves: A, ui: U, port: 4000 }
}`;

async function landing(buttons: string): Promise<string> {
  const files = await generateSystemFiles(src(buttons));
  for (const [p, c] of files) if (p.endsWith("/landing_live.ex")) return c;
  throw new Error("landing_live.ex not found");
}

/** The `<.button …>…</.button>` block carrying the given data-testid. */
function button(heex: string, testid: string): string {
  const start = heex.indexOf(`<.button data-testid="${testid}"`);
  expect(start, `no button with testid ${testid}`).toBeGreaterThan(-1);
  return heex.slice(start, heex.indexOf("</.button>", start));
}

describe("HEEx Button — icon + loading slots", () => {
  it("renders `icon:` as an aria-hidden glyph AFTER the label by default", async () => {
    const heex = await landing(`        Button { "Save", icon: "check", testid: "save" }`);
    const save = button(heex, "save");
    // The builtin registry's SVG, resolved walker-side exactly as the TSX
    // emitter resolves it — the pack's `<.button>` needs no new attr.
    expect(save).toContain('<span class="loom-icon" aria-hidden="true"><svg');
    expect(save).toContain('<path d="M5 12l4 4L19 7"/>');
    // Decorative: the button's own text is already the accessible name.
    // …and the default position is trailing (the TSX `iconPosition` default).
    expect(save.indexOf('"Save"')).toBeLessThan(save.indexOf('class="loom-icon"'));
  });

  it('honours `iconPosition: "left"` by leading with the glyph', async () => {
    const heex = await landing(
      `        Button { "Back", icon: "x", iconPosition: "left", testid: "back" }`,
    );
    const back = button(heex, "back");
    expect(back).toContain('class="loom-icon"');
    expect(back.indexOf('class="loom-icon"')).toBeLessThan(back.indexOf('"Back"'));
  });

  it("renders `loading:` as the ARIA global aria-busy, not a dropped attr", async () => {
    const heex = await landing(`        Button { "Go", loading: true, testid: "go" }`);
    expect(button(heex, "go")).toContain("aria-busy={true}");
  });

  // The knobs stay OFF the tag: `<.button>` declares no `icon`/`loading`
  // attribute, so leaking either as an attribute is a -Werror build failure.
  it("never emits icon / loading / iconPosition as attributes on <.button>", async () => {
    const heex = await landing(
      `        Button { "Save", icon: "check", loading: true, iconPosition: "left", testid: "save" }`,
    );
    const save = button(heex, "save");
    expect(save).not.toMatch(/\sicon=/);
    expect(save).not.toMatch(/\sloading=/);
    expect(save).not.toMatch(/\sicon_position=|\siconPosition=/);
  });

  it("leaves a plain Button byte-identical (no glyph, no aria-busy)", async () => {
    const heex = await landing(`        Button { "Plain", testid: "plain" }`);
    const plain = button(heex, "plain");
    expect(plain).not.toContain("loom-icon");
    expect(plain).not.toContain("aria-busy");
  });
});

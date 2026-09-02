import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// G2667-C7 — `Button { icon: / iconPosition: / loading: }` on HEEx.
//
// The three were DROPPED, rationalised by a comment: they are not attrs
// `<.button>` declares, and an undeclared attribute on a Phoenix function
// component is a compile warning ⇒ a `--warnings-as-errors` build failure.  A
// silent degradation with a code comment is still silent, so the drop is now a
// real rendering that stays inside what BOTH shipping HEEx packs' buttons
// already declare — the `inner_block` slot and `attr :rest, :global`:
//
//   icon:/iconSvg:/iconPosition: → a `<span class="loom-icon">` sibling of the
//     label INSIDE the button (the shape the shadcn/flowbite JSX templates
//     emit), before or after it per `iconPosition:` (default "right")
//   loading:                     → `aria-busy={…}` (an `aria-` global) plus
//     `disabled={…}`, OR-ed with an author `disabled:`
//
// Nothing here adds an attribute to the pack component, so `designs/` is
// untouched and the emitted page still compiles warning-free.
// ---------------------------------------------------------------------------

const SRC = `
system Demo {
  subdomain M {
    context C {
      aggregate Doc { name: string  derived display: string = name }
      repository Docs for Doc { }
    }
  }
  api DemoApi from M
  ui DemoUi {
    page Landing {
      route: "/"
      state { busy: bool = false  locked: bool = false }
      body: Stack {
        Button("Add", icon: "check", iconPosition: "left"),
        Button("Next", icon: "arrow-right"),
        Button("Save", loading: busy),
        Button("Send", loading: busy, disabled: locked),
        Button("Plain")
      }
    }
  }
  storage loomDb { type: postgres }
  resource cState { for: C, kind: state, use: loomDb }
  deployable phoenixApp {
    platform: elixir, contexts: [C], dataSources: [cState], serves: DemoApi,
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

/** The `<.button>…</.button>` block whose label is `label`. */
function buttonBlock(heex: string, label: string): string {
  const blocks = [...heex.matchAll(/<\.button[\s\S]*?<\/\.button>/g)].map((m) => m[0]);
  const hit = blocks.find((b) => b.includes(label));
  expect(
    hit,
    `no <.button> block containing '${label}' (${blocks.length} buttons emitted)`,
  ).toBeTruthy();
  return hit as string;
}

describe("HEEx Button icon / loading", () => {
  it("renders a left icon as a glyph span BEFORE the label, inside the button", async () => {
    const block = buttonBlock(await landingHeex(), "Add");
    expect(block).toContain(`<span class="loom-icon" aria-hidden="true">`);
    expect(block).toContain("<svg");
    // Order: the glyph precedes the label text.
    expect(block.indexOf("loom-icon")).toBeLessThan(block.indexOf("Add"));
  });

  it("defaults `iconPosition` to the right — glyph AFTER the label", async () => {
    const block = buttonBlock(await landingHeex(), "Next");
    expect(block).toContain(`<span class="loom-icon" aria-hidden="true">`);
    expect(block.indexOf("Next")).toBeLessThan(block.indexOf("loom-icon"));
  });

  it("never emits `icon` / `iconPosition` / `loading` as an attribute on <.button>", async () => {
    const heex = await landingHeex();
    for (const label of ["Add", "Next", "Save", "Send"]) {
      const open = buttonBlock(heex, label).split(">")[0] as string;
      expect(open).not.toMatch(/\sicon[=\s]/);
      expect(open).not.toMatch(/\siconPosition=/);
      expect(open).not.toMatch(/\sicon_position=/);
      expect(open).not.toMatch(/\sloading=/);
    }
  });

  it("renders `loading:` as aria-busy plus a disabled binding", async () => {
    const block = buttonBlock(await landingHeex(), "Save");
    expect(block).toMatch(/aria-busy=\{[^}]*busy[^}]*\}/);
    expect(block).toMatch(/disabled=\{[^}]*busy[^}]*\}/);
  });

  it("ORs an author `disabled:` with `loading:` — one disabled attribute, both operands", async () => {
    const block = buttonBlock(await landingHeex(), "Send");
    const open = block.split(">")[0] as string;
    expect((open.match(/\sdisabled=/g) ?? []).length).toBe(1);
    expect(open).toMatch(/disabled=\{.*locked.* or .*busy.*\}/);
  });

  it("leaves a plain Button untouched — no glyph, no aria-busy", async () => {
    const block = buttonBlock(await landingHeex(), "Plain");
    expect(block).not.toContain("loom-icon");
    expect(block).not.toContain("aria-busy");
  });
});

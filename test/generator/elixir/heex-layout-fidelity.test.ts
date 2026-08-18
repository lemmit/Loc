import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// HEEx page-body layout FIDELITY (generator code review C7).
//
// `heex-parity.test.ts` freezes which primitives have a HEEx renderer; it says
// nothing about what that renderer EMITS.  Under that gate the closed layout
// primitives rendered as bare `<div>`s — no flex, no grid, no card surface —
// while all fifteen JSX packs emitted real layout, so a Phoenix app was
// functionally unstyled and no test could see it.
//
// Worse, the generic named-attr fall-through turned every knob the primitive
// did not understand into a raw HTML attribute:
//
//   Grid { cols: [3,2,1], … }   →  <div cols={[3, 2, 1]}>   a LIST handed to
//                                  Phoenix's attribute escaper — the page
//                                  compiles and raises on first render
//   Container { size: "md", … } →  <div size="md">          invalid attribute
//   Button { variant: "primary" } → <.button variant="…">   an undeclared attr
//                                  on a function component ⇒ `mix compile
//                                  --warnings-as-errors` fails
//
// This suite pins the three halves of the fix: layout classes exist, knobs are
// CONSUMED (never leaked), and the pack owns the card surface.
// ---------------------------------------------------------------------------

const phoenixSystem = (uiBody: string, state = ""): string => `
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
        ${state}
        body: ${uiBody}
      }
    }
    deployable phoenixApp {
      platform: elixir, contexts: [C], serves: DemoApi,
      ui: DemoUi, port: 4000
    }
  }
`;

async function landingHeex(uiBody: string, state = ""): Promise<string> {
  const files = await generateSystemFiles(phoenixSystem(uiBody, state));
  for (const [path, content] of files) {
    if (path.endsWith("/landing_live.ex")) return content;
  }
  throw new Error("Landing LiveView not found");
}

describe("HEEx layout primitives carry real Tailwind geometry", () => {
  it("Stack is a column flexbox", async () => {
    expect(await landingHeex(`Stack { Text { "a" } }`)).toContain(
      '<div class="flex flex-col gap-4">',
    );
  });

  it("Group is a row flexbox", async () => {
    expect(await landingHeex(`Group { Text { "a" } }`)).toContain(
      '<div class="flex flex-row items-center gap-4">',
    );
  });

  it("Toolbar is a space-between row (and keeps its a11y contract attrs)", async () => {
    const heex = await landingHeex(`Toolbar { Text { "a" } }`);
    expect(heex).toMatch(
      /<div class="flex flex-row items-center justify-between gap-4" role="toolbar" aria-label="Actions">/,
    );
  });

  it("Grid without cols: is a 3-column grid, one wrapper div per child", async () => {
    const heex = await landingHeex(`Grid { Text { "a" }, Text { "b" } }`);
    expect(heex).toContain('<div class="grid gap-4 grid-cols-3">');
    // Each child rides its own grid item (the JSX packs' column wrapper), so a
    // multi-root child can't spill into a second cell.
    expect(heex.match(/<div>\n\s*<p>/g)?.length).toBe(2);
  });
});

describe("HEEx layout primitives CONSUME their named args", () => {
  it("Grid cols: [3,2,1] becomes the mobile-first breakpoint ladder", async () => {
    const heex = await landingHeex(`Grid { cols: [3, 2, 1], Text { "a" } }`);
    expect(heex).toContain('class="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-3"');
    // The leak: a LIST spliced into an attribute, which raises at RENDER time.
    expect(heex).not.toContain("cols={[");
    expect(heex).not.toMatch(/\scols=/);
  });

  it("Grid cols: 4 (scalar) applies to every breakpoint — same reader as JSX", async () => {
    const heex = await landingHeex(`Grid { cols: 4, Text { "a" } }`);
    expect(heex).toContain("grid-cols-4 md:grid-cols-4 lg:grid-cols-4");
  });

  it("Grid cols: [4] fills the missing breakpoints (tablet=ceil(4/2), mobile=1)", async () => {
    const heex = await landingHeex(`Grid { cols: [4], Text { "a" } }`);
    expect(heex).toContain("grid-cols-1 md:grid-cols-2 lg:grid-cols-4");
  });

  it("Container size: maps to a max-width utility, never a size= attribute", async () => {
    const heex = await landingHeex(`Container { size: "md", Text { "a" } }`);
    expect(heex).toContain('<div class="mx-auto w-full px-4 max-w-5xl">');
    expect(heex).not.toMatch(/\ssize="md"/);
  });

  it("Container without size: keeps the centred default container", async () => {
    expect(await landingHeex(`Container { Text { "a" } }`)).toContain(
      '<div class="container mx-auto px-4">',
    );
  });

  it("an UNKNOWN named arg is dropped, not spliced as a bare attribute", async () => {
    // `gap:` has no HEEx mapping (the JSX packs ignore it too).  Dropping it is
    // the contract; emitting `gap="6"` on a <div> is the bug.
    const heex = await landingHeex(`Stack { gap: 6, Text { "a" } }`);
    expect(heex).toContain('<div class="flex flex-col gap-4">');
    expect(heex).not.toMatch(/\sgap="/);
    expect(heex).not.toMatch(/\sgap=\{/);
  });

  it("Button's `to:` still reaches the pack component (allowlisted, not dropped)", async () => {
    const heex = await landingHeex(`Button { "Go", to: "/x" }`);
    expect(heex).toContain('<.button to="/x"');
  });

  it("Button's `icon:` — a knob `<.button>` does not declare — is dropped", async () => {
    // An undeclared attribute on a Phoenix function component is a compile
    // WARNING, i.e. a build failure under `mix compile --warnings-as-errors`.
    const heex = await landingHeex(`Button { "Go", icon: "check" }`);
    expect(heex).not.toMatch(/\sicon=/);
  });
});

describe("HEEx Card/Paper render through the pack's <.card> component", () => {
  it("Card's first text-like positional becomes the component's title attr", async () => {
    const heex = await landingHeex(`Card { "Sales", Text { "body" } }`);
    expect(heex).toMatch(/<\.card title=(\{pgettext\(|")/);
    expect(heex).toContain("</.card>");
  });

  it("Card's variant:/shadow: are consumed as component attrs", async () => {
    const heex = await landingHeex(`Card { "T", variant: "outline", shadow: "lg", Text { "b" } }`);
    expect(heex).toContain('variant="outline"');
    expect(heex).toContain('shadow="lg"');
  });

  it("Paper has no title slot — its first positional is a child", async () => {
    const heex = await landingHeex(`Paper { Text { "body" } }`);
    expect(heex).toContain("<.card>");
    expect(heex).not.toContain("<.card title=");
  });
});

describe("HEEx Table column headers are attribute-safe", () => {
  it("escapes a label carrying a quote and angle brackets", async () => {
    const heex = await landingHeex(
      `Table { of: api.Doc.all, Column { "Na\\"me <b>", d => d.name } }`,
    );
    expect(heex).toContain('label="Na&quot;me &lt;b&gt;"');
    // The pre-fix shape closed the attribute mid-value and the template failed
    // to parse: `label="Na"me <b>"`.
    expect(heex).not.toContain('label="Na"me');
  });

  it("a NON-LITERAL header falls back to `Column N`, like the JSX side", async () => {
    const heex = await landingHeex(
      `Table { of: api.Doc.all, Column { "First", d => d.name }, Column { q, d => d.name } }`,
      `state { q: string = "" }`,
    );
    expect(heex).toContain('label="First"');
    expect(heex).toContain('label="Column 2"');
    // The leak: the rendered Elixir expression spliced inside the quotes.
    expect(heex).not.toContain('label="@q"');
  });
});

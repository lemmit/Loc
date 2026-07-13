// HEEx walker — `testid:` named-arg coverage across primitives.
//
// Phase D leftover from `docs/old/plans/phase-a-platform-expansion-prereqs.md`
// (the "broader HEEx testid emission" follow-up flagged in Item 3).
//
// Two regression classes covered:
//
//   1. The generic `renderPrimitive` helper used to forward
//      `testid: "foo"` as a literal `testid="foo"` HTML attribute —
//      Playwright / lvtest look for `data-testid`, so the attribute
//      was being silently dropped.  This file pins that 12 primitives
//      (Stack/Card/Button/Heading/Text/Toolbar/Group/Empty/Badge/
//      Paper/Grid/Container) now emit `data-testid="..."` as intended.
//
//   2. Several bespoke renderers (`renderAlert`, `renderIdLink`,
//      `renderDateDisplay`, `renderEnumBadge`, `renderKeyValueRow`,
//      `renderSkeleton`, `renderTable`) had no `testid:` handling
//      at all.  This file pins they now accept the arg and emit
//      `data-testid` on their outer element.
//
// What this file does NOT pin: TSX-parity output (templates differ
// by design — `<.button>` vs `<Button>` etc.).  It pins the testid
// attribute presence only.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const phoenixSystem = (uiBody: string): string => `
  system Demo {
    subdomain M {
      context C {
        enum Status { Open, Closed }
        aggregate Doc {
          name: string
          status: Status
          createdAt: datetime
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
  for (const [path, content] of files) {
    if (path.endsWith("/landing_live.ex")) return content;
  }
  throw new Error(
    `Landing LiveView not found. Files: ${[...files.keys()]
      .filter((p) => p.includes("live"))
      .slice(0, 5)
      .join(", ")}`,
  );
}

describe("HEEx primitive — testid: emits data-testid (renderPrimitive)", () => {
  // Each entry: DSL primitive snippet → regex that must appear in
  // the emitted HEEx.  The regex anchors `data-testid="x"` after
  // an opening tag (`<...>`) — guards against the pre-fix shape
  // where the attribute name was bare `testid` instead.
  const cases: ReadonlyArray<{ name: string; dsl: string; tagRx: RegExp }> = [
    {
      name: "Stack",
      dsl: `Stack { testid: "s", Text { "x" } }`,
      tagRx: /<div [^>]*data-testid="s"/,
    },
    { name: "Card", dsl: `Card { testid: "c", Text { "x" } }`, tagRx: /<div [^>]*data-testid="c"/ },
    {
      name: "Button",
      dsl: `Button { "Click", testid: "b" }`,
      tagRx: /<\.button [^>]*data-testid="b"/,
    },
    {
      name: "Heading",
      dsl: `Heading("Title", testid: "h")`,
      tagRx: /<h2 [^>]*data-testid="h"/,
    },
    { name: "Text", dsl: `Text("Body", testid: "t")`, tagRx: /<p [^>]*data-testid="t"/ },
    {
      name: "Toolbar",
      dsl: `Toolbar { testid: "tb", Text { "x" } }`,
      tagRx: /<div [^>]*data-testid="tb"/,
    },
    {
      name: "Group",
      dsl: `Group { testid: "g", Text { "x" } }`,
      tagRx: /<div [^>]*data-testid="g"/,
    },
    { name: "Empty", dsl: `Empty(testid: "e")`, tagRx: /<\.empty [^>]*data-testid="e"/ },
    { name: "Badge", dsl: `Badge("ok", testid: "bg")`, tagRx: /<\.badge [^>]*data-testid="bg"/ },
    {
      name: "Paper",
      dsl: `Paper { testid: "p", Text { "x" } }`,
      tagRx: /<div [^>]*data-testid="p"/,
    },
    {
      name: "Grid",
      dsl: `Grid { testid: "gr", Text { "x" } }`,
      tagRx: /<div [^>]*data-testid="gr"/,
    },
    {
      name: "Container",
      dsl: `Container { testid: "ct", Text { "x" } }`,
      tagRx: /<div [^>]*data-testid="ct"/,
    },
  ];

  for (const { name, dsl, tagRx } of cases) {
    it(`${name}: testid: "x" → data-testid="x"`, async () => {
      const files = await generateSystemFiles(phoenixSystem(dsl));
      const heex = findLandingHeex(files);
      expect(heex).toMatch(tagRx);
      // Anti-regression: the bare `testid="x"` attribute (the pre-fix
      // shape) must NOT appear — that's the exact bug this slice fixes.
      // We allow `data-testid="x"` (the new shape) so a substring-style
      // `testid="x"` check would false-positive — anchor on a non-data
      // prefix character to exclude the data- form.
      expect(heex).not.toMatch(/[^-]testid="[^"]+"/);
    });
  }
});

describe("HEEx primitive — testid: on bespoke renderers", () => {
  it("Alert: data-testid on the alert div", async () => {
    const files = await generateSystemFiles(
      phoenixSystem(`Alert("oops", color: "red", testid: "alert-x")`),
    );
    const heex = findLandingHeex(files);
    expect(heex).toMatch(/<div class="alert alert-red"[^>]*data-testid="alert-x"/);
  });

  it("IdLink: data-testid on the link", async () => {
    const files = await generateSystemFiles(
      phoenixSystem(`IdLink("123", of: Doc, testid: "link-x")`),
    );
    const heex = findLandingHeex(files);
    expect(heex).toMatch(/<\.link [^>]*data-testid="link-x"/);
  });

  it("DateDisplay: data-testid on the time element", async () => {
    // Use a literal datetime so the renderer hits the non-empty branch.
    const files = await generateSystemFiles(phoenixSystem(`DateDisplay(now(), testid: "date-x")`));
    const heex = findLandingHeex(files);
    expect(heex).toMatch(/<time [^>]*data-testid="date-x"/);
  });

  it("EnumBadge: data-testid on the badge span", async () => {
    const files = await generateSystemFiles(
      phoenixSystem(`EnumBadge(Status.Open, testid: "enum-x")`),
    );
    const heex = findLandingHeex(files);
    expect(heex).toMatch(/<span class="badge badge-enum"[^>]*data-testid="enum-x"/);
  });

  it("KeyValueRow: data-testid on the row div", async () => {
    const files = await generateSystemFiles(
      phoenixSystem(`KeyValueRow("Label", "Value", testid: "kv-x")`),
    );
    const heex = findLandingHeex(files);
    expect(heex).toMatch(/<div class="key-value-row"[^>]*data-testid="kv-x"/);
  });

  it("Skeleton: data-testid on the wrapper div", async () => {
    const files = await generateSystemFiles(phoenixSystem(`Skeleton(count: 2, testid: "skel-x")`));
    const heex = findLandingHeex(files);
    expect(heex).toMatch(/<div class="skeleton"[^>]*data-testid="skel-x"/);
  });

  it("Table: data-testid alongside the required id attr", async () => {
    // Table uses the `testid:` value as the `id=` attribute (the
    // `<.table>` LiveView component requires id for hooks).  The
    // change adds `data-testid` alongside — both must be present.
    const files = await generateSystemFiles(
      phoenixSystem(
        `QueryView { of: Doc.all, data: docs => Table { rows: docs, testid: "tbl-x", Column("Name", d => d.name) } }`,
      ),
    );
    const heex = findLandingHeex(files);
    expect(heex).toMatch(/<\.table id="tbl-x"[^>]*data-testid="tbl-x"/);
  });
});

describe("HEEx primitive — testid: omitted leaks no attribute", () => {
  // Anti-regression: when `testid:` is absent the output stays clean
  // (no empty `data-testid=""`, no stray `testid` attribute).
  it("Stack without testid emits no data-testid", async () => {
    const files = await generateSystemFiles(phoenixSystem(`Stack { Text { "x" } }`));
    const heex = findLandingHeex(files);
    // Find the Stack's opening div — should NOT carry testid markers.
    expect(heex).not.toMatch(/data-testid=""/);
    expect(heex).not.toMatch(/testid=""/);
  });
});

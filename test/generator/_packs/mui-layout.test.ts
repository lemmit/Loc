// M-FT.20 — the MUI pack's page-layout contract, plus the one DataGrid label
// every pack got wrong.
//
// Field-test findings S3 / S11 / B10 and review-C D3 / D4:
//
//   * `primitive-stack.hbs` passed no `spacing`, and MUI's `Stack` default is
//     `spacing = 0` — so breadcrumb, title bar and content sat FLUSH on every
//     generated MUI page (`pw/packs/measures.json`: mui `stackGaps [0,0,0,0]`
//     against mantine's and shadcn's 16).  The pack's own `primitive-group`
//     remembered the gap; the stack did not.
//   * `primitive-toolbar.hbs` was a `Stack direction="row"` with no
//     `alignItems`, so the row stretched: the "New issue" button grew to the
//     full height of the heading beside it.
//   * `primitive-heading.hbs` mapped the SEMANTIC level straight onto the
//     DISPLAY variant (`variant="h{level}"`).  The pack theme only overrides
//     h1..h4, so level 5 (MUI default 24px) and level 6 (20px) rendered BIGGER
//     than level 4 (themed 16px) — the scale inverted at the bottom.
//   * the form text fields carried a `label` but no persistent-label hint, so
//     under react-hook-form's uncontrolled `register` the label never shrinks:
//     it reads as a placeholder, and overlaps a seeded value, while every
//     `Select` in the same modal shows a floating label (S3's screenshot).
//   * the DataGrid column-visibility checkbox was labelled
//     `String(col.columnDef.header ?? col.id)` — and a TanStack `header` may be
//     a RENDER FUNCTION.  The selection column's is, so `String()` serialised
//     the compiled checkbox JSX into a checkbox label.  All FIFTEEN packs had
//     the line, so the guard lives in the walker's grid contract and every pack
//     consumes it (review-B D4).
//
// The assertions are deliberately split: the template-level ones run against
// BOTH pack versions (a `design:` clause only ever reaches the newest version
// of a family, so generating can never see v5), and the generated-output ones
// prove the rendered page really carries them.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { loadPack, resolvePackDir } from "../../../src/generator/_packs/loader-fs.js";
import { generateSystemFiles } from "../../_helpers/index.js";

const MUI_PACKS = ["mui@v5", "mui@v7"] as const;
const DESIGNS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../designs");

function render(pack: string, primitive: string, ctx: Record<string, unknown>): string {
  return loadPack(resolvePackDir(pack)).render(primitive, ctx);
}

/** The children-container context every layout primitive is rendered with. */
const CHILDREN = {
  hasChildren: true,
  childrenBlock: "«CHILD»",
  indent: "  ",
  closeIndent: "",
  testidAttr: ' data-testid="x"',
  styleAttr: "",
};

describe("MUI pack — vertical rhythm", () => {
  it.each(MUI_PACKS)("%s: the page Stack carries a spacing prop", (pack) => {
    const html = render(pack, "primitive-stack", CHILDREN);
    // MUI's Stack default is spacing 0 — a gap has to be spelled.
    expect(html).toMatch(/<Stack (gap|spacing)=\{\d+\}/);
    // …and the childless form gets it too, so an empty region still reserves
    // the same rhythm once something fills it.
    const empty = render(pack, "primitive-stack", { ...CHILDREN, hasChildren: false });
    expect(empty).toMatch(/<Stack (gap|spacing)=\{\d+\}/);
  });

  it.each(MUI_PACKS)("%s: the Toolbar centres its row and spaces it", (pack) => {
    const html = render(pack, "primitive-toolbar", {
      ...CHILDREN,
      a11yAttr: ' role="toolbar" aria-label="Actions"',
    });
    expect(html).toContain('direction="row"');
    // Cross-axis: without this the button stretches to the heading's height.
    expect(html).toContain('alignItems="center"');
    expect(html).toMatch(/(gap|spacing)=\{\d+\}/);
    expect(html).toContain('justifyContent="space-between"');
  });
});

describe("MUI pack — heading scale", () => {
  // level -> the display variant it may render at.  The ELEMENT always follows
  // the semantic level; the variant is bounded so it never inverts.
  const SCALE: ReadonlyArray<readonly [number, string]> = [
    [1, "h1"],
    [2, "h2"],
    [3, "h3"],
    [4, "h4"],
    [5, "h4"],
    [6, "h4"],
  ];

  it.each(MUI_PACKS)("%s: the element is the semantic level", (pack) => {
    for (const [level] of SCALE) {
      const html = render(pack, "primitive-heading", {
        level,
        text: "Title",
        testidAttr: "",
        styleAttr: "",
      });
      expect(html).toContain(`component="h${level}"`);
    }
  });

  it.each(MUI_PACKS)("%s: the variant is a bounded section scale", (pack) => {
    for (const [level, variant] of SCALE) {
      const html = render(pack, "primitive-heading", {
        level,
        text: "Title",
        testidAttr: "",
        styleAttr: "",
      });
      expect(html).toContain(`variant="${variant}"`);
    }
  });

  it.each(MUI_PACKS)("%s: level 2 is the pack's 24px step, like the others", (pack) => {
    // The size itself lives in the theme, and h2 is the step both shadcn (24px)
    // and mantine (26px) render a level-2 heading at.  Pinned here because the
    // template's variant choice is only meaningful against the theme that sizes
    // it — a level-2 heading must not be able to become MUI's 60px h1/h2 hero.
    const theme = fs.readFileSync(
      path.join(DESIGNS_DIR, pack.replace("@", "/"), "theme.hbs"),
      "utf-8",
    );
    expect(theme).toContain('h2: { fontSize: "1.5rem"');
    // …and every variant the heading template can emit is themed, so none of
    // them falls back to MUI's display scale.
    for (const variant of new Set(SCALE.map(([, v]) => v))) {
      expect(theme).toContain(`${variant}: { fontSize:`);
    }
  });
});

describe("MUI pack — form text fields are labelled", () => {
  it.each(MUI_PACKS)("%s: every field-input TextField keeps its label", (pack) => {
    const dir = path.join(DESIGNS_DIR, pack.replace("@", "/"));
    const inputs = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith("field-input-") && f.endsWith(".hbs"));
    expect(inputs.length).toBeGreaterThan(5);
    for (const file of inputs) {
      const src = fs.readFileSync(path.join(dir, file), "utf-8");
      for (const line of src.split("\n")) {
        if (!line.includes("<TextField")) continue;
        // A label, and a label that STAYS: react-hook-form's `register` leaves
        // the input uncontrolled, so MUI never learns it is filled and the
        // label sits over the value like a placeholder unless shrink is asked
        // for explicitly.  The selects next to it always float theirs.
        expect(line, `${file}: TextField without a label`).toContain('label="{{label}}"');
        expect(line, `${file}: TextField without a persistent label`).toContain(
          "InputLabelProps=\\{{ shrink: true }}",
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Generated output — the same four properties, on a real page.
// ---------------------------------------------------------------------------

const APP = `
system Tracker {
  api TrackerApi from Work
  subdomain Work {
    context Tracking {
      aggregate Task with crudish {
        title: string
        estimate: int
      }
      repository Tasks for Task { }
    }
  }
  storage db { type: postgres }
  resource trackState { for: Tracking, kind: state, use: db }
  ui WebApp with scaffold(subdomains: [Work]) { api Tracker: TrackerApi }
  deployable api { platform: node contexts: [Tracking] dataSources: [trackState] serves: TrackerApi port: 3000 }
  deployable web { platform: static targets: api ui: WebApp { Tracker: api } port: 3001 design: mui }
}
`;

describe("MUI pack — a generated page carries the contract", () => {
  it("the list page has vertical rhythm and a centred toolbar", async () => {
    const files = await generateSystemFiles(APP);
    const list = [...files.entries()].find(([p]) => p.endsWith("tasks/list.tsx"))?.[1];
    expect(list, "no tasks/list.tsx was generated").toBeDefined();
    // The page's root Stack — the one whose gap was 0.
    expect(list).toMatch(/<Stack gap=\{\d+\} data-testid="tasks-list"/);
    expect(list).toContain('<Stack direction="row" alignItems="center"');
    // The heading is an element at its semantic level, sized by the section
    // scale rather than MUI's display scale.
    expect(list).toContain('component="h2"');
    // Every heading on the page pairs its semantic element with a variant from
    // the bounded scale — `variant="h5"`/`"h6"` would be MUI's own display
    // steps, which this theme does not override and which render BIGGER than
    // the themed h4 they sit below.  (Scoped to headings: `variant="h6"` is
    // also the pack's card-title style, which is not a `Heading`.)
    const headings = [...(list ?? "").matchAll(/<Typography variant="(h\d)" component="(h\d)"/g)];
    expect(headings.length).toBeGreaterThan(0);
    for (const [, variant] of headings) expect(["h1", "h2", "h3", "h4"]).toContain(variant);
  });

  it("the create form labels its text inputs and keeps the label visible", async () => {
    const files = await generateSystemFiles(APP);
    const form = [...files.entries()].find(([p]) => p.endsWith("tasks/new.tsx"))?.[1];
    expect(form, "no tasks/new.tsx was generated").toBeDefined();
    expect(form).toContain('<TextField label="Title" InputLabelProps={{ shrink: true }}');
    expect(form).toContain('<TextField label="Estimate" InputLabelProps={{ shrink: true }}');
  });
});

// ---------------------------------------------------------------------------
// The DataGrid column-visibility label — every pack, one contract.
// ---------------------------------------------------------------------------

const GRID_TEMPLATES = fs
  .readdirSync(DESIGNS_DIR)
  .flatMap((family) =>
    fs
      .readdirSync(path.join(DESIGNS_DIR, family))
      .map((version) => path.join(DESIGNS_DIR, family, version, "primitive-data-grid.hbs")),
  )
  .filter((p) => fs.existsSync(p))
  .map((p) => [path.relative(DESIGNS_DIR, p), p] as const);

describe("DataGrid — the visibility toggle never stringifies a header function", () => {
  it("every pack that ships a grid was found", () => {
    // 15 packs share the line the fix replaces; if a pack is added or the glob
    // stops matching, the per-pack assertions below silently cover nothing.
    expect(GRID_TEMPLATES.length).toBe(15);
  });

  it.each(GRID_TEMPLATES)("%s reads the shared label", (_name, file) => {
    const src = fs.readFileSync(file, "utf-8");
    // The hand-spelled form: `String()` over a header that may be a function.
    expect(src).not.toContain("String(col.columnDef.header");
    expect(src).toContain("visibilityLabel");
  });

  it("the emitted expression falls back to the column id for a function header", async () => {
    const files = await generateSystemFiles(`
      system S {
        subdomain Sales { context Orders {
          aggregate Customer { name: string  tier: int }
          repository Customers for Customer { } } }
        api SalesApi from Sales
        storage pg { type: postgres }
        ui WebApp {
          api Sales: SalesApi
          page X { route: "/x"  body: QueryView { of: Sales.Customer.all, data: rows => DataGrid(
            Column("Name", o => o.name, sortable: true),
            rows: rows, columnVisibility: true, selection: picked, testid: "customers-grid") }
            state { picked: string[] } }
        }
        resource ordersState { for: Orders, kind: state, use: pg }
        deployable api { platform: node, contexts: [Orders], dataSources: [ordersState], serves: SalesApi, port: 3000 }
        deployable web { platform: static, targets: api, port: 3001, ui: WebApp { Sales: api }, design: mui }
      }
    `);
    const page = files.get("web/src/pages/x.tsx");
    expect(page, "no page was generated").toBeDefined();
    const label = /label=\{(String\([^\n]*columnDef\.header[^\n]*?)\}\n/.exec(page ?? "")?.[1];
    expect(label, "no column-visibility label in the generated grid").toBeDefined();

    // Two dialect hazards this one expression has to clear, both found the hard
    // way by the vue and angular build lanes:
    //   * a Vue template resolves bare identifiers against the render context
    //     and its allowed-globals list has no `Function`, so `instanceof
    //     Function` fails `vue-tsc` with "Property 'Function' does not exist on
    //     type '{ table: Table<T>; … }'";
    //   * vuetify splices this into a DOUBLE-quoted attribute (`:label="…"`),
    //     which a double-quoted string literal would close early.
    expect(label, "`Function` is not a Vue template global").not.toContain("Function");
    expect(label, "a double quote would close vuetify's :label attribute").not.toContain('"');

    // Evaluate the expression the page actually ships, against the two header
    // shapes TanStack allows.  A function header is what the SELECTION column
    // carries — the case that printed compiled JSX as a checkbox label.
    const evaluate = (col: unknown) => new Function("col", `return ${label};`)(col);
    expect(
      evaluate({ id: "loom-select", columnDef: { header: () => "<input type=checkbox />" } }),
    ).toBe("loom-select");
    expect(evaluate({ id: "name", columnDef: { header: "Name" } })).toBe("Name");
    expect(evaluate({ id: "tier", columnDef: {} })).toBe("tier");
  });
});

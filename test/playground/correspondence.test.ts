import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { generateSystems } from "../../src/system/index.js";
import type { SourceMap } from "../../src/trace/index.js";
import {
  constructColor,
  constructHue,
  correspondenceAt,
  generatedBands,
  mappedFiles,
  pickHighlights,
  sourceBands,
  sourceSpanFor,
} from "../../web/src/build/correspondence.js";
import { parseString } from "../_helpers/index.js";

// ---------------------------------------------------------------------------
// Source ↔ output correspondence — the headless gate for M-T8.20 slice 3.
//
// The claim the feature makes is "hover a declaration and watch it light up
// ACROSS EVERY TARGET", so the fixture has to be a system that actually ships
// several: `web/src/examples/acme.ddd` deploys the same `aggregate Product`
// on .NET (`api/`, `catalog_api/`) AND Hono (`catalog_web/`), plus a React
// frontend (`web_app/`) whose pages the `scaffold` macro synthesises.  A
// single-backend fixture would let the mapping be accidentally
// TypeScript-shaped and still pass.
//
// Both directions are driven against a REAL sourcemap from a real generate —
// never a hand-written fixture — so a change to what the recorder records
// fails here rather than silently degrading the playground's hover.
// ---------------------------------------------------------------------------

const ACME = path.resolve(__dirname, "../../web/src/examples/acme.ddd");
const SALES = path.resolve(__dirname, "../../web/src/examples/sales-system.ddd");

interface Fixture {
  map: SourceMap;
  /** The `.ddd` path the map's origins are keyed by — the parse helper mints
   *  a synthetic URI per run, so it is read back, never hardcoded. */
  dddPath: string;
  source: string;
  files: Map<string, string>;
}

async function fixture(file: string): Promise<Fixture> {
  const source = readFileSync(file, "utf-8");
  const { model, doc, errors } = await parseString(source, { validate: true });
  expect(errors).toEqual([]);
  const files = generateSystems(model, { sourcemap: true }).files;
  const raw = files.get(".loom/sourcemap.json");
  expect(raw).toBeDefined();
  return { map: JSON.parse(raw!) as SourceMap, dddPath: doc.uri.path, source, files };
}

/** 1-based line of the first line CONTAINING `needle`. */
function lineOf(source: string, needle: string): number {
  const lines = source.split("\n");
  const idx = lines.findIndex((l) => l.includes(needle));
  expect(idx, `no line contains ${JSON.stringify(needle)}`).toBeGreaterThanOrEqual(0);
  return idx + 1;
}

/** The top-level project directory of a generated path — one deployable. */
function deployableOf(file: string): string {
  return file.split("/")[0]!;
}

describe("correspondence — `.ddd` position → generated files (across targets)", () => {
  it("maps `aggregate Product` onto BOTH .NET deployables and the Hono one", async () => {
    const { map, dddPath, source } = await fixture(ACME);
    const at = correspondenceAt(map, dddPath, lineOf(source, "aggregate Product"), source);

    expect(at).not.toBeNull();
    // The label is the declaration the cursor points at — NOT the narrower
    // `Products.Product.update` the `crudish` token on the same line
    // synthesises (see `labelOf`).
    expect(at!.construct).toBe("Products.Product");

    const files = at!.files.map((f) => f.file);
    // .NET — the shared `api` deployable and the Catalog-only `catalog_api`.
    expect(files).toContain("api/Domain/Products/Product.cs");
    expect(files).toContain("catalog_api/Domain/Products/Product.cs");
    // Hono — the same aggregate emitted as TypeScript.
    expect(files).toContain("catalog_web/domain/product.ts");
    expect(files).toContain("catalog_web/http/product.routes.ts");

    // The "across every target" claim, asserted rather than assumed: at
    // least three separate deployable projects light up from one hover.
    const deployables = new Set(files.map(deployableOf));
    expect(deployables.size).toBeGreaterThanOrEqual(3);
  });

  it("maps the `ui WebApp` declaration onto the React frontend's pages", async () => {
    const { map, dddPath, source } = await fixture(ACME);
    // The scaffolded pages record their origin as a MACRO ref whose call site
    // is the `with scaffold(...)` clause — the frontend half of the mapping,
    // and the one that proves macro-produced output is reachable too.
    const at = correspondenceAt(map, dddPath, lineOf(source, "ui WebApp with scaffold"), source);

    expect(at).not.toBeNull();
    const files = at!.files.map((f) => f.file);
    expect(files).toContain("web_app/src/pages/products/list.tsx");
    expect(files).toContain("web_app/src/pages/orders/detail.tsx");
    expect(files.every((f) => deployableOf(f) === "web_app")).toBe(true);
    expect(at!.construct?.startsWith("WebApp.")).toBe(true);
  });

  it("narrows to the operation's own lines when the cursor is inside an aggregate", async () => {
    const { map, dddPath, source, files } = await fixture(ACME);
    // A STATEMENT line inside `operation addLine` — the granularity the
    // recorder actually works at (the `operation` head line itself carries
    // only the enclosing aggregate's region, which is why the assertion
    // below is on a body line and not on the signature).
    const at = correspondenceAt(map, dddPath, lineOf(source, "precondition qty > 0"), source);

    expect(at).not.toBeNull();
    expect(at!.construct).toBe("Orders.Order.addLine");

    const order = at!.files.find((f) => f.file === "api/Domain/Orders/Order.cs");
    expect(order).toBeDefined();
    // The whole-file region for `Orders.Order` still MATCHES (the aggregate
    // covers this line) but must not be what gets painted — otherwise
    // hovering one operation highlights the entire class.
    const total = (files.get("api/Domain/Orders/Order.cs") ?? "").split("\n").length;
    for (const h of order!.highlights) {
      expect(h.construct).toBe("Orders.Order.addLine");
      expect(h.endLine - h.startLine).toBeLessThan(total - 1);
    }
    expect(order!.spans.length).toBeGreaterThan(order!.highlights.length);
  });

  it("returns null for a `.ddd` line no generated region came from", async () => {
    const { map, dddPath, source } = await fixture(ACME);
    // The file's opening comment block produces nothing.
    expect(correspondenceAt(map, dddPath, 1, source)).toBeNull();
  });

  it("highlights the WHOLE generated file when only the declaration matched", async () => {
    const { map, dddPath, source, files } = await fixture(SALES);
    const at = correspondenceAt(map, dddPath, lineOf(source, "aggregate Product"), source);
    expect(at).not.toBeNull();

    // sales-system deploys one Hono backend.  The repository file is
    // deliberately NOT expected: its region's origin is the `repository`
    // declaration, not the aggregate — the map says what each file came
    // from, and this test does not paper over that.
    const paths = at!.files.map((f) => f.file);
    expect(paths).toEqual(["api/domain/product.ts", "api/http/product.routes.ts"]);

    const routes = at!.files.find((f) => f.file === "api/http/product.routes.ts")!;
    const lines = files.get("api/http/product.routes.ts")!.split("\n").length;
    expect(routes.highlights).toHaveLength(1);
    expect(routes.highlights[0]!.startLine).toBe(1);
    expect(routes.highlights[0]!.endLine).toBeGreaterThan(lines / 2);
  });
});

describe("correspondence — generated position → `.ddd` span (the reverse)", () => {
  it("resolves a line of the Hono aggregate back to the declaration it came from", async () => {
    const { map, source } = await fixture(ACME);
    const declLine = lineOf(source, "aggregate Product");

    const back = sourceSpanFor(map, "catalog_web/domain/product.ts", 5, undefined, source);
    expect(back).not.toBeNull();
    expect(back!.construct).toBe("Products.Product");
    expect(back!.startLine).toBe(declLine);
    expect(back!.endLine).toBeGreaterThan(declLine);
    // The span the UI flashes must actually cover the declaration text.
    expect(source.slice(back!.span[0], back!.span[1])).toContain("aggregate Product");
  });

  it("resolves a line of the .NET aggregate back to the SAME `.ddd` span", async () => {
    const { map, dddPath, source } = await fixture(ACME);
    const hono = sourceSpanFor(map, "catalog_web/domain/product.ts", 5, undefined, source);
    const dotnet = sourceSpanFor(map, "api/Domain/Products/Product.cs", 5, undefined, source);
    expect(dotnet).not.toBeNull();
    // One declaration, two targets, one span — this is the round-trip the
    // whole feature rests on.
    expect(dotnet!.span).toEqual(hono!.span);
    expect(dotnet!.path).toBe(hono!.path);
    expect(dotnet!.path.endsWith(dddPath.split("/").pop()!)).toBe(true);
  });

  it("round-trips: every forward highlight resolves back to the hovered line", async () => {
    const { map, dddPath, source } = await fixture(ACME);
    const declLine = lineOf(source, "aggregate Product");
    const at = correspondenceAt(map, dddPath, declLine, source)!;

    let checked = 0;
    for (const file of at.files) {
      for (const h of file.highlights) {
        const back = sourceSpanFor(map, file.file, h.startLine, undefined, source);
        if (!back) continue;
        expect(back.startLine).toBeLessThanOrEqual(declLine);
        expect(back.endLine).toBeGreaterThanOrEqual(declLine);
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(3);
  });

  it("answers null for an unmapped generated file and an unmapped line", async () => {
    const { map, source } = await fixture(ACME);
    expect(sourceSpanFor(map, "docker-compose.yml", 1, undefined, source)).toBeNull();
    expect(
      sourceSpanFor(map, "catalog_web/domain/product.ts", 100_000, undefined, source),
    ).toBeNull();
  });
});

describe("correspondence — colour bands (the godbolt toggle)", () => {
  it("gives one band per construct in the source, and the same hue on both sides", async () => {
    const { map, dddPath, source } = await fixture(ACME);
    const bands = sourceBands(map, dddPath, source);
    const product = bands.find((b) => b.construct === "Products.Product");
    expect(product).toBeDefined();
    expect(product!.startLine).toBe(lineOf(source, "aggregate Product"));
    // Bands are sorted by where they start, so the overlay paints top-down.
    for (let i = 1; i < bands.length; i++) {
      expect(bands[i]!.startLine).toBeGreaterThanOrEqual(bands[i - 1]!.startLine);
    }

    const generated = generatedBands(map, "catalog_web/domain/product.ts");
    expect(generated.some((b) => b.construct === "Products.Product")).toBe(true);
    // The mapping IS the colour: one construct, one hue, both sides.
    expect(constructHue("Products.Product")).toBe(constructHue("Products.Product"));
    expect(constructColor("Products.Product")).toContain(String(constructHue("Products.Product")));
    // Narrow bands sort last so a viewer painting in order lets them win.
    const widths = generated.map((b) => b.endLine - b.startLine);
    expect([...widths].sort((a, b) => b - a)).toEqual(widths);
  });

  it("lists every mapped generated file", async () => {
    const { map } = await fixture(ACME);
    const listed = mappedFiles(map);
    expect(listed).toContain("catalog_web/domain/product.ts");
    expect(listed).toEqual([...listed].sort());
  });
});

describe("pickHighlights", () => {
  const wholeFile = {
    startLine: 1,
    endLine: 80,
    construct: "X.Agg",
    originWidth: 500,
    originStartLine: 10,
  };
  const fine = {
    startLine: 40,
    endLine: 40,
    construct: "X.Agg.op",
    originWidth: 20,
    originStartLine: 25,
  };

  it("keeps only what the hovered line anchors", () => {
    expect(pickHighlights([wholeFile, fine], 25)).toEqual([fine]);
    expect(pickHighlights([wholeFile, fine], 10)).toEqual([wholeFile]);
  });

  it("falls back to the narrowest covering span when nothing is anchored", () => {
    expect(pickHighlights([wholeFile, fine], 12)).toEqual([fine]);
    expect(pickHighlights([wholeFile], 12)).toEqual([wholeFile]);
  });
});

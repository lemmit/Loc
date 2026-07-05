import { describe, expect, it } from "vitest";
import { generateSystems } from "../../src/system/index.js";
import { annotateTrace, LineIndex } from "../../src/trace/annotate.js";
import type { SourceMap, WireRegion } from "../../src/trace/resolve.js";
import { parseValid } from "../_helpers/index.js";

// ---------------------------------------------------------------------------
// Round trip for `ddd trace` over a REAL `.loom/sourcemap.json` — reuses the
// generate-a-system-with-{sourcemap:true} fixture pattern from
// test/system/sourcemap.test.ts (that suite proves the artifact is
// well-formed; this one proves the CLI-facing consumer — frame parsing +
// path/region/chain resolution — actually lands on the right construct for
// each backend's native crash-log dialect).
// ---------------------------------------------------------------------------

const SOURCE = `
system SourceMapDemo {
  subdomain Sales {
    context Orders {
      aggregate Order {
        customerName: string
        operation confirm() { }
      }
      repository Orders for Order { }
    }
  }

  storage primary { type: postgres }
  resource ordersState { for: Orders, kind: state, use: primary }
  api SalesApi from Sales
  ui SalesUi with scaffold(subdomains: [Sales]) { }

  deployable honoApi    { platform: node                          contexts: [Orders] dataSources: [ordersState] serves: SalesApi port: 3000 }
  deployable dotnetApi  { platform: dotnet                        contexts: [Orders] dataSources: [ordersState] serves: SalesApi port: 8080 }
  deployable pythonApi  { platform: python                        contexts: [Orders] dataSources: [ordersState] serves: SalesApi port: 8000 }
  deployable javaApi    { platform: java                          contexts: [Orders] dataSources: [ordersState] serves: SalesApi port: 8081 }
  deployable phoenixApi { platform: elixir { foundation: vanilla } contexts: [Orders] dataSources: [ordersState] ui: SalesUi port: 4000 }
}
`;

// The line `aggregate Order {` lands on, 1-based — every backend's
// source-kind region for `Order` chains back to this declaration.
const AGGREGATE_LINE = SOURCE.split("\n").findIndex((l) => l.includes("aggregate Order {")) + 1;

/** Read the fixture text regardless of the requested path — the parsed
 *  in-memory document's URI (`/1.ddd`-shaped) isn't a real file on disk,
 *  and this suite only ever has the one source anyway. */
const readFixtureSource = (): string => SOURCE;

/** Find the (first, sorted-for-determinism) region under `prefix` whose
 *  origin is the given kind and whose path passes `pathFilter` (used to
 *  pin down a file extension matching the frame format under test — a
 *  deployable can map several files to the same construct, e.g. the
 *  domain file *and* the repository file both carry `Orders.Order`).
 *  For `"source"`, additionally requires the origin span's own text to
 *  cover the aggregate declaration itself (not e.g. the repository's). */
function findRegion(
  map: SourceMap,
  prefix: string,
  kind: "source" | "macro",
  pathFilter: (path: string) => boolean = () => true,
): { path: string; region: WireRegion } | undefined {
  for (const path of Object.keys(map.files).sort()) {
    if (!path.startsWith(prefix) || !pathFilter(path)) continue;
    const region = map.files[path]!.find((r) => {
      if (r.origin.kind !== kind) return false;
      if (kind !== "source") return true;
      const [start, end] = (r.origin as { span: [number, number] }).span;
      return SOURCE.slice(start, end).includes("aggregate Order {");
    });
    if (region) return { path, region };
  }
  return undefined;
}

/** A line comfortably inside `[start, end]` — `start + 1` unless the
 *  region is a single line, which no fixture region here actually is. */
function lineInside(region: WireRegion): number {
  const [start, end] = region.target;
  return Math.min(start + 1, end);
}

describe("ddd trace over a generated system's .loom/sourcemap.json", () => {
  it.each([
    {
      platform: "node",
      slug: "hono_api",
      ext: ".ts",
      frame: (path: string, line: number) => `    at OrderDomain.rename (${path}:${line}:3)`,
    },
    {
      platform: "dotnet",
      slug: "dotnet_api",
      ext: ".cs",
      frame: (path: string, line: number) =>
        `   at Orders.OrderService.Confirm() in ${path}:line ${line}`,
    },
    {
      platform: "python",
      slug: "python_api",
      ext: ".py",
      frame: (path: string, line: number) => `  File "${path}", line ${line}, in confirm`,
    },
    {
      platform: "elixir",
      slug: "phoenix_api",
      ext: ".ex",
      frame: (path: string, line: number) =>
        `(phoenix_api 0.1.0) ${path}:${line}: PhoenixApi.Orders.Order.confirm/2`,
    },
  ])("$platform: a native-format frame into a source-kind region names Orders.Order and resolves the .ddd declaration line", async ({
    slug,
    ext,
    frame,
  }) => {
    const model = await parseValid(SOURCE);
    const { files } = generateSystems(model, { sourcemap: true });
    const raw = files.get(".loom/sourcemap.json")!;
    const map = JSON.parse(raw) as SourceMap;

    const found = findRegion(map, `${slug}/`, "source", (p) => p.endsWith(ext));
    expect(found, `no source-kind Order region found under ${slug}/*${ext}`).toBeDefined();
    const { path, region } = found!;
    const line = lineInside(region);

    const log = frame(path, line);
    const annotated = annotateTrace(log, map, readFixtureSource);

    expect(annotated).toContain("Orders.Order");
    expect(annotated).toMatch(new RegExp(`:${AGGREGATE_LINE}\\)$`));
  });

  it("java: an FQN-carrying frame into a source-kind region resolves the same way (path derived from the FQN, not the log's own path)", async () => {
    const model = await parseValid(SOURCE);
    const { files } = generateSystems(model, { sourcemap: true });
    const raw = files.get(".loom/sourcemap.json")!;
    const map = JSON.parse(raw) as SourceMap;

    const found = findRegion(map, "java_api/", "source", (p) => p.endsWith(".java"));
    expect(found, "no source-kind Order region found under java_api/*.java").toBeDefined();
    const { path, region } = found!;
    const line = lineInside(region);

    // Derive the FQN from the actual mapped path instead of hardcoding the
    // layout adapter's package-naming scheme (byFeature vs byLayer, base
    // package derivation, ...) — robust to those changing independently.
    const marker = "src/main/java/";
    const idx = path.indexOf(marker);
    expect(idx, `expected a src/main/java/ path, got ${path}`).toBeGreaterThanOrEqual(0);
    const classPath = path.slice(idx + marker.length);
    const file = classPath.split("/").pop()!;
    const fqn = `${classPath.replace(/\.java$/, "").replace(/\//g, ".")}.confirm`;

    const log = `\tat ${fqn}(${file}:${line})`;
    const annotated = annotateTrace(log, map, readFixtureSource);

    expect(annotated).toContain("Orders.Order");
    expect(annotated).toMatch(new RegExp(`:${AGGREGATE_LINE}\\)$`));
  });

  it("elixir: a frame into a macro-kind (scaffolded ui) region is marked [macro scaffold]", async () => {
    const model = await parseValid(SOURCE);
    const { files } = generateSystems(model, { sourcemap: true });
    const raw = files.get(".loom/sourcemap.json")!;
    const map = JSON.parse(raw) as SourceMap;

    const found = findRegion(map, "phoenix_api/", "macro", (p) => p.endsWith(".ex"));
    expect(found, "no macro-kind region found under phoenix_api/*.ex").toBeDefined();
    const { path, region } = found!;
    expect(region.origin.kind).toBe("macro");
    const line = lineInside(region);

    const log = `(phoenix_api 0.1.0) ${path}:${line}: PhoenixApiWeb.OrderListLive.render/1`;
    const annotated = annotateTrace(log, map, readFixtureSource);

    expect(annotated).toContain("[macro scaffold]");
    // The macro call site resolves to a real .ddd line too (the `ui
    // SalesUi with scaffold(...)` declaration), not just a bare marker.
    const callLine = new LineIndex(SOURCE).lineOf(
      region.origin.kind === "macro" ? region.origin.call.span[0] : -1,
    );
    expect(annotated).toMatch(new RegExp(`:${callLine}\\)$`));
  });

  it("an unmatched frame (unknown file) passes through unchanged", async () => {
    const model = await parseValid(SOURCE);
    const { files } = generateSystems(model, { sourcemap: true });
    const raw = files.get(".loom/sourcemap.json")!;
    const map = JSON.parse(raw) as SourceMap;

    const log = "    at /nowhere/does-not-exist.ts:10:3";
    expect(annotateTrace(log, map, readFixtureSource)).toBe(log);
  });
});

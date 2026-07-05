import { describe, expect, it } from "vitest";
import { resolveToSource } from "../../src/ir/types/origin.js";
import { generateSystems } from "../../src/system/index.js";
import { parseValid } from "../_helpers/index.js";

// ---------------------------------------------------------------------------
// Round-trip test for the `--sourcemap` artifact (docs/plans/
// source-map-debug-kickoff.md §5/§6).  All five backends carry the emit
// bracket, so each must map at least one file per aggregate.
// ---------------------------------------------------------------------------

const BRACKETED: string[] = ["node", "dotnet", "elixir", "python", "java"];

const AGGREGATE_NAMES = ["Order", "Product"];

// One module, two aggregates (fields + operations), a valueobject, and an
// event — served by all five backend platforms so the fan-out slices can
// reuse this fixture unmodified.  The Phoenix deployable also mounts a
// scaffolded ui, so its pages carry a `macro` origin (the case the fan-out
// slices need to prove alongside the `source` case).
const SOURCE = `
system SourceMapDemo {
  subdomain Sales {
    context Orders {
      valueobject Money {
        amount: int
        currency: string
      }

      event OrderPlaced {
        order: Order id
      }

      aggregate Order {
        customerName: string
        total: Money
        operation confirm() {
          emit OrderPlaced { order: id }
        }
      }
      repository Orders for Order { }

      aggregate Product {
        name: string
        price: int
        operation discontinue() { }
      }
      repository Products for Product { }
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

// Deployable names run through `serviceSlug` (camelCase -> snake_case,
// src/system/index.ts) before becoming the output path prefix.
const SLUG_FOR: Record<string, string> = {
  node: "hono_api",
  dotnet: "dotnet_api",
  python: "python_api",
  java: "java_api",
  elixir: "phoenix_api",
};

// The elixir platform's `composeService` mints a fresh cryptographically
// random `SECRET_KEY_BASE` on every call (src/platform/elixir.ts) — a
// pre-existing nondeterminism independent of --sourcemap. Normalize it out
// so the byte-identical comparison below isn't a false negative on that
// unrelated axis.
function normalizeNondeterministic(content: string): string {
  return content.replace(/SECRET_KEY_BASE: "[0-9a-f]+"/, 'SECRET_KEY_BASE: "<redacted>"');
}

describe(".loom/sourcemap.json", () => {
  it("is absent by default, and output is otherwise byte-identical to a --sourcemap run", async () => {
    const model = await parseValid(SOURCE);
    const withoutFlag = generateSystems(model).files;
    const withFlag = generateSystems(model, { sourcemap: true }).files;

    expect(withoutFlag.has(".loom/sourcemap.json")).toBe(false);

    const withFlagMinusMap = new Map(withFlag);
    withFlagMinusMap.delete(".loom/sourcemap.json");

    expect([...withFlagMinusMap.keys()].sort()).toEqual([...withoutFlag.keys()].sort());
    for (const [path, content] of withoutFlag) {
      const other = withFlagMinusMap.get(path);
      expect(other && normalizeNondeterministic(other), `content drifted for ${path}`).toBe(
        normalizeNondeterministic(content),
      );
    }
  });

  it("emits a well-formed artifact when the flag is on", async () => {
    const model = await parseValid(SOURCE);
    const files = generateSystems(model, { sourcemap: true }).files;
    const raw = files.get(".loom/sourcemap.json");
    expect(raw).toBeDefined();
    expect(raw!.endsWith("\n")).toBe(true);

    const map = JSON.parse(raw!) as {
      version: number;
      sources: string[];
      files: Record<string, { target: [number, number]; origin: unknown; construct?: string }[]>;
    };
    expect(map.version).toBe(1);
    expect(map.sources.length).toBeGreaterThan(0);
    expect(Object.keys(map.files).length).toBeGreaterThan(0);
  });

  it("every recorded region resolves to a real source span and a sane target range", async () => {
    const model = await parseValid(SOURCE);
    const files = generateSystems(model, { sourcemap: true }).files;
    const raw = files.get(".loom/sourcemap.json")!;
    const map = JSON.parse(raw) as {
      sources: string[];
      files: Record<
        string,
        {
          target: [number, number];
          origin: import("../../src/ir/types/origin.js").OriginRef;
          construct?: string;
        }[]
      >;
    };

    for (const [path, regions] of Object.entries(map.files)) {
      const generatedContent = files.get(path);
      expect(generatedContent, `sourcemap references unknown output path ${path}`).toBeDefined();
      const generatedLineCount = generatedContent!.endsWith("\n")
        ? generatedContent!.split("\n").length - 1
        : generatedContent!.split("\n").length;

      for (const region of regions) {
        const [start, end] = region.target;
        expect(start, `${path}: target start out of range`).toBeGreaterThanOrEqual(1);
        expect(end, `${path}: target end out of range`).toBeLessThanOrEqual(
          Math.max(1, generatedLineCount),
        );
        expect(start, `${path}: target start > end`).toBeLessThanOrEqual(end);

        const resolved = resolveToSource(region.origin);
        expect(resolved, `${path}: origin chain never resolves to a source span`).toBeDefined();
        expect(
          map.sources,
          `${path}: resolved source path ${resolved!.path} not in sources`,
        ).toContain(resolved!.path);
        const [spanStart, spanEnd] = resolved!.span;
        expect(spanStart, `${path}: span start negative`).toBeGreaterThanOrEqual(0);
        expect(spanStart, `${path}: span start >= end`).toBeLessThan(spanEnd);
        expect(spanEnd, `${path}: span end beyond source length`).toBeLessThanOrEqual(
          SOURCE.length,
        );

        if (region.construct) {
          const aggName = AGGREGATE_NAMES.find((n) => region.construct!.endsWith(`.${n}`));
          if (aggName) {
            const text = SOURCE.slice(spanStart, spanEnd);
            expect(
              text,
              `${path}: construct ${region.construct} span doesn't mention ${aggName}`,
            ).toContain(aggName);
          }
        }
      }
    }
  });

  it.each(
    BRACKETED,
  )("bracketed platform %s maps at least one file per aggregate", async (platform) => {
    const model = await parseValid(SOURCE);
    const files = generateSystems(model, { sourcemap: true }).files;
    const raw = files.get(".loom/sourcemap.json")!;
    const map = JSON.parse(raw) as {
      files: Record<string, { construct?: string }[]>;
    };

    const slug = SLUG_FOR[platform]!;
    const prefix = `${slug}/`;
    const mappedForPlatform = Object.keys(map.files).filter((p) => p.startsWith(prefix));
    expect(
      mappedForPlatform.length,
      `platform ${platform}: expected >= ${AGGREGATE_NAMES.length} mapped files under ${prefix}, saw ${JSON.stringify(mappedForPlatform)}`,
    ).toBeGreaterThanOrEqual(AGGREGATE_NAMES.length);

    for (const aggName of AGGREGATE_NAMES) {
      const constructs = mappedForPlatform.flatMap((p) => map.files[p]!.map((r) => r.construct));
      expect(
        constructs.some((c) => c?.endsWith(`.${aggName}`)),
        `platform ${platform}: no region's construct mentions ${aggName} (saw ${JSON.stringify(constructs)})`,
      ).toBe(true);
    }
  });
});

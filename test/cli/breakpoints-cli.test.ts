import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LineIndex } from "../../src/trace/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "bin", "cli.js");

// Same fixture shape as test/cli/trace-cli.test.ts — `confirm`'s body carries
// a `let` + an assignment, real op-body content to resolve breakpoints into.
const DDL = `
  system Shop {
    subdomain Sales {
      context Orders {
        aggregate Order {
          customerName: string
          label: string
          operation confirm() {
            let note = customerName
            label := note
          }
        }
        repository Orders for Order { }
      }
    }
    storage pg { type: postgres }
    resource ordersState { for: Orders, kind: state, use: pg }
    deployable honoApi {
      platform: node  contexts: [Orders]  dataSources: [ordersState]
    }
  }
`;

let tmp: string;
let ddd: string;
let out: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loom-breakpoints-"));
  ddd = path.join(tmp, "shop.ddd");
  fs.writeFileSync(ddd, DDL, "utf8");
  out = path.join(tmp, "out");
  execSync(`node ${cli} generate system ${ddd} -o ${out} --sourcemap`, { stdio: "pipe" });
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function run(args: string[]): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execSync(`node ${cli} ${args.join(" ")}`, {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    return { stdout, stderr: "", status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", status: e.status ?? 1 };
  }
}

interface WireRegionLike {
  target: [number, number];
  origin: { kind: string; path?: string; span?: [number, number] };
  targetCol?: [number, number];
}

/** Read the emitted map + find the 1-based `.ddd` line hosting `needle`, and
 *  a region in `hono_api/domain/order.ts` whose origin span overlaps that
 *  line — mirroring `translateBreakpoint`'s own overlap test rather than
 *  hardcoding line numbers (the #1748 pattern). */
function findDddLineAndDomainTarget(needle: string): {
  dddLine: number;
  domainKey: string;
  targetLine: number;
} {
  const map = JSON.parse(fs.readFileSync(path.join(out, ".loom", "sourcemap.json"), "utf8")) as {
    files: Record<string, WireRegionLike[]>;
  };

  const index = new LineIndex(DDL);
  const needleOffset = DDL.indexOf(needle);
  expect(needleOffset, `fixture must contain ${JSON.stringify(needle)}`).toBeGreaterThanOrEqual(0);
  const dddLine = DDL.slice(0, needleOffset).split("\n").length;
  const lineStart = index.offsetOfLine(dddLine);
  const lineEnd = index.offsetOfLine(dddLine + 1);

  const domainKey = Object.keys(map.files).find((k) => k.includes("domain/order.ts"));
  expect(domainKey, "expected a domain/order.ts entry in the sourcemap").toBeDefined();

  const region = map.files[domainKey!]!.find((r) => {
    if (r.origin.kind !== "source" || !r.origin.span) return false;
    const [s, e] = r.origin.span;
    return s < lineEnd && e > lineStart;
  });
  expect(region, `no region in ${domainKey} overlaps .ddd line ${dddLine}`).toBeDefined();

  return { dddLine, domainKey: domainKey!, targetLine: region!.target[0] };
}

/** Same lookup as `findDddLineAndDomainTarget`, but requires the matched
 *  region to carry a `targetCol` — the fine expression-level mark this
 *  fixture's op-body statements get (M23, the forward twin of the reverse
 *  path's `targetCol` support). Used to prove `runBreakpoints` prints
 *  `file:line:col` for a column-bearing target, derived from the emitted
 *  sourcemap rather than a hardcoded column (the #1748 pattern). */
function findColumnBearingDomainTarget(needle: string): {
  dddLine: number;
  domainKey: string;
  targetLine: number;
  column: number;
} {
  const map = JSON.parse(fs.readFileSync(path.join(out, ".loom", "sourcemap.json"), "utf8")) as {
    files: Record<string, WireRegionLike[]>;
  };

  const index = new LineIndex(DDL);
  const needleOffset = DDL.indexOf(needle);
  expect(needleOffset, `fixture must contain ${JSON.stringify(needle)}`).toBeGreaterThanOrEqual(0);
  const dddLine = DDL.slice(0, needleOffset).split("\n").length;
  const lineStart = index.offsetOfLine(dddLine);
  const lineEnd = index.offsetOfLine(dddLine + 1);

  const domainKey = Object.keys(map.files).find((k) => k.includes("domain/order.ts"));
  expect(domainKey, "expected a domain/order.ts entry in the sourcemap").toBeDefined();

  const region = map.files[domainKey!]!.find((r) => {
    if (r.origin.kind !== "source" || !r.origin.span || !r.targetCol) return false;
    const [s, e] = r.origin.span;
    return s < lineEnd && e > lineStart;
  });
  expect(
    region,
    `no column-bearing region in ${domainKey} overlaps .ddd line ${dddLine}`,
  ).toBeDefined();

  return {
    dddLine,
    domainKey: domainKey!,
    targetLine: region!.target[0],
    column: region!.targetCol![0],
  };
}

describe("ddd breakpoints", () => {
  it("resolves a line inside an op body to the domain file:line, exit 0", () => {
    const { dddLine, domainKey, targetLine } =
      findDddLineAndDomainTarget("let note = customerName");

    const r = run(["breakpoints", ddd, "--line", String(dddLine), "--out", out]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`${domainKey}:${targetLine}`);
  });

  it("--map takes an explicit path", () => {
    const { dddLine, domainKey, targetLine } =
      findDddLineAndDomainTarget("let note = customerName");
    const mapPath = path.join(out, ".loom", "sourcemap.json");

    const r = run(["breakpoints", ddd, "--line", String(dddLine), "--map", mapPath]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`${domainKey}:${targetLine}`);
  });

  it("prints a count header + narrowest-first list when a line maps to >1 target", () => {
    // `let note = customerName` maps to the fine statement region in
    // domain/order.ts AND the coarser enclosing aggregate + route-file
    // regions — so runBreakpoints takes its `targets.length > 1` branch
    // (a count header, then every target). The single-region happy-path
    // tests above never exercise it.
    const { dddLine } = findDddLineAndDomainTarget("let note = customerName");

    const r = run(["breakpoints", ddd, "--line", String(dddLine), "--out", out]);
    expect(r.status).toBe(0);
    // The count header (the >1-targets branch).
    expect(r.stdout).toContain(`${ddd}:${dddLine} maps to `);
    expect(r.stdout).toMatch(/maps to \d+ generated location\(s\):/);

    const printed = r.stdout.trim().split("\n").slice(1); // drop the header line
    expect(printed.length).toBeGreaterThan(1);
    // Narrowest-origin-span first: the fine domain statement region beats the
    // whole-file aggregate/route regions, so the domain file leads the list.
    expect(printed[0]).toContain("domain/order.ts:");
    // Fan-out crosses files — a route-file target is also listed.
    expect(printed.some((l) => l.includes("order.routes.ts:"))).toBe(true);
  });

  it("prints file:line:col when the resolved target carries a column (M23)", () => {
    const { dddLine, domainKey, targetLine, column } =
      findColumnBearingDomainTarget("let note = customerName");

    const r = run(["breakpoints", ddd, "--line", String(dddLine), "--out", out]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`${domainKey}:${targetLine}:${column}`);
  });

  it("a column-less line still prints bare file:line (no trailing `:undefined` or stray `:`)", () => {
    // The aggregate declaration line has no fine expression region, only the
    // coarse whole-aggregate + route-file regions — every printed line for
    // it must stay bare `file:line`.
    const needle = "aggregate Order {";
    const needleOffset = DDL.indexOf(needle);
    expect(needleOffset).toBeGreaterThanOrEqual(0);
    const dddLine = DDL.slice(0, needleOffset).split("\n").length;

    const r = run(["breakpoints", ddd, "--line", String(dddLine), "--out", out]);
    expect(r.status).toBe(0);
    const printed = r.stdout
      .trim()
      .split("\n")
      .filter((l) => !l.includes(" maps to "));
    expect(printed.length).toBeGreaterThan(0);
    for (const line of printed) {
      expect(line).not.toContain("undefined");
      // Exactly one colon (file:line), never two (file:line:col).
      expect(line.split(":").length - 1).toBe(1);
    }
  });

  it("exits 1 when the source map is present but unparseable", () => {
    const badOut = path.join(tmp, "bad-sourcemap");
    fs.mkdirSync(path.join(badOut, ".loom"), { recursive: true });
    fs.writeFileSync(path.join(badOut, ".loom", "sourcemap.json"), "{ not valid json", "utf8");

    const r = run(["breakpoints", ddd, "--line", "9", "--out", badOut]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Could not parse source map/);
  });

  it("a .ddd line with no construct maps to nothing, exit 0", () => {
    // The blank line right after the opening backtick — no `.ddd` construct
    // starts there.
    const r = run(["breakpoints", ddd, "--line", "1", "--out", out]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(`No generated location maps to ${ddd}:1.`);
  });

  it("exits 1 with a hint when the source map is missing", () => {
    const emptyOut = path.join(tmp, "no-sourcemap");
    fs.mkdirSync(emptyOut, { recursive: true });

    const r = run(["breakpoints", ddd, "--line", "9", "--out", emptyOut]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Source map not found/);
    expect(r.stderr).toMatch(/--sourcemap/);
  });

  it("exits 1 when the .ddd file itself is missing", () => {
    const r = run(["breakpoints", path.join(tmp, "nope.ddd"), "--line", "9", "--out", out]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/DDD file not found/);
  });

  it.each(["0", "-1", "abc"])("exits 1 when --line is not a positive integer (%s)", (bad) => {
    const r = run(["breakpoints", ddd, "--line", bad, "--out", out]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/--line must be a positive integer/);
  });
});

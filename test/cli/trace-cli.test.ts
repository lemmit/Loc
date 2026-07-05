import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "bin", "cli.js");

const DDL = `
  system Shop {
    subdomain Sales {
      context Orders {
        aggregate Order {
          customerName: string
          operation confirm() { }
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loom-trace-"));
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

describe("ddd trace", () => {
  it("annotates a resolvable frame and passes an unmatched one through, exit 0", () => {
    const domainPath = path.join(out, "hono_api", "domain", "order.ts");
    expect(fs.existsSync(domainPath)).toBe(true);

    const log = [
      "Error: boom",
      `    at OrderDomain.rename (hono_api/domain/order.ts:2:3)`,
      "    at /nowhere/does-not-exist.ts:1:1",
    ].join("\n");
    const logPath = path.join(tmp, "crash.log");
    fs.writeFileSync(logPath, log, "utf8");

    const r = run(["trace", logPath, "--out", out]);
    expect(r.status).toBe(0);
    const lines = r.stdout.split("\n");
    expect(lines[0]).toBe("Error: boom");
    expect(lines[1]).toContain("Orders.Order");
    expect(lines[1]).toContain("→");
    expect(lines[2]).toBe("    at /nowhere/does-not-exist.ts:1:1");
  });

  it("--map takes an explicit path", () => {
    const mapPath = path.join(out, ".loom", "sourcemap.json");
    const logPath = path.join(tmp, "crash2.log");
    fs.writeFileSync(logPath, "    at OrderDomain.rename (hono_api/domain/order.ts:2:3)", "utf8");

    const r = run(["trace", logPath, "--map", mapPath]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Orders.Order");
  });

  it("exits 1 with a hint when the source map is missing", () => {
    const emptyOut = path.join(tmp, "no-sourcemap");
    fs.mkdirSync(emptyOut, { recursive: true });
    const logPath = path.join(tmp, "crash3.log");
    fs.writeFileSync(logPath, "Error: boom", "utf8");

    const r = run(["trace", logPath, "--out", emptyOut]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Source map not found/);
    expect(r.stderr).toMatch(/--sourcemap/);
  });

  it("exits 1 when the log file itself is missing", () => {
    const r = run(["trace", path.join(tmp, "nope.log"), "--out", out]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Log file not found/);
  });
});

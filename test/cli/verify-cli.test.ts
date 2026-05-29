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
  requirement US-001 { type: UserStory  title: "Login" }
  requirement AC-001 parent US-001 { type: AcceptanceCriteria  title: "valid creds" }
  system Shop {
    subdomain M { context C {
      aggregate A { operation go() {}  test "go works" verifies TC-001 {} }
    } }
    storage pg { type: postgres }
    resource cState { for: C, kind: state, use: pg }
    deployable api {
      platform: hono  contexts: [C]  dataSources: [cState]
    }
  }
  testCase TC-001 verifies AC-001 { covers [ M.C.A.go ] }
`;

let tmp: string;
let ddd: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loom-verify-"));
  ddd = path.join(tmp, "shop.ddd");
  fs.writeFileSync(ddd, DDL, "utf8");
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

function writeResults(name: string, status: "pass" | "fail"): string {
  const p = path.join(tmp, `results-${status}.json`);
  fs.writeFileSync(
    p,
    JSON.stringify({ version: 1, results: [{ name, suite: "A", status }] }),
    "utf8",
  );
  return p;
}

describe("ddd verify", () => {
  it("passes (exit 0) and writes the verification artifacts when the backing test passes", () => {
    const results = writeResults("go works", "pass");
    const out = path.join(tmp, "pass");
    const r = run(["verify", ddd, "--results", results, "--out", out]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Verified 2\/2 requirements/);
    expect(fs.existsSync(path.join(out, ".loom", "verification.md"))).toBe(true);
    expect(fs.existsSync(path.join(out, ".loom", "verification.mmd"))).toBe(true);
    const json = JSON.parse(fs.readFileSync(path.join(out, ".loom", "verification.json"), "utf8"));
    expect(json.requirements["US-001"].verdict).toBe("VERIFIED");
    expect(json.requirements["AC-001"].verdict).toBe("VERIFIED");
  });

  it("fails the gate (exit 1) when a backing test fails", () => {
    const results = writeResults("go works", "fail");
    const r = run(["verify", ddd, "--results", results, "--out", path.join(tmp, "fail")]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/gate failed/);
  });

  it("exits 2 on a missing results file", () => {
    const r = run(["verify", ddd, "--results", path.join(tmp, "nope.json")]);
    expect(r.status).toBe(2);
  });
});

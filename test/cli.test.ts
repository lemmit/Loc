import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const cli = path.join(repoRoot, "bin", "cli.js");
const example = path.join(repoRoot, "examples", "sales.ddd");

function runCli(args: string[]): { stdout: string; stderr: string; status: number } {
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

describe("CLI", () => {
  it("`--dry-run` writes nothing and reports each path", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loom-dry-"));
    const result = runCli(["generate", "ts", example, "-o", tmp, "--dry-run"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Would write \d+ file/);
    // Output dir is empty / has no generated artifacts.
    const entries = fs.readdirSync(tmp);
    expect(entries).toEqual([]);
    fs.rmSync(tmp, { recursive: true });
  });

  it("`.loomignore` filters paths from the write set", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loom-pin-"));
    fs.writeFileSync(
      path.join(tmp, ".loomignore"),
      "package.json\n/index.ts\n",
      "utf8",
    );
    const result = runCli(["generate", "ts", example, "-o", tmp]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/skipped 2 via \.loomignore/);
    expect(fs.existsSync(path.join(tmp, "package.json"))).toBe(false);
    expect(fs.existsSync(path.join(tmp, "index.ts"))).toBe(false);
    // `http/index.ts` survives because `.loomignore` anchored `/index.ts`.
    expect(fs.existsSync(path.join(tmp, "http", "index.ts"))).toBe(true);
    expect(fs.existsSync(path.join(tmp, "domain", "order.ts"))).toBe(true);
    fs.rmSync(tmp, { recursive: true });
  });

  it("does not emit project-shell files (README, .env.example, .gitignore)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loom-shell-"));
    runCli(["generate", "ts", example, "-o", tmp]);
    expect(fs.existsSync(path.join(tmp, "README.md"))).toBe(false);
    expect(fs.existsSync(path.join(tmp, ".env.example"))).toBe(false);
    expect(fs.existsSync(path.join(tmp, ".gitignore"))).toBe(false);
    fs.rmSync(tmp, { recursive: true });
  });
});

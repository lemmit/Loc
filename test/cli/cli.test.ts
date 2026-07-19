import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
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

  it("`--dry-run` over a fresh dir creates nothing on disk (not even the out dir)", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "loom-dry2-"));
    // Point at a not-yet-existing subdir so we can assert the dry run
    // never mkdir'd it.
    const out = path.join(base, "nested", "out");
    const result = runCli(["generate", "ts", example, "-o", out, "--dry-run"]);
    expect(result.status).toBe(0);
    expect(fs.existsSync(out)).toBe(false);
    expect(fs.existsSync(path.dirname(out))).toBe(false);
    fs.rmSync(base, { recursive: true });
  });

  it("`--dry-run` over an up-to-date tree reports 0 would-writes (parity with a real run)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loom-dry-parity-"));
    // Real run first, so the tree is up to date.
    const real = runCli(["generate", "ts", example, "-o", tmp]);
    expect(real.status).toBe(0);
    expect(real.stdout).toMatch(/Wrote 33 file\(s\)/);

    // A dry run over the up-to-date tree must classify everything as
    // unchanged — 0 would-writes, matching what a real re-run does.
    const dry = runCli(["generate", "ts", example, "-o", tmp, "--dry-run"]);
    expect(dry.status).toBe(0);
    expect(dry.stdout).toMatch(/Would write 0 file\(s\) in [^,]+, unchanged: 33/);
    fs.rmSync(tmp, { recursive: true });
  });

  it("`.loomignore` filters paths from the write set", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loom-pin-"));
    fs.writeFileSync(path.join(tmp, ".loomignore"), "package.json\n/index.ts\n", "utf8");
    const result = runCli(["generate", "ts", example, "-o", tmp]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/skipped \(\.loomignore\): 2/);
    expect(fs.existsSync(path.join(tmp, "package.json"))).toBe(false);
    expect(fs.existsSync(path.join(tmp, "index.ts"))).toBe(false);
    // `http/index.ts` survives because `.loomignore` anchored `/index.ts`.
    expect(fs.existsSync(path.join(tmp, "http", "index.ts"))).toBe(true);
    expect(fs.existsSync(path.join(tmp, "domain", "order.ts"))).toBe(true);
    fs.rmSync(tmp, { recursive: true });
  });

  it("emits a MIT LICENSE at the output root declaring generated code is unencumbered", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loom-license-"));
    runCli(["generate", "ts", example, "-o", tmp]);
    const license = fs.readFileSync(path.join(tmp, "LICENSE"), "utf8");
    expect(license).toMatch(/MIT License/);
    expect(license).toMatch(/scaffolded by Loom/);
    expect(license).toMatch(/license-faq/);
    fs.rmSync(tmp, { recursive: true });
  });

  it("`.loomignore` can pin LICENSE so the user keeps their own", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loom-license-pin-"));
    fs.writeFileSync(path.join(tmp, ".loomignore"), "/LICENSE\n", "utf8");
    fs.writeFileSync(path.join(tmp, "LICENSE"), "Custom LICENSE\n", "utf8");
    const result = runCli(["generate", "ts", example, "-o", tmp]);
    expect(result.status).toBe(0);
    expect(fs.readFileSync(path.join(tmp, "LICENSE"), "utf8")).toBe("Custom LICENSE\n");
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

  it("incremental: second run writes 0 files and reports unchanged count", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loom-inc-"));
    const first = runCli(["generate", "ts", example, "-o", tmp]);
    expect(first.status).toBe(0);
    expect(first.stdout).toMatch(/Wrote 33 file\(s\)/);
    // Capture mtimes after the first run so we can verify the second
    // run doesn't re-touch anything.
    const sample = path.join(tmp, "domain", "order.ts");
    const mtimeBefore = fs.statSync(sample).mtimeMs;

    const second = runCli(["generate", "ts", example, "-o", tmp]);
    expect(second.status).toBe(0);
    expect(second.stdout).toMatch(/Wrote 0 file\(s\) in [^,]+, unchanged: 33/);
    const mtimeAfter = fs.statSync(sample).mtimeMs;
    expect(mtimeAfter).toBe(mtimeBefore);
    fs.rmSync(tmp, { recursive: true });
  });

  it("incremental: only touches files whose content actually changed", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loom-inc2-"));
    runCli(["generate", "ts", example, "-o", tmp]);
    const idsPath = path.join(tmp, "domain", "ids.ts");
    const orderPath = path.join(tmp, "domain", "order.ts");
    const idsMtimeBefore = fs.statSync(idsPath).mtimeMs;
    const orderMtimeBefore = fs.statSync(orderPath).mtimeMs;

    // Mutate ids.ts on disk so the next regen *will* rewrite it (its
    // content no longer matches the generator's output).  order.ts
    // is untouched and should still be skipped.
    fs.writeFileSync(idsPath, "// stomped\n", "utf8");

    // Sleep briefly so any rewrite is observable in mtime resolution.
    const start = Date.now();
    while (Date.now() - start < 20) {
      // tight wait — fs mtime resolution on most platforms is ~1ms
    }

    const result = runCli(["generate", "ts", example, "-o", tmp]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Wrote 1 file\(s\) in [^,]+, unchanged: 32/);
    expect(fs.statSync(idsPath).mtimeMs).toBeGreaterThan(idsMtimeBefore);
    expect(fs.statSync(orderPath).mtimeMs).toBe(orderMtimeBefore);
    fs.rmSync(tmp, { recursive: true });
  });
});

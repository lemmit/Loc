import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MIX_DEPS_GET_ATTEMPTS, mixDepsGet } from "./mix-retry";

// ---------------------------------------------------------------------------
// Unit gate for the `mix deps.get` retry snippet (test/e2e/support/mix-retry.ts).
//
// This does NOT assert on the snippet's text — a string assertion would pass
// just as happily on a snippet the shell mangles.  It EXECUTES the snippet in a
// real shell against a stub `mix` that fails a controlled number of times, and
// counts the invocations.  A stub `sleep` (a no-op) shadows the real one, so
// the 5s/20s backoff costs nothing here.
//
// Fast + hermetic (no docker, no hex, no network) — runs in the default suite.
// ---------------------------------------------------------------------------

let binDir: string;
let counter: string;

/** A stub `mix` that records every invocation and fails the first `failures`. */
function stubMix(failures: number): void {
  fs.writeFileSync(
    path.join(binDir, "mix"),
    [
      "#!/bin/sh",
      `n=$(cat ${counter})`,
      "n=$((n+1))",
      `echo $n > ${counter}`,
      `echo mix-stub called with: $@`,
      `if [ "$n" -le ${failures} ]; then echo 'Request failed (500)' >&2; exit 1; fi`,
      "exit 0",
    ].join("\n"),
    { mode: 0o755 },
  );
}

function calls(): number {
  return Number(fs.readFileSync(counter, "utf8").trim());
}

/** Run a command with the stub bin dir first on PATH. */
function run(cmd: string): { code: number; out: string } {
  try {
    const out = execSync(cmd, {
      env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` },
      stdio: "pipe",
    }).toString();
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer; stderr?: Buffer };
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

beforeEach(() => {
  binDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-mix-retry-"));
  counter = path.join(binDir, "calls");
  fs.writeFileSync(counter, "0\n");
  // No-op `sleep`, so the real 5s + 20s backoff doesn't slow this suite down.
  fs.writeFileSync(path.join(binDir, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
});

afterEach(() => {
  fs.rmSync(binDir, { recursive: true, force: true });
});

describe("mixDepsGet — bounded retry snippet", () => {
  it("runs deps.get exactly once on the happy path", () => {
    stubMix(0);
    const r = run(`sh -c '${mixDepsGet()}'`);
    expect(r.code).toBe(0);
    expect(calls()).toBe(1);
    expect(r.out).not.toContain("loom-retry");
  });

  it("retries a transient failure and succeeds on a later attempt", () => {
    stubMix(2); // attempts 1 and 2 fail, attempt 3 succeeds
    const r = run(`sh -c '${mixDepsGet()}'`);
    expect(r.code).toBe(0);
    expect(calls()).toBe(3);
    expect(r.out).toContain("attempt 2 of 3");
    expect(r.out).toContain("attempt 3 of 3");
  });

  it("gives up after the bounded number of attempts and propagates the failure", () => {
    stubMix(99);
    const r = run(`sh -c '${mixDepsGet()}'`);
    expect(r.code).not.toBe(0);
    expect(calls()).toBe(MIX_DEPS_GET_ATTEMPTS);
  });

  it("short-circuits an && chain when every attempt fails (compile never runs)", () => {
    stubMix(99);
    const r = run(`sh -c '${mixDepsGet()} && touch ${path.join(binDir, "compiled")}'`);
    expect(r.code).not.toBe(0);
    expect(fs.existsSync(path.join(binDir, "compiled"))).toBe(false);
  });

  // `&&` and `||` are EQUAL precedence and associate LEFT, so an un-grouped
  // `fetch || retry1 || retry2` spliced into `hex && fetch… && compile` parses
  // as `((((hex && fetch) || retry1) || retry2) && compile)` — a failing
  // `mix local.hex` would fall INTO the retries, and a then-succeeding fetch
  // would let `mix compile` run anyway.  Caught for real in the hexpm image.
  it("does not swallow a failure of the command BEFORE it in the && chain", () => {
    stubMix(0); // deps.get itself would succeed
    const compiled = path.join(binDir, "compiled");
    const r = run(`sh -c 'false && ${mixDepsGet()} && touch ${compiled}'`);
    expect(r.code, "the chain must still fail").not.toBe(0);
    expect(calls(), "deps.get must not run at all").toBe(0);
    expect(r.out).not.toContain("loom-retry");
    expect(fs.existsSync(compiled), "compile must not run").toBe(false);
  });

  it("passes extra flags through on every attempt", () => {
    stubMix(1);
    const r = run(`sh -c '${mixDepsGet("--only prod")}'`);
    expect(r.code).toBe(0);
    expect(calls()).toBe(2);
    expect(r.out.match(/mix-stub called with: deps\.get --only prod/g)).toHaveLength(2);
  });

  // The snippet is spliced into single-quoted (`bash -c '…'`), double-quoted
  // (`sh -c "…"`) and bare command lines.  A `$` or a quote in it would be
  // eaten by the OUTER shell in at least one of those shapes — so exercise all
  // three, through an extra shell level, and demand identical behaviour.
  it.each([
    ["single-quoted (bash -c '…')", (s: string) => `bash -c '${s}'`],
    ['double-quoted (sh -c "…")', (s: string) => `sh -c "${s}"`],
    ["bare", (s: string) => s],
  ])("survives being embedded %s", (_label, wrap) => {
    stubMix(1);
    const r = run(wrap(mixDepsGet()));
    expect(r.code).toBe(0);
    expect(calls()).toBe(2);
  });

  it("stays quote-free and shell-inert", () => {
    expect(mixDepsGet("--only prod")).not.toMatch(/["'$`\\]/);
  });

  it("refuses args that would break the enclosing quoting", () => {
    expect(() => mixDepsGet('--only "prod"')).toThrow(/quote-free/);
    expect(() => mixDepsGet("--only $MIX_ENV")).toThrow(/quote-free/);
  });

  it("wraps only deps.get — never compile", () => {
    expect(mixDepsGet()).not.toContain("compile");
  });
});

// ---------------------------------------------------------------------------
// The ratchet: a NEW elixir harness must not reintroduce a bare `mix deps.get`.
// Only the three retry definitions themselves may spell the raw command; every
// other harness composes `mixDepsGet(...)` (or, in the .mjs / .sh harnesses,
// their documented twin).
// ---------------------------------------------------------------------------

/** The retry definitions themselves — the only files allowed the raw command. */
const RAW_ALLOWED = new Set([
  "test/e2e/support/mix-retry.ts", // this helper
  "test/behavioral/run-elixir.mjs", // the execFileSync twin (no shell there)
  "scripts/context-integration-e2e.sh", // the shell twin
  "test/e2e/support/mix-retry.test.ts", // this gate (names the command in its own message)
]);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "fixtures" || e.name === ".work-elixir") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sourceFiles(p, out);
    else if (/\.(ts|mjs|sh)$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Lines that are plainly comments — a prose mention of the command is fine. */
function isComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("#");
}

it("no harness invokes a bare `mix deps.get` — the fetch always goes through the retry", () => {
  const offenders: string[] = [];
  for (const dir of ["test", "scripts"]) {
    for (const file of sourceFiles(path.join(repoRoot, dir))) {
      const rel = path.relative(repoRoot, file).split(path.sep).join("/");
      if (RAW_ALLOWED.has(rel)) continue;
      fs.readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (!isComment(line) && line.includes("mix deps.get")) offenders.push(`${rel}:${i + 1}`);
        });
    }
  }
  expect(
    offenders,
    `these call sites fetch hex deps without the bounded retry — compose ` +
      `mixDepsGet() from test/e2e/support/mix-retry.ts instead:\n  ${offenders.join("\n  ")}`,
  ).toEqual([]);
});

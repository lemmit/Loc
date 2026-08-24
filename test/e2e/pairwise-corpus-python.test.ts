import { execSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll } from "vitest";
import { describeCompileLeg } from "../pairwise/compile-leg.js";

// ---------------------------------------------------------------------------
// M-T9.29 — the COMPILE oracle, python leg (FastAPI/SQLAlchemy, `uv sync` +
// `ruff check` + `mypy --strict` + `pytest`).
//
// Sibling of `pairwise-corpus-tsc.test.ts` (node) — see `compile-leg.ts` for
// why the non-node legs matter more than a second copy of the same check.
// This file supplies only python's toolchain recipe: the case loop, verdict
// handling and both directions of the waiver ratchet live in the shared core.
//
// Toolchain recipe mirrors `corpus-python-build.test.ts`: `uv sync`, then
// `uv run ruff check .`, `uv run mypy --strict app[ tests]`, and `uv run
// pytest -q` when the emitted project carries a `tests/` dir.
// ---------------------------------------------------------------------------

/**
 * Share one `uv`-managed virtualenv across every case whose emitted
 * `pyproject.toml` is byte-identical, keyed by content hash — the python
 * analogue of the node leg's `node_modules` reuse. The cover's cases differ
 * in domain shape, not in dependency set (only `auth: required`, timers,
 * file uploads or channel transports change the dependency list at all), so
 * most cases share a handful of distinct dependency sets. `uv sync` per case
 * would otherwise dominate this leg's runtime.
 *
 * The venv is relocated out of the project directory via
 * `UV_PROJECT_ENVIRONMENT` — uv builds/consumes it there regardless of which
 * project directory invokes `uv sync`/`uv run`, so the same shared venv can
 * back many distinct case directories without any symlink games. Only the
 * FIRST case for a given dependency hash pays for `uv sync`; every later case
 * with the same hash runs its tools with `--no-sync` against the
 * already-populated shared environment.
 */
const venvs = new Map<string, { dir: string; synced: boolean }>();

function venvSlotFor(pyproject: string): { dir: string; synced: boolean } {
  const key = crypto.createHash("sha256").update(pyproject).digest("hex").slice(0, 16);
  let slot = venvs.get(key);
  if (!slot) {
    slot = {
      dir: fs.mkdtempSync(path.join(os.tmpdir(), `loom-pw-py-venv-${key}-`)),
      synced: false,
    };
    venvs.set(key, slot);
  }
  return slot;
}

afterAll(() => {
  for (const slot of venvs.values()) fs.rmSync(slot.dir, { recursive: true, force: true });
});

describeCompileLeg({
  platform: "python",
  label: "python",
  enabled: process.env.LOOM_PAIRWISE === "1" && process.env.LOOM_PYTHON_BUILD === "1",
  projectDir: (root) => path.join(root, "d"),
  compile(proj) {
    const pyproject = fs.readFileSync(path.join(proj, "pyproject.toml"), "utf8");
    const slot = venvSlotFor(pyproject);
    const env = { ...process.env, UV_PROJECT_ENVIRONMENT: slot.dir };
    const run = (cmd: string) => execSync(cmd, { cwd: proj, env, stdio: "pipe", timeout: 300_000 });
    try {
      if (!slot.synced) {
        run("uv sync");
        slot.synced = true;
      }
      run("uv run --no-sync ruff check .");
      const hasTests = fs.existsSync(path.join(proj, "tests"));
      run(`uv run --no-sync mypy --strict app${hasTests ? " tests" : ""}`);
      if (hasTests) {
        run("uv run --no-sync pytest -q");
      }
      return undefined;
    } catch (e) {
      const err = e as { stdout?: Buffer; stderr?: Buffer };
      return `${err.stdout?.toString() ?? ""}${err.stderr?.toString() ?? ""}`.slice(0, 4000);
    }
  },
  timeoutMs: 600_000,
});

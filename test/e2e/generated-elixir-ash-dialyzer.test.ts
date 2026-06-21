import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Generated Phoenix project passes `mix dialyzer` against the
// pre-shipped `.dialyzer_ignore.exs` filter.  Mirrors
// `generated-elixir-ash-build.test.ts` (the compile gate) — emit a
// fixture via `ddd generate system`, then run dialyzer inside the
// same hexpm/elixir docker image.
//
// Catches structural-typing bugs the compile gate can't see: bad
// `@spec`s that don't match implementations, dead pattern arms,
// `Ash.Error.t()` shape mismatches in error tuples, etc.  The
// generator-emitted `@spec`s from PRs #902 / #904 / #906 / #911 give
// Dialyzer a typed surface to narrow against; the Ash framework
// noise is filtered by the `.dialyzer_ignore.exs` from PR #907.
//
// Opt-in via LOOM_PHOENIX_DIALYZER=1 so the default `npm test` stays
// fast.  CI's `.github/workflows/phoenix-dialyzer.yml` runs the same
// check with PLT caching (cold dialyzer is 5-15 min; warm is ~30s).
//
// CI knob:  `LOOM_PHOENIX_OUT_DIR=<path>` — when set, the test uses
// `<path>/<fixture-stem>` as the project outDir.  Skips regeneration
// when `mix.exs` already exists, and skips the rm-rf cleanup so
// `deps/` / `_build/` / `priv/plts/` survive for the post-job cache
// save.
//
// Network requirement: `mix deps.get` + Dialyxir PLT generation
// reach repo.hex.pm.  Runs inside the hexpm/elixir image; GitHub-
// hosted runners satisfy the network + passwordless docker run
// requirements.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "bin", "cli.js");
const fixturesDir = path.join(here, "fixtures", "elixir-ash-build");

const ENABLED = process.env.LOOM_PHOENIX_DIALYZER === "1";

describe.skipIf(!ENABLED)(
  "generated Phoenix project passes `mix dialyzer` (LOOM_PHOENIX_DIALYZER=1)",
  () => {
    // Single fixture first — Dialyzer is slow (cold PLT is 5-15 min);
    // matrix expansion lands after the first run is confirmed green.
    // acme-lv.ddd is the canonical LiveView fixture and the same
    // entrypoint generated-elixir-ash-build.test.ts exercises.
    it("acme-lv.ddd → mix dialyzer is clean against the shipped ignore filter", () => {
      const fixturePath = path.join(fixturesDir, "acme-lv.ddd");
      const baseOutDir = process.env.LOOM_PHOENIX_OUT_DIR;
      const outDir = baseOutDir
        ? path.join(baseOutDir, "acme-lv")
        : fs.mkdtempSync(path.join(os.tmpdir(), "loom-phoenix-dia-"));
      fs.mkdirSync(outDir, { recursive: true });
      try {
        const projDir = path.join(outDir, "out", "phoenix_app");
        // Skip regeneration when the project already exists — i.e. CI
        // pre-generated to compute the dep/PLT cache key.  Local runs
        // (no env var) always start fresh.
        if (!fs.existsSync(path.join(projDir, "mix.exs"))) {
          execSync(`node ${cli} generate system ${fixturePath} -o ${outDir}/out`, {
            stdio: "inherit",
            cwd: repoRoot,
          });
        }
        expect(fs.existsSync(path.join(projDir, "mix.exs"))).toBe(true);
        // Sanity: the shipped pieces from PRs #907 + this PR must be
        // present before we delegate to mix dialyzer.
        expect(fs.existsSync(path.join(projDir, ".dialyzer_ignore.exs"))).toBe(true);
        const mix = fs.readFileSync(path.join(projDir, "mix.exs"), "utf8");
        expect(mix).toMatch(/dialyxir/);

        const image = "hexpm/elixir:1.18.4-erlang-27.3.4-debian-bookworm-20260610-slim";
        // Dialyxir is a dev-only dep so `mix deps.get` here is
        // unscoped (NOT --only prod) — pulls dialyxir + transitive deps
        // alongside the runtime ones.  MIX_ENV defaults to :dev which
        // is where dialyxir is enabled per the only: [:dev, :test]
        // qualifier in the generated mix.exs.
        execSync(
          `docker run --rm -v ${projDir}:/app -w /app ${image} ` +
            `bash -c 'mix local.hex --force && mix local.rebar --force && ` +
            `mix deps.get && mix compile && mix dialyzer'`,
          {
            stdio: "inherit",
            timeout: 1_500_000,
          },
        );
      } finally {
        // CI runs leave deps/ / _build/ / priv/plts/ for the cache.
        if (!baseOutDir) {
          try {
            fs.rmSync(outDir, { recursive: true, force: true });
          } catch {
            /* ignore */
          }
        }
      }
    }, 1_800_000);
  },
);

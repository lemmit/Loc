import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Generated Phoenix project is `mix format`-clean.  Mirrors
// `generated-phoenix-build.test.ts` (the compile gate) — emit each
// fixture via `ddd generate system`, then run
// `mix format --check-formatted` which exits non-zero if any file
// isn't formatted per the project's `.formatter.exs`.
//
// Catches generator drift that produces syntactically valid but
// non-canonical Elixir/HEEx (wrong indentation, inconsistent
// pipeline alignment, trailing whitespace, etc.).  The compile gate
// doesn't see these because they compile; the format gate does.
//
// Opt-in via LOOM_PHOENIX_FORMAT=1 so the default `npm test` stays
// fast.  CI's `.github/workflows/phoenix-build.yml` runs the same
// check as a second step after `mix compile`.
//
// Network requirement: `mix format` itself requires no deps, but
// the project's `.formatter.exs` may reference `phoenix`/`phoenix_live_view`
// in `import_deps:` — those have to be fetched first via `mix deps.get`.
// Runs inside the same hexpm/elixir docker image as `generated-phoenix-build`.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "bin", "cli.js");
const fixturesDir = path.join(here, "fixtures", "phoenix-build");

const ENABLED = process.env.LOOM_PHOENIX_FORMAT === "1";

describe.skipIf(!ENABLED)(
  "generated Phoenix project is `mix format`-clean (LOOM_PHOENIX_FORMAT=1)",
  () => {
    it.each([
      { name: "acme-lv.ddd" },
      { name: "roster.ddd" },
      { name: "seeding.ddd" },
      { name: "phoenix-embed-react.ddd" },
    ])("$name → mix format --check-formatted", ({ name }) => {
      const fixturePath = path.join(fixturesDir, name);
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-phoenix-fmt-"));
      try {
        const projDir = path.join(outDir, "out", "phoenix_app");
        execSync(`node ${cli} generate system ${fixturePath} -o ${outDir}/out`, {
          stdio: "inherit",
          cwd: repoRoot,
        });
        expect(fs.existsSync(path.join(projDir, "mix.exs"))).toBe(true);

        // `mix format` reads `.formatter.exs` from project root; for
        // Phoenix projects the typical `import_deps: [:phoenix, ...]`
        // line means we need `deps/` populated.  Use the same image
        // and `mix deps.get` as the compile gate.
        const image = "hexpm/elixir:1.17.2-erlang-27.0.1-debian-bookworm-20240722-slim";
        execSync(
          `docker run --rm -v ${projDir}:/app -w /app ${image} ` +
            `bash -c 'mix local.hex --force && mix local.rebar --force && ` +
            `mix deps.get --only prod && mix format --check-formatted'`,
          {
            stdio: "inherit",
            timeout: 600_000,
          },
        );
      } finally {
        try {
          fs.rmSync(outDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }, 700_000);
  },
);

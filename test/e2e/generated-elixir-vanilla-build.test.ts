import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type HexMirror, startHexMirror } from "./support/hex-mirror";

// ---------------------------------------------------------------------------
// Slice 6 of docs/old/plans/vanilla-foundation-tdd-plan.md — CI gate for
// the vanilla emit subtree.  Parallel to test/e2e/generated-elixir-ash-
// build.test.ts but exercises `foundation: vanilla` deployables and
// expects no Ash deps in the generated mix.exs.
//
// For every fixture under `test/e2e/fixtures/elixir-vanilla-build/`,
// generate the project then `mix deps.get && mix compile
// --warnings-as-errors` inside the hexpm/elixir Docker image.  Catches
// every Elixir surface error the unit-test layer (string assertions)
// can't see — the actual acceptance gate for the vanilla emitters.
//
// Gated behind LOOM_PHOENIX_VANILLA_BUILD=1 so it stays out of the
// always-on `test` matrix; runs in CI via .github/workflows/elixir-
// vanilla-build.yml and locally via `npm run test:phoenix-vanilla`.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "bin", "cli.js");
const fixturesDir = path.join(here, "fixtures", "elixir-vanilla-build");
const ENABLED = process.env.LOOM_PHOENIX_VANILLA_BUILD === "1";
const IMAGE = "hexpm/elixir:1.18.4-erlang-27.3.4-debian-bookworm-20260610-slim";

// `mix deps.get && mix compile --warnings-as-errors` inside the elixir image.
// When `mirror` is set (LOOM_HEX_MIRROR=1) hex.pm traffic is routed through the
// loopback mirror — mirrors the Ash gate, so this gate also runs behind a
// TLS-fingerprinting egress proxy.  See test/e2e/support/hex-mirror.ts.
function runMixCompile(projDir: string, mirror: HexMirror | undefined): void {
  const dockerArgs = mirror ? `${mirror.dockerArgs.join(" ")} ` : "";
  const shellPrefix = mirror?.shellPrefix ?? "";
  execSync(
    `docker run --rm ${dockerArgs}-v ${projDir}:/app -w /app -e MIX_ENV=prod ${IMAGE} ` +
      `bash -c '${shellPrefix}mix local.hex --force && mix local.rebar --force && ` +
      `mix deps.get --only prod && mix compile --warnings-as-errors'`,
    { stdio: "inherit", timeout: 600_000 },
  );
}

// `mix test` (MIX_ENV=test) for a fixture whose aggregates declare domain
// `test "..."` blocks — the emitted ExUnit suite runs the pure domain core
// (vanilla/domain-core-emit.ts) with NO database, so this gate just compiles +
// runs the tests.  Catches an emitter regression that produces invalid Elixir
// or a behaviourally wrong assertion (the `mix compile --warnings-as-errors`
// gate above is MIX_ENV=prod and never compiles `test/`).
function runMixTest(projDir: string, mirror: HexMirror | undefined): void {
  const dockerArgs = mirror ? `${mirror.dockerArgs.join(" ")} ` : "";
  const shellPrefix = mirror?.shellPrefix ?? "";
  execSync(
    `docker run --rm ${dockerArgs}-v ${projDir}:/app -w /app ${IMAGE} ` +
      `bash -c '${shellPrefix}mix local.hex --force && mix local.rebar --force && ` +
      `mix deps.get && mix test'`,
    { stdio: "inherit", timeout: 600_000 },
  );
}

// Embedded-SPA host (M-T6.1): a `hosts:` React/Vue/Svelte deployable drops the
// SPA project under `<proj>/assets/`.  `mix compile` (above) never touches it
// (elixirc_paths is `lib` only), so the SPA's own tsc + vite build is proved
// HERE on the host — the Phoenix-embedded equivalent of `generated-react-
// build.yml`, gating the one path (`basePath: "/app"` + same-origin `/api`)
// the standalone react-build matrix doesn't exercise.  No-op when no `assets/`
// project exists (every non-hosting fixture).
function runSpaBuild(assetsDir: string): void {
  execSync("npm ci --prefer-offline --no-audit --no-fund || npm install", {
    cwd: assetsDir,
    stdio: "inherit",
    timeout: 600_000,
  });
  execSync("npm run build", { cwd: assetsDir, stdio: "inherit", timeout: 600_000 });
}

// CI shards one fixture per matrix cell (see elixir-vanilla-build.yml) so a cold
// dep compile fits the per-cell timeout and reseeds its own cache.
// `LOOM_PHOENIX_VANILLA_BUILD_CASE=<fixture>.ddd` selects that single fixture;
// unset (local `npm run test:phoenix-vanilla`) builds them all.
function pickCases<T extends { name: string }>(all: T[]): T[] {
  const only = process.env.LOOM_PHOENIX_VANILLA_BUILD_CASE;
  if (!only) return all;
  const selected = all.filter((c) => c.name === only);
  if (selected.length === 0) {
    throw new Error(
      `LOOM_PHOENIX_VANILLA_BUILD_CASE=${only} matched no elixir-vanilla-build fixture ` +
        `(have: ${all.map((c) => c.name).join(", ")})`,
    );
  }
  return selected;
}

describe.skipIf(!ENABLED)(
  "generated vanilla Phoenix project compiles against plain Ecto (LOOM_PHOENIX_VANILLA_BUILD=1)",
  () => {
    // Behind a TLS-fingerprinting proxy (LOOM_HEX_MIRROR=1) start one loopback
    // hex mirror for the whole suite; a no-op (undefined) with direct access.
    let mirror: HexMirror | undefined;
    beforeAll(async () => {
      mirror = await startHexMirror();
    });
    afterAll(() => {
      mirror?.stop();
    });
    // Enumerate the fixtures dynamically from the directory — the same set the
    // `elixir-vanilla-build.yml` matrix derives via `ls`, so the two never
    // drift (a fixture added/removed under elixir-vanilla-build/ needs no edit
    // here). Every `.ddd` in the dir is a mix-compile target.
    const allFixtures = fs
      .readdirSync(fixturesDir)
      .filter((f) => f.endsWith(".ddd"))
      .sort()
      .map((name) => ({ name }));
    it.each(pickCases(allFixtures))("$name → mix compile --warnings-as-errors", ({ name }) => {
      const fixturePath = path.join(fixturesDir, name);
      const baseOutDir = process.env.LOOM_PHOENIX_OUT_DIR;
      const outDir = baseOutDir
        ? path.join(baseOutDir, name.replace(/\.ddd$/, ""))
        : fs.mkdtempSync(path.join(os.tmpdir(), "loom-vanilla-"));
      fs.mkdirSync(outDir, { recursive: true });

      try {
        const genRoot = path.join(outDir, "out");
        // The vanilla orchestrator emits one project per deployable under
        // `out/<deployable>/`; the deployable slug varies per fixture (`api`,
        // `phoenixApp`, …), so discover the elixir project(s) by globbing for
        // `mix.exs` rather than hardcoding the slug.
        const mixProjects = (): string[] =>
          fs.existsSync(genRoot)
            ? fs
                .readdirSync(genRoot)
                .map((d) => path.join(genRoot, d))
                .filter((d) => fs.existsSync(path.join(d, "mix.exs")))
            : [];
        if (mixProjects().length === 0) {
          execSync(`node ${cli} generate system ${fixturePath} -o ${genRoot}`, {
            stdio: "inherit",
            cwd: repoRoot,
          });
        }
        const projDirs = mixProjects();
        expect(projDirs.length).toBeGreaterThan(0);

        for (const projDir of projDirs) {
          // Vanilla mix.exs must have zero Ash deps — re-asserting at the e2e
          // level on top of the unit assertion.
          const mix = fs.readFileSync(path.join(projDir, "mix.exs"), "utf8");
          expect(mix).not.toContain(":ash,");
          expect(mix).not.toContain(":ash_postgres,");
          expect(mix).not.toContain(":ash_phoenix,");

          // mix deps.get + compile inside the elixir image (cold-cache fits the
          // 600s exec budget; the headroom absorbs transient hex slowness).
          // Routed through the loopback hex mirror when LOOM_HEX_MIRROR=1.
          runMixCompile(projDir, mirror);

          // If the fixture's aggregates declared domain `test "..."` blocks, the
          // emitter wrote an ExUnit suite (+ test_helper.exs) — run it (DB-free).
          if (fs.existsSync(path.join(projDir, "test", "test_helper.exs"))) {
            runMixTest(projDir, mirror);
          }

          // Embedded-SPA host: build the `assets/` SPA project (tsc + vite) so
          // the fullstack Phoenix path is compile-proved end to end.
          const assetsDir = path.join(projDir, "assets");
          if (fs.existsSync(path.join(assetsDir, "package.json"))) {
            runSpaBuild(assetsDir);
          }
        }
      } finally {
        if (!baseOutDir) {
          try {
            fs.rmSync(outDir, { recursive: true, force: true });
          } catch {
            // best-effort cleanup
          }
        }
      }
    }, 700_000);
    // Cold mix deps.get + mix compile inside docker can take several
    // minutes on a fresh cache; mirror the Ash test's 700_000 ms
    // per-test timeout so vitest doesn't kill the docker exec at the
    // default 30s.
  },
);

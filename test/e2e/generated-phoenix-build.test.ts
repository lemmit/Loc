import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// generated Phoenix project compiles against real Ash 3.x.
//
// Mirrors `test/generated-build.test.ts` (the TS-build regression):
// emit a phoenix deployable from a fixture, then run
// `mix deps.get && mix compile --warnings-as-errors` inside the
// hexpm/elixir Docker image.  Catches Ash 3.x API drift and any
// other semantic emission bug that the per-file syntax check
// (`Code.string_to_quoted!`) doesn't see.
//
// Slow (~3-5 min cold; ~30s warm with deps cache) — opt-in via
// LOOM_PHOENIX_BUILD=1 so the default `npm test` stays fast.  CI's
// `.github/workflows/phoenix-build.yml` runs the same check on every
// PR that touches the Phoenix generator.
//
// Fixtures live under `test/e2e/fixtures/phoenix-build/` — the
// workflow reads them too (single source of truth, so the workflow
// stays in sync without manual heredoc edits per language change).
//
// CI knob:  `LOOM_PHOENIX_OUT_DIR=<path>` — when set, the test uses
// `<path>/<fixture-stem>` as the project outDir instead of a per-run
// tmpdir.  Skips regeneration when `mix.exs` already exists at that
// path (lets the workflow pre-generate to seed the cache key), and
// skips the rm-rf cleanup so `deps/` + `_build/` survive for the
// post-job `actions/cache` save.
//
// Network requirement: `mix deps.get` reaches repo.hex.pm.  In a
// proxy-restricted sandbox the call fails with a TLS handshake
// error from Erlang's :inets — the Dockerfile bakes proxy CAs via
// /usr/local/share/ca-certificates/, but this test
// shells out directly rather than using that Dockerfile, so it
// requires network access to hex.pm AND a host with passwordless
// `docker run`.  GitHub-hosted runners satisfy both.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "bin", "cli.js");
const fixturesDir = path.join(here, "fixtures", "phoenix-build");

const ENABLED = process.env.LOOM_PHOENIX_BUILD === "1";

describe.skipIf(!ENABLED)(
  "generated Phoenix project compiles against real Ash 3.x (LOOM_PHOENIX_BUILD=1)",
  () => {
    it.each([
      { name: "acme-lv.ddd" },
      // Value-object array (`Money[]`) — Ash stores it inline as an
      // `{:array, Money}` embedded attribute → `{:array, :map}` column (no
      // child table); compiles the embedded-array path.
      { name: "value-collections.ddd" },
      // Reference-collection (`Id<T>[]`) fixture — exercises the m2m join
      // entity + many_to_many relationship + `manage_relationship` mutations
      // + `exists(...)` filter that Phoenix join-table emission produces.
      { name: "roster.ddd" },
      // First-boot seeding (database-seeding.md): compiles priv/repo/seeds.exs
      // (the Ash create-action seed path) + the ecto.setup alias change.
      { name: "seeding.ddd" },
      // D-PHOENIX-SURFACE: a phoenix backend that EMBEDS a React SPA
      // (hosts: a `ui { framework: react }`).  Compiles the
      // embedded-react Elixir side — the endpoint `/app` Plug.Static,
      // the router `/app` SpaController fallback, and the SpaController
      // itself — against real Ash 3.x.  No LiveView pages are emitted;
      // the React `assets/` half is covered by the react-build matrix.
      { name: "phoenix-embed-react.ddd" },
      // Carrier-bounded generics (payload-transport-layer.md, P3b): compiles
      // the Ash offset-pagination read actions + the controller page/pageSize
      // actions that map %Ash.Page.Offset{} to the cross-backend envelope.
      { name: "paged.ddd" },
      // Discriminated unions (payload-transport-layer.md, P4d): compiles the
      // controller `tag_<union>/1` serializer (struct-pattern clauses → the
      // `%{type: tag, …}` wire) for an `Order or Cancel` find.
      { name: "union.ddd" },
      // TPH (sharedTable) inheritance (aggregate-inheritance.md I2): the two
      // concrete Ash resources (Customer, Vendor) share one `parties` table,
      // each `base_filter`'d on a `kind` discriminator, plus the polymorphic
      // `list_parties` base reader.  The decisive check that Ash 3.x compiles
      // multiple resources mapping to one table (Ash has no native STI).
      { name: "tph.ddd" },
      // In-process event dispatch (channels.md): compiles the emitted
      // per-context Dispatcher, the reactor / event-create handler modules
      // (`StartOrderPlaced` / `OnShipmentRequested`), and the persisted
      // saga-state `Ecto.Schema` (load-or-allocate / route-or-drop+log)
      // against real Ash 3.x — the decisive check that the event-triggered
      // saga path compiles under `--warnings-as-errors`.
      { name: "dispatch.ddd" },
    ])("$name → mix compile --warnings-as-errors", ({ name }) => {
      const fixturePath = path.join(fixturesDir, name);
      const baseOutDir = process.env.LOOM_PHOENIX_OUT_DIR;
      const outDir = baseOutDir
        ? path.join(baseOutDir, name.replace(/\.ddd$/, ""))
        : fs.mkdtempSync(path.join(os.tmpdir(), "loom-phoenix-"));
      fs.mkdirSync(outDir, { recursive: true });
      try {
        const projDir = path.join(outDir, "out", "phoenix_app");
        // Skip regeneration when the project already exists at the
        // expected path — i.e. the CI workflow pre-generated it to
        // compute the dep-cache key.  Local runs (no env var) always
        // start from a fresh tmpdir so this branch is the cold path.
        if (!fs.existsSync(path.join(projDir, "mix.exs"))) {
          // 1. Generate the project.
          execSync(`node ${cli} generate system ${fixturePath} -o ${outDir}/out`, {
            stdio: "inherit",
            cwd: repoRoot,
          });
        }
        expect(fs.existsSync(path.join(projDir, "mix.exs"))).toBe(true);

        // 2. mix deps.get + mix compile inside the elixir image.
        //    --warnings-as-errors catches Ash 3.x API drift (deprecated
        //    define_for, wrong Ash.transaction signature, etc.).
        const image = "hexpm/elixir:1.17.2-erlang-27.0.1-debian-bookworm-20240722-slim";
        execSync(
          `docker run --rm -v ${projDir}:/app -w /app -e MIX_ENV=prod ${image} ` +
            `bash -c 'mix local.hex --force && mix local.rebar --force && ` +
            `mix deps.get --only prod && mix compile --warnings-as-errors'`,
          {
            stdio: "inherit",
            timeout: 600_000,
          },
        );
      } finally {
        // CI-driven runs (LOOM_PHOENIX_OUT_DIR set) MUST leave deps/
        // and _build/ on disk so `actions/cache` can save them after
        // the job.  Only clean up the tmpdir variant.
        if (!baseOutDir) {
          try {
            fs.rmSync(outDir, { recursive: true, force: true });
          } catch {
            /* ignore */
          }
        }
      }
    }, 700_000);

    // The showcase is the maximal multi-context, multi-deployable example —
    // it intentionally touches the whole language surface (derived nil-checks,
    // unreferenced domain `function`s, function-form preconditions, views).
    // Its phoenixApi deployable is the one that surfaced the four
    // `--warnings-as-errors` regressions this gate now pins:
    //   1. unused `alias` in view modules,
    //   2. `x != nil` instead of `is_nil/1`,
    //   3. unreferenced helper `function` as a private `defp`,
    //   4. missing `require_atomic? false` on a function-form-validate action.
    // It lives in examples/ (not the fixtures dir) because it's the shared
    // cross-backend showcase, so it gets its own standalone case.
    //
    // Gated behind LOOM_PHOENIX_SHOWCASE (in addition to the block-level
    // LOOM_PHOENIX_BUILD) so it runs in its OWN parallel CI job
    // (`build-generated-phoenix-showcase`) rather than stacking onto the
    // fixtures job's sequential docker legs — generating the full
    // multi-deployable system + compiling this large Ash app is markedly
    // heavier than any single fixture.  Local `npm run test:phoenix` runs
    // (no LOOM_PHOENIX_SHOWCASE) skip it; set the var to run it directly.
    it.skipIf(!process.env.LOOM_PHOENIX_SHOWCASE)(
      "system showcase (phoenix) — multi-context backend compiles under --warnings-as-errors",
      () => {
        const baseOutDir = process.env.LOOM_PHOENIX_OUT_DIR;
        const outDir = baseOutDir
          ? path.join(baseOutDir, "showcase")
          : fs.mkdtempSync(path.join(os.tmpdir(), "loom-phoenix-showcase-"));
        fs.mkdirSync(outDir, { recursive: true });
        try {
          const projDir = path.join(outDir, "out", "phoenix_api");
          if (!fs.existsSync(path.join(projDir, "mix.exs"))) {
            execSync(`node ${cli} generate system examples/showcase.ddd -o ${outDir}/out`, {
              stdio: "inherit",
              cwd: repoRoot,
            });
          }
          expect(fs.existsSync(path.join(projDir, "mix.exs"))).toBe(true);

          const image = "hexpm/elixir:1.17.2-erlang-27.0.1-debian-bookworm-20240722-slim";
          execSync(
            `docker run --rm -v ${projDir}:/app -w /app -e MIX_ENV=prod ${image} ` +
              `bash -c 'mix local.hex --force && mix local.rebar --force && ` +
              `mix deps.get --only prod && mix compile --warnings-as-errors'`,
            {
              stdio: "inherit",
              timeout: 600_000,
            },
          );
        } finally {
          if (!baseOutDir) {
            try {
              fs.rmSync(outDir, { recursive: true, force: true });
            } catch {
              /* ignore */
            }
          }
        }
      },
      700_000,
    );
  },
);

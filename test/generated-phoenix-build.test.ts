import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Batch F1 — generated Phoenix project compiles against real Ash 3.x.
//
// Mirrors `test/generated-build.test.ts` (the TS-build regression):
// emit a phoenixLiveView deployable from a fixture, then run
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
// Network requirement: `mix deps.get` reaches repo.hex.pm.  In a
// proxy-restricted sandbox the call fails with a TLS handshake
// error from Erlang's :inets — the Dockerfile bakes proxy CAs via
// /usr/local/share/ca-certificates/ (see Batch D4), but this test
// shells out directly rather than using that Dockerfile, so it
// requires network access to hex.pm AND a host with passwordless
// `docker run`.  GitHub-hosted runners satisfy both.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const cli = path.join(repoRoot, "bin", "cli.js");

const ENABLED = process.env.LOOM_PHOENIX_BUILD === "1";

const FIXTURE_DDD = `system AcmeLV {
  module Sales {
    context Sales {
      valueobject Money {
        amount: decimal
        currency: string
      }
      aggregate Customer {
        name: string display
        email: string
        creditLimit: Money
        invariant email.length > 0
        operation adjustCredit(amount: decimal) {
          precondition amount > 0
        }
      }
      repository Customers for Customer { }
    }
  }
  api SalesApi from Sales
  ui SalesAdmin { scaffold modules: Sales }
  deployable phoenixApp {
    platform: phoenixLiveView
    modules: Sales
    serves: SalesApi
    ui: SalesAdmin
    port: 4000
  }
}
`;

describe.skipIf(!ENABLED)(
  "generated Phoenix project compiles against real Ash 3.x (LOOM_PHOENIX_BUILD=1)",
  () => {
    it("examples/acme-lv.ddd → mix compile --warnings-as-errors", () => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-phoenix-"));
      const dddPath = path.join(outDir, "acme-lv.ddd");
      try {
        fs.writeFileSync(dddPath, FIXTURE_DDD);
        // 1. Generate the project.
        execSync(`node ${cli} generate system ${dddPath} -o ${outDir}/out`, {
          stdio: "inherit",
          cwd: repoRoot,
        });
        const projDir = path.join(outDir, "out", "phoenix_app");
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
        try {
          fs.rmSync(outDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }, 700_000);
  },
);

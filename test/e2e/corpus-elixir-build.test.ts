import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CORPUS_DEPLOYABLE, materializeCorpusFixture } from "../fixtures/corpus/harness.js";
import { CORPUS } from "../fixtures/corpus/manifest.js";
import { type HexMirror, startHexMirror } from "./support/hex-mirror.js";

// ---------------------------------------------------------------------------
// Phase 1 compile tier (docs/old/plans/global-test-coverage-plan.md) for the
// Elixir (plain Ecto/Phoenix) backend — the sibling of `corpus-{tsc,dotnet,
// java,python}-build.test.ts` (M-T9.10).  The fast `corpus-coverage` gate
// proves every corpus feature *generates* on `vanilla` (elixir); this gate
// proves the emitted project actually *compiles* under `mix compile
// --warnings-as-errors` inside the hexpm/elixir Docker image — upgrading the
// corpus from a generation floor to a compile guarantee on the FIFTH backend,
// from the SAME single source of truth (one `.ddd` per feature, no per-backend
// duplicate).
//
// Before this leg, an Elixir codegen regression on any corpus feature shipped
// green until the nightly cross-backend conformance run — this closes that
// silent per-PR gap (the matrix used to cap at tsc/dotnet/java/python because
// only Elixir needs the docker hexpm image + the LOOM_HEX_MIRROR loopback dance
// behind a TLS-fingerprinting egress proxy).
//
// Slow (docker mix deps.get + compile per feature) — opt-in via
// LOOM_ELIXIR_BUILD=1.  CI shards one feature per cell via
// LOOM_CORPUS_ELIXIR_CASE=<feature-id> (see corpus-elixir-build.yml).  Requires
// a running docker daemon; behind a TLS-fingerprinting proxy set LOOM_HEX_MIRROR=1
// (a no-op on CI's direct hex.pm access).  See test/e2e/support/hex-mirror.ts.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "bin", "cli.js");

const ENABLED = process.env.LOOM_ELIXIR_BUILD === "1";
const CASE = process.env.LOOM_CORPUS_ELIXIR_CASE;

// Same image the single-fixture vanilla gate pins
// (test/e2e/generated-elixir-vanilla-build.test.ts) — keep the two in lockstep.
const IMAGE = "hexpm/elixir:1.18.4-erlang-27.3.4-debian-bookworm-20260610-slim";

// Features that GENERATE on elixir but don't yet compile under `mix compile
// --warnings-as-errors` — real Elixir generator gaps this compile tier would
// surface (the generation gate still covers all of them on all six backends;
// each line is a precise, reproducible bug report).  Widen the gate by FIXING
// the emitter, then dropping the entry.
const ELIXIR_COMPILE_SKIP: Record<string, string> = {
  // (empty — every corpus feature the manifest declares on `vanilla` compiles
  //  clean under `mix compile --warnings-as-errors`.)
};

// Every corpus feature the manifest declares to generate on the elixir backend
// (manifest key `vanilla` — plain Ecto/Phoenix), minus the documented
// compile-tier skips.
const elixirFeatures = CORPUS.filter((f) => f.backends.includes("vanilla"))
  .filter((f) => !(f.id in ELIXIR_COMPILE_SKIP))
  .filter((f) => !CASE || f.id === CASE)
  .map((f) => f.id);

// `mix deps.get --only prod && mix compile --warnings-as-errors` inside the
// elixir image.  When `mirror` is set (LOOM_HEX_MIRROR=1) hex.pm traffic is
// routed through the loopback mirror so this gate also runs behind a
// TLS-fingerprinting egress proxy — mirrors the single-fixture vanilla gate.
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

describe.skipIf(!ENABLED)(
  "corpus features compile under mix (Elixir/Phoenix) (LOOM_ELIXIR_BUILD=1)",
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

    it.each(elixirFeatures)("%s — generated elixir project compiles", (featureId) => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), `loom-corpus-elixir-${featureId}-`));
      try {
        const src = materializeCorpusFixture(featureId, "vanilla", outDir);
        execSync(`node ${cli} generate system ${src} -o ${outDir}`, {
          stdio: "inherit",
          cwd: repoRoot,
        });
        // The deployable is named `d` → its elixir project lands under `d/`.
        const proj = path.join(outDir, CORPUS_DEPLOYABLE);
        expect(
          fs.existsSync(path.join(proj, "mix.exs")),
          `${featureId}: elixir project emitted`,
        ).toBe(true);
        runMixCompile(proj, mirror);
      } finally {
        fs.rmSync(outDir, { recursive: true, force: true });
      }
    }, 700_000);
  },
);

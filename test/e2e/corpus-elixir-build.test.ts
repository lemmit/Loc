import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { corpusProjectDirs, materializeCorpusFixture } from "../fixtures/corpus/harness.js";
import { CORPUS } from "../fixtures/corpus/manifest.js";
import { type HexMirror, startHexMirror } from "./support/hex-mirror.js";
import { mixDepsGet, mixLocalInstall } from "./support/mix-retry.js";

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

// A hex PACKAGE cache shared by every container this file starts.
//
// `docker run --rm` throws away the container's `~/.hex`, so each project
// re-downloads the entire dependency closure from scratch.  That was invisible
// while a feature meant exactly one project; a multi-deployable feature doubles
// it, and behind the loopback hex mirror the second `deps.get` reliably dies
// with `Request failed (:timeout)` fetching a tarball the first run had already
// pulled.  Mounting one host dir at `/root/.hex` makes the second project a
// cache hit — correctness behind the mirror, and a straight speed-up on CI's
// direct hex.pm access.  Same shape as the NuGet cache mount in
// `api-call-e2e.test.ts`.
const HEX_CACHE = path.join(os.tmpdir(), "loom-corpus-elixir-hex");

// `mix deps.get --only prod && mix compile --warnings-as-errors` inside the
// elixir image.  When `mirror` is set (LOOM_HEX_MIRROR=1) hex.pm traffic is
// routed through the loopback mirror so this gate also runs behind a
// TLS-fingerprinting egress proxy — mirrors the single-fixture vanilla gate.
// The FETCH is retried (transient hex.pm 500s used to kill whole cells — see
// support/mix-retry.ts); the COMPILE is not, and must keep failing fast.
function runMixCompile(projDir: string, mirror: HexMirror | undefined): void {
  const dockerArgs = mirror ? `${mirror.dockerArgs.join(" ")} ` : "";
  const shellPrefix = mirror?.shellPrefix ?? "";
  fs.mkdirSync(HEX_CACHE, { recursive: true });
  execSync(
    `docker run --rm ${dockerArgs}-v ${projDir}:/app -v ${HEX_CACHE}:/root/.hex ` +
      `-w /app -e MIX_ENV=prod ${IMAGE} ` +
      `bash -c '${shellPrefix}${mixLocalInstall()} && ` +
      `${mixDepsGet("--only prod")} && mix compile --warnings-as-errors'`,
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
        // One project per declared deployable (`d` for every single-service
        // fixture; a multi-service feature names both, and BOTH must compile).
        for (const dir of corpusProjectDirs(featureId)) {
          const proj = path.join(outDir, dir);
          expect(
            fs.existsSync(path.join(proj, "mix.exs")),
            `${featureId}: elixir project '${dir}' emitted`,
          ).toBe(true);
          runMixCompile(proj, mirror);
        }
      } finally {
        // Best-effort: the docker container runs as root and writes root-owned
        // `deps/` + `_build/` into the mounted project dir, so a non-root CI
        // runner's rmSync can't remove them (EACCES).  The compile result is
        // what gates; a leftover temp dir on an ephemeral runner is harmless.
        try {
          fs.rmSync(outDir, { recursive: true, force: true });
        } catch {
          // leave the root-owned tree for the runner's own /tmp cleanup
        }
      }
    }, 700_000);
  },
);

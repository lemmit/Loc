import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CORPUS_DEPLOYABLE, materializeCorpusFixture } from "../fixtures/corpus/harness.js";
import { CORPUS } from "../fixtures/corpus/manifest.js";
import { type HexMirror, startHexMirror } from "./support/hex-mirror";

// ---------------------------------------------------------------------------
// Phase 1 compile tier (docs/plans/global-test-coverage-plan.md) for the
// Phoenix / Ash 3.x backend — the sibling of `corpus-tsc-build` (node),
// `corpus-java-build` (Java), `corpus-python-build` (Python) and
// `corpus-dotnet-build` (.NET).  The fast `corpus-coverage` gate proves every
// corpus feature *generates* on `phoenix`; this gate proves the emitted project
// actually *compiles* under `mix compile --warnings-as-errors` against real Ash
// 3.x, upgrading the corpus from a generation floor to a compile guarantee on
// the Phoenix backend too — from the SAME single source of truth (one `.ddd`
// per feature, no per-backend duplicate).
//
// Slow (`mix deps.get` + compile per feature, in Docker) — opt-in via
// LOOM_PHOENIX_BUILD=1 (the same switch the single-fixture
// `generated-elixir-ash-build` gate uses).  CI shards one feature per cell via
// LOOM_CORPUS_ELIXIR_CASE=<feature-id>.  Behind a TLS-fingerprinting egress
// proxy set LOOM_HEX_MIRROR=1 to route hex.pm through the loopback mirror (see
// generated-elixir-ash-build.test.ts + test/e2e/support/hex-mirror.ts).
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "bin", "cli.js");

const ENABLED = process.env.LOOM_PHOENIX_BUILD === "1";
const CASE = process.env.LOOM_CORPUS_ELIXIR_CASE;

const IMAGE = "hexpm/elixir:1.18.4-erlang-27.3.4-debian-bookworm-20260610-slim";

// `mix deps.get --only prod && mix compile --warnings-as-errors` inside the
// elixir image.  When `mirror` is set (LOOM_HEX_MIRROR=1) hex.pm traffic routes
// through the loopback mirror.  Identical recipe to generated-elixir-ash-build.
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

// Features that GENERATE on phoenix but don't yet compile under `mix compile
// --warnings-as-errors` against real Ash 3.x — real Phoenix/Ash generator gaps
// this compile tier surfaces (the generation gate still covers all of them on
// all six backends; each line is a precise, reproducible bug report).  Widen
// the gate by FIXING the emitter, then dropping the entry.
const ELIXIR_COMPILE_SKIP: Record<string, string> = {
  // FEATURE GAP (not an emitter bug): workflow own-state mutation.  `attempts := 1`
  // in a saga body is documented ("own-state mutation", workflow.md) but not yet
  // lowered on any backend — the same cross-backend gap every other tier tracks.
  "workflow-view": "FEATURE GAP: workflow own-state mutation (`field := …`) not yet lowered",
  // PLATFORM LIMITATION (Ash foundation, generate-time error): `shape(document)`.
  // Ash emits only relational/embedded shapes; the generator points to
  // foundation: vanilla (or a node/dotnet deployable) for whole-aggregate jsonb.
  document:
    "PLATFORM LIMITATION: Ash foundation emits no shape(document) (use foundation: vanilla)",
  // PLATFORM LIMITATION (Ash foundation, generate-time error): `persistedAs(eventLog)`.
  // Ash has no pure-ES data-layer fit (AshEvents is hybrid); the generator points
  // to foundation: vanilla / node / dotnet.  See proposals/vanilla-phoenix-foundation.md.
  "event-sourcing":
    "PLATFORM LIMITATION: Ash foundation has no pure-ES data layer (use foundation: vanilla)",
  // PLATFORM LIMITATION (Ash foundation, generate-time error): an `eventSourced`
  // workflow needs a per-correlation event stream — implemented on node/dotnet/
  // java/python/elixir-vanilla, not the Ash foundation.
  "eventsourced-workflow":
    "PLATFORM LIMITATION: event-sourced workflow not on Ash foundation (use foundation: vanilla)",
  // PLATFORM LIMITATION (Ash foundation, generate-time error): the `provenanced`
  // field runtime (trace capture + history) is emitted for node/dotnet/java/
  // python/elixir-vanilla, not the Ash foundation.
  provenance:
    "PLATFORM LIMITATION: provenance runtime not on Ash foundation (use foundation: vanilla)",
};

// Every corpus feature the manifest declares to generate on `phoenix`, minus the
// documented compile-tier skips.
const elixirFeatures = CORPUS.filter((f) => f.backends.includes("phoenix"))
  .filter((f) => !(f.id in ELIXIR_COMPILE_SKIP))
  .filter((f) => !CASE || f.id === CASE)
  .map((f) => f.id);

describe.skipIf(!ENABLED)("corpus features compile under mix (Phoenix / Ash 3.x)", () => {
  let mirror: HexMirror | undefined;
  beforeAll(async () => {
    mirror = await startHexMirror();
  });
  afterAll(() => {
    mirror?.stop();
  });

  it.each(elixirFeatures)("%s — generated Phoenix project compiles", (featureId) => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), `loom-corpus-elixir-${featureId}-`));
    try {
      const src = materializeCorpusFixture(featureId, "phoenix", outDir);
      execSync(`node ${cli} generate system ${src} -o ${outDir}`, {
        stdio: "inherit",
        cwd: repoRoot,
      });
      // The deployable is named `d` → its project lands under `d/`.
      const proj = path.join(outDir, CORPUS_DEPLOYABLE);
      expect(
        fs.existsSync(path.join(proj, "mix.exs")),
        `${featureId}: phoenix project emitted`,
      ).toBe(true);
      runMixCompile(proj, mirror);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  }, 660_000);
});

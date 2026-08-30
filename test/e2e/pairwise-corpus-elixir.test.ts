import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll } from "vitest";
import { describeCompileLeg } from "../pairwise/compile-leg.js";
import { type HexMirror, startHexMirror } from "./support/hex-mirror.js";
import { mixDepsGet, mixLocalInstall } from "./support/mix-retry.js";

// ---------------------------------------------------------------------------
// M-T9.29 — the COMPILE oracle, elixir leg (plain Ecto/Phoenix, `mix compile
// --warnings-as-errors` inside the hexpm/elixir Docker image).
//
// Sibling of `pairwise-corpus-tsc.test.ts` (node); see `compile-leg.ts` for the
// shared contract and the motivating bug class. This leg supplies only
// elixir's toolchain — the SAME image + `mix local.hex`/`mix local.rebar` +
// `mix deps.get --only prod && mix compile --warnings-as-errors` recipe
// `corpus-elixir-build.test.ts` uses, with a persistent `~/.hex` package cache
// mounted across cases (a `docker run --rm` container throws away its own, and
// the cover shares a handful of distinct dependency sets across ~25 cases).
//
// PERSISTENCE AXIS: elixir has no non-default adapter registered in
// `PERSISTENCE_BACKEND` (`test/pairwise/axes.ts`), so `pairwiseCover("elixir")`
// already narrows to `["default"]` — nothing to override here.
//
// SHAPE AXIS: `shape: document` is a named elixir refusal
// (`loom.vanilla-document-unsupported`, src/ir/validate/checks/system-checks.ts)
// — those crossings come back `verdict: "rejected"` from the shared harness,
// which `describeCompileLeg` treats as legitimate (nothing to compile). The
// cover is NOT narrowed to avoid them: the refusal firing correctly on every
// crossing that reaches it is itself the thing worth proving.
//
// Egress: behind a TLS-fingerprinting proxy Erlang/OTP's `:ssl` can't reach
// hex.pm at all (bare HTTP 503) where curl/other stacks succeed — set
// `LOOM_HEX_MIRROR=1` to route through the loopback TLS-terminating mirror
// (see test/e2e/support/hex-mirror.ts, docs/tools.md). A no-op when unset
// (CI's direct hex.pm access). The FETCH is retried (transient hex.pm 500s,
// support/mix-retry.ts); the COMPILE is not, and must keep failing fast.
// ---------------------------------------------------------------------------

const IMAGE = "hexpm/elixir:1.18.4-erlang-27.3.4-debian-bookworm-20260610-slim";

/** Shared across every case in this run — persisted under the OS tmp dir (not
 *  a per-run mkdtemp) so a re-run of a single shard via
 *  LOOM_PAIRWISE_COMPILE_CASE also benefits from a previous run's downloads.
 *  Mirrors the HEX_CACHE mount in `corpus-elixir-build.test.ts`. */
const HEX_CACHE = path.join(os.tmpdir(), "loom-pairwise-elixir-hex");

let mirror: HexMirror | undefined;
beforeAll(async () => {
  mirror = await startHexMirror();
});
afterAll(() => {
  mirror?.stop();
});

describeCompileLeg({
  platform: "elixir",
  label: "elixir",
  enabled: process.env.LOOM_PAIRWISE === "1" && process.env.LOOM_ELIXIR_BUILD === "1",
  projectDir: (root) => path.join(root, "d"),
  compile(proj) {
    fs.mkdirSync(HEX_CACHE, { recursive: true });
    const dockerArgs = mirror ? `${mirror.dockerArgs.join(" ")} ` : "";
    const shellPrefix = mirror?.shellPrefix ?? "";
    try {
      execSync(
        `docker run --rm ${dockerArgs}-v ${proj}:/app -v ${HEX_CACHE}:/root/.hex ` +
          `-w /app -e MIX_ENV=prod ${IMAGE} ` +
          `bash -c '${shellPrefix}${mixLocalInstall()} && ` +
          `${mixDepsGet("--only prod")} && mix compile --warnings-as-errors'`,
        { stdio: "pipe", timeout: 600_000 },
      );
      return undefined;
    } catch (e) {
      const err = e as { stdout?: Buffer; stderr?: Buffer };
      return `${err.stdout?.toString() ?? ""}${err.stderr?.toString() ?? ""}`.slice(0, 4000);
    }
  },
  timeoutMs: 900_000,
});

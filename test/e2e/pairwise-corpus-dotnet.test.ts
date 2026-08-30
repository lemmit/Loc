import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { caInstallPrefix, describeCompileLeg, proxyCaDockerArgs } from "../pairwise/compile-leg.js";

// ---------------------------------------------------------------------------
// M-T9.29 — the COMPILE oracle, .NET leg (ASP.NET + EF Core / Dapper,
// `dotnet build /warnaserror`).
//
// Sibling of `pairwise-corpus-tsc.test.ts` (node) / `-java.test.ts` /
// `-python.test.ts` / `-elixir.test.ts`; see `compile-leg.ts` for the shared
// contract and the motivating bug class. .NET is where the recorded bug class
// actually lived: #2412 (`mask unless` × `audited`) generated cleanly and then
// failed CS0128; #2387 / #2391 (`audited` × dapper × document / eventLog) were
// uncompilable; #2181 (channels × rabbit) failed `/warnaserror`. Three of the
// four historically-recorded intersection bugs this corpus exists for failed
// on .NET, not node.
//
// The persistence axis matters MORE on this leg than on any other: .NET is
// the one non-node backend the cover reaches a second adapter on
// (`persistenceFor("dotnet")` → `default` EF Core AND `dapper`,
// `PERSISTENCE_BACKEND` in `test/pairwise/axes.ts`), and the dapper crossings
// are exactly where #2387/#2391 lived — this leg does NOT narrow it.
//
// TOOLCHAIN. The generated projects target `net10.0`, which the sandbox host
// has no SDK for at all, so `compile` shells out to
// `docker run … mcr.microsoft.com/dotnet/sdk:10.0 …` per case — the same
// image `corpus-dotnet-build.test.ts` and docs/tools.md's documented recipe
// build against — rather than re-hosting the whole vitest process inside the
// dotnet image (the harness already runs on Node; the container would need
// Node installed too, for no benefit). Unlike the java leg's `JAVA_TOOL_OPTIONS`
// truststore, NuGet trusts only the container's SYSTEM certificate store, so
// the proxy CA has to be installed into it with `update-ca-certificates`
// before `dotnet restore` — mounting `/root/.ccr` alone fails restore with a
// misleading NU1301 "UntrustedRoot" (docs/tools.md, "Compiling generated
// backends in Docker").
//
// CACHING. Unlike npm, NuGet's global packages cache (`~/.nuget/packages`) is
// content-addressed by package id+version, not by project, so restoring the
// SAME package set twice never re-downloads regardless of which project asks.
// A single host-side cache dir mounted into every case's container gets the
// reuse the node leg gets from hashing `package.json`, with no per-project
// bookkeeping needed: `renderCsproj` (src/generator/dotnet/emit/program.ts)
// varies only with `usingDapper` for every crossing this composer emits (no
// `extern`/resource/oidc/cron/channel axis is in play), so the cover only
// ever exercises TWO distinct package sets — `default` and `dapper` — and
// every case after the first of each resolves entirely from the warm cache.
// Persisted under the OS tmp dir (not a per-run mkdtemp) so a single-shard
// re-run via LOOM_PAIRWISE_COMPILE_CASE also benefits from a previous run's
// downloads.
// ---------------------------------------------------------------------------

const DOTNET_IMAGE = "mcr.microsoft.com/dotnet/sdk:10.0";

const NUGET_CACHE_DIR = path.join(os.tmpdir(), "loom-pairwise-dotnet-nuget-cache");
fs.mkdirSync(NUGET_CACHE_DIR, { recursive: true });

/** Proxy + CA plumbing the container needs to reach nuget.org in this
 *  environment. Harmless where the proxy is absent (CI runners) — `-e NAME`
 *  with no `=value` passes through whatever the host process has (or nothing). */
const PROXY_ENV = ["-e", "HTTPS_PROXY", "-e", "HTTP_PROXY", ...proxyCaDockerArgs()];

/** Install the sandbox's proxy CA into the container's system trust store
 *  (NuGet, unlike the JVM, only reads that store — no env-var override) and
 *  then restore + build under `/warnaserror`, matching
 *  `corpus-dotnet-build.test.ts` exactly. */
const BUILD_SCRIPT =
  `${caInstallPrefix()}dotnet restore --nologo ` +
  "&& dotnet build --no-restore --nologo /warnaserror";

describeCompileLeg({
  platform: "dotnet",
  label: ".NET",
  enabled: process.env.LOOM_PAIRWISE === "1" && process.env.LOOM_DOTNET_BUILD === "1",
  projectDir: (root) => path.join(root, "d"),
  compile(proj) {
    const args = [
      "run",
      "--rm",
      "--network",
      "host",
      "-v",
      `${proj}:/src`,
      "-w",
      "/src",
      "-v",
      `${NUGET_CACHE_DIR}:/root/.nuget/packages`,
      ...PROXY_ENV,
      DOTNET_IMAGE,
      "bash",
      "-c",
      BUILD_SCRIPT,
    ];
    try {
      execSync(`docker ${args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ")}`, {
        stdio: "pipe",
        timeout: 280_000,
      });
      return undefined;
    } catch (e) {
      const err = e as { stdout?: Buffer; stderr?: Buffer };
      return `${err.stdout?.toString() ?? ""}${err.stderr?.toString() ?? ""}`.slice(0, 4000);
    }
  },
  timeoutMs: 300_000,
});

import { describe, expect, it } from "vitest";
import { infraFailure } from "./compile-leg.js";

// ---------------------------------------------------------------------------
// The infra-vs-finding classifier (compile-leg.ts).
//
// This is the gate that stops a broken INSTRUMENT from being reported as a
// broken SUBJECT.  Both rows in the first table are verbatim output from real
// failures this leg produced on its first day; both had read zero bytes of
// emitted code, and both were reported as "emitted project failed to compile".
//
// The second table is the direction that matters just as much: a REAL compiler
// diagnostic must NOT be swallowed as infra, or the leg silently stops finding
// the bugs it exists for.
// ---------------------------------------------------------------------------

const INFRA = [
  [
    "dockerd reaped mid-run",
    "failed to connect to the docker API at unix:///var/run/docker.sock; check if the path is correct and if the daemon is running: dial unix /var/run/docker.sock: connect: no such file or directory",
  ],
  [
    "hex.pm install timeout (17 of 25 elixir cases)",
    "** (Mix) request timed out after 60000ms\nCould not install Hex because Mix could not download metadata at https://builds.hex.pm/installs/hex.csv.",
  ],
  [
    "nuget service index unreachable",
    "error NU1301: Unable to load the service index for source https://api.nuget.org/v3/index.json.",
  ],
  ["dns failure", "curl: (6) Could not resolve host: repo.maven.apache.org"],
  ["disk exhausted", "write /src/build/x.o: no space left on device"],
] as const;

const REAL_FINDINGS = [
  [
    ".NET CS0535 (the dotnet leg's actual finding)",
    "/src/Infrastructure/Repositories/ThingRepository.cs(20,39): error CS0535: 'ThingRepository' does not implement interface member 'IThingRepository.GetByIdForWriteAsync(ThingId, CancellationToken)'",
  ],
  [
    "python mypy call-arg (the python leg's actual finding)",
    'app/http/thing_routes.py:88: error: Unexpected keyword argument "expected_version" for "save"  [call-arg]',
  ],
  [
    "TS2339 (F2, node)",
    "src/repo.ts(12,7): error TS2339: Property 'toWireMasked' does not exist on type 'ThingRepository'.",
  ],
  ["elixir warning-as-error", "** (CompileError) lib/app/thing.ex:14: undefined function foo/1"],
  ["javac symbol error", "/src/Thing.java:9: error: cannot find symbol"],
] as const;

describe("infra failures are classified as harness faults, not findings", () => {
  for (const [name, out] of INFRA) {
    it(`detects: ${name}`, () => expect(infraFailure(out)).toBeDefined());
  }
});

describe("real compiler diagnostics are NOT swallowed as infra", () => {
  for (const [name, out] of REAL_FINDINGS) {
    it(`passes through: ${name}`, () => expect(infraFailure(out)).toBeUndefined());
  }
});

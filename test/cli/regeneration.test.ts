import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { materializeCorpusFixture } from "../fixtures/corpus/harness.js";

// ---------------------------------------------------------------------------
// Generation as a FUNCTION — the algebraic properties of `ddd generate system`.
//
// Every other gate in the tree asks what the compiler emitted.  These ask how
// it emits: the same input twice, the same input in a different environment,
// the same model spelled with different whitespace, and a preview against the
// run it previews.  All four are self-checking — there is no expected output to
// maintain, only a relation between two runs — which is why they cost four
// assertions and no fixtures, and why they keep working as every emitter
// changes underneath them.
//
// WHAT EACH ONE CATCHES, concretely:
//
//   * IDEMPOTENCE — a `Date.now()` / `randomUUID()` / unstable `Map` iteration
//     order that leaks into output.  The CLI's incremental writer already
//     classifies an up-to-date file as `unchanged`, so a second run reporting
//     any write IS the leak, named precisely.
//   * NO SPURIOUS TOUCH — the same fact from the filesystem's side.  The
//     incremental write exists so a regen is "a precise reload signal instead
//     of a full project bounce" (src/cli/main.ts); nothing checked that a
//     no-op regen leaves mtimes alone, which is the only form of the claim a
//     watching Vite / `dotnet watch` can observe.
//   * TIMEZONE INDEPENDENCE — a zone reaching the output through `Date`
//     formatting.  Two child processes with `TZ` swapped, byte-compared.  This
//     has to be a subprocess: Node caches the zone at first use, so an
//     in-process pair would compare one environment with itself and pass
//     forever.
//   * SOURCE-FORM INDEPENDENCE — comments and blank lines in a `.ddd` reaching
//     the emitted artefact.  The output is a function of the MODEL, not of its
//     spelling.
//   * DRY-RUN FIDELITY — `--dry-run` is a second implementation of the write
//     classification (`src/cli/main.ts` runs the same predicates down a
//     different branch), and a preview that disagrees with the run is worse
//     than no preview.
//
// THE LOCALE VARS ARE A RIDER, NOT A PROVEN AXIS.  `LANG`/`LC_ALL` are swapped
// alongside `TZ` because it costs nothing and would catch a future
// `localeCompare` ordering leak — but on an ASCII fixture no locale pair
// reorders anything (`sv_SE` differs from `en_US` only from `ä` onward), so
// this file does NOT claim to gate the locale axis and the mutation proof below
// does not cover it.  Naming a gate for a failure mode it cannot see is the
// exact habit `experience_gathered.md` §68 records; the vars stay, the claim
// does not.  Making it real needs non-ASCII identifiers in the fixture, which
// belongs with the adversarial-identifier corpus, not here.
//
// Deliberately one corpus fixture on one backend, not a matrix: these are
// properties of the PIPELINE and its writer, which every backend shares.  A
// per-backend sweep would multiply the cost by five and the coverage by
// nothing.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "bin", "cli.js");

const tmps: string[] = [];
const mkTmp = (tag: string): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `loom-regen-${tag}-`));
  tmps.push(d);
  return d;
};
afterAll(() => {
  for (const d of tmps) fs.rmSync(d, { recursive: true, force: true });
});

function generate(src: string, out: string, extra: string[] = [], env: NodeJS.ProcessEnv = {}) {
  return execFileSync("node", [cli, "generate", "system", src, "-o", out, ...extra], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    // stderr is captured, not inherited: the fixture emits an index-suggestion
    // warning on every one of the ten runs below, and ten copies of it in the
    // suite log buries whatever a real failure prints.
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Every emitted file as `relPath -> content`, so two trees compare in one
 *  assertion and a difference names the file. */
function readTree(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else
        out.set(path.relative(dir, full).split(path.sep).join("/"), fs.readFileSync(full, "utf8"));
    }
  };
  walk(dir);
  return out;
}

/** The paths a run reported it would write, from `--dry-run`'s per-file plan. */
const plannedWrites = (stdout: string): string[] =>
  stdout
    .split("\n")
    .filter((l) => l.startsWith("  write "))
    .map((l) =>
      l
        .trim()
        .replace(/^write\s+/, "")
        .replace(/\s+\([\d.]+ KB\)$/, ""),
    )
    .sort();

/** One shared source: `core-domain` is the widest single fixture (enum, value
 *  object, event, containment, derived, invariant, operation, find) and is
 *  maintained as the corpus' canonical feature. */
const fixtureDir = mkTmp("src");
const SRC = materializeCorpusFixture("core-domain", "node", fixtureDir);

describe("generate system is a function of the model", () => {
  it("is idempotent — a second identical run writes nothing", () => {
    const out = mkTmp("idem");
    const first = generate(SRC, out);
    expect(first).toMatch(/Wrote \d+ file\(s\)/);
    const second = generate(SRC, out);
    // The whole claim in one line: every file classified `unchanged`, none
    // rewritten.  A nondeterministic byte anywhere in the tree lands here.
    expect(second, second).toMatch(/Wrote 0 file\(s\) in .*, unchanged: \d+/);
  }, 120_000);

  it("touches no file on a no-op regen", () => {
    const out = mkTmp("mtime");
    generate(SRC, out);
    const before = [...readTree(out).keys()].map(
      (p) => [p, fs.statSync(path.join(out, p)).mtimeMs] as const,
    );
    generate(SRC, out);
    const touched = before.filter(([p, m]) => fs.statSync(path.join(out, p)).mtimeMs !== m);
    expect(touched.map(([p]) => p)).toEqual([]);
  }, 120_000);

  it("emits the same bytes under a different timezone", () => {
    const a = mkTmp("tz-a");
    const b = mkTmp("tz-b");
    // `Asia/Kolkata` is a half-hour offset, so a date rendered there differs
    // from UTC in the MINUTES field too — a leak that a whole-hour zone could
    // hide whenever the emitted value happened to be midnight.
    generate(SRC, a, [], { TZ: "UTC", LANG: "C", LC_ALL: "C" });
    generate(SRC, b, [], { TZ: "Asia/Kolkata", LANG: "sv_SE.UTF-8", LC_ALL: "sv_SE.UTF-8" });
    expect([...readTree(b).entries()]).toEqual([...readTree(a).entries()]);
  }, 180_000);

  it("ignores comments and blank lines in the source", () => {
    const out = mkTmp("form-a");
    generate(SRC, out);
    const decorated = path.join(fixtureDir, "decorated.ddd");
    fs.writeFileSync(
      decorated,
      fs
        .readFileSync(SRC, "utf8")
        .split("\n")
        .flatMap((l) => [
          "",
          `// a comment that must not reach the output: ${l.trim().slice(0, 20)}`,
          l,
        ])
        .join("\n"),
    );
    const out2 = mkTmp("form-b");
    generate(decorated, out2);
    expect([...readTree(out2).entries()]).toEqual([...readTree(out).entries()]);
  }, 180_000);

  it("--dry-run predicts exactly the set a real run writes", () => {
    const planned = plannedWrites(generate(SRC, mkTmp("plan"), ["--dry-run"]));
    expect(planned.length).toBeGreaterThan(0);
    const out = mkTmp("real");
    generate(SRC, out);
    expect([...readTree(out).keys()].sort()).toEqual(planned);
  }, 120_000);
});

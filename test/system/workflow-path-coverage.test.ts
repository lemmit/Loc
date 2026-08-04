// A gate that never runs is not a gate.
//
// WHY THIS EXISTS
// ---------------
// Every heavy CI gate narrows itself with a `paths:` filter so it only fires on
// a change that could plausibly break it.  That filter is hand-maintained, and
// it is written ONCE — when the workflow is added — against whatever the test
// imported that day.  The test's dependencies then grow, the filter doesn't,
// and the gate quietly stops firing for a widening slice of the compiler.
//
// The failure is invisible in exactly the way the surrounding work has been
// draining (#2384, #2387/#2391, #2393, #2394): the gate is green, the check
// name is in the list, the workflow file looks thorough — and for the change
// you just made, it never ran.  Worse than a vacuous assertion, because there
// is no assertion to inspect.
//
// When this test was written, ALL 27 path-filtered gates omitted
// `src/macros/**` and `src/util/**`.  So a change to `src/macros/prelude.ts` —
// which is where the `auditable`, `tenantOwned`, `versioned` and
// `tenantRegistry` capabilities are defined — fired none of them.  Neither did
// a change to `src/util/naming.ts` (`pascal`/`camel`/`snake`/`plural`) or
// `src/util/code-builder.ts` (`lines()`), both imported by every emitter on
// every backend.  That `auditable` is what landed there is not a coincidence:
// #2387 and #2391 were both audit-capability bugs on the Dapper path.
//
// THE INVARIANT
// -------------
// A workflow that (a) carries a `paths:` filter and (b) runs a test that
// generates a project must watch every dir on the GENERATION PATH:
//
//     parse -> macro expand -> lower -> enrich -> IR validate -> compose
//     language/   macros/      ir/                               system/
//                                    util/  (naming + code-builder + axes,
//                                            imported by every emitter)
//
// Those five run for EVERY backend, so no per-backend argument excuses one.
// The generator's shared seams (`_walker`, `_expr`, `_frontend`, ...) are
// deliberately NOT required: those are genuinely per-target, and requiring them
// would produce false positives — which is how a gate like this gets weakened
// into theatre.  This checks the part that is unarguable.
//
// "Runs a test that generates a project" is DERIVED, not declared: the entry
// points named by the workflow are walked transitively, and the workflow counts
// as a generation gate when that closure reaches `src/system/index.ts` (or
// spawns `bin/cli.js`, which is the same pipeline behind a process boundary).
// So a workflow cannot fall out of scope by having its imports rearranged.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const workflowsDir = path.join(repoRoot, ".github/workflows");

/** The pipeline phases every `generate system` walks, whatever the backend. */
const GENERATION_PATH = [
  "src/language/**",
  "src/macros/**",
  "src/ir/**",
  "src/system/**",
  "src/util/**",
] as const;

/** The composition entry every generation path funnels through. */
const GENERATION_ENTRY = "src/system/index.ts";

// ---------------------------------------------------------------------------
// Workflows that carry a `paths:` filter but are legitimately NOT generation
// gates, or are scoped to one narrow artefact on purpose.  Each entry is a
// REASON, not a suppression: it must say why the generation path cannot break
// this workflow's subject.  Keep this list short — it is the pressure valve
// that decides whether this gate stays honest.
// ---------------------------------------------------------------------------
const EXEMPT: Record<string, string> = {
  "langium-generated.yml":
    "checks only that `langium:generate` output matches the grammar — it runs the generator, not the pipeline, and the closure below never reaches src/system/index.ts",
  "workflow-lint.yml": "lints .github/workflows/** itself; touches no Loom source",
};

// ---------------------------------------------------------------------------
// A deliberately small resolver for local ESM imports.  `src/**` is authored as
// `./x.js` specifiers over `.ts` sources, so `.js` is rewritten before probing.
// ---------------------------------------------------------------------------
function resolveSpec(fromFile: string, spec: string): string | undefined {
  if (!spec.startsWith(".")) return undefined;
  const base = path.resolve(path.dirname(fromFile), spec).replace(/\.js$/, ".ts");
  const candidates = [base, `${base}.ts`, path.join(base.replace(/\.ts$/, ""), "index.ts")];
  return candidates.find((c) => existsSync(c) && c.endsWith(".ts"));
}

const IMPORT_RE = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;
/** A test that shells out to the CLI drives the whole pipeline out-of-process. */
const SPAWNS_CLI_RE = /cli\.js|out\/cli\/main\.js/;

interface Closure {
  /** Every repo-relative `src/**` file reachable from the entry points. */
  readonly files: ReadonlySet<string>;
  /** True when some visited file drives generation (in-process or via the CLI). */
  readonly generates: boolean;
}

function closureOf(entries: readonly string[]): Closure {
  const seen = new Set<string>();
  let spawnsCli = false;

  const walk = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      return;
    }
    if (SPAWNS_CLI_RE.test(source)) spawnsCli = true;
    IMPORT_RE.lastIndex = 0;
    let m = IMPORT_RE.exec(source);
    while (m) {
      const target = resolveSpec(file, m[1]);
      if (target) walk(target);
      m = IMPORT_RE.exec(source);
    }
  };

  for (const e of entries) walk(path.join(repoRoot, e));

  const files = new Set([...seen].map((f) => path.relative(repoRoot, f).split(path.sep).join("/")));
  return { files, generates: spawnsCli || files.has(GENERATION_ENTRY) };
}

// ---------------------------------------------------------------------------
// Workflow reading — the same indentation-disciplined approach as
// `merge-queue-readiness.test.ts` (no YAML parser resolves in this repo's
// dependency tree).  Two things are extracted: the positive `paths:` globs
// under every trigger, and the test entry points the jobs run.
// ---------------------------------------------------------------------------

/** Positive `paths:` globs across all triggers (`!`-negations are ignored:
 *  they only ever SHRINK coverage, and a shrink is not what this gate is
 *  looking for). */
function pathGlobs(source: string): string[] {
  const globs = new Set<string>();
  let inPaths = false;
  let keyIndent = 0;
  for (const raw of source.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (/^\s*#/.test(line)) continue;
    const header = line.match(/^(\s*)paths(-ignore)?:\s*$/);
    if (header) {
      inPaths = header[2] === undefined;
      keyIndent = header[1].length;
      continue;
    }
    if (!inPaths) continue;
    const item = line.match(/^(\s*)-\s*'([^']+)'\s*$/);
    if (item && item[1].length > keyIndent) {
      if (!item[2].startsWith("!")) globs.add(item[2]);
      continue;
    }
    // Any non-list line at or above the `paths:` indent ends the block.
    if (line.trim() !== "") inPaths = false;
  }
  return [...globs];
}

const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
  scripts?: Record<string, string>;
};

/** Test files a workflow RUNS: paths named inline, plus those reachable through
 *  the `npm run <script>` invocations in its steps.
 *
 *  Comment lines are stripped first — a workflow that merely *mentions* a test
 *  path in a comment does not run it.  (This bit immediately: the rationale
 *  comment this change adds to each `paths:` block names this very file, and an
 *  unfiltered scan read that as an entry point.) */
function entryPoints(yaml: string): string[] {
  const source = yaml
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
  const found = new Set<string>();
  const add = (text: string): void => {
    for (const m of text.matchAll(/(test\/[\w./-]+\.test\.ts)/g)) found.add(m[1]);
  };
  add(source);
  for (const m of source.matchAll(/npm run ([\w:-]+)/g)) {
    const script = pkg.scripts?.[m[1]];
    if (script) add(script);
  }
  return [...found].filter((f) => existsSync(path.join(repoRoot, f)));
}

/** Does `glob` cover EVERY file under `dir/`?  Only a `dir/**` (or a wider
 *  ancestor) does — a single-file pin like `src/ir/lower/lower.ts` covers one
 *  file and leaves the rest of the phase dark, which is precisely the drift
 *  this gate is about. */
function watchesTree(globs: readonly string[], tree: string): boolean {
  const dir = tree.replace(/\*\*$/, "");
  return globs.some((g) => g.endsWith("**") && dir.startsWith(g.slice(0, -2)));
}

interface Gate {
  readonly file: string;
  readonly globs: readonly string[];
  readonly entries: readonly string[];
  readonly closure: Closure;
  /** True when the workflow drives generation itself — a `run:` step calling
   *  `node bin/cli.js generate …` with no test file in between.  Found the hard
   *  way: the first cut of this gate keyed only on resolved `test/**.test.ts`
   *  entry points, and `generated-{feliz,flutter}-build` — which generate
   *  straight from a `run:` step — fell out of scope entirely.  That is the
   *  same "looked covered, wasn't" shape this file is about, so it is checked
   *  from the workflow SOURCE rather than inferred from its tests. */
  readonly generatesInline: boolean;
}

const gates: Gate[] = readdirSync(workflowsDir)
  .filter((f) => f.endsWith(".yml"))
  .sort()
  .map((file) => {
    const source = readFileSync(path.join(workflowsDir, file), "utf8");
    const entries = entryPoints(source);
    return {
      file,
      globs: pathGlobs(source),
      entries,
      closure: closureOf(entries),
      generatesInline: /bin\/cli\.js\s+generate/.test(source),
    };
  })
  .filter((g) => g.globs.length > 0);

const generates = (g: Gate): boolean => g.closure.generates || g.generatesInline;
const generationGates = gates.filter((g) => generates(g) && !(g.file in EXEMPT));

describe("workflow path filters cover the generation path", () => {
  it("finds the path-filtered generation gates (the reader still works)", () => {
    // If the reader silently stops recognising workflows, every assertion below
    // passes over an empty set — this gate's own vacuous-success mode. Pin it.
    expect(generationGates.length).toBeGreaterThan(10);
    expect(gates.every((g) => g.globs.length > 0)).toBe(true);
  });

  for (const gate of generationGates) {
    it(`${gate.file} watches every pipeline phase it depends on`, () => {
      const unwatched = GENERATION_PATH.filter((tree) => !watchesTree(gate.globs, tree));
      expect(
        unwatched,
        `${gate.file} filters on \`paths:\` but does not watch ${unwatched.join(", ")}.\n` +
          `It drives \`generate system\` (${
            gate.generatesInline
              ? "a `run:` step invokes bin/cli.js directly"
              : `via ${gate.entries.join(", ")}`
          }) — so a change confined to an unwatched phase cannot trigger this ` +
          "gate, and it will not run for that change at all.\n" +
          "Add the missing globs to EVERY trigger's `paths:` block, or add a reasoned " +
          "entry to EXEMPT in this file.",
      ).toEqual([]);
    });
  }

  it("every EXEMPT entry names a real workflow and carries a reason", () => {
    for (const [file, reason] of Object.entries(EXEMPT)) {
      expect(existsSync(path.join(workflowsDir, file)), `${file} does not exist`).toBe(true);
      expect(reason.trim().length, `${file} needs a reason`).toBeGreaterThan(20);
    }
  });

  it("no EXEMPT entry is stale — an exempt workflow must not be a generation gate", () => {
    // An exemption granted because "this doesn't generate" has to stay true.
    // If the workflow later starts driving the pipeline, the exemption is
    // silently hiding a real hole.
    const stale = Object.keys(EXEMPT).filter((f) => {
      const g = gates.find((x) => x.file === f);
      return g !== undefined && generates(g);
    });
    expect(stale, `EXEMPT claims these don't generate, but their closure does: ${stale}`).toEqual(
      [],
    );
  });
});

describe("the closure walker resolves what it claims to", () => {
  // The walker is the whole gate: if it resolved nothing, every workflow would
  // read as "not a generation gate" and this suite would pass while checking
  // nothing.  Pin it against a known-shaped fixture from the tree.
  it("reaches the pipeline from a test that spawns the CLI", () => {
    const c = closureOf(["test/e2e/corpus-dotnet-build.test.ts"]);
    expect(c.generates).toBe(true);
    expect(c.files.has("src/macros/prelude.ts")).toBe(true);
    expect(c.files.has("src/util/naming.ts")).toBe(true);
  });

  it("reaches the pipeline from a test that imports the composer directly", () => {
    const c = closureOf(["test/conformance/behavioural-coverage.test.ts"]);
    expect(c.generates).toBe(true);
    expect(c.files.has(GENERATION_ENTRY)).toBe(true);
  });

  it("recognises a workflow that generates from a `run:` step, with no test file", () => {
    // generated-{feliz,flutter}-build run `node bin/cli.js generate system`
    // directly. They resolve NO test entry point, so a closure-only reader
    // scores them as non-generation gates and skips them silently — which is
    // exactly what the first cut of this file did.
    const inline = gates.filter((g) => g.generatesInline && g.entries.length === 0);
    expect(inline.map((g) => g.file)).toContain("generated-feliz-build.yml");
    expect(inline.map((g) => g.file)).toContain("generated-flutter-build.yml");
  });

  it("watchesTree accepts a tree glob and rejects a single-file pin", () => {
    expect(watchesTree(["src/ir/**"], "src/ir/**")).toBe(true);
    expect(watchesTree(["src/**"], "src/macros/**")).toBe(true);
    expect(watchesTree(["src/ir/lower/lower.ts"], "src/ir/**")).toBe(false);
    expect(watchesTree(["src/generator/**"], "src/util/**")).toBe(false);
  });
});

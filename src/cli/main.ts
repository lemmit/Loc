import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { Command } from "commander";
import ignore from "ignore";
import { URI } from "langium";
import { NodeFileSystem } from "langium/node";
import { generateDotnet } from "../generator/dotnet/index.js";
import { enrichLoomModel } from "../ir/enrichments.js";
import type { LoomModel, TestOutcome } from "../ir/loom-ir.js";
import { lowerModel, mergeLoomModels } from "../ir/lower.js";
import { validateLoomModel } from "../ir/validate.js";
import { createDddServices } from "../language/ddd-module.js";
import type { Model } from "../language/generated/ast.js";
import { loadProject } from "../language/project-loader.js";
import { installFsBackendSource } from "../platform/fs-discovery.js";
import { generateTypeScript } from "../platform/hono/v4/emit.js";
// Legacy single-context `generate ts` targets the default Hono
// backend; the CLI (an entrypoint) supplies that package's pins to
// the version-agnostic shared emitter.
import { BACKEND_PINS as HONO_V4_PINS } from "../platform/hono/v4/pins.js";
import { generateSystemsFromLoom } from "../system/index.js";
import { fsSnapshotStore } from "../system/snapshot.js";
import { captureSnapshots } from "../system/loomsnap.js";
import {
  renderVerdictGraph,
  renderVerificationJson,
  renderVerificationMd,
} from "../verify/render.js";
import { computeVerification } from "../verify/verification.js";

interface ParseResult {
  model: Model;
  diagnostics: string[];
  errorCount: number;
  warningCount: number;
}

async function parseFile(file: string): Promise<ParseResult> {
  const services = createDddServices(NodeFileSystem);
  const absolute = path.resolve(file);
  if (!fs.existsSync(absolute)) {
    throw new Error(`File not found: ${absolute}`);
  }
  const docs = services.shared.workspace.LangiumDocuments;
  const doc = await docs.getOrCreateDocument(URI.file(absolute));
  await services.shared.workspace.DocumentBuilder.build([doc], { validation: true });

  const diagnostics: string[] = [];
  let errorCount = 0;
  let warningCount = 0;
  for (const d of doc.diagnostics ?? []) {
    const severity = d.severity === 1 ? "error" : d.severity === 2 ? "warning" : "info";
    if (severity === "error") errorCount++;
    if (severity === "warning") warningCount++;
    const line = d.range.start.line + 1;
    const col = d.range.start.character + 1;
    diagnostics.push(`${absolute}:${line}:${col} ${severity}: ${d.message}`);
  }
  return {
    model: doc.parseResult?.value as Model,
    diagnostics,
    errorCount,
    warningCount,
  };
}

interface ProjectParseResult {
  /** Pre-enriched LoomModel, merged from every reachable document. */
  loom: LoomModel;
  diagnostics: string[];
  errorCount: number;
  warningCount: number;
}

/**
 * Multi-file entry — load the project rooted at `entryFile`, walk
 * its `import` graph, and return a single enriched `LoomModel` built
 * by lowering each document independently and merging the results.
 * Used by `generate system`.  Single-document legacy commands stay
 * on `parseFile`.
 */
async function parseProject(entryFile: string): Promise<ProjectParseResult> {
  const services = createDddServices(NodeFileSystem);
  const absolute = path.resolve(entryFile);
  if (!fs.existsSync(absolute)) {
    throw new Error(`File not found: ${absolute}`);
  }
  const { all } = await loadProject(URI.file(absolute), services.shared);

  const diagnostics: string[] = [];
  let errorCount = 0;
  let warningCount = 0;
  for (const doc of all) {
    const docPath = doc.uri.fsPath;
    for (const d of doc.diagnostics ?? []) {
      const severity = d.severity === 1 ? "error" : d.severity === 2 ? "warning" : "info";
      if (severity === "error") errorCount++;
      if (severity === "warning") warningCount++;
      const line = d.range.start.line + 1;
      const col = d.range.start.character + 1;
      diagnostics.push(`${docPath}:${line}:${col} ${severity}: ${d.message}`);
    }
  }

  // Lower each document independently; references between documents
  // were resolved by the linker during DocumentBuilder.build so each
  // IR node carries fully-resolved cross-doc refs.  The merge is then
  // an in-order concatenation of the top-level slices.
  const lowered = all.map((doc) => lowerModel(doc.parseResult.value as Model));
  const merged = mergeLoomModels(lowered);
  const loom = enrichLoomModel(merged);
  return { loom, diagnostics, errorCount, warningCount };
}

function printDiagnostics(result: ParseResult) {
  for (const d of result.diagnostics) console.error(d);
  console.error(`${result.errorCount} error(s), ${result.warningCount} warning(s).`);
}

async function runParse(file: string) {
  const result = await parseFile(file);
  printDiagnostics(result);
  if (result.errorCount > 0) process.exit(1);
  console.log(`OK: ${file}`);
}

/**
 * Loads the project's `.loomignore` (gitignore-syntax) from the output
 * directory, if present, and returns a matcher.  Patterns are matched
 * against forward-slash-normalised paths relative to the output dir.
 */
function loadLoomIgnore(outDir: string): ignore.Ignore {
  const ig = ignore();
  const file = path.join(outDir, ".loomignore");
  if (fs.existsSync(file)) {
    ig.add(fs.readFileSync(file, "utf8"));
  }
  return ig;
}

/**
 * MIT grant emitted at the root of every generated project.  Loom
 * itself is FSL-1.1-Apache-2.0, but the *output* of `ddd generate` is
 * licensed to the user under MIT so that production users can ship
 * generated code without inheriting FSL terms.  The companion FAQ
 * lives at `docs/license-faq.md` in the Loom repo.
 *
 * If the generator emits a LICENSE file as part of its own output
 * (none do today), that emitted entry wins — we only inject this
 * when no LICENSE is already in the file map.  Users who want to
 * substitute their own LICENSE pin it via `.loomignore`.
 */
const GENERATED_OUTPUT_LICENSE = `MIT License

Copyright (c) ${new Date().getFullYear()} the authors of this generated project.

This project was scaffolded by Loom (https://github.com/lemmit/loc), a
source-available DDD code generator licensed under FSL-1.1-Apache-2.0.
The generator's license does NOT extend to this output: every file in
this directory is licensed to you under the MIT License below.  Any
runtime helper snippets that Loom embedded verbatim into this project
are dual-licensed MIT OR Apache-2.0 in this context.  See
https://github.com/lemmit/loc/blob/main/docs/license-faq.md for the
full posture.

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT.  IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS
BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN
ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

interface RunOptions {
  dryRun?: boolean;
  /** When true, errors are reported but `runGenerate` returns instead
   * of calling `process.exit`.  Used by watch mode so a typo in the
   * `.ddd` source doesn't tear down the watcher. */
  continueOnError?: boolean;
  /** Compile-time `--trace` switch — when true, the TS generators inject
   * trace-level domain instrumentation (`value_computed`,
   * `precondition_evaluated`, etc., via `requestLog().trace(...)`).  Off
   * by default keeps the artefact lean and the domain layer pure; on
   * regenerate to diagnose.  See docs/proposals/observability.md. */
  emitTrace?: boolean;
}

interface RunResult {
  /** True iff the run produced an error (parse, IR validation, or
   * thrown during generation).  In one-shot mode the CLI translates
   * this to a non-zero exit; in watch mode it keeps watching. */
  hadError: boolean;
  /** File counts for the "Wrote N…" summary.  Undefined when the run
   * errored out before reaching the write loop. */
  written?: number;
  unchanged?: number;
  skippedByIgnore?: number;
}

type GenerateTarget = "ts" | "dotnet" | "system";

async function runGenerate(
  target: GenerateTarget,
  file: string,
  outDir: string,
  options: RunOptions = {},
): Promise<RunResult> {
  // `generate system` is multi-file aware: load the entry's import
  // graph, lower per document, merge.  Legacy single-deployable
  // `generate ts` / `generate dotnet` stay on the single-file path.
  let loom: LoomModel;
  let legacyModel: Model | undefined; // non-system targets only
  if (target === "system") {
    let projectResult: ProjectParseResult;
    try {
      projectResult = await parseProject(file);
    } catch (err) {
      console.error(`${file}: ${err instanceof Error ? err.message : String(err)}`);
      if (!options.continueOnError) process.exit(1);
      return { hadError: true };
    }
    if (projectResult.errorCount > 0) {
      for (const d of projectResult.diagnostics) console.error(d);
      console.error(
        `${projectResult.errorCount} error(s), ${projectResult.warningCount} warning(s).`,
      );
      if (!options.continueOnError) process.exit(1);
      return { hadError: true };
    }
    loom = projectResult.loom;
  } else {
    const result = await parseFile(file);
    if (result.errorCount > 0) {
      printDiagnostics(result);
      if (!options.continueOnError) process.exit(1);
      return { hadError: true };
    }
    legacyModel = result.model;
    loom = enrichLoomModel(lowerModel(result.model));
  }

  // Loom-IR-level validation: catches `api.<unknown>.<verb>` and
  // `ui.<unknown>.<verb>` references in `test e2e` bodies before
  // generators are called.  Everything caught here used to throw
  // mid-generation with a slightly less helpful trace.
  const loomDiags = validateLoomModel(loom);
  const loomErrors = loomDiags.filter((d) => d.severity === "error");
  if (loomErrors.length > 0) {
    for (const d of loomDiags) {
      console.error(`${d.source} ${d.severity}: ${d.message}`);
    }
    console.error(
      `${loomErrors.length} error(s), ${loomDiags.length - loomErrors.length} warning(s).`,
    );
    if (!options.continueOnError) process.exit(1);
    return { hadError: true };
  }
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  let files: Map<string, string>;
  if (target === "system") {
    // Diff each module's current schema against the snapshot the LAST
    // regen wrote into `.loom/snapshots/` (under `outDir`).  Fresh
    // output dirs ⇒ `fsSnapshotStore.read` returns null ⇒ initial
    // migration; existing snapshots ⇒ delta migration when the source
    // moves.  See `docs/migrations-design.md`.
    files = generateSystemsFromLoom(loom, {
      emitTrace: options.emitTrace,
      snapshots: fsSnapshotStore(outDir),
    }).files;
    if (files.size === 0) {
      console.error(
        `No \`system\` block declared in ${file}.  Use \`generate ts\` or \`generate dotnet\` for legacy single-deployable sources.`,
      );
      if (!options.continueOnError) process.exit(1);
      return { hadError: true };
    }
  } else if (target === "ts") {
    files = generateTypeScript(legacyModel!, HONO_V4_PINS, { emitTrace: options.emitTrace });
  } else {
    files = generateDotnet(legacyModel!, { emitTrace: options.emitTrace });
  }

  if (!files.has("LICENSE")) {
    files.set("LICENSE", GENERATED_OUTPUT_LICENSE);
  }

  const ig = loadLoomIgnore(outDir);
  let written = 0;
  let unchanged = 0;
  let skippedByIgnore = 0;
  const sortedPaths = [...files.keys()].sort();
  for (const relPath of sortedPaths) {
    const content = files.get(relPath)!;
    const normalised = relPath.split(path.sep).join("/");
    const ignored = ig.ignores(normalised);
    if (options.dryRun) {
      const sizeKb = (Buffer.byteLength(content, "utf8") / 1024).toFixed(1);
      const status = ignored ? "  skip (.loomignore)" : "  write              ";
      console.log(`${status}  ${relPath}  (${sizeKb} KB)`);
      if (ignored) skippedByIgnore++;
      else written++;
      continue;
    }
    if (ignored) {
      skippedByIgnore++;
      continue;
    }
    const full = path.join(outDir, relPath);
    // Incremental write: only touch files whose content actually
    // changed.  Downstream watchers (Vite, `dotnet watch`) react to
    // mtimes, so skipping unchanged writes turns a regen of an N-file
    // project where the user touched one aggregate into a precise
    // reload signal instead of a full project bounce.
    if (fileContentMatches(full, content)) {
      unchanged++;
      continue;
    }
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
    written++;
  }
  const verb = options.dryRun ? "Would write" : "Wrote";
  const parts: string[] = [`${verb} ${written} file(s) in ${outDir}`];
  if (unchanged > 0) parts.push(`unchanged: ${unchanged}`);
  if (skippedByIgnore > 0) parts.push(`skipped (.loomignore): ${skippedByIgnore}`);
  console.log(parts.join(", "));
  return { hadError: false, written, unchanged, skippedByIgnore };
}

/** Resolve the current git commit (short) for the snapshot envelope, or
 *  undefined when not in a repo / git unavailable. */
function gitCommitHash(): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

/**
 * `ddd snapshot` — the explicit provenance-capture prebuild step.  Lowers
 * the model and writes one immutable, timestamped + GUID-named snapshot
 * file per system under `<out>/.loom/snapshots/`.  Analogous to
 * `dotnet ef migrations add`: run it deliberately when rules change so the
 * deployed runtime's trace records can be explained against a captured
 * version of the code.
 */
async function runSnapshot(
  file: string,
  outDir: string,
  options: { dryRun?: boolean } = {},
): Promise<RunResult> {
  const result = await parseFile(file);
  if (result.errorCount > 0) {
    printDiagnostics(result);
    process.exit(1);
  }
  const loom = enrichLoomModel(lowerModel(result.model));
  const loomDiags = validateLoomModel(loom);
  const loomErrors = loomDiags.filter((d) => d.severity === "error");
  if (loomErrors.length > 0) {
    for (const d of loomDiags) console.error(`${d.source} ${d.severity}: ${d.message}`);
    process.exit(1);
  }

  const commit = gitCommitHash();
  if (commit) process.env.LOOM_COMMIT_HASH = commit;
  const files = captureSnapshots(loom);
  if (files.size === 0) {
    console.log(`No written \`provenanced\` field found in ${file}; nothing to capture.`);
    return { hadError: false, written: 0 };
  }

  let written = 0;
  for (const [relPath, content] of files) {
    if (options.dryRun) {
      console.log(
        `  write  ${relPath}  (${(Buffer.byteLength(content, "utf8") / 1024).toFixed(1)} KB)`,
      );
      written++;
      continue;
    }
    const full = path.join(outDir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
    written++;
  }
  console.log(
    `${options.dryRun ? "Would capture" : "Captured"} ${written} snapshot file(s) in ${path.join(outDir, ".loom/snapshots")}`,
  );
  return { hadError: false, written };
}

/** True iff the file at `absPath` exists and its bytes match `content`
 * exactly.  Used to skip writes that would produce identical output. */
function fileContentMatches(absPath: string, content: string): boolean {
  if (!fs.existsSync(absPath)) return false;
  try {
    const existing = fs.readFileSync(absPath, "utf8");
    return existing === content;
  } catch {
    return false;
  }
}

interface VerifyOptions {
  results: string;
  out?: string;
  requireAll?: boolean;
  min?: string;
  json?: boolean;
}

/** `ddd verify` — join a test-results file onto the requirements graph,
 *  emit the verification artifacts, and gate the exit code. */
async function runVerify(file: string, options: VerifyOptions): Promise<void> {
  const result = await parseFile(file);
  if (result.errorCount > 0) {
    printDiagnostics(result);
    process.exit(2);
  }
  const loom = enrichLoomModel(lowerModel(result.model));
  const loomErrors = validateLoomModel(loom).filter((d) => d.severity === "error");
  if (loomErrors.length > 0) {
    for (const d of loomErrors) console.error(`${d.source} error: ${d.message}`);
    process.exit(2);
  }
  if (loom.requirements.length === 0) {
    console.error(`No \`requirement\` declarations in ${file} — nothing to verify.`);
    process.exit(2);
  }

  // Read + validate the results file.
  if (!fs.existsSync(options.results)) {
    console.error(`Results file not found: ${options.results}`);
    process.exit(2);
  }
  let outcomes: TestOutcome[];
  try {
    const parsed = JSON.parse(fs.readFileSync(options.results, "utf8")) as {
      results?: TestOutcome[];
    };
    if (!Array.isArray(parsed.results)) {
      throw new Error('expected a top-level "results" array');
    }
    outcomes = parsed.results;
  } catch (err) {
    console.error(
      `Could not parse results file: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(2);
  }

  const verification = computeVerification(
    loom.traceability!,
    loom.requirements.map((r) => r.id),
    outcomes,
  );

  // Emit artifacts.
  const outDir = path.join(path.resolve(options.out ?? path.dirname(file)), ".loom");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "verification.json"), renderVerificationJson(verification));
  fs.writeFileSync(path.join(outDir, "verification.md"), renderVerificationMd(loom, verification));
  fs.writeFileSync(path.join(outDir, "verification.mmd"), renderVerdictGraph(loom, verification));

  const s = verification.summary;
  console.log(
    `Verified ${s.verified}/${s.total} requirements ` +
      `(${s.failing} failing, ${s.unverified} unverified, ${s.untested} untested).`,
  );
  if (options.json) console.log(renderVerificationJson(verification));

  // Gate.
  let failed = s.failing > 0;
  let reason = failed ? `${s.failing} requirement(s) failing` : "";
  if (options.requireAll && s.verified < s.total) {
    failed = true;
    reason = `${s.total - s.verified} requirement(s) not verified (--require-all)`;
  }
  if (options.min !== undefined) {
    const minPct = Number(options.min);
    const actual = s.total === 0 ? 100 : (s.verified / s.total) * 100;
    if (actual < minPct) {
      failed = true;
      reason = `verified ${actual.toFixed(0)}% < --min ${minPct}%`;
    }
  }
  if (failed) {
    console.error(`Verification gate failed: ${reason}.`);
    process.exit(1);
  }
}

const program = new Command();
program.name("ddd").description("DDD DSL CLI").version("0.1.0");

program
  .command("parse <file>")
  .description("Parse and validate a .ddd file")
  .action(async (file: string) => {
    await runParse(file);
  });

const generate = program.command("generate").description("Generate code from a .ddd file");
generate
  .command("ts <file>")
  .description("Generate TypeScript (Hono + Drizzle)")
  .requiredOption("-o, --out <dir>", "output directory")
  .option("-w, --watch", "re-run on changes to <file>")
  .option("--dry-run", "list paths that would be written / skipped, write nothing")
  .option(
    "--trace",
    "emit trace-level domain instrumentation (value_computed, precondition_evaluated, …) — off by default; see docs/proposals/observability.md",
  )
  .action(
    async (
      file: string,
      options: { out: string; watch?: boolean; dryRun?: boolean; trace?: boolean },
    ) => {
      await runGenerate("ts", file, options.out, {
        dryRun: options.dryRun,
        emitTrace: !!options.trace,
      });
      if (options.watch)
        await watchAndRegenerate("ts", file, options.out, { emitTrace: !!options.trace });
    },
  );
generate
  .command("dotnet <file>")
  .description("Generate .NET (ASP.NET Core + EF Core + Mediator)")
  .requiredOption("-o, --out <dir>", "output directory")
  .option("-w, --watch", "re-run on changes to <file>")
  .option("--dry-run", "list paths that would be written / skipped, write nothing")
  .option(
    "--trace",
    "emit trace-level seam instrumentation (tx_begin/commit/rollback around SaveChangesAsync) — off by default; see docs/proposals/observability.md",
  )
  .action(
    async (
      file: string,
      options: { out: string; watch?: boolean; dryRun?: boolean; trace?: boolean },
    ) => {
      await runGenerate("dotnet", file, options.out, {
        dryRun: options.dryRun,
        emitTrace: !!options.trace,
      });
      if (options.watch)
        await watchAndRegenerate("dotnet", file, options.out, { emitTrace: !!options.trace });
    },
  );
generate
  .command("system <file>")
  .description(
    "Generate every deployable in the file's `system` blocks plus a docker-compose.yml at the output root.",
  )
  .requiredOption("-o, --out <dir>", "output directory")
  .option("-w, --watch", "re-run on changes to <file>")
  .option("--dry-run", "list paths that would be written / skipped, write nothing")
  .option(
    "--trace",
    "emit trace-level domain instrumentation (value_computed, precondition_evaluated, …) — off by default; see docs/proposals/observability.md",
  )
  .action(
    async (
      file: string,
      options: { out: string; watch?: boolean; dryRun?: boolean; trace?: boolean },
    ) => {
      await runGenerate("system", file, options.out, {
        dryRun: options.dryRun,
        emitTrace: !!options.trace,
      });
      if (options.watch)
        await watchAndRegenerate("system", file, options.out, { emitTrace: !!options.trace });
    },
  );

program
  .command("verify <file>")
  .description(
    "Join a test-results JSON onto the requirements graph, write .loom/verification.* and gate the exit code.",
  )
  .requiredOption("--results <file>", "JSON file: { version, results: [{ name, status, suite? }] }")
  .option("--out <dir>", "output directory for .loom/ artifacts (default: the .ddd file's dir)")
  .option("--require-all", "fail unless every requirement is VERIFIED")
  .option("--min <pct>", "fail if the verified percentage is below <pct>")
  .option("--json", "also print verification.json to stdout")
  .action(async (file: string, options: VerifyOptions) => {
    await runVerify(file, options);
  });

program
  .command("snapshot <file>")
  .description(
    "Capture provenance rule snapshots for every written `provenanced` field — one immutable timestamped+GUID file per system under <out>/.loom/snapshots/. Run as an explicit prebuild step when rules change.",
  )
  .requiredOption("-o, --out <dir>", "output directory")
  .option("--dry-run", "list snapshot files that would be captured, write nothing")
  .action(async (file: string, options: { out: string; dryRun?: boolean }) => {
    await runSnapshot(file, options.out, { dryRun: options.dryRun });
  });

async function watchAndRegenerate(
  target: GenerateTarget,
  file: string,
  outDir: string,
  options: { emitTrace?: boolean } = {},
) {
  console.log(`Watching ${file} for changes…`);
  let timer: NodeJS.Timeout | null = null;
  let inFlight = false;
  let pending = false;
  const regen = async () => {
    if (inFlight) {
      // Coalesce: a save while a regen is running schedules at most
      // one follow-up.  Avoids unbounded queueing if the user
      // mashes Cmd+S during a slow regen.
      pending = true;
      return;
    }
    inFlight = true;
    try {
      await runGenerate(target, file, outDir, {
        continueOnError: true,
        emitTrace: options.emitTrace,
      });
    } catch (err) {
      // Defensive — runGenerate is supposed to capture its own
      // errors when continueOnError is set, but a renderer throwing
      // shouldn't kill the watch loop.
      console.error(err);
    } finally {
      inFlight = false;
      if (pending) {
        pending = false;
        await regen();
      }
    }
  };
  fs.watch(file, () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(regen, 100);
  });
  // Keep the process alive
  await new Promise(() => {});
}

// Install the fs-backed `discoverBackends()` source before any
// platform resolution.  Composes the in-tree default with whatever
// `@loom/*` backend packages are installed in the project's
// `node_modules`.  Today this is a no-op for emitted output because
// the fs source returns the same surface instances as the in-tree
// default; once the workspace package becomes the true source of
// code, this call becomes load-bearing.  Errors during fs walk
// (missing `node_modules`, permission, malformed manifest) are
// non-fatal — the function returns whatever it could read, and the
// composition falls back to the in-tree set.
await installFsBackendSource(process.cwd()).catch((err) => {
  // Don't take down the CLI for a discovery hiccup; just leave the
  // in-tree default active.
  console.warn(
    `loom: fs backend discovery skipped (${
      err instanceof Error ? err.message : String(err)
    }); using in-tree default.`,
  );
});

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});

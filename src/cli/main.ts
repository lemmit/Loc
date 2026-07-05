import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { Command } from "commander";
import ignore from "ignore";
import { URI } from "langium";
import { NodeFileSystem } from "langium/node";
import { generate as generateModel, LOOM_VERSION, validate } from "../api/index.js";
import { generateDotnet } from "../generator/dotnet/index.js";
import { enrichLoomModel } from "../ir/enrich/enrichments.js";
import { lowerModel, lowerProject } from "../ir/lower/lower.js";
import type { EnrichedLoomModel, TestOutcome } from "../ir/types/loom-ir.js";
import { validateLoomModel } from "../ir/validate/validate.js";
import { createDddServices } from "../language/ddd-module.js";
import type { Model } from "../language/generated/ast.js";
import { applyPatches, type ModelPatch } from "../language/model-patch.js";
import { loadProject } from "../language/project-loader.js";
import { installFsBackendSource } from "../platform/fs-discovery.js";
import { generateTypeScript } from "../platform/hono/v4/emit.js";
// Legacy single-context `generate ts` targets the default Hono
// backend; the CLI (an entrypoint) supplies that package's pins to
// the version-agnostic shared emitter.
import { BACKEND_PINS as HONO_V4_PINS } from "../platform/hono/v4/pins.js";
import { generateSystemsFromLoom } from "../system/index.js";
import { captureSnapshots } from "../system/loomsnap.js";
import { MigrationDestructiveError } from "../system/migrations-builder.js";
import { fsSnapshotStore, SnapshotReadError } from "../system/snapshot.js";
import {
  renderVerdictGraph,
  renderVerificationJson,
  renderVerificationMd,
} from "../verify/render.js";
import { computeVerification } from "../verify/verification.js";
import {
  DESIGN_PACKS,
  type DesignPack,
  renderLoomignore,
  renderReadme,
  renderStarter,
  STARTER_PLATFORMS,
  STARTER_TEMPLATES,
  type StarterPlatform,
  type StarterTemplate,
} from "./new-templates.js";
import { escapesOutDir } from "./output-containment.js";

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
  /** Enriched LoomModel, merged from every reachable document and run
   *  through `enrichLoomModel`.  Branded `EnrichedLoomModel` so the
   *  downstream pipeline (validator, system orchestrator, generators)
   *  type-rejects an un-enriched IR at the call site. */
  loom: EnrichedLoomModel;
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
  // `lowerProject` composes the whole import graph as one project — the
  // lone `system { }` block plus top-level `subdomain` / `context`
  // declarations from any file fold into a single system (see
  // docs/proposals/implicit-system-composition.md).
  const merged = lowerProject(all.map((doc) => doc.parseResult.value as Model));
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
  // AST is clean → surface the advisory index-suggestion lint (uniqueness-and-
  // indexes.md §11) in its own footer.  It rides the normal `validateLoomModel`
  // channel — we just filter the WARNING-severity `loom.index-suggestion`
  // diagnostics out of it here; they never fail the parse.  Defensive: a throw
  // in lower/enrich/validate is swallowed (the AST result already printed).
  try {
    const hints = validateLoomModel(enrichLoomModel(lowerModel(result.model))).filter(
      (d) => d.code === "loom.index-suggestion",
    );
    if (hints.length > 0) {
      console.error(`\nSuggestions (${hints.length}):`);
      for (const d of hints) console.error(`  ${d.source}: ${d.message}`);
    }
  } catch {
    // IR lowering can throw on shapes the AST validator doesn't gate.
  }
  console.log(`OK: ${file}`);
}

/**
 * `ddd patch <file> --patches <json>` — apply node-addressed model patches
 * (docs/proposals/ai-authoring-loop.md §4).  Default output is the patched
 * source on stdout (so it composes: `ddd patch m.ddd --patches p.json > m2.ddd`);
 * `--json` emits the structured PatchResult.  Exits 1 if any patch fails.
 */
async function runPatch(file: string, patchesFile: string, options: { json?: boolean }) {
  const absolute = path.resolve(file);
  if (!fs.existsSync(absolute)) {
    throw new Error(`File not found: ${absolute}`);
  }
  const source = fs.readFileSync(absolute, "utf8");
  const raw =
    patchesFile === "-"
      ? fs.readFileSync(0, "utf8")
      : fs.readFileSync(path.resolve(patchesFile), "utf8");
  const parsed = JSON.parse(raw) as ModelPatch[] | { patches: ModelPatch[] };
  const patches = Array.isArray(parsed) ? parsed : parsed.patches;

  const result = await applyPatches(source, patches);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.ok) {
    process.stdout.write(result.text);
  } else {
    for (const e of result.errors) {
      console.error(`patch error [${e.patch.op} ${e.patch.target}]: ${e.message}`);
    }
  }
  if (!result.ok) process.exit(1);
}

/** Read a `.ddd` file, or throw a clear error.  The structured-JSON verbs
 *  operate on a single in-memory source (the toolkit parses it browser-safe);
 *  multi-file `import` resolution stays on the fs-based `generate`/`parse`
 *  paths. */
function readSource(file: string): { absolute: string; source: string } {
  const absolute = path.resolve(file);
  if (!fs.existsSync(absolute)) {
    throw new Error(`File not found: ${absolute}`);
  }
  return { absolute, source: fs.readFileSync(absolute, "utf8") };
}

/**
 * `ddd parse --json` — the structured-diagnostics contract
 * (docs/proposals/ai-diagnostics-contract.md).  Thin wrapper over the toolkit
 * `validate()`: prints the `ValidateReport` to stdout, exits 1 when not `ok`.
 */
async function runParseJson(file: string): Promise<void> {
  const { absolute, source } = readSource(file);
  const report = await validate(source, { path: absolute });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exit(1);
}

/**
 * `ddd generate system --json` — the GenerateReport contract (§4).  Thin
 * wrapper over the toolkit `generate()`: validates and reports the deployable
 * manifest as JSON.  It does not write a project tree — run `generate system
 * -o <dir>` (without `--json`) to emit files.
 */
async function runGenerateJson(file: string): Promise<void> {
  const { absolute, source } = readSource(file);
  const report = await generateModel(source, { path: absolute });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exit(1);
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
  /** `--k8s` switch — when true, `generate system` additionally emits a Helm
   * chart (`helm/`) and the raw manifests it renders to (`k8s/`) alongside
   * `docker-compose.yml`.  See docs/kubernetes.md. */
  emitKubernetes?: boolean;
  /** `--allow-destructive` switch — permit destructive delta migrations
   * (column/table drops, NOT-NULL adds without a default on an existing
   * table).  Off by default: a destructive delta aborts the run with a
   * `loom.migration-destructive` error.  See docs/migrations.md. */
  allowDestructive?: boolean;
  /** `--sourcemap` switch — when true, `generate system` additionally emits
   * `.loom/sourcemap.json` mapping generated file regions back to `.ddd`
   * spans / macro-call sites.  Off by default (byte-identical output).
   * System target only — the legacy single-project `generate ts` /
   * `generate dotnet` paths don't accept this flag.
   * See docs/plans/source-map-debug-kickoff.md. */
  sourcemap?: boolean;
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
  // `generate ts` / `generate dotnet` stay on the single-file path
  // and re-lower internally through `generateTypeScript` /
  // `generateDotnet` (each of which calls `enrichLoomModel(lowerModel(model))`).
  let loom: EnrichedLoomModel;
  let model: Model | undefined;
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
    model = result.model;
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
  // Directory creation is deferred to the write loop below (and guarded by
  // `!options.dryRun`) so a `--dry-run` touches nothing on disk — not even
  // `mkdir`-ing the output dir.

  let files: Map<string, string>;
  if (target === "system") {
    // Diff each subdomain's current schema against the snapshot the
    // LAST regen wrote into `.loom/snapshots/` (under `outDir`).
    // Fresh output dirs ⇒ `fsSnapshotStore.read` returns null ⇒ initial
    // migration; existing snapshots ⇒ delta migration when the source
    // moves.  See `src/system/migrations-builder.ts` for the diff
    // builder + `docs/generators.md` § Migrations for the pipeline.
    try {
      files = generateSystemsFromLoom(loom, {
        emitTrace: options.emitTrace,
        emitKubernetes: options.emitKubernetes,
        snapshots: fsSnapshotStore(outDir),
        allowDestructive: options.allowDestructive,
        sourcemap: options.sourcemap,
      }).files;
    } catch (err) {
      // A corrupted/truncated migration snapshot, or a destructive delta
      // without --allow-destructive, is a recoverable operator problem, not
      // a compiler crash — report it as a clean CLI failure (with the
      // recovery hint from the error message), matching how the other fatal
      // generation errors above surface.  Re-throw anything else for the
      // top-level handler to print.
      if (err instanceof SnapshotReadError || err instanceof MigrationDestructiveError) {
        console.error(`${file}: ${err.message}`);
        if (!options.continueOnError) process.exit(1);
        return { hadError: true };
      }
      throw err;
    }
    if (files.size === 0) {
      console.error(
        `No \`system\` block declared in ${file}.  Use \`generate ts\` or \`generate dotnet\` for legacy single-deployable sources.`,
      );
      if (!options.continueOnError) process.exit(1);
      return { hadError: true };
    }
  } else if (target === "ts") {
    files = generateTypeScript(model!, HONO_V4_PINS, { emitTrace: options.emitTrace });
  } else {
    files = generateDotnet(model!, { emitTrace: options.emitTrace });
  }

  if (!files.has("LICENSE")) {
    files.set("LICENSE", GENERATED_OUTPUT_LICENSE);
  }

  const ig = loadLoomIgnore(outDir);
  let written = 0;
  let unchanged = 0;
  let skippedByIgnore = 0;
  const resolvedOut = path.resolve(outDir);
  const sortedPaths = [...files.keys()].sort();
  for (const relPath of sortedPaths) {
    const content = files.get(relPath)!;
    // Output-path containment: every generated key must resolve to a path
    // strictly inside the out dir.  An absolute key or one that climbs out
    // via `..` would let a generator (in particular an untrusted, out-of-
    // tree backend/design pack) write anywhere on disk — reject it loudly
    // rather than honouring the escape.  Checked for dry-run and real runs
    // alike, before any filesystem touch.
    if (escapesOutDir(resolvedOut, relPath)) {
      console.error(`Refusing to write '${relPath}': path escapes the output directory ${outDir}.`);
      if (!options.continueOnError) process.exit(1);
      return { hadError: true };
    }
    const normalised = relPath.split(path.sep).join("/");
    const ignored = ig.ignores(normalised);
    const full = path.join(outDir, relPath);
    // Classify exactly as the real writer does so a dry run's tallies
    // match the run it previews: an up-to-date file is `unchanged`, not
    // a would-write.  `fileContentMatches` returns false for a missing
    // file (fresh output dir ⇒ everything is a write).
    const wouldChange = !ignored && !fileContentMatches(full, content);
    if (options.dryRun) {
      const sizeKb = (Buffer.byteLength(content, "utf8") / 1024).toFixed(1);
      const status = ignored
        ? "  skip (.loomignore)"
        : wouldChange
          ? "  write              "
          : "  unchanged          ";
      console.log(`${status}  ${relPath}  (${sizeKb} KB)`);
      if (ignored) skippedByIgnore++;
      else if (wouldChange) written++;
      else unchanged++;
      continue;
    }
    if (ignored) {
      skippedByIgnore++;
      continue;
    }
    // Incremental write: only touch files whose content actually
    // changed.  Downstream watchers (Vite, `dotnet watch`) react to
    // mtimes, so skipping unchanged writes turns a regen of an N-file
    // project where the user touched one aggregate into a precise
    // reload signal instead of a full project bounce.
    if (!wouldChange) {
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

interface NewOptions {
  platform?: string;
  template?: string;
  design?: string;
  out?: string;
  force?: boolean;
}

/**
 * `ddd new <name>` — scaffold a small, provably-valid starter project
 * (docs/proposals/quickstart-and-day-one-batteries.md §3.1).  Picks the
 * backend platform (`--platform`) and frontend (`--design`: a React pack, or
 * `coreComponents` for a Phoenix LiveView fullstack), renders a `main.ddd` +
 * `README.md` + `.loomignore`, validates the rendered model in-memory, and
 * only then writes.  Validate-only — the README points the author at
 * `ddd generate system` to emit the runnable tree.
 */
async function runNew(name: string, options: NewOptions): Promise<void> {
  // Clean user-facing failure — a flag mistake is guidance, not a crash, so
  // print the message without a stack trace (the top-level catch prints stacks).
  const fail = (msg: string): never => {
    console.error(`ddd new: ${msg}`);
    process.exit(1);
  };

  // --- resolve + validate flags (fail fast, write nothing) ---
  const platformDefaulted = options.platform === undefined;
  const platform = (options.platform ?? "node") as StarterPlatform;
  if (!STARTER_PLATFORMS.includes(platform)) {
    fail(`unknown --platform "${options.platform}". Valid: ${STARTER_PLATFORMS.join(" | ")}.`);
  }
  const template = (options.template ?? "crud") as StarterTemplate;
  if (!STARTER_TEMPLATES.includes(template)) {
    fail(`unknown --template "${options.template}". Valid: ${STARTER_TEMPLATES.join(" | ")}.`);
  }
  // Frontend: a React pack for node/dotnet (default mantine); a Phoenix
  // LiveView (coreComponents) is the default for elixir.
  const design = (options.design ??
    (platform === "elixir" ? "coreComponents" : "mantine")) as DesignPack;
  if (!DESIGN_PACKS.includes(design)) {
    fail(`unknown --design "${options.design}". Valid: ${DESIGN_PACKS.join(" | ")}.`);
  }
  if (design === "coreComponents" && platform !== "elixir") {
    fail("--design coreComponents requires --platform elixir (it is the Phoenix LiveView UI).");
  }

  const outDir = path.resolve(options.out ?? name);
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length > 0 && !options.force) {
    fail(`directory not empty: ${outDir} (use --force to scaffold into it anyway).`);
  }

  // --- render + soundness check (guards against template drift) ---
  const source = renderStarter({ name, template, platform, design });
  const report = await validate(source, { path: "main.ddd" });
  if (!report.ok) {
    console.error("ddd new: the generated starter failed validation (please report this):");
    for (const d of report.diagnostics) {
      if (d.severity === "error") console.error(`  ${d.message}`);
    }
    process.exit(1);
  }

  // --- write the three starter files ---
  const files = new Map<string, string>([
    ["main.ddd", source],
    ["README.md", renderReadme({ name, platform, design })],
    [".loomignore", renderLoomignore()],
  ]);
  for (const [rel, content] of files) {
    const full = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
  }

  // --- report + the platform hint ---
  const where = options.out ?? name;
  console.log(
    `Scaffolded ${files.size} file(s) in ${outDir} (platform: ${platform}, template: ${template}).`,
  );
  if (platformDefaulted) {
    console.log(
      "  platform: node (default) — also: dotnet, elixir, java, python (re-run with --platform <p>)",
    );
  }
  console.log(`  next: cd ${where} && ddd generate system main.ddd -o . && docker compose up`);
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
  // Validate `--min` up front: `Number("90%")` / `Number("abc")` is NaN and
  // `actual < NaN` is always false, so a typo'd threshold would silently pass
  // the gate.  Reject non-numeric or out-of-[0,100] values before any work.
  let minPct: number | undefined;
  if (options.min !== undefined) {
    minPct = Number(options.min);
    if (!Number.isFinite(minPct) || minPct < 0 || minPct > 100) {
      console.error(
        `Invalid --min "${options.min}": expected a number between 0 and 100 (e.g. --min 90).`,
      );
      process.exit(2);
    }
  }

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
  if (minPct !== undefined) {
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
program.name("ddd").description("DDD DSL CLI").version(LOOM_VERSION);

program
  .command("parse <file>")
  .description("Parse and validate a .ddd file")
  .option(
    "--json",
    "emit structured diagnostics + outline as JSON (also runs IR validation); see docs/proposals/ai-diagnostics-contract.md",
  )
  .action(async (file: string, options: { json?: boolean }) => {
    if (options.json) await runParseJson(file);
    else await runParse(file);
  });

program
  .command("patch <file>")
  .description(
    "Apply node-addressed model patches (JSON) to a .ddd file; prints the patched source, or --json for the structured PatchResult. See docs/proposals/ai-authoring-loop.md.",
  )
  .requiredOption(
    "--patches <file>",
    "JSON file (or '-' for stdin): a ModelPatch[] or { patches: [...] }",
  )
  .option("--json", "emit the structured PatchResult instead of the patched source")
  .action(async (file: string, options: { patches: string; json?: boolean }) => {
    await runPatch(file, options.patches, options);
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
  .option("-o, --out <dir>", "output directory (required unless --json)")
  .option("-w, --watch", "re-run on changes to <file>")
  .option("--dry-run", "list paths that would be written / skipped, write nothing")
  .option(
    "--json",
    "validate and print the deployable manifest as JSON (GenerateReport); writes no files. See docs/proposals/ai-diagnostics-contract.md.",
  )
  .option(
    "--trace",
    "emit trace-level domain instrumentation (value_computed, precondition_evaluated, …) — off by default; see docs/proposals/observability.md",
  )
  .option(
    "--k8s",
    "also emit a Helm chart (helm/) and raw manifests (k8s/) alongside docker-compose.yml; see docs/kubernetes.md",
  )
  .option(
    "--allow-destructive",
    "permit destructive delta migrations (column/table drops, NOT-NULL adds without a default on an existing table); off by default a destructive delta aborts. See docs/migrations.md.",
  )
  .option(
    "--sourcemap",
    "emit .loom/sourcemap.json mapping generated code back to .ddd spans; off by default. See docs/plans/source-map-debug-kickoff.md.",
  )
  .action(
    async (
      file: string,
      options: {
        out?: string;
        watch?: boolean;
        dryRun?: boolean;
        json?: boolean;
        trace?: boolean;
        k8s?: boolean;
        allowDestructive?: boolean;
        sourcemap?: boolean;
      },
    ) => {
      if (options.json) {
        await runGenerateJson(file);
        return;
      }
      if (!options.out) {
        console.error("error: required option '-o, --out <dir>' not specified");
        process.exit(1);
      }
      const runOpts = {
        dryRun: options.dryRun,
        emitTrace: !!options.trace,
        emitKubernetes: !!options.k8s,
        allowDestructive: !!options.allowDestructive,
        sourcemap: !!options.sourcemap,
      };
      await runGenerate("system", file, options.out, runOpts);
      if (options.watch) {
        await watchAndRegenerate("system", file, options.out, runOpts);
      }
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

program
  .command("new <name>")
  .description(
    "Scaffold a starter .ddd project (main.ddd + README + .loomignore), validated before writing. Pick the backend with --platform and the frontend with --design.",
  )
  .option(
    "--platform <platform>",
    "backend: node | dotnet | elixir | java | python (default: node)",
  )
  .option("--template <template>", "starter model: blank | crud (default: crud)")
  .option(
    "--design <pack>",
    "frontend: mantine | shadcn | mui | chakra (React), shadcnSvelte | flowbite (Svelte), or coreComponents (Phoenix LiveView)",
  )
  .option("-o, --out <dir>", "output directory (default: ./<name>)")
  .option("--force", "scaffold into an existing, non-empty directory")
  .action(async (name: string, options: NewOptions) => {
    await runNew(name, options);
  });

async function watchAndRegenerate(
  target: GenerateTarget,
  file: string,
  outDir: string,
  extraOptions: Partial<RunOptions> = {},
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
      await runGenerate(target, file, outDir, { continueOnError: true, ...extraOptions });
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

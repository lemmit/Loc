import { Command } from "commander";
import ignore from "ignore";
import { NodeFileSystem } from "langium/node";
import { URI } from "langium";
import * as fs from "node:fs";
import * as path from "node:path";
import { createDddServices } from "../language/ddd-module.js";
import type { Model } from "../language/generated/ast.js";
import { generateTypeScript } from "../platform/hono/v4/emit.js";
// Legacy single-context `generate ts` targets the default Hono
// backend; the CLI (an entrypoint) supplies that package's pins to
// the version-agnostic shared emitter (B2.1).
import { BACKEND_PINS as HONO_V4_PINS } from "../platform/hono/v4/pins.js";
import { generateDotnet } from "../generator/dotnet/index.js";
import { generateSystems } from "../system/index.js";
import { lowerModel } from "../ir/lower.js";
import { enrichLoomModel } from "../ir/enrichments.js";
import { validateLoomModel } from "../ir/validate.js";

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
  const result = await parseFile(file);
  if (result.errorCount > 0) {
    printDiagnostics(result);
    if (!options.continueOnError) process.exit(1);
    return { hadError: true };
  }
  // Loom-IR-level validation: catches `api.<unknown>.<verb>` and
  // `ui.<unknown>.<verb>` references in `test e2e` bodies before
  // generators are called.  Everything caught here used to throw
  // mid-generation with a slightly less helpful trace.
  const loom = enrichLoomModel(lowerModel(result.model));
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
    files = generateSystems(result.model).files;
    if (files.size === 0) {
      console.error(
        `No \`system\` block declared in ${file}.  Use \`generate ts\` or \`generate dotnet\` for legacy single-deployable sources.`,
      );
      if (!options.continueOnError) process.exit(1);
      return { hadError: true };
    }
  } else if (target === "ts") {
    files = generateTypeScript(result.model, HONO_V4_PINS);
  } else {
    files = generateDotnet(result.model);
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
  .action(
    async (file: string, options: { out: string; watch?: boolean; dryRun?: boolean }) => {
      await runGenerate("ts", file, options.out, { dryRun: options.dryRun });
      if (options.watch) await watchAndRegenerate("ts", file, options.out);
    },
  );
generate
  .command("dotnet <file>")
  .description("Generate .NET (ASP.NET Core + EF Core + Mediator)")
  .requiredOption("-o, --out <dir>", "output directory")
  .option("-w, --watch", "re-run on changes to <file>")
  .option("--dry-run", "list paths that would be written / skipped, write nothing")
  .action(
    async (file: string, options: { out: string; watch?: boolean; dryRun?: boolean }) => {
      await runGenerate("dotnet", file, options.out, { dryRun: options.dryRun });
      if (options.watch) await watchAndRegenerate("dotnet", file, options.out);
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
  .action(
    async (file: string, options: { out: string; watch?: boolean; dryRun?: boolean }) => {
      await runGenerate("system", file, options.out, { dryRun: options.dryRun });
      if (options.watch) await watchAndRegenerate("system", file, options.out);
    },
  );

async function watchAndRegenerate(target: GenerateTarget, file: string, outDir: string) {
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
      await runGenerate(target, file, outDir, { continueOnError: true });
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

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});

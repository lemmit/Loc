import { Command } from "commander";
import { NodeFileSystem } from "langium/node";
import { URI } from "langium";
import * as fs from "node:fs";
import * as path from "node:path";
import { createDddServices } from "../language/ddd-module.js";
import type { Model } from "../language/generated/ast.js";
import { generateTypeScript } from "../generator/typescript/index.js";
import { generateDotnet } from "../generator/dotnet/index.js";

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

async function runGenerate(target: "ts" | "dotnet", file: string, outDir: string) {
  const result = await parseFile(file);
  if (result.errorCount > 0) {
    printDiagnostics(result);
    process.exit(1);
  }
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const files =
    target === "ts" ? generateTypeScript(result.model) : generateDotnet(result.model);
  for (const [relPath, content] of files) {
    const full = path.join(outDir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
  }
  console.log(`Generated ${files.size} file(s) in ${outDir}`);
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
  .action(async (file: string, options: { out: string; watch?: boolean }) => {
    await runGenerate("ts", file, options.out);
    if (options.watch) await watchAndRegenerate("ts", file, options.out);
  });
generate
  .command("dotnet <file>")
  .description("Generate .NET (ASP.NET Core + EF Core + Mediator)")
  .requiredOption("-o, --out <dir>", "output directory")
  .option("-w, --watch", "re-run on changes to <file>")
  .action(async (file: string, options: { out: string; watch?: boolean }) => {
    await runGenerate("dotnet", file, options.out);
    if (options.watch) await watchAndRegenerate("dotnet", file, options.out);
  });

async function watchAndRegenerate(target: "ts" | "dotnet", file: string, outDir: string) {
  console.log(`Watching ${file} for changes…`);
  let timer: NodeJS.Timeout | null = null;
  fs.watch(file, () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        await runGenerate(target, file, outDir);
      } catch (err) {
        console.error(err);
      }
    }, 100);
  });
  // Keep the process alive
  await new Promise(() => {});
}

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});

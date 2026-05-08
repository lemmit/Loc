// One-shot fixture capture for the page-metamodel migration.
// Reads examples/acme.ddd through the existing generator pipeline and
// writes every emitted file under test/fixtures/v22-output/.  The
// page-metamodel implementation will diff its output against this
// fixture (Slice 5 acceptance test) to enforce byte equivalence in
// the bulk-scaffold case.
//
// Run:  node scripts/capture-v22-fixture.mjs
import path from "node:path";
import fs from "node:fs";
import { URI } from "vscode-uri";
import { NodeFileSystem } from "langium/node";
import { createDddServices } from "../out/language/ddd-module.js";
import { generateSystems } from "../out/system/index.js";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const inputPath = path.join(repoRoot, "examples/acme.ddd");
const outRoot = path.join(repoRoot, "test/fixtures/v22-output");

const services = createDddServices(NodeFileSystem).Ddd;
const docs = services.shared.workspace.LangiumDocuments;
const builder = services.shared.workspace.DocumentBuilder;
const doc = await docs.getOrCreateDocument(URI.file(inputPath));
await builder.build([doc], { validation: true });

const diagnostics = doc.diagnostics ?? [];
const errors = diagnostics.filter((d) => d.severity === 1);
if (errors.length > 0) {
  console.error("Validation errors in", inputPath);
  for (const e of errors) console.error(" ", e.message);
  process.exit(1);
}

const model = doc.parseResult.value;
const { files } = generateSystems(model);

if (fs.existsSync(outRoot)) fs.rmSync(outRoot, { recursive: true });
fs.mkdirSync(outRoot, { recursive: true });

const sortedKeys = [...files.keys()].sort();
for (const key of sortedKeys) {
  const dest = path.join(outRoot, key);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, files.get(key), "utf8");
}

console.log(`Wrote ${sortedKeys.length} files under ${path.relative(repoRoot, outRoot)}`);

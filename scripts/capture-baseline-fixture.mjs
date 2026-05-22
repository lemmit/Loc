// One-shot baseline-fixture capture for the page-metamodel migration.
// Reads examples/acme.ddd through the existing generator pipeline and
// writes every emitted file under test/fixtures/baseline-output/.
// The page-metamodel implementation will diff its output against this
// fixture (Slice 5 acceptance test) to enforce byte equivalence in
// the bulk-scaffold case — i.e. when the only `ui {}` member is
// `scaffold modules: <every module>` and there is no override or
// explicit `menu`, the new pages-emitter must produce the same files
// the legacy per-aggregate generator emits today.
//
// Re-run whenever main moves forward (the legacy generator's output
// drifts; the fixture is only useful as long as it matches).
//
// Run:  node scripts/capture-baseline-fixture.mjs

import fs from "node:fs";
import path from "node:path";
import { NodeFileSystem } from "langium/node";
import { URI } from "vscode-uri";
import { createDddServices } from "../out/language/ddd-module.js";
import { generateSystems } from "../out/system/index.js";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const inputPath = path.join(repoRoot, "examples/acme.ddd");
const outRoot = path.join(repoRoot, "test/fixtures/baseline-output");

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

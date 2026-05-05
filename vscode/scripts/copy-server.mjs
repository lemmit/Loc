// Build-time script: copy the parent project's compiled `out/` tree
// (the LSP server + CLI) into ./server/ so the extension can resolve
// it via `context.asAbsolutePath("server/main.js")` at runtime.  Also
// copies the TextMate grammar from ../syntaxes/ into ./syntaxes/.
//
// Run after `tsc -p .` in the extension directory.

import { cp, mkdir, rm, writeFile, copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const extRoot = path.resolve(here, "..");

const sourceOut = path.join(repoRoot, "out");
const targetServer = path.join(extRoot, "server");

const sourceGrammar = path.join(repoRoot, "syntaxes", "ddd.tmLanguage.json");
const targetGrammar = path.join(extRoot, "syntaxes", "ddd.tmLanguage.json");

await rm(targetServer, { recursive: true, force: true });
await mkdir(targetServer, { recursive: true });

console.log(`copying ${sourceOut} → ${targetServer}`);
await cp(sourceOut, targetServer, { recursive: true });

// Drop a tiny CLI shim that mirrors bin/cli.js but with the
// extension-bundled relative path.  Keeps the user-facing
// invocation `node server/cli.js generate …` consistent.
const cliShim = `#!/usr/bin/env node
import("./cli/main.js").catch((err) => {
  console.error(err);
  process.exit(1);
});
`;
console.log(`writing ${path.join(targetServer, "cli.js")}`);
await writeFile(path.join(targetServer, "cli.js"), cliShim, "utf8");

// The extension's outer package.json is CommonJS (default) so VS Code
// can require() the extension module.  The bundled server tree is the
// parent project's tsc output, which is ESM.  Drop a minimal
// package.json under server/ pinning `type: module` so node treats the
// imports correctly without the perf-degrading auto-detection warning.
console.log(`writing ${path.join(targetServer, "package.json")}`);
await writeFile(
  path.join(targetServer, "package.json"),
  JSON.stringify({ name: "loom-server-bundle", private: true, type: "module" }, null, 2) + "\n",
  "utf8",
);

// Refresh the bundled grammar so a regenerated TextMate file is
// picked up without a manual copy step.
await mkdir(path.join(extRoot, "syntaxes"), { recursive: true });
console.log(`copying ${sourceGrammar} → ${targetGrammar}`);
await copyFile(sourceGrammar, targetGrammar);

console.log("done.");

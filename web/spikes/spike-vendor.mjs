// THROWAWAY SPIKE (C2 step 1) — verify the prebuilt Mantine vendor:
// (a) the importmap covers every vendor specifier the generated app
//     imports (the gate that prevents iframe "failed to resolve"),
// (b) the vendor bundle is real (react source present, css non-empty).

import { NodeFileSystem } from "langium/node";
import { URI } from "langium";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDddServices } from "../../out/language/ddd-module.js";
import { generateSystems } from "../../out/system/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const vdir = path.resolve(here, "../public/vendor/mantine");
const importmap = JSON.parse(readFileSync(path.join(vdir, "importmap.json"), "utf8")).imports;
log_keys(importmap);
function log_keys(m) { console.log("# importmap specs:", Object.keys(m).join(", ")); }

// Generate the mantine app, collect its bare (non-relative, non-@/,
// non-CSS) imports — these must all be in the importmap.
const text = readFileSync(path.resolve(here, "../src/examples/storybook-mantine.ddd"), "utf8");
const s = createDddServices(NodeFileSystem);
const d = s.shared.workspace.LangiumDocuments.createDocument(URI.parse("inmemory:///m.ddd"), text);
await s.shared.workspace.DocumentBuilder.build([d], { validation: true });
const fm = generateSystems(d.parseResult.value).files;
const slug = [...fm.keys()].find((p) => /\/src\/main\.tsx$/.test(p))?.split("/")[0];

const bare = new Set();
for (const [p, c] of fm) {
  // Only the FRONTEND deployable's source — that's what the react
  // bundle compiles (not the backend or config/tooling files).
  if (!p.startsWith(`${slug}/src/`)) continue;
  if (!/\.(tsx?|jsx?)$/.test(p)) continue;
  for (const m of c.matchAll(/from\s*["']([^"']+)["']/g)) {
    const spec = m[1];
    if (spec.startsWith(".") || spec.startsWith("@/") || spec.startsWith("/")) continue;
    if (spec.endsWith(".css")) continue;
    if (spec.startsWith("node:")) continue;
    const top = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
    bare.add(top);
  }
}

let ok = true;
const check = (label, cond) => { if (!cond) ok = false; console.log(`  ${cond ? "OK  " : "FAIL"} ${label}`); };

console.log("# app's top-level vendor imports:", [...bare].join(", "));
const missing = [...bare].filter((b) => !(b in importmap));
check(`importmap covers all ${bare.size} app vendor imports` + (missing.length ? ` (missing: ${missing.join(", ")})` : ""), missing.length === 0);

// With splitting, entries are thin re-exports; real code is in shared
// chunks.  Sum all vendor JS to confirm the bundle is substantial.
import { readdirSync, statSync } from "node:fs";
const totalJs = readdirSync(vdir)
  .filter((f) => f.endsWith(".js"))
  .reduce((n, f) => n + statSync(path.join(vdir, f)).size, 0);
check(`vendor JS bundle substantial (${(totalJs / 1024) | 0} KB)`, totalJs > 100_000);
const css = readFileSync(path.join(vdir, "vendor.css"), "utf8");
check("vendor.css non-empty", css.length > 5000);
check("importmap has react + react-dom/client + @mantine/core", !!importmap["react"] && !!importmap["react-dom/client"] && !!importmap["@mantine/core"]);

console.log("");
console.log(ok ? "PASS — prebuilt Mantine vendor + importmap cover the generated app." : "FAIL");
process.exit(ok ? 0 : 1);

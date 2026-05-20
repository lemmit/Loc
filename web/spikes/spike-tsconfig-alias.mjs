// THROWAWAY SPIKE — tsconfig `@/*` alias resolution in the npm VFS
// plugin (the shadcn bug: `vfs: bare "@/components/ui/button" not in
// installed node_modules`).  Network-free synthetic VFS.

import * as esbuild from "esbuild";
import { makeVfsNpmPlugin } from "../src/engine/npm/esbuild-vfs-plugin.ts";
import { harvestTsconfigPaths } from "../src/bundle/plugin.ts";

const files = new Map([
  [
    "/app/tsconfig.json",
    JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"] } } }),
  ],
  ["/app/src/components/ui/button.tsx", "export const Button = () => null;\n"],
  [
    "/app/src/main.tsx",
    'import { Button } from "@/components/ui/button";\nexport default Button;\n',
  ],
]);

const entry = "/app/src/main.tsx";
const aliases = harvestTsconfigPaths(files, entry);
console.log("harvested aliases:", JSON.stringify(aliases));

let ok = true;
let code = "";
try {
  const out = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    logLevel: "silent",
    write: false,
    outdir: "/",
    plugins: [makeVfsNpmPlugin(files, "/node_modules", false, aliases)],
  });
  code = out.outputFiles[0].text;
} catch (err) {
  ok = false;
  console.log("FAIL — bundle errored:", err.errors?.[0]?.text ?? String(err));
}

const resolved = ok && /Button/.test(code);
console.log(`  alias harvested: ${aliases.length === 1 ? "OK" : "FAIL"}`);
console.log(`  @/ import bundled (no bare-package error): ${resolved ? "OK" : "FAIL"}`);
console.log("");
console.log(
  ok && resolved
    ? "PASS — tsconfig @/* alias resolves to the real file in the VFS."
    : "FAIL — @/ alias not resolved.",
);
process.exit(ok && resolved ? 0 : 1);

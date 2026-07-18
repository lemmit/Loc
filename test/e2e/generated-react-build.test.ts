import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { reactBuildExamples as examples } from "./react-build-cases.js";

// ---------------------------------------------------------------------------
// Generator regression test for the React frontend: for each example
// .ddd × each design pack, run `generate system`, npm-install the
// emitted project, and `tsc --noEmit` it.  Catches generator drift
// that compiles the TS backend cleanly but breaks the generated TSX
// (missing imports, wrong prop types, JSX namespace issues, …) —
// the kind of thing that's invisible to the IR-level tests but
// blows up at user time.
//
// Matrix: 13 single-file examples × 8 packs.  Non-default-pack variants
// are produced by injecting `design: <pack>` into the deployable at
// test-run time, so the canonical example sources stay pack-neutral.
// Multi-file examples (those with `import "./…"`, e.g. erp/main.ddd,
// fulfillment-newest.ddd) are intentionally excluded — the harness
// copies a single .ddd to a temp dir, which breaks relative imports.
// Their parse/generate coverage lives in playground-feature-examples.
//
// Run modes:
//   1. Full sweep — `LOOM_REACT_BUILD=1 npx vitest run …` runs every
//      case sequentially in one Node process (~5min).  Used by
//      developers locally.
//   2. Single shard — `LOOM_REACT_BUILD_CASE=<ddd>:<pack>` filters to
//      exactly one case (implies the suite is enabled even without
//      LOOM_REACT_BUILD=1).  Used by CI to parallelise across a
//      GitHub Actions job matrix — every shard runs one case in its
//      own runner, wall time drops from ~5min to ~30s per case.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "bin", "cli.js");

const SHARD = process.env.LOOM_REACT_BUILD_CASE;
const ENABLED = process.env.LOOM_REACT_BUILD === "1" || SHARD !== undefined;

/** Inject `design: "<family>@<version>"` into the `deployable webApp
 *  { ... }` block of a `.ddd` source.  Handles both the multi-line
 *  acme syntax and the single-line playground syntax.  Idempotent and
 *  safe — if no webApp block matches, the input passes through
 *  unchanged.  When an existing `design:` slot is present (the
 *  storybook examples already declare one), the slot is rewritten in
 *  place rather than duplicated.
 *
 *  Writes the pinned `family@version`
 *  quoted form so each shard tests a specific pack version, not
 *  "whatever BUILTIN_PACK_LATEST resolves to today".  Pre-existing
 *  bareword slots and pinned slots both get rewritten in place. */
function injectDesign(src: string, qualified: string): string {
  // Existing slot — either bareword (`design: mantine`) or pinned
  // (`design: "mantine@v7"`).  Match both shapes and rewrite to the
  // quoted pinned form.
  const existing = /(\bdesign:\s*)(?:"[^"]*"|\w+)/;
  const replacement = `$1"${qualified}"`;
  if (existing.test(src)) {
    return src.replace(existing, replacement);
  }
  // Multi-line:  deployable webApp {\n  platform: react\n  …\n}
  const multiLine = /(deployable webApp \{)([^}]*?)\n(\s*)\}/;
  if (multiLine.test(src)) {
    return src.replace(multiLine, (_, head, body, indent) => {
      return `${head}${body}\n${indent}design: "${qualified}"\n${indent}}`;
    });
  }
  // Single-line:  deployable webApp { platform: react, targets: api, port: 3001 }
  const singleLine = /(deployable webApp \{[^}\n]+?)(\s*)\}/;
  return src.replace(singleLine, `$1, design: "${qualified}"$2}`);
}

/** Materialise stub impls for any frontend `function … extern from "<path>"`
 *  the generated project references. Loom emits the typed signature + a
 *  conformance shim (`src/lib/<name>.ts`) but never the impl module — that's
 *  user-owned by design (extern-function-hook-escape-hatch.md §3). A
 *  generated-only tree therefore has a dangling import, so we write the exact
 *  file a real user would (a conforming stub) before type-checking. Idempotent;
 *  a no-op for the (majority) examples with no frontend externs. */
function stubFrontendExterns(projectDir: string): void {
  const libDir = path.join(projectDir, "src", "lib");
  if (!fs.existsSync(libDir)) return;
  // Shim shape: `import { <name> as _impl } from "<relative-path>";`
  const importRe = /import\s*\{\s*(\w+)\s+as\s+_impl\s*\}\s*from\s*"([^"]+)"/;
  for (const ent of fs.readdirSync(libDir)) {
    if (!ent.endsWith(".ts")) continue;
    const shim = fs.readFileSync(path.join(libDir, ent), "utf-8");
    if (!shim.includes("AUTO-GENERATED shim")) continue;
    const m = importRe.exec(shim);
    if (!m) continue;
    const [, name, spec] = m;
    const target = `${path.resolve(libDir, spec)}.ts`;
    if (fs.existsSync(target)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // A zero-arg `any`-returning function is assignable to any generated
    // signature, so the shim's `const <name>: <Name>Fn = _impl` conformance
    // annotation still type-checks.
    fs.writeFileSync(
      target,
      `// Test stub for a user-owned extern impl (not part of codegen output).\n` +
        `export function ${name}(): any {\n` +
        `  throw new Error("extern test stub: ${name}");\n` +
        `}\n`,
    );
  }
}

interface PackSpec {
  family: "mantine" | "shadcn" | "mui" | "chakra";
  version: string;
}

/** The matrix of `family@version` shards the test sweeps.  Today it
 *  ships one version per family — the same set that existed before
 *  versioning, now explicitly pinned.  Later additions (mantine@v9,
 *  chakra@v3, …) append entries here; the matrix grows
 *  multiplicatively without other code edits. */
const PACKS: readonly PackSpec[] = [
  { family: "mantine", version: "v7" },
  { family: "mantine", version: "v9" },
  { family: "shadcn", version: "v3" },
  { family: "shadcn", version: "v4" },
  { family: "mui", version: "v5" },
  { family: "mui", version: "v7" },
  { family: "chakra", version: "v2" },
  { family: "chakra", version: "v3" },
];

function packId(p: PackSpec): string {
  return `${p.family}@${p.version}`;
}

interface Case {
  ddd: string;
  reactDir: string;
  /** Additional emitted React project dirs to type-check (not vite-build) in
   *  the same case — used to compile a SECOND web deployable (e.g. a scaffold
   *  UI) that the single `reactDir` gate would otherwise never touch.  Built
   *  once, on the first pack cell (see the loop guard below). */
  extraReactDirs?: readonly string[];
  pack: PackSpec;
}

const allCases: Case[] = examples.flatMap((e) => PACKS.map((pack) => ({ ...e, pack })));

/** Filter to the case named by
 *  `LOOM_REACT_BUILD_CASE=<ddd>:<family>@<version>`, or return every
 *  case when no filter is set.  Throws on a malformed shard spec so
 *  the CI matrix surfaces typos loudly instead of silently skipping
 *  a case. */
function selectCases(): Case[] {
  if (SHARD === undefined) return allCases;
  const [ddd, packStr] = SHARD.split(":");
  const match = allCases.find((c) => c.ddd === ddd && packId(c.pack) === packStr);
  if (!match) {
    throw new Error(
      `LOOM_REACT_BUILD_CASE="${SHARD}" did not match any case.  Available: ${allCases.map((c) => `${c.ddd}:${packId(c.pack)}`).join(", ")}`,
    );
  }
  return [match];
}

const cases = ENABLED ? selectCases() : [];

describe.skipIf(!ENABLED)(
  "generated React TSX compiles + bundles under strict tsc + vite build",
  () => {
    it.each(
      cases.map((c) => ({ ...c, packLabel: packId(c.pack) })),
    )("$ddd × $packLabel → $reactDir type-checks and bundles", ({
      ddd,
      reactDir,
      extraReactDirs,
      pack,
    }) => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-react-tsc-"));
      try {
        // Always materialise a mutated copy with `design: <pack>` set
        // — even for mantine, since some sources (storybook-shadcn,
        // …) declare a non-mantine pack as their canonical default
        // and we need to override it.  `injectDesign` rewrites an
        // existing slot in place rather than duplicating.
        const original = fs.readFileSync(path.join(repoRoot, ddd), "utf-8");
        const mutated = injectDesign(original, packId(pack));
        const dddPath = path.join(outDir, "_mutated.ddd");
        fs.writeFileSync(dddPath, mutated);
        execSync(`node ${cli} generate system ${dddPath} -o ${outDir}`, {
          stdio: "inherit",
          cwd: repoRoot,
        });
        const projectDir = path.join(outDir, reactDir);
        if (!fs.existsSync(projectDir)) {
          throw new Error(
            `Expected React project at ${projectDir} after generating ${ddd} (pack=${pack})`,
          );
        }
        // Frontend `function … extern from` impls are user-owned and never
        // generated; stub them so the generated-only tree type-checks.
        stubFrontendExterns(projectDir);
        execSync(`npm install --silent --no-audit --no-fund`, {
          cwd: projectDir,
          stdio: "inherit",
          timeout: 240_000,
        });
        // `tsc --noEmit` honours the project's tsconfig.json `include`
        // / `strict` settings.  References (tsconfig.node.json) are
        // not built — Vite's config is only checked when `tsc -b` runs
        // explicitly, which would require composite emit.
        execSync(`npx tsc --noEmit`, {
          cwd: projectDir,
          stdio: "inherit",
          timeout: 90_000,
        });
        // `vite build` — the production bundling step.  `tsc --noEmit`
        // alone is a type-check; it doesn't catch class-shape issues
        // that only surface when esbuild/rollup actually load the
        // modules and resolve imports.  Example caught by adding
        // this: the React-18 idiom `import ReactDOM from
        // "react-dom/client"; ReactDOM.createRoot(...)` type-checks
        // under React 19 (TS accepts the default-import as namespace-
        // shaped) but bombs at runtime ("ReactDOM.createRoot is not
        // a function") because React 19 dropped the namespace
        // forwarding.  `vite build` short-circuits that gap.
        execSync(`npx vite build --logLevel warn`, {
          cwd: projectDir,
          stdio: "inherit",
          timeout: 120_000,
        });
        // Extra web deployables (e.g. a scaffold UI): install + `tsc --noEmit`
        // only — the tsc pass is what catches an off-wire field reference; a
        // second vite build would add cost without new coverage.  Built once,
        // on the first pack cell, because injectDesign only rewrites the
        // primary (console_web) design slot — every extra dir builds
        // identically under every pack, so ×N packs would be pure redundancy.
        const isFirstPackCell = packId(pack) === packId(PACKS[0]);
        if (isFirstPackCell) {
          for (const extra of extraReactDirs ?? []) {
            const extraDir = path.join(outDir, extra);
            if (!fs.existsSync(extraDir)) {
              throw new Error(
                `Expected extra React project at ${extraDir} after generating ${ddd}`,
              );
            }
            stubFrontendExterns(extraDir);
            execSync(`npm install --silent --no-audit --no-fund`, {
              cwd: extraDir,
              stdio: "inherit",
              timeout: 240_000,
            });
            execSync(`npx tsc --noEmit`, { cwd: extraDir, stdio: "inherit", timeout: 90_000 });
          }
        }
        expect(true).toBe(true);
      } finally {
        try {
          fs.rmSync(outDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }, 420_000);
  },
);

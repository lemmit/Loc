import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// The IP / bundle boundary, enforced.
//
// `platform/registry.ts` (the GENERATION registry) statically imports every
// backend surface, each of which imports its generator under `src/generator/`.
// So importing `registry.ts` anywhere in a module graph drags ALL backend
// generators (.NET / Java / Phoenix / Python) into that bundle.
//
// The front half of the toolchain — language services (validators) + the IR
// passes (lower / enrich / validate) — must read platform facts ONLY from
// `platform/metadata.ts` (the client-safe descriptor table, which imports no
// surfaces).  Then a client build whose entry stays within `language/` + `ir/`
// + `metadata.ts` tree-shakes the premium generators out by construction.
//
// A new `from ".../platform/registry"` import under language/ or ir/ fails
// here — the leak is caught in CI, not in a bloated bundle nobody inspects.
// ---------------------------------------------------------------------------

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...tsFiles(p));
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

const REGISTRY_IMPORT = /from\s+["'][^"']*platform\/registry(\.js)?["']/;

describe("front half reads platform METADATA, never the generation registry", () => {
  it.each([
    "src/language",
    "src/ir",
  ])("%s never imports platform/registry (only platform/metadata)", (rel) => {
    const offenders: string[] = [];
    for (const f of tsFiles(path.join(repoRoot, rel))) {
      if (REGISTRY_IMPORT.test(fs.readFileSync(f, "utf8"))) {
        offenders.push(path.relative(repoRoot, f));
      }
    }
    expect(offenders).toEqual([]);
  });
});

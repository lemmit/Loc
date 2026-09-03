import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// `test/playground/*` runs in the ROOT vitest project, which installs only the
// repo's own dependencies — `react` and `@mantine/*` live in `web/node_modules`
// and are NOT installed on the CI test shards.  A headless test that reaches a
// React module at RUNTIME therefore passes on a developer machine (where
// `web/node_modules` exists) and fails on the runner with "Cannot find package
// 'react'".  That is exactly how `palette-blockers.test.ts` went red on #2758
// after passing locally.
//
// The rule this pins: a `test/playground` file may import `web/src/**` at
// runtime only through React-free modules.  `import type` is exempt — the TS
// transform erases it, so it never loads the module (several tests legitimately
// borrow a prop interface from a component).  The fix for a violation is the
// pure-core split, e.g. `builder/refusal-text.ts` beside `builder/refusal.tsx`.
const DIR = dirname(new URL(import.meta.url).pathname);

function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? testFiles(join(dir, e.name))
      : e.name.endsWith(".test.ts")
        ? [join(dir, e.name)]
        : [],
  );
}

/** A `.js` specifier resolves to `.ts` or `.tsx`; report the `.tsx` hit. */
function resolvesToTsx(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec);
  const tsx = base.endsWith(".js") ? `${base.slice(0, -3)}.tsx` : `${base}.tsx`;
  return existsSync(tsx) ? tsx : null;
}

describe("playground headless tests stay React-free", () => {
  it("has no RUNTIME import of a .tsx module under web/src", () => {
    const offenders: string[] = [];
    for (const file of testFiles(DIR)) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        // Type-only imports are erased — they never load the module.
        if (/^\s*import\s+type\b/.test(line)) continue;
        const m = /from\s+"([^"]*web\/src\/[^"]*)"/.exec(line);
        if (!m) continue;
        const tsx = resolvesToTsx(file, m[1]);
        if (tsx) offenders.push(`${file.slice(DIR.length + 1)} → ${m[1]}`);
      }
    }
    expect(offenders, "import the React-free core instead (see builder/refusal-text.ts)").toEqual([]);
  });
});

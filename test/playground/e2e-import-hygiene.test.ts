import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// A merge once moved `readEditorSource` out of the `./_helpers` import and into
// the `@playwright/test` one on `builder-page.spec.ts`.  Nothing in the fast
// suite could see it: the specs only load under `playground-e2e-no-network`, a
// slow path-scoped gate, where it surfaced as
// `The requested module '@playwright/test' does not provide an export named
// 'readEditorSource'` — after a full vite build, an hour into the runner queue.
//
// The class is cheap to close statically: `@playwright/test` has a small, known
// export surface, and every name `_helpers.ts` exports must come from
// `./_helpers`.  Both directions are checked, so the same bad resolution the
// other way round (a playwright export attributed to the helpers) also fails.
const E2E = resolve(dirname(new URL(import.meta.url).pathname), "../../web/e2e");

/** The `@playwright/test` names the specs in this repo legitimately use. */
const PLAYWRIGHT_EXPORTS = new Set([
  "test",
  "expect",
  "devices",
  "chromium",
  "firefox",
  "webkit",
  "request",
  "defineConfig",
  "Page",
  "Locator",
  "BrowserContext",
  "ConsoleMessage",
  "Browser",
  "TestInfo",
  "Route",
  "Request",
  "Response",
  "APIRequestContext",
  "FullConfig",
  "PlaywrightTestConfig",
]);

/** Names in an `import { … }` clause, with `type ` prefixes and aliases stripped. */
function importedNames(clause: string): string[] {
  return clause
    .split(",")
    .map((s) =>
      s
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)[0]
        .trim(),
    )
    .filter((s) => s.length > 0);
}

function specFiles(): string[] {
  return readdirSync(E2E, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts"))
    .map((e) => join(E2E, e.name));
}

/** Exported function/const names of `web/e2e/_helpers.ts`. */
function helperExports(): Set<string> {
  const src = readFileSync(join(E2E, "_helpers.ts"), "utf8");
  const names = new Set<string>();
  for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function|const|class)\s+(\w+)/gm)) {
    names.add(m[1]);
  }
  return names;
}

describe("web/e2e import hygiene", () => {
  const helpers = helperExports();

  it("finds the helper exports it is meant to guard", () => {
    // Guards the guard: an empty set would make every assertion below vacuous.
    expect(helpers.size).toBeGreaterThan(3);
    expect(helpers).toContain("readEditorSource");
  });

  it("imports only real names from @playwright/test", () => {
    const offenders: string[] = [];
    for (const file of specFiles()) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(
        /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"@playwright\/test"/g,
      )) {
        for (const name of importedNames(m[1])) {
          if (!PLAYWRIGHT_EXPORTS.has(name)) {
            offenders.push(`${file.slice(E2E.length + 1)}: "${name}"`);
          }
        }
      }
    }
    expect(
      offenders,
      "not a @playwright/test export — a local helper belongs in the ./_helpers import",
    ).toEqual([]);
  });

  it("imports every _helpers export from ./_helpers", () => {
    const offenders: string[] = [];
    for (const file of specFiles()) {
      if (file.endsWith("_helpers.ts")) continue;
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"([^"]+)"/g)) {
        if (m[2] === "./_helpers") continue;
        for (const name of importedNames(m[1])) {
          if (helpers.has(name))
            offenders.push(`${file.slice(E2E.length + 1)}: "${name}" from "${m[2]}"`);
        }
      }
    }
    expect(offenders, "web/e2e/_helpers.ts owns this name — import it from ./_helpers").toEqual([]);
  });
});

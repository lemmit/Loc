// Frontend ↔ wire-contract parity gate (no boot).
//
// The generated frontend's zod Response schemas and the canonical wire contract
// (`.loom/wire-spec.json`, the shape every backend serializes) both derive from
// the same `wireFieldsFor` projection today — so they agree BY CONSTRUCTION.
// Nothing PINS that coupling, though: a refactor that makes the frontend zod
// emitter (`src/generator/_frontend/api-module.ts`) drop a field, reorder into a
// transform, or stop consuming `wireFieldsFor` would silently ship a UI whose
// parse shape disagrees with the API it calls — a wire-contract break that keeps
// BOTH halves compiling and each half booting independently, so it sails through
// every per-PR compile gate and only surfaces in the nightly full-stack e2e.
//
// This fast gate converts that implicit coupling into an explicit per-PR
// invariant: for every aggregate, the frontend `<Agg>Response = z.object({…})`
// keys MUST equal the canonical wire-spec property keys (same set, incl. derived
// fields like `display`). The repo's "lock what's true-by-construction so it
// can't silently regress" discipline (cf. domain-test-emission-parity).
//
// Backend↔wire parity is separately gated at runtime per-PR by conformance-parity
// (boots all 5 backends, diffs OpenAPI); this closes the FRONTEND leg of the same
// contract without a boot.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { lowerFirst } from "../../src/util/naming.js";
import { generateSystemFiles } from "../_helpers/generate.js";

/** Top-level keys of `export const <name> = z.object({ … });` in a frontend api
 *  module. The block is flat — value objects / nested rows are separate `const`s
 *  referenced by name — so we collect `key:` lines until the closing `});`. */
function zodObjectKeys(content: string, constName: string): string[] {
  const lines = content.split("\n");
  const start = lines.findIndex((l) => l.includes(`const ${constName} = z.object({`));
  if (start === -1) return [];
  const keys: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\}\)/.test(lines[i])) break; // closing `});`
    const m = lines[i].match(/^\s*([A-Za-z_$][\w$]*)\s*:/);
    if (m) keys.push(m[1]);
  }
  return keys;
}

describe("frontend zod Response ↔ canonical wire-spec parity", () => {
  it("every aggregate's frontend Response schema keys equal the wire contract", async () => {
    const src = readFileSync("web/src/examples/sales-system.ddd", "utf8");
    const files = await generateSystemFiles(src);

    const specRaw = files.get(".loom/wire-spec.json");
    expect(specRaw, "expected a generated .loom/wire-spec.json").toBeTruthy();
    const spec = JSON.parse(specRaw as string) as {
      aggregates: Record<string, { properties: Record<string, unknown> }>;
    };

    const aggregates = Object.keys(spec.aggregates);
    expect(aggregates.length, "fixture should carry aggregates").toBeGreaterThan(0);

    for (const agg of aggregates) {
      const canonical = Object.keys(spec.aggregates[agg].properties).sort();

      // Locate the frontend api client module for this aggregate.
      const modKey = [...files.keys()].find((k) => k.endsWith(`/src/api/${lowerFirst(agg)}.ts`));
      expect(modKey, `expected a frontend api module for ${agg}`).toBeTruthy();

      const frontendKeys = zodObjectKeys(files.get(modKey as string) as string, `${agg}Response`);
      expect(
        frontendKeys.length,
        `${agg}: could not extract ${agg}Response = z.object({…}) keys`,
      ).toBeGreaterThan(0);

      expect(
        [...frontendKeys].sort(),
        `${agg}: frontend Response schema keys diverge from the canonical wire contract.\n` +
          `  wire-spec:  ${canonical.join(", ")}\n` +
          `  frontend:   ${[...frontendKeys].sort().join(", ")}\n` +
          `A UI built for this schema would mis-parse the API response.`,
      ).toEqual(canonical);
    }
  });
});

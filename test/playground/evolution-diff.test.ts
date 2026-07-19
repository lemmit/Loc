import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runEvolution } from "../../web/src/build/evolution.js";
import type { EvolutionOk, EvolutionTree } from "../../web/src/build/protocol.js";

// The evolution-diff core (`web/src/build/evolution.ts`) — the playground's
// migration + wire-contract delta between a pinned baseline and the live edit,
// driven by the Migrations dock tab (M-T8.11).  Extracted from the build worker
// precisely so it's headless-testable: the runtime bug it guards (a shared
// Langium workspace binding a cross-aggregate `X id` ref to the wrong doc's `X`
// → a spurious "expects 'Product id' but got 'Product id'" that failed the whole
// diff) could only surface in the browser e2e before.  Per-tree service
// isolation is the fix; these assertions lock it in.

const SALES = readFileSync(
  fileURLToPath(new URL("../../web/src/examples/sales-system.ddd", import.meta.url)),
  "utf8",
);

/** Wrap a single-file `.ddd` source as an evolution tree. */
function tree(content: string): EvolutionTree {
  return {
    entryPath: "/workspace/main.ddd",
    files: [{ kind: "file", path: "/workspace/main.ddd", content }],
  };
}

describe("runEvolution", () => {
  it("smoke: current == baseline lowers to ok with no changes (not 'Diff failed')", async () => {
    const r = await runEvolution({ baseline: tree(SALES), current: tree(SALES) });
    expect(r.ok).toBe(true);
    const ok = r as EvolutionOk;
    expect(ok.hasBaseline).toBe(true);
    expect(ok.migrations).toEqual([]);
    expect(ok.wireChanges).toEqual([]);
    expect(ok.breaking).toBe(false);
  });

  it("runs repeatedly without cross-run contamination (the isolation guarantee)", async () => {
    // The very bug this file exists for: a second run must be as clean as the
    // first — no resident docs leaking a wrong-node `X id` binding.
    for (let i = 0; i < 3; i++) {
      const r = await runEvolution({ baseline: tree(SALES), current: tree(SALES) });
      expect(r.ok).toBe(true);
      expect((r as EvolutionOk).migrations).toEqual([]);
    }
  });

  it("edit-driven: adding a field to an aggregate surfaces an add-column migration", async () => {
    // Add `phone: string` to the Customer aggregate (which has `email: string`).
    const edited = SALES.replace("email: string", "email: string\n        phone: string");
    expect(edited).not.toBe(SALES); // guard: the anchor matched
    const r = await runEvolution({ baseline: tree(SALES), current: tree(edited) });
    expect(r.ok).toBe(true);
    const ok = r as EvolutionOk;
    expect(ok.hasBaseline).toBe(true);
    expect(ok.migrations.length).toBeGreaterThan(0);
    const sql = ok.migrations.flatMap((m) => m.steps.map((s) => s.sql)).join("\n");
    expect(sql).toMatch(/phone/i);
    // The added field is an additive wire change (not breaking).
    expect(ok.wireChanges.some((c) => /phone/i.test(`${c.entity}.${c.field}`))).toBe(true);
  });

  it("no baseline ⇒ hasBaseline false, no contract noise", async () => {
    const r = await runEvolution({ baseline: null, current: tree(SALES) });
    expect(r.ok).toBe(true);
    const ok = r as EvolutionOk;
    expect(ok.hasBaseline).toBe(false);
    expect(ok.wireChanges).toEqual([]);
  });

  it("a source with no system block reports the no-op warning, still ok", async () => {
    const r = await runEvolution({
      baseline: null,
      current: tree("context C { aggregate A { x: int } }"),
    });
    expect(r.ok).toBe(true);
    const ok = r as EvolutionOk;
    expect(ok.hasBaseline).toBe(false);
    expect(ok.migrations).toEqual([]);
    expect(ok.diagnostics.some((d) => /no .*system. block/i.test(d.message))).toBe(true);
  });
});

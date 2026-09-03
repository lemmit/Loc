import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import type { LoomModel } from "../../src/ir/types/loom-ir.js";
import { verifyLoomModel } from "../../src/ir/verify/verify-ir.js";
import { genModel } from "../_helpers/ddd-model-generator.js";
import { loadExampleModel, parseString, toLoomModel } from "../_helpers/index.js";
import { corpusSourceFor } from "../fixtures/corpus/harness.js";
import { CORPUS } from "../fixtures/corpus/manifest.js";

// ---------------------------------------------------------------------------
// The IR verifier's gate (M-T9.40).
//
// STATED PLAINLY: the verifier found nothing when it was written — zero
// violations over eight examples and all 59 corpus fixtures — so this file is
// a REGRESSION guard, not a discovery.  What earns it its lines is the INPUT
// SET.  `test/ir/properties.test.ts` asserts a comparable set of invariants
// over four examples because that is what a hand-rolled walk per example could
// afford; this runs the whole contract over every corpus fixture and every
// generated model, because `forEachModelExpr` made the walk a single call.
//
// A gate that passes on its first run proves nothing, which is why the
// mutation block below is not optional: each invariant is re-checked against a
// model with that invariant deliberately broken.  Without it this file is
// indistinguishable from one that verifies nothing at all — the exact shape
// `experience_gathered.md` §67/§68 record.
// ---------------------------------------------------------------------------

const EXAMPLES = [
  "examples/acme.ddd",
  "examples/showcase.ddd",
  "examples/banking.ddd",
  "examples/sales-ui.ddd",
  "examples/inventory.ddd",
  "examples/document.ddd",
  "examples/event-sourcing.ddd",
  "examples/roster.ddd",
];

describe("IR verifier", () => {
  it.each(EXAMPLES)("%s produces a well-formed IR", async (example) => {
    const model = toLoomModel(await loadExampleModel(example));
    expect(verifyLoomModel(model)).toEqual([]);
  });

  it("every corpus fixture produces a well-formed IR", async () => {
    const bad: string[] = [];
    for (const f of CORPUS) {
      const parsed = await parseString(corpusSourceFor(f.id, "node"), { validate: false });
      if (parsed.errors.length > 0) continue;
      for (const v of verifyLoomModel(toLoomModel(parsed.model))) bad.push(`${f.id}: ${v}`);
    }
    expect(bad.slice(0, 5)).toEqual([]);
  }, 300_000);

  it("every generated model produces a well-formed IR", async () => {
    // The input set no fixture list covers.  `pipeline-fuzz` already proves the
    // pipeline does not THROW on these; this proves the IR it produces holds
    // its own contract — the difference between "did not crash" and "is
    // consumable", which is exactly the gap a backend discovers later.
    const bad: string[] = [];
    for (let seed = 1; seed <= 60; seed++) {
      const source = genModel(seed).replaceAll("__PLATFORM__", "node");
      const parsed = await parseString(source, { validate: false });
      if (parsed.errors.length > 0) continue;
      for (const v of verifyLoomModel(toLoomModel(parsed.model))) bad.push(`seed ${seed}: ${v}`);
    }
    expect(bad.slice(0, 5)).toEqual([]);
  }, 300_000);

  it("enrichment is idempotent on every corpus fixture", async () => {
    // `properties.test.ts` pins this on four examples.  Enrichment is where a
    // derivation that appends rather than replaces (an auto-`all` added twice,
    // a wire field duplicated) turns a re-entrant call into a corrupted model,
    // and the corpus is where the shapes that could do it actually live.
    const bad: string[] = [];
    for (const f of CORPUS) {
      const parsed = await parseString(corpusSourceFor(f.id, "node"), { validate: false });
      if (parsed.errors.length > 0) continue;
      const once = toLoomModel(parsed.model);
      const twice = enrichLoomModel(once as LoomModel);
      try {
        expect(twice).toEqual(once);
      } catch {
        bad.push(f.id);
      }
    }
    expect(bad).toEqual([]);
  }, 300_000);

  describe("can actually fail", () => {
    // Each mutation breaks ONE invariant on a real model and asserts the
    // verifier names it.  Mutating the IR directly (rather than the lowering
    // pass) keeps the proof in this file, where a reader can see it.
    const load = async (): Promise<LoomModel> =>
      toLoomModel(await loadExampleModel("examples/acme.ddd"));

    it("names an enum-value ref that lost its enumName", async () => {
      const model = await load();
      let patched = 0;
      const strip = (node: unknown): void => {
        if (!node || typeof node !== "object") return;
        const o = node as Record<string, unknown>;
        if (o.kind === "ref" && o.refKind === "enum-value" && o.enumName) {
          o.enumName = undefined;
          patched++;
        }
        for (const value of Object.values(o)) {
          if (Array.isArray(value)) for (const child of value) strip(child);
          else if (value && typeof value === "object") strip(value);
        }
      };
      strip(model);
      expect(patched, "acme has no enum-value ref to break — pick another fixture").toBeGreaterThan(
        0,
      );
      const violations = verifyLoomModel(model);
      expect(violations.length).toBeGreaterThan(0);
      expect(violations[0]).toMatch(/enum-value ref .* has no enumName/);
    });

    it("names an aggregate whose repository lost its auto `all`", async () => {
      const model = await load();
      const ctx = model.systems[0]?.subdomains.flatMap((s) => s.contexts)[0];
      const repo = ctx?.repositories[0];
      expect(repo?.finds[0]?.name).toBe("all");
      repo?.finds.shift();
      expect(verifyLoomModel(model).join("\n")).toMatch(/first find is .*, not the auto-derived/);
    });
  });
});

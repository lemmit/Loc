import { describe, expect, it } from "vitest";
import { BACKENDS, type Backend, SEMANTICS_RULES } from "./semantics-rules.js";

// Well-formedness gate for the runtime-semantics rule registry.
//
// This is the registry-shape guard (the diagnostic-code-registry pattern) that
// makes `docs/conformance-semantics.md` a contract rather than prose: a rule
// can't be added as documentation only — it must be a well-formed entry here,
// naming real backends and a real provenance. When A6.2 lands (a second
// backend in the per-PR behavioral tier), the `tier` field is what the runner
// reads to decide which rules it can enforce.

const BACKEND_SET = new Set<string>(BACKENDS);

describe("runtime-semantics rule registry", () => {
  it("is non-empty and every rule is structurally well-formed", () => {
    expect(SEMANTICS_RULES.length).toBeGreaterThan(0);
    for (const r of SEMANTICS_RULES) {
      expect(r.id, `${r.id}: id shape`).toMatch(/^RS-\d+$/);
      expect(r.title.length, `${r.id}: title`).toBeGreaterThan(0);
      expect(r.trigger.length, `${r.id}: trigger`).toBeGreaterThan(0);
      expect(r.observable.length, `${r.id}: observable`).toBeGreaterThan(0);
      expect(r.provenance.length, `${r.id}: provenance`).toBeGreaterThan(0);
      expect(["static", "behavioral", "full"], `${r.id}: tier`).toContain(r.tier);
    }
  });

  it("ids are unique and gap-free (RS-1..RS-N)", () => {
    const ids = SEMANTICS_RULES.map((r) => r.id);
    expect(new Set(ids).size, "duplicate rule id").toBe(ids.length);
    const nums = ids.map((id) => Number(id.slice(3))).sort((a, b) => a - b);
    expect(nums[0]).toBe(1);
    for (let i = 1; i < nums.length; i++) {
      expect(nums[i], "rule ids must be contiguous (retire, don't delete)").toBe(nums[i - 1] + 1);
    }
  });

  it("every rule names ≥1 conforming backend, all drawn from the five", () => {
    for (const r of SEMANTICS_RULES) {
      expect(r.conforms.length, `${r.id}: needs ≥1 conforming backend`).toBeGreaterThan(0);
      for (const b of r.conforms) {
        expect(BACKEND_SET.has(b), `${r.id}: unknown backend ${b}`).toBe(true);
      }
    }
  });

  it("targets (defensive guards) are real backends, disjoint from conforms", () => {
    for (const r of SEMANTICS_RULES) {
      if (!r.targets) continue;
      const conforming = new Set<Backend>(r.conforms);
      for (const b of r.targets) {
        expect(BACKEND_SET.has(b), `${r.id}: unknown target backend ${b}`).toBe(true);
        expect(conforming.has(b), `${r.id}: ${b} can't be both conforms and target`).toBe(false);
      }
    }
  });

  it("a static-tier rule is gateable without booting a backend", () => {
    // Sanity anchor: at least one rule is cheap enough to gate per-PR against
    // emitted source today. If this ever drops to zero, the registry has
    // drifted into behavioral-only and the per-PR net has a hole — surface it.
    expect(SEMANTICS_RULES.some((r) => r.tier === "static")).toBe(true);
  });
});

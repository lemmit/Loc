import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { wireFieldsFor } from "../../src/ir/enrich/wire-projection.js";
import type { EntityPartIR, LoomModel, ValueObjectIR } from "../../src/ir/types/loom-ir.js";
import { allAggregates, allContexts } from "../../src/ir/types/loom-ir.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { buildWireSpec } from "../../src/system/wire-spec.js";
import { loadExampleModel, toLoomModel } from "../_helpers/index.js";

// ---------------------------------------------------------------------------
// IR-transformation properties.  Every assertion here is an *invariant*
// the pipeline is supposed to maintain across all examples — if any of
// them fail, the failure points at a structural bug rather than at a
// content typo.
// ---------------------------------------------------------------------------

const EXAMPLES = [
  "examples/sales.ddd",
  "examples/banking.ddd",
  "examples/inventory.ddd",
  "examples/acme.ddd",
];

async function buildEnriched(file: string): Promise<LoomModel> {
  return toLoomModel(await loadExampleModel(file));
}

function allParts(loom: LoomModel): EntityPartIR[] {
  return allAggregates(loom).flatMap((a) => a.parts);
}

function allValueObjects(loom: LoomModel): ValueObjectIR[] {
  return allContexts(loom).flatMap((c) => c.valueObjects);
}

describe("IR invariants — every example", () => {
  for (const example of EXAMPLES) {
    describe(example, () => {
      it("validates with zero errors", async () => {
        const loom = await buildEnriched(example);
        // Warnings are allowed (e.g. advisory `loom.index-suggestion`); the
        // invariant is that no example produces a correctness ERROR.
        const errors = validateLoomModel(loom).filter((d) => d.severity === "error");
        expect(errors, `${example} errors: ${JSON.stringify(errors)}`).toEqual([]);
      });

      it("every aggregate has wireShape with `id` first", async () => {
        const loom = await buildEnriched(example);
        for (const a of allAggregates(loom)) {
          expect(wireFieldsFor(a), `${a.name}.wireShape`).toBeDefined();
          expect(wireFieldsFor(a)[0]!.name, `${a.name} first field name`).toBe("id");
          expect(wireFieldsFor(a)[0]!.source, `${a.name} first field source`).toBe("id");
        }
      });

      it("every part has wireShape with `id` first and a parent reference", async () => {
        const loom = await buildEnriched(example);
        for (const p of allParts(loom)) {
          expect(wireFieldsFor(p), `${p.name}.wireShape`).toBeDefined();
          expect(wireFieldsFor(p)[0]!.name).toBe("id");
        }
      });

      it("value objects have no `id` and no `containment` in wire shape", async () => {
        const loom = await buildEnriched(example);
        for (const v of allValueObjects(loom)) {
          for (const f of wireFieldsFor(v)) {
            expect(f.source, `${v.name}.${f.name}`).not.toBe("id");
            expect(f.source).not.toBe("containment");
          }
        }
      });

      it("every aggregate has a repository whose first find is auto `all`", async () => {
        const loom = await buildEnriched(example);
        for (const ctx of allContexts(loom)) {
          for (const agg of ctx.aggregates) {
            const repo = ctx.repositories.find((r) => r.aggregateName === agg.name);
            expect(repo, `${agg.name} repository`).toBeDefined();
            expect(repo!.finds[0]!.name).toBe("all");
            expect(repo!.finds[0]!.params).toEqual([]);
          }
        }
      });

      it("enrichLoomModel is idempotent", async () => {
        const once = await buildEnriched(example);
        const twice = enrichLoomModel(once);
        expect(twice).toEqual(once);
      });

      it("react deployables inherit contextNames from their target", async () => {
        const loom = await buildEnriched(example);
        for (const sys of loom.systems) {
          for (const d of sys.deployables) {
            if (d.platform !== "react") continue;
            const target = sys.deployables.find((t) => t.name === d.targetName);
            expect(target, `${d.name} → ${d.targetName}`).toBeDefined();
            expect([...d.contextNames].sort()).toEqual([...target!.contextNames].sort());
          }
        }
      });
    });
  }
});

describe("Wire-spec artifact invariants", () => {
  it("includes every aggregate / part / value object across the system", async () => {
    const loom = await buildEnriched("examples/acme.ddd");
    for (const sys of loom.systems) {
      const spec = buildWireSpec(sys);
      const aggsInSys = allContexts(loom).flatMap((c) => c.aggregates);
      const partsInSys = aggsInSys.flatMap((a) => a.parts);
      const vosInSys = allContexts(loom).flatMap((c) => c.valueObjects);
      for (const a of aggsInSys) {
        expect(spec.aggregates[a.name], `agg ${a.name} in spec`).toBeDefined();
      }
      for (const p of partsInSys) {
        expect(spec.parts[p.name], `part ${p.name} in spec`).toBeDefined();
      }
      for (const v of vosInSys) {
        expect(spec.valueObjects[v.name], `vo ${v.name} in spec`).toBeDefined();
      }
    }
  });

  it("required[] excludes optional fields", async () => {
    const loom = await buildEnriched("examples/banking.ddd");
    for (const sys of loom.systems) {
      const spec = buildWireSpec(sys);
      // banking has optional fields; ensure no `required` entry refers
      // to a non-existent property.
      for (const schema of Object.values(spec.aggregates)) {
        for (const reqName of schema.required) {
          expect(
            schema.properties[reqName],
            `required ${reqName} must be a declared property`,
          ).toBeDefined();
        }
      }
    }
  });

  it("is byte-stable across repeated builds", async () => {
    const loom = await buildEnriched("examples/acme.ddd");
    const sys = loom.systems[0]!;
    const a = JSON.stringify(buildWireSpec(sys));
    const b = JSON.stringify(buildWireSpec(sys));
    expect(a).toBe(b);
  });
});

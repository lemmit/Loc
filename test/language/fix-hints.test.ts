import { describe, expect, it } from "vitest";
import { buildValidateReport } from "../../src/api/report.js";
import type { ModelPatch } from "../../src/diagnostics/contract.js";
import { applyPatches } from "../../src/language/model-patch.js";
import { parseString } from "../_helpers/parse.js";

// ---------------------------------------------------------------------------
// Fix-hints close the validate→repair loop (ai-diagnostics-contract.md §3.3).
// A diagnostic carries a `fixHint` whose `patch` applies back onto the model;
// applying it and re-validating must produce a clean model.  This is the
// self-suggesting-loop proof: diagnostic → fixHint → applyPatches → green.
// ---------------------------------------------------------------------------

const BAD = `context Sales {
  aggregate Order {
    customer: Customer
    lines: OrderLine[]
  }
  aggregate Customer { name: string }
  aggregate OrderLine { qty: int }
}
`;

describe("fix-hints", () => {
  it("bare-aggregate diagnostics carry a replace-text fixHint (scalar and array)", async () => {
    const { doc, model, diagnostics } = await parseString(BAD);
    const report = buildValidateReport({
      modelPath: "m.ddd",
      langiumDiagnostics: diagnostics,
      doc,
      irDiagnostics: [],
      model,
    });
    const hinted = report.diagnostics.filter(
      (d) => d.code === "loom.bare-aggregate-in-type" && d.fixHint?.patch,
    );
    expect(hinted.length).toBe(2);
    for (const d of hinted) {
      expect(d.fixHint?.kind).toBe("replace-text");
      expect(d.fixHint?.patch?.op).toBe("replace");
    }
  });

  it("closes the loop — applying the fixHints yields a clean model", async () => {
    const { doc, model, diagnostics } = await parseString(BAD);
    const report = buildValidateReport({
      modelPath: "m.ddd",
      langiumDiagnostics: diagnostics,
      doc,
      irDiagnostics: [],
      model,
    });
    const patches = report.diagnostics
      .filter((d) => d.code === "loom.bare-aggregate-in-type")
      .map((d) => d.fixHint?.patch)
      .filter((p): p is ModelPatch => p !== undefined);

    const applied = await applyPatches(BAD, patches);
    expect(applied.ok).toBe(true);
    expect(applied.text).toContain("customer: Customer id");
    expect(applied.text).toContain("lines: OrderLine id[]");

    // Re-validate: the bare-aggregate errors are gone.
    const re = await parseString(applied.text);
    expect(re.errors).toEqual([]);
  });
});

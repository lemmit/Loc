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

  it("reserved-derived-on-vo: dropping 'derived' fixes it (round-trip clean)", async () => {
    const VO = `context Sales {
  valueobject Money {
    amount: int
    derived display: string = "x"
  }
}`;
    const { doc, model, diagnostics } = await parseString(VO);
    const report = buildValidateReport({
      modelPath: "m.ddd",
      langiumDiagnostics: diagnostics,
      doc,
      irDiagnostics: [],
      model,
    });
    const hint = report.diagnostics.find((d) => d.code === "loom.reserved-derived-on-vo");
    expect(hint?.fixHint?.patch).toMatchObject({
      op: "replace",
      target: "valueobject Sales.Money.display",
      source: 'display: string = "x"',
    });

    const applied = await applyPatches(VO, [hint?.fixHint?.patch as ModelPatch]);
    expect(applied.ok).toBe(true);
    const re = await parseString(applied.text);
    expect(re.errors).toEqual([]); // the reserved-derived error is gone
  });

  it("token-nullable: dropping '?' makes the token field non-optional (round-trip clean)", async () => {
    const TOK = `context Sales {
  aggregate Order {
    etag: string? token
    total: int
  }
}`;
    const { doc, model, diagnostics } = await parseString(TOK);
    const report = buildValidateReport({
      modelPath: "m.ddd",
      langiumDiagnostics: diagnostics,
      doc,
      irDiagnostics: [],
      model,
    });
    const hint = report.diagnostics.find((d) => d.code === "loom.token-nullable");
    expect(hint?.fixHint?.kind).toBe("replace-text");
    expect(hint?.fixHint?.patch).toMatchObject({
      op: "replace",
      target: "aggregate Sales.Order.etag",
      source: "etag: string token",
    });

    const applied = await applyPatches(TOK, [hint?.fixHint?.patch as ModelPatch]);
    expect(applied.ok).toBe(true);
    expect(applied.text).toContain("etag: string token");
    // Re-validate: the token-nullable error is gone and it still parses.
    const { diagnostics: after, errors } = await parseString(applied.text);
    expect(after.some((d) => d.code === "loom.token-nullable")).toBe(false);
    expect(errors).toEqual([]);
  });

  it("react-deployable-missing-ui: appends `ui: <Name>` (single ui, round-trip clean)", async () => {
    const SYS = `system S {
  context Sales { aggregate Order { total: int } }
  ui Web with scaffold(subdomains: [Sales]) {}
  storage primary { type: postgres }
  resource st { for: Sales, kind: state, use: primary }
  deployable api { platform: node contexts: [Sales] dataSources: [st] port: 3000 }
  deployable web {
    platform: react
    targets: api
    port: 3001
  }
}`;
    const { doc, model, diagnostics } = await parseString(SYS);
    const report = buildValidateReport({
      modelPath: "m.ddd",
      langiumDiagnostics: diagnostics,
      doc,
      irDiagnostics: [],
      model,
    });
    const hint = report.diagnostics.find((d) => d.code === "loom.react-deployable-missing-ui");
    expect(hint?.fixHint?.kind).toBe("insert-decl");
    expect(hint?.fixHint?.patch).toMatchObject({
      op: "add",
      target: "deployable web",
      source: "ui: Web",
    });

    const applied = await applyPatches(SYS, [hint?.fixHint?.patch as ModelPatch]);
    expect(applied.ok).toBe(true);
    expect(applied.text).toContain("ui: Web");
    const { diagnostics: after } = await parseString(applied.text);
    expect(after.some((d) => d.code === "loom.react-deployable-missing-ui")).toBe(false);
    expect(after.some((d) => (d.data as { code?: string })?.code === "parsing-error")).toBe(false);
  });

  it("deployable-missing-ui: offers a `choose` when several ui blocks exist", async () => {
    const SYS = `system S {
  context Sales { aggregate Order { total: int } }
  ui Web with scaffold(subdomains: [Sales]) {}
  ui Admin with scaffold(subdomains: [Sales]) {}
  storage primary { type: postgres }
  resource st { for: Sales, kind: state, use: primary }
  deployable api { platform: node contexts: [Sales] dataSources: [st] port: 3000 }
  deployable web { platform: react targets: api port: 3001 }
}`;
    const { doc, model, diagnostics } = await parseString(SYS);
    const report = buildValidateReport({
      modelPath: "m.ddd",
      langiumDiagnostics: diagnostics,
      doc,
      irDiagnostics: [],
      model,
    });
    const hint = report.diagnostics.find((d) => d.code === "loom.react-deployable-missing-ui");
    expect(hint?.fixHint?.kind).toBe("choose");
    const sources = hint?.fixHint?.options?.map((o) => o.patch?.source).sort();
    expect(sources).toEqual(["ui: Admin", "ui: Web"]);
    // Applying a chosen option round-trips clean.
    const chosen = hint?.fixHint?.options?.find((o) => o.patch?.source === "ui: Web")?.patch;
    const applied = await applyPatches(SYS, [chosen as ModelPatch]);
    expect(applied.ok).toBe(true);
    const { diagnostics: after } = await parseString(applied.text);
    expect(after.some((d) => d.code === "loom.react-deployable-missing-ui")).toBe(false);
  });

  it("es-tph-forced-own-table: header-end inserts inheritanceUsing: ownTable", async () => {
    const TPH = `context Sales {
  abstract aggregate Party inheritanceUsing: sharedTable { name: string }
  aggregate Customer extends Party persistedAs: eventLog { credit: int }
}`;
    const { doc, model, diagnostics } = await parseString(TPH);
    const report = buildValidateReport({
      modelPath: "m.ddd",
      langiumDiagnostics: diagnostics,
      doc,
      irDiagnostics: [],
      model,
    });
    const hint = report.diagnostics.find((d) => d.code === "loom.es-tph-forced-own-table");
    expect(hint?.fixHint?.patch).toMatchObject({
      op: "insert",
      target: "aggregate Sales.Customer",
      position: "header-end",
      source: "inheritanceUsing: ownTable",
    });

    const applied = await applyPatches(TPH, [hint?.fixHint?.patch as ModelPatch]);
    expect(applied.ok).toBe(true);
    expect(applied.text).toContain("persistedAs: eventLog inheritanceUsing: ownTable {");
    // The es-tph diagnostic clears and the result parses (remaining errors, if
    // any, are orthogonal backend-support constraints, not this fix).
    const { diagnostics: after } = await parseString(applied.text);
    expect(after.some((d) => d.code === "loom.es-tph-forced-own-table")).toBe(false);
    expect(after.some((d) => (d.data as { code?: string })?.code === "parsing-error")).toBe(false);
  });
});

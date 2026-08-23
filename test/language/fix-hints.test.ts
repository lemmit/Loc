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

/** The report for one source (the shape every case starts from). */
async function reportFor(src: string) {
  const { doc, model, diagnostics } = await parseString(src);
  return buildValidateReport({
    modelPath: "m.ddd",
    langiumDiagnostics: diagnostics,
    doc,
    irDiagnostics: [],
    model,
  });
}

/**
 * The whole point of a fix-hint: apply it and the model is CLEAN.
 *
 * Asserts the diagnostic carries a hint, applies the patch, re-parses, and
 * requires (a) the diagnostic is GONE and (b) no error at all remains — every
 * fixture below carries exactly one defect, so a leftover error is a new one
 * the fix introduced.  Returns the patched source for per-case shape asserts.
 */
async function closesTheLoop(
  src: string,
  code: string,
  expect_: { kind: string; op: string },
): Promise<string> {
  const report = await reportFor(src);
  const hint = report.diagnostics.find((d) => d.code === code)?.fixHint;
  expect(hint, `no fixHint on ${code}`).toBeDefined();
  expect(hint?.kind).toBe(expect_.kind);
  expect(hint?.patch?.op).toBe(expect_.op);

  const applied = await applyPatches(src, [hint?.patch as ModelPatch]);
  expect(applied.errors).toEqual([]);
  expect(applied.ok).toBe(true);

  const after = await parseString(applied.text);
  expect(after.diagnostics.some((d) => d.code === code)).toBe(false);
  expect(after.errors).toEqual([]);
  return applied.text;
}

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

  // -------------------------------------------------------------------------
  // The `data` channel — a validator that already COMPUTED the repair hands it
  // over as structured data, so the provider doesn't re-derive it (or scrape it
  // back out of the message prose).
  // -------------------------------------------------------------------------

  const TYPO = `context Sales {
  aggregate Order {
    qty: int
    operation bump(by: int) { qty := qtyy + by }
  }
}`;

  it("unknown-name: the did-you-mean suggestion reaches the provider on `data`", async () => {
    const { doc, model, diagnostics } = await parseString(TYPO);
    // End to end: the validator's `data` survives onto the LSP Diagnostic …
    const raw = diagnostics.find((d) => d.code === "loom.unknown-name");
    expect(raw?.data).toEqual({ suggestion: "qty" });
    // … and the provider turns it into a patch that swaps just the typo.
    const report = buildValidateReport({
      modelPath: "m.ddd",
      langiumDiagnostics: diagnostics,
      doc,
      irDiagnostics: [],
      model,
    });
    const hint = report.diagnostics.find((d) => d.code === "loom.unknown-name")?.fixHint;
    expect(hint?.summary).toBe("Did you mean 'qty'?");
    expect(hint?.patch).toMatchObject({
      op: "replace",
      target: "operation Sales.Order.bump",
      source: "operation bump(by: int) { qty := qty + by }",
    });
  });

  it("unknown-name: applying the suggestion closes the loop", async () => {
    const fixed = await closesTheLoop(TYPO, "loom.unknown-name", {
      kind: "replace-text",
      op: "replace",
    });
    expect(fixed).toContain("qty := qty + by");
  });

  it("unknown-name: no hint when the validator computed no suggestion", async () => {
    // `zzzzzzzz` is nowhere near an in-scope name, so `suggest` returns
    // undefined, no `data` is attached, and the provider stays silent.
    const report = await reportFor(`context Sales {
  aggregate Order {
    qty: int
    operation bump(by: int) { qty := zzzzzzzz + by }
  }
}`);
    const d = report.diagnostics.find((x) => x.code === "loom.unknown-name");
    expect(d).toBeDefined();
    expect(d?.fixHint).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Drop-the-rejected-marker batch
  // -------------------------------------------------------------------------

  it("entity-field-optional-collection: drops the '?' (round-trip clean)", async () => {
    const fixed = await closesTheLoop(
      `context Sales {
  aggregate Order {
    entity Line { qty: int }
    lines: Line[]?
  }
}`,
      "loom.entity-field-optional-collection",
      { kind: "replace-text", op: "replace" },
    );
    expect(fixed).toContain("lines: Line[]");
    expect(fixed).not.toContain("Line[]?");
  });

  it("entity-field-modifier: drops a flag modifier (round-trip clean)", async () => {
    const fixed = await closesTheLoop(
      `context Sales {
  aggregate Order {
    entity Line { qty: int }
    line: Line provenanced
  }
}`,
      "loom.entity-field-modifier",
      { kind: "replace-text", op: "replace" },
    );
    expect(fixed).toContain("line: Line\n");
    expect(fixed).not.toContain("provenanced");
  });

  it("entity-field-modifier: drops `= default` including the `=` (round-trip clean)", async () => {
    // The diagnostic's range covers only the default EXPRESSION, so the cut has
    // to extend back over the `=` or the remainder wouldn't parse.  (The
    // companion "default has type int but the field is declared Line" error is
    // the same defect seen by the type checker; it clears with the same fix.)
    const fixed = await closesTheLoop(
      `context Sales {
  aggregate Order {
    entity Line { qty: int }
    line: Line = 1
  }
}`,
      "loom.entity-field-modifier",
      { kind: "replace-text", op: "replace" },
    );
    expect(fixed).toContain("line: Line\n");
    expect(fixed).not.toContain("= 1");
  });

  it("entity-field-modifier: drops `check … message …` whole (round-trip clean)", async () => {
    const fixed = await closesTheLoop(
      `context Sales {
  aggregate Order {
    entity Line { qty: int }
    line: Line check 1 > 0 message "nope"
  }
}`,
      "loom.entity-field-modifier",
      { kind: "replace-text", op: "replace" },
    );
    expect(fixed).toContain("line: Line\n");
    expect(fixed).not.toMatch(/check|message/);
  });

  it("test-redundant-for: drops the redundant `for` head (round-trip clean)", async () => {
    const fixed = await closesTheLoop(
      `context Sales {
  aggregate Order {
    qty: int
    test "keeps qty" for Order { expect(1).toBe(1) }
  }
}`,
      "loom.test-redundant-for",
      { kind: "replace-text", op: "replace" },
    );
    expect(fixed).toContain(`test "keeps qty" { expect(1).toBe(1) }`);
  });

  it("test-redundant-for: no hint for the context-nested variant (unaddressable)", async () => {
    // A `test` sitting beside its aggregate in the context is not in the patch
    // applier's address space, so the provider declines rather than emitting a
    // target `applyPatches` would reject.
    const report = await reportFor(`context Sales {
  aggregate Order { qty: int }
  test "hoisted" for Sales { expect(1).toBe(1) }
}`);
    const d = report.diagnostics.find((x) => x.code === "loom.test-redundant-for");
    expect(d).toBeDefined();
    expect(d?.fixHint).toBeUndefined();
  });

  it("cross-aggregate-entity-part is unreachable — a foreign part never links", async () => {
    // Why there is no provider for it: the scope provider filters entity parts
    // of OTHER aggregates out of every bare-name type position, so the
    // reference fails linking and `checkTypeReferences` never sees a resolved
    // foreign part.  Pinned so the drop is a fact, not an assumption.
    const { diagnostics } = await parseString(`context Sales {
  aggregate Order {
    line: Line
  }
  aggregate Invoice {
    entity Line { qty: int }
  }
}`);
    expect(diagnostics.some((d) => d.code === "loom.cross-aggregate-entity-part")).toBe(false);
    expect(diagnostics.some((d) => (d.data as { code?: string })?.code === "linking-error")).toBe(
      true,
    );
  });

  // -------------------------------------------------------------------------
  // Insert-a-header-clause batch
  // -------------------------------------------------------------------------

  it("applier-on-non-event-sourced: inserts `persistedAs: eventLog` (round-trip clean)", async () => {
    const fixed = await closesTheLoop(
      `context Core {
  event Bumped { counter: Counter id, by: int }
  aggregate Counter {
    total: int
    operation bump(by: int) { emit Bumped { counter: id, by: by } }
    apply(e: Bumped) { total += e.by }
  }
}`,
      "loom.applier-on-non-event-sourced",
      { kind: "insert-decl", op: "insert" },
    );
    expect(fixed).toContain("aggregate Counter persistedAs: eventLog {");
  });

  it("applier-on-non-event-sourced: no hint when a `with` clause holds the header slot", async () => {
    // `header-end` splices just before the `{`, which would land AFTER the
    // trailing `with …` clause and no longer parse.
    const report = await reportFor(`context Core {
  event Bumped { counter: Counter id, by: int }
  aggregate Counter with auditable {
    total: int
    operation bump(by: int) { emit Bumped { counter: id, by: by } }
    apply(e: Bumped) { total += e.by }
  }
}`);
    const d = report.diagnostics.find((x) => x.code === "loom.applier-on-non-event-sourced");
    expect(d).toBeDefined();
    expect(d?.fixHint).toBeUndefined();
  });

  it("workflow-applier-on-non-event-sourced: inserts `eventSourced` (round-trip clean)", async () => {
    const fixed = await closesTheLoop(
      `context Core {
  aggregate Job persistedAs: eventLog {
    label: string
    create start() { emit Started { job: id } }
    apply(e: Started) { label := "" }
  }
  event Started { job: Job id }
  event Ticked { job: Job id, by: int }
  workflow Counter {
    jobId: Job id
    total: int
    create(s: Started) by s.job { emit Ticked { job: s.job, by: 1 } }
    apply(t: Ticked) { total := total + t.by }
  }
}`,
      "loom.workflow-applier-on-non-event-sourced",
      { kind: "insert-decl", op: "insert" },
    );
    expect(fixed).toContain("workflow Counter eventSourced {");
  });
});

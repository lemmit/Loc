// Origin spine — Phase 0 of docs/plans/source-map-debug-kickoff.md.  Asserts
// every listed structural IR node carries a real `.ddd` source span at
// lowering, that scaffolded (macro-synthesized) pages carry a macro chain
// pointing at the `with scaffold(...)` call site, that the origin survives
// enrichment, and that `resolveToSource` walks the chain correctly.

import { describe, expect, it } from "vitest";
import { resolveToSource } from "../../src/ir/types/origin.js";
import { buildLoomModel } from "../_helpers/index.js";

const SOURCE = `
  system Shop {
    subdomain Sales {
      context Orders {
        valueobject Money {
          amount: int
          currency: string
        }
        event OrderPlaced {
          orderId: string
        }
        aggregate Order {
          reference: string
          total: Money
          operation confirm() {}
        }
        repository Orders for Order { }
      }
    }
    deployable Api { platform: node  contexts: [Orders] }
  }
`;

describe("origin spine — source capture at lowering", () => {
  it("stamps a real .ddd span on each structural IR node", async () => {
    const loom = await buildLoomModel(SOURCE);
    const sys = loom.systems[0]!;
    const ctx = sys.subdomains[0]!.contexts[0]!;
    expect(ctx.name).toBe("Orders");

    // BoundedContextIR
    expect(ctx.origin?.kind).toBe("source");
    if (ctx.origin?.kind === "source") {
      expect(SOURCE.slice(ctx.origin.span.start, ctx.origin.span.end)).toContain("context Orders");
    }

    // AggregateIR
    const agg = ctx.aggregates.find((a) => a.name === "Order")!;
    expect(agg.origin?.kind).toBe("source");
    if (agg.origin?.kind === "source") {
      expect(SOURCE.slice(agg.origin.span.start, agg.origin.span.end)).toContain("aggregate Order");
    }

    // FieldIR
    const field = agg.fields.find((f) => f.name === "reference")!;
    expect(field.origin?.kind).toBe("source");
    if (field.origin?.kind === "source") {
      expect(SOURCE.slice(field.origin.span.start, field.origin.span.end)).toContain("reference");
    }

    // OperationIR
    const op = agg.operations.find((o) => o.name === "confirm")!;
    expect(op.origin?.kind).toBe("source");
    if (op.origin?.kind === "source") {
      expect(SOURCE.slice(op.origin.span.start, op.origin.span.end)).toContain("confirm");
    }

    // RepositoryIR
    const repo = ctx.repositories.find((r) => r.name === "Orders")!;
    expect(repo.origin?.kind).toBe("source");
    if (repo.origin?.kind === "source") {
      expect(SOURCE.slice(repo.origin.span.start, repo.origin.span.end)).toContain(
        "repository Orders",
      );
    }

    // ValueObjectIR
    const vo = ctx.valueObjects.find((v) => v.name === "Money")!;
    expect(vo.origin?.kind).toBe("source");
    if (vo.origin?.kind === "source") {
      expect(SOURCE.slice(vo.origin.span.start, vo.origin.span.end)).toContain("valueobject Money");
    }

    // EventIR
    const evt = ctx.events.find((e) => e.name === "OrderPlaced")!;
    expect(evt.origin?.kind).toBe("source");
    if (evt.origin?.kind === "source") {
      expect(SOURCE.slice(evt.origin.span.start, evt.origin.span.end)).toContain(
        "event OrderPlaced",
      );
    }
  });

  it("survives enrichment (buildLoomModel runs lower + enrich)", async () => {
    const loom = await buildLoomModel(SOURCE);
    const ctx = loom.systems[0]!.subdomains[0]!.contexts[0]!;
    const agg = ctx.aggregates.find((a) => a.name === "Order")!;
    // The enriched aggregate went through enrichAggregate's spread-based
    // rebuild (resolveFieldAccess / routeSlug stamping / wireShape) — origin
    // must still be attached, not dropped by a field-by-field reconstruction.
    expect(agg.origin?.kind).toBe("source");
    const op = agg.operations.find((o) => o.name === "confirm")!;
    expect(op.origin?.kind).toBe("source"); // survives the `stamp()` routeSlug rebuild too
  });
});

describe("origin spine — macro-synthesized pages", () => {
  const SCAFFOLD_SOURCE = `
    system Demo {
      subdomain Sales {
        context Orders {
          aggregate Order { subject: string }
          repository Orders for Order { }
        }
      }
      deployable Api { platform: node  contexts: [Orders] }
      ui App with scaffold(subdomains: [Sales]) { }
    }
  `;

  it("stamps a macro origin on scaffolded pages, pointing at the scaffold call site", async () => {
    const loom = await buildLoomModel(SCAFFOLD_SOURCE);
    const sys = loom.systems[0]!;
    const ui = sys.uis[0]!;
    expect(ui.pages.length).toBeGreaterThan(0);

    for (const p of ui.pages) {
      expect(p.origin?.kind).toBe("macro");
      if (p.origin?.kind !== "macro") continue;
      expect(p.origin.macro).toBe("scaffold");
      const callText = SCAFFOLD_SOURCE.slice(p.origin.call.span.start, p.origin.call.span.end);
      expect(callText).toContain("scaffold(subdomains: [Sales])");
    }
  });
});

describe("resolveToSource", () => {
  const src: import("../../src/ir/types/origin.js").SourceRef = {
    kind: "source",
    path: "/a.ddd",
    span: { start: 0, end: 10 },
  };

  it("resolves a macro chain to its call-site SourceRef", () => {
    const macro: import("../../src/ir/types/origin.js").MacroRef = {
      kind: "macro",
      macro: "scaffold",
      call: src,
    };
    expect(resolveToSource(macro)).toEqual(src);
  });

  it("resolves a derived-with-from chain through to the source", () => {
    const derived: import("../../src/ir/types/origin.js").DerivedRef = {
      kind: "derived",
      reason: "auto-findAll",
      from: src,
    };
    expect(resolveToSource(derived)).toEqual(src);
  });

  it("returns undefined for a bare derived ref with no `from`", () => {
    expect(resolveToSource({ kind: "derived", reason: "wireShape" })).toBeUndefined();
  });

  it("returns undefined for undefined input", () => {
    expect(resolveToSource(undefined)).toBeUndefined();
  });
});

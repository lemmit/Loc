// Origin spine — Phase 0 of docs/old/plans/source-map-debug-kickoff.md.  Asserts
// every listed structural IR node carries a real `.ddd` source span at
// lowering, that scaffolded (macro-synthesized) pages carry a macro chain
// pointing at the `with scaffold(...)` call site, that the origin survives
// enrichment, and that `resolveToSource` walks the chain correctly.

import { describe, expect, it } from "vitest";
import { allContexts } from "../../src/ir/types/loom-ir.js";
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

describe("statement origins", () => {
  const STMT_SOURCE = `
    system Shop {
      subdomain Sales {
        context Orders {
          event OrderPlaced {
            order: Order id
          }
          aggregate Order {
            reference: string
            operation confirm(): string {
              let tag = reference
              reference := tag
              emit OrderPlaced { order: id }
              return tag
            }
          }
          repository Orders for Order { }
        }
      }
      deployable Api { platform: node  contexts: [Orders] }
    }
  `;
  // Distinctive token per statement, in source order — used to assert each
  // span slices to ITS OWN statement's text, not merely somewhere inside the
  // enclosing operation.
  const TOKENS = ["let tag", "reference := tag", "emit OrderPlaced", "return tag"];

  it("stamps a distinct real .ddd span on every statement in an aggregate operation body", async () => {
    const loom = await buildLoomModel(STMT_SOURCE);
    const ctx = loom.systems[0]!.subdomains[0]!.contexts[0]!;
    const agg = ctx.aggregates.find((a) => a.name === "Order")!;
    const op = agg.operations.find((o) => o.name === "confirm")!;
    expect(op.statements.map((s) => s.kind)).toEqual(["let", "assign", "emit", "return"]);

    const spanKeys = op.statements.map((s, i) => {
      expect(s.origin?.kind, `statement ${i} (${s.kind}) has no source origin`).toBe("source");
      if (s.origin?.kind !== "source") return "";
      const text = STMT_SOURCE.slice(s.origin.span.start, s.origin.span.end);
      expect(text, `statement ${i} span doesn't contain its own token`).toContain(TOKENS[i]);
      return `${s.origin.span.start}:${s.origin.span.end}`;
    });
    // Spans must differ per statement — not all four collapsed onto the
    // enclosing operation's span.
    expect(new Set(spanKeys).size).toBe(spanKeys.length);
  });

  it("survives enrichment (buildLoomModel runs lower + enrich)", async () => {
    const loom = await buildLoomModel(STMT_SOURCE);
    const ctx = loom.systems[0]!.subdomains[0]!.contexts[0]!;
    const agg = ctx.aggregates.find((a) => a.name === "Order")!;
    const op = agg.operations.find((o) => o.name === "confirm")!;
    const letStmt = op.statements[0]!;
    expect(letStmt.origin?.kind).toBe("source");
    if (letStmt.origin?.kind === "source") {
      expect(STMT_SOURCE.slice(letStmt.origin.span.start, letStmt.origin.span.end)).toContain(
        "let tag",
      );
    }
  });

  const WORKFLOW_SOURCE = `
    context Sales {
      event TagAssigned {
        note: string
      }
      aggregate Order {
        tag: string
      }
      repository Orders for Order { }
      workflow TagFlow {
        create() {
          let picked = "alpha"
          emit TagAssigned { note: picked }
        }
      }
    }
  `;

  it("stamps a distinct real .ddd span on every statement in a workflow create body", async () => {
    const loom = await buildLoomModel(WORKFLOW_SOURCE);
    const ctx = allContexts(loom).find((c) => c.name === "Sales")!;
    const wf = ctx.workflows.find((w) => w.name === "TagFlow")!;
    const create = wf.creates[0]!;
    expect(create.statements.map((s) => s.kind)).toEqual(["expr-let", "emit"]);

    const tokens = ["let picked", "emit TagAssigned"];
    const spanKeys = create.statements.map((s, i) => {
      expect(s.origin?.kind, `workflow statement ${i} (${s.kind}) has no source origin`).toBe(
        "source",
      );
      if (s.origin?.kind !== "source") return "";
      const text = WORKFLOW_SOURCE.slice(s.origin.span.start, s.origin.span.end);
      expect(text, `workflow statement ${i} span doesn't contain its own token`).toContain(
        tokens[i],
      );
      return `${s.origin.span.start}:${s.origin.span.end}`;
    });
    expect(new Set(spanKeys).size).toBe(spanKeys.length);
  });
});

describe("expression origins", () => {
  const EXPR_SOURCE = `
    system Shop {
      subdomain Sales {
        context Orders {
          aggregate Order {
            reference: string
            a: int
            b: int
            c: int
            function double(x: int): int {
              return x * 2
            }
            operation confirm(): int {
              let tag = reference
              let total = a + b + c
              let doubled = double(a)
              return total
            }
          }
          repository Orders for Order { }
        }
      }
      deployable Api { platform: node  contexts: [Orders] }
    }
  `;

  it("stamps a let's RHS ref with its own exact .ddd token span", async () => {
    const loom = await buildLoomModel(EXPR_SOURCE);
    const ctx = loom.systems[0]!.subdomains[0]!.contexts[0]!;
    const agg = ctx.aggregates.find((a) => a.name === "Order")!;
    const op = agg.operations.find((o) => o.name === "confirm")!;
    const tagStmt = op.statements[0]!;
    expect(tagStmt.kind).toBe("let");
    if (tagStmt.kind !== "let") return;
    expect(tagStmt.expr.kind).toBe("ref");
    expect(tagStmt.expr.origin?.kind).toBe("source");
    if (tagStmt.expr.origin?.kind === "source") {
      expect(EXPR_SOURCE.slice(tagStmt.expr.origin.span.start, tagStmt.expr.origin.span.end)).toBe(
        "reference",
      );
    }
  });

  it("stamps a binary chain's OUTERMOST node with the whole chain's span; a folded inner node stays undefined", async () => {
    const loom = await buildLoomModel(EXPR_SOURCE);
    const ctx = loom.systems[0]!.subdomains[0]!.contexts[0]!;
    const agg = ctx.aggregates.find((a) => a.name === "Order")!;
    const op = agg.operations.find((o) => o.name === "confirm")!;
    const totalStmt = op.statements[1]!;
    expect(totalStmt.kind).toBe("let");
    if (totalStmt.kind !== "let") return;
    expect(totalStmt.expr.kind).toBe("binary");
    expect(totalStmt.expr.origin?.kind).toBe("source");
    if (totalStmt.expr.origin?.kind === "source") {
      expect(
        EXPR_SOURCE.slice(totalStmt.expr.origin.span.start, totalStmt.expr.origin.span.end),
      ).toBe("a + b + c");
    }
    // The fold's inner accumulator (`a + b`, the left operand of the
    // outermost `+ c` node) is a synthetic intermediate built directly by
    // `lowerBinaryChain`'s left-fold — never passed back through the
    // `lowerExpr` wrapper — so it carries no origin of its own.
    expect(totalStmt.expr.kind === "binary" && totalStmt.expr.left.origin).toBeUndefined();
  });

  it("stamps a call with the whole call expression's span", async () => {
    const loom = await buildLoomModel(EXPR_SOURCE);
    const ctx = loom.systems[0]!.subdomains[0]!.contexts[0]!;
    const agg = ctx.aggregates.find((a) => a.name === "Order")!;
    const op = agg.operations.find((o) => o.name === "confirm")!;
    const doubledStmt = op.statements[2]!;
    expect(doubledStmt.kind).toBe("let");
    if (doubledStmt.kind !== "let") return;
    expect(doubledStmt.expr.kind).toBe("call");
    expect(doubledStmt.expr.origin?.kind).toBe("source");
    if (doubledStmt.expr.origin?.kind === "source") {
      expect(
        EXPR_SOURCE.slice(doubledStmt.expr.origin.span.start, doubledStmt.expr.origin.span.end),
      ).toBe("double(a)");
    }
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

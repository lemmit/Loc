// Direct unit tests for Phoenix's `renderElixirStatements` —
// exercises each `StmtIR.kind` arm in
// `src/generator/phoenix-live-view/render-stmt.ts:33-102`.
// Statements appear inside Ash action `change` blocks and lower to
// changeset-threading lines of Elixir.

import { describe, expect, it } from "vitest";
import { renderElixirStatements } from "../../../src/generator/phoenix-live-view/render-stmt.js";
import type { EnrichedAggregateIR, ExprIR, StmtIR, TypeIR } from "../../../src/ir/types/loom-ir.js";

const ctx = { thisName: "record", contextModule: "MyApp" };

const INT: TypeIR = { kind: "primitive", name: "int" };
const STRING: TypeIR = { kind: "primitive", name: "string" };

const litInt = (v: string): ExprIR => ({ kind: "literal", lit: "int", value: v });
const litStr = (v: string): ExprIR => ({ kind: "literal", lit: "string", value: v });
const refParam = (name: string): ExprIR => ({ kind: "ref", name, refKind: "param" });

describe("phoenix renderElixirStatements — primitive arms", () => {
  it("renders `precondition` as an `if not (…), do: raise(...)` line", () => {
    const out = renderElixirStatements(
      [
        {
          kind: "precondition",
          expr: { kind: "literal", lit: "bool", value: "true" },
          source: "is positive",
        },
      ],
      ctx,
    );
    expect(out).toMatch(/if not \(true\), do: raise\(ArgumentError,/);
    expect(out).toMatch(/Precondition failed: is positive/);
  });

  it("renders `requires` as a `Forbidden:`-flavoured raise", () => {
    const out = renderElixirStatements(
      [
        {
          kind: "requires",
          expr: { kind: "literal", lit: "bool", value: "true" },
          source: "currentUser != null",
        },
      ],
      ctx,
    );
    expect(out).toMatch(/Forbidden: currentUser != null/);
  });

  it("renders `let` as a snake-cased local binding", () => {
    const out = renderElixirStatements(
      [{ kind: "let", name: "subtotal", expr: litInt("100"), type: INT }],
      ctx,
    );
    expect(out.trim()).toBe("subtotal = 100");
  });

  it("renders `assign` as Ash.Changeset.change_attribute on the head atom", () => {
    const out = renderElixirStatements(
      [
        {
          kind: "assign",
          target: { segments: ["totalCents"] },
          value: litInt("500"),
          targetType: INT,
        },
      ],
      ctx,
    );
    expect(out.trim()).toBe(
      "changeset = Ash.Changeset.change_attribute(changeset, :total_cents, 500)",
    );
  });

  it("threads a custom changesetVar through change_attribute", () => {
    const out = renderElixirStatements(
      [
        {
          kind: "assign",
          target: { segments: ["status"] },
          value: litStr("Open"),
          targetType: STRING,
        },
      ],
      ctx,
      "cs",
    );
    expect(out.trim()).toBe('cs = Ash.Changeset.change_attribute(cs, :status, "Open")');
  });
});

describe("phoenix renderElixirStatements — collection mutations", () => {
  it("renders containment-collection `add` as manage_relationship type: :create", () => {
    const out = renderElixirStatements(
      [
        {
          kind: "add",
          target: { segments: ["lines"] },
          value: refParam("lineItem"),
          elementType: { kind: "entity", name: "LineItem" },
        },
      ],
      ctx,
    );
    expect(out.trim()).toBe(
      "changeset = Ash.Changeset.manage_relationship(changeset, :lines, [line_item], type: :create)",
    );
  });

  it("renders containment-collection `remove` as manage_relationship type: :destroy", () => {
    const out = renderElixirStatements(
      [
        {
          kind: "remove",
          target: { segments: ["lines"] },
          value: refParam("line"),
          elementType: { kind: "entity", name: "LineItem" },
        },
      ],
      ctx,
    );
    expect(out.trim()).toBe(
      "changeset = Ash.Changeset.manage_relationship(changeset, :lines, [line], type: :destroy)",
    );
  });

  it("renders ref-collection `add` as :append with use_identities: [:id]", () => {
    const agg: EnrichedAggregateIR = {
      // Only the `associations` field is consulted by render-stmt.
      // The rest of the EnrichedAggregateIR shape is irrelevant here.
      // biome-ignore lint/suspicious/noExplicitAny: minimal mock
      ...({} as any),
      associations: [
        {
          fieldName: "party",
          owner: "Trainer",
          target: "Pokemon",
          owningField: "party",
        },
      ],
    } as EnrichedAggregateIR;

    const out = renderElixirStatements(
      [
        {
          kind: "add",
          target: { segments: ["party"] },
          value: refParam("pokemonId"),
          elementType: { kind: "id", targetName: "Pokemon", valueType: "guid" },
        },
      ],
      { ...ctx, agg },
    );
    expect(out.trim()).toBe(
      "changeset = Ash.Changeset.manage_relationship(changeset, :party_through, [pokemon_id], type: :append, use_identities: [:id])",
    );
  });

  it("renders ref-collection `remove` as :remove (not :destroy)", () => {
    const agg = {
      associations: [
        { fieldName: "party", owner: "Trainer", target: "Pokemon", owningField: "party" },
      ],
    } as EnrichedAggregateIR;
    const out = renderElixirStatements(
      [
        {
          kind: "remove",
          target: { segments: ["party"] },
          value: refParam("pokemonId"),
          elementType: { kind: "id", targetName: "Pokemon", valueType: "guid" },
        },
      ],
      { ...ctx, agg },
    );
    expect(out.trim()).toBe(
      "changeset = Ash.Changeset.manage_relationship(changeset, :party_through, [pokemon_id], type: :remove, use_identities: [:id])",
    );
  });
});

describe("phoenix renderElixirStatements — emit / call / expression", () => {
  it("renders `emit` as a Phoenix.PubSub.broadcast with module-qualified event struct", () => {
    const out = renderElixirStatements(
      [
        {
          kind: "emit",
          eventName: "orderPlaced",
          fields: [{ name: "orderId", value: refParam("id") }],
        },
      ],
      ctx,
    );
    expect(out.trim()).toBe(
      'Phoenix.PubSub.broadcast(MyApp.PubSub, "events", %MyApp.Events.OrderPlaced{order_id: id})',
    );
  });

  it("renders `call` (private-operation) with receiver prepended and snake name", () => {
    const out = renderElixirStatements(
      [
        {
          kind: "call",
          target: "private-operation",
          name: "computeTotals",
          args: [litInt("3")],
        },
      ],
      ctx,
    );
    expect(out.trim()).toBe("compute_totals(record, 3)");
  });

  it("renders `expression` as a bare snake-cased expression statement", () => {
    const out = renderElixirStatements(
      [
        {
          kind: "expression",
          expr: { kind: "ref", name: "ping", refKind: "helper-fn" },
        },
      ],
      ctx,
    );
    expect(out.trim()).toBe("ping");
  });
});

describe("phoenix renderElixirStatements — multi-statement composition", () => {
  it("joins successive statements with newlines and preserves indent", () => {
    const stmts: StmtIR[] = [
      { kind: "let", name: "x", expr: litInt("1"), type: INT },
      { kind: "let", name: "y", expr: litInt("2"), type: INT },
    ];
    const out = renderElixirStatements(stmts, ctx);
    expect(out.split("\n")).toEqual(["      x = 1", "      y = 2"]);
  });
});

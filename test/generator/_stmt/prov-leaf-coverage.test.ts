// ---------------------------------------------------------------------------
// A provenanced write records EVERY leaf input of its RHS — including the ones
// behind a `convert`.
//
// `collectLeaves` was a hand-written nine-arm switch (copied verbatim into four
// backends before #2637 lifted it here) that simply had no case for `convert` /
// `duration` / `list` / `i18nFormat` / `match`'s variant arms.  A missing arm is
// not an error, it is a SILENT STOP: the walk returns and the leaf below is
// never recorded.  So
//
//     total := money(subtotal) * factor
//
// snapshotted `factor` and NOT `subtotal` — the lineage published a computed
// value whose main input is absent, which #2653's `Provenanced<T>` then put on
// the wire.
//
// The traversal now delegates to `walkExprChildren` (`src/ir/util/walk.ts`),
// which is `never`-checked over every `ExprIR.kind`, so a newly added kind
// fails the build rather than quietly dropping lineage.  The two
// binding-introducing slots — a lambda body and a `match` variant arm — stay
// undescended on purpose: the snapshot line is emitted in the ENCLOSING scope,
// so a leaf named there would not compile.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { collectLeaves } from "../../../src/generator/_stmt/leaves.js";
import type { ExprIR } from "../../../src/ir/types/loom-ir.js";
import { generateSystemFiles } from "../../_helpers/generate.js";

/** Render a leaf the way a backend would — enough to tell the leaves apart. */
const render = (e: ExprIR): string =>
  e.kind === "ref" ? e.name : e.kind === "member" ? `${render(e.receiver)}.${e.member}` : "?";

const prop = (name: string): ExprIR => ({ kind: "ref", name, refKind: "this-prop" });
const paths = (e: ExprIR) => collectLeaves(e, render).map((l) => l.path);

describe("collectLeaves — arms the hand-written switch dropped", () => {
  it("descends a `convert` (money(subtotal) * factor)", () => {
    const rhs: ExprIR = {
      kind: "binary",
      op: "*",
      left: { kind: "convert", target: "money", from: "decimal", value: prop("subtotal") },
      right: prop("factor"),
    };
    expect(paths(rhs)).toEqual(["subtotal", "factor"]);
  });

  it("descends a `duration` amount", () => {
    const rhs: ExprIR = { kind: "duration", unit: "days", amount: prop("term") };
    expect(paths(rhs)).toEqual(["term"]);
  });

  it("descends `list` elements", () => {
    const rhs: ExprIR = { kind: "list", elements: [prop("a"), prop("b")] };
    expect(paths(rhs)).toEqual(["a", "b"]);
  });

  it("descends an `i18nFormat` wrapper", () => {
    const rhs: ExprIR = { kind: "i18nFormat", inner: prop("amount"), format: ", number" };
    expect(paths(rhs)).toEqual(["amount"]);
  });

  it("descends a `match` SUBJECT", () => {
    const rhs: ExprIR = {
      kind: "match",
      subject: prop("state"),
      arms: [{ cond: prop("isDraft"), value: prop("draftTotal") }],
      variantArms: [],
      otherwise: prop("fallback"),
    };
    expect(paths(rhs)).toEqual(["state", "isDraft", "draftTotal", "fallback"]);
  });
});

describe("collectLeaves — binding-introducing slots stay undescended", () => {
  it("records a lambda's RECEIVER, never a name bound inside it", () => {
    // `lines.sum(l => l.price)` — `l` exists only inside the lambda, but the
    // snapshot is emitted before the write, in the enclosing scope.
    const rhs: ExprIR = {
      kind: "method-call",
      receiver: prop("lines"),
      method: "sum",
      args: [
        {
          kind: "lambda",
          params: [{ name: "l" }],
          body: {
            kind: "member",
            receiver: { kind: "ref", name: "l", refKind: "param" },
            member: "price",
          },
        },
      ],
      callKind: "collection-op",
    } as ExprIR;
    expect(paths(rhs)).toEqual(["lines"]);
  });

  it("skips a `match` variant arm's bound value", () => {
    const rhs: ExprIR = {
      kind: "match",
      subject: prop("result"),
      arms: [],
      variantArms: [
        {
          varType: { kind: "primitive", name: "string" },
          binding: "ok",
          value: {
            kind: "member",
            receiver: { kind: "ref", name: "ok", refKind: "param" },
            member: "total",
          },
        },
      ],
    } as ExprIR;
    expect(paths(rhs)).toEqual(["result"]);
  });
});

it("the emitted node snapshot line names the leaf behind the convert", async () => {
  // The end-to-end shape of the same defect: `money(subtotal)` is a `convert`,
  // so the snapshot array recorded `factor` alone and shipped a lineage whose
  // main input was missing.
  const files = await generateSystemFiles(`
system ProvSys {
  subdomain Ordering {
    context Ordering {
      aggregate Order with crudish {
        reference: string
        subtotal: decimal
        factor: decimal
        total: money provenanced

        operation reprice(f: decimal) {
          factor := f
          total := money(subtotal) * factor
        }
        derived display: string = reference
      }
      repository Orders for Order { }
    }
  }
  storage primary { type: postgres }
  resource orderingState { for: Ordering, kind: state, use: primary }
  api OrderingApi from Ordering
  deployable api { platform: node contexts: [Ordering] dataSources: [orderingState] serves: OrderingApi port: 4400 }
}`);
  const domain = [...files].find(([p]) => /domain\/order\.ts$/.test(p))?.[1] ?? "";
  expect(domain, "no Order domain class emitted").not.toBe("");
  const snapshot = domain.split("\n").find((l) => /const __prov_\d+ = \[/.test(l)) ?? "";
  expect(snapshot, "no provenance snapshot line emitted").not.toBe("");
  expect(snapshot, "the leaf behind `money(...)` is missing from the lineage").toContain(
    'path: "subtotal"',
  );
  expect(snapshot).toContain('path: "factor"');
});

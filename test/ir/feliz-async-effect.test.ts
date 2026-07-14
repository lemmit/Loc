// Feliz `match await` async-effect shape classifier (M-T6.15).
//
// `classifyFelizAsyncEffect` is the shared arbiter between the
// `loom.feliz-async-effect-unsupported` validator gate and the Feliz generator —
// a shape the generator renders is exactly a shape the gate lets through.  This
// pins the supported v1 shape and each honest-gate reason, driven off the LOWERED
// `variant-match` StmtIR (so it doubles as the variant-match-lowering check).

import { describe, expect, it } from "vitest";
import { lowerModel } from "../../src/ir/lower/lower.js";
import type { StmtIR } from "../../src/ir/types/loom-ir.js";
import { classifyFelizAsyncEffect } from "../../src/ir/util/feliz-async-effect.js";
import { parseString } from "../_helpers/parse.js";

// Lower a source and pull the first `variant-match` statement out of the named
// page action's body — the `match await` lowering under test.
async function variantMatch(src: string, page: string, action: string) {
  const { model, errors } = await parseString(src);
  if (errors.length) throw new Error(`unexpected parse errors:\n${errors.join("\n")}`);
  const loom = lowerModel(model);
  const ui = loom.systems.flatMap((s) => s.uis).find((u) => u.pages.some((p) => p.name === page))!;
  const pg = ui.pages.find((p) => p.name === page)!;
  const act = pg.actions.find((a) => a.name === action)!;
  const vm = act.body.find(
    (s): s is Extract<StmtIR, { kind: "variant-match" }> => s.kind === "variant-match",
  );
  if (!vm) throw new Error(`no variant-match in ${page}.${action}`);
  return { vm, apiParamNames: new Set(ui.apiParams.map((p) => p.name)) };
}

// A system whose detail page hosts a `match await` we vary per test.  `op` is the
// op signature+body, `armsAndElse` the match arms.
const sys = (op: string, armsAndElse: string) => `
system Demo {
  subdomain S {
    context C {
      error OrderMissing { missingRef: string }
      aggregate Order with crudish {
        customerId: string
        ${op}
      }
    }
  }
  api A from S
  ui Web {
    api C: A
    page Detail(id: Order id) {
      route: "/orders/:id"
      state { draftName: string = "" }
      action reserveNow() {
        match await C.Order.reserve() {
${armsAndElse}
        }
      }
      body: Heading { "D", level: 1 }
    }
  }
  storage primary { type: postgres }
  resource st { for: C, kind: state, use: primary }
  deployable api { platform: node contexts: [C] dataSources: [st] serves: A port: 3000 }
  deployable web { platform: feliz targets: api ui: Web { C: api } port: 3001 }
}`;

const AGGS = new Set(["Order"]);

describe("classifyFelizAsyncEffect (M-T6.15)", () => {
  it("accepts the v1 shape — 0-arg instance op, one aggregate SUCCESS arm + else", async () => {
    const { vm, apiParamNames } = await variantMatch(
      sys(
        "operation reserve(): Order or OrderMissing { return OrderMissing { missingRef: customerId } }",
        '          Order o => { draftName := o.customerId }\n          else    => { draftName := "x" }',
      ),
      "Detail",
      "reserveNow",
    );
    const cls = classifyFelizAsyncEffect(vm, apiParamNames, AGGS);
    expect(cls.supported).toBe(true);
    if (cls.supported) {
      expect(cls.shape.opAggregate).toBe("Order");
      expect(cls.shape.op).toBe("reserve");
      expect(cls.shape.successAggregate).toBe("Order");
      expect(cls.shape.binding).toBe("o");
      expect(cls.shape.successBody.length).toBeGreaterThan(0);
      expect(cls.shape.elseBody.length).toBeGreaterThan(0);
    }
  });

  it("gates a genuine multi-variant union (>1 match arm)", async () => {
    const { vm, apiParamNames } = await variantMatch(
      sys(
        "operation reserve(): Order or OrderMissing { return OrderMissing { missingRef: customerId } }",
        "          Order o        => { draftName := o.customerId }\n" +
          "          OrderMissing e => { draftName := e.missingRef }\n" +
          '          else           => { draftName := "x" }',
      ),
      "Detail",
      "reserveNow",
    );
    const cls = classifyFelizAsyncEffect(vm, apiParamNames, AGGS);
    expect(cls.supported).toBe(false);
    if (!cls.supported) expect(cls.reason).toMatch(/match arms/);
  });

  it("gates an op with params (a non-0-arg awaited call)", async () => {
    const { vm, apiParamNames } = await variantMatch(
      sys(
        "operation reserve(note: string): Order or OrderMissing { return OrderMissing { missingRef: note } }",
        '          Order o => { draftName := o.customerId }\n          else    => { draftName := "x" }',
      ).replace("C.Order.reserve()", 'C.Order.reserve("hi")'),
      "Detail",
      "reserveNow",
    );
    const cls = classifyFelizAsyncEffect(vm, apiParamNames, AGGS);
    expect(cls.supported).toBe(false);
    if (!cls.supported) expect(cls.reason).toMatch(/0-argument/);
  });
});

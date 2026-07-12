// `when` canCommand gate (criterion.md, use site 2) — IR side.
//
// `operation x() when <pred> { … }` lowers the predicate into
// `OperationIR.when` in the AGGREGATE env (op params are out of scope),
// and the validators pin the surface: param references are rejected, the
// predicate must be bool, private ops warn (no route → no gate), and a
// java-hosted context is gated (`loom.when-unsupported`) until its
// emitters land (node / dotnet / python / elixir emit the gate + can-query).

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { allContexts } from "../../src/ir/types/loom-ir.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

const SRC = `
  context Orders {
    enum OrderStatus { Draft, Shipped, Cancelled }
    aggregate Order {
      status: OrderStatus
      operation cancel() when this.status != Shipped {
        status := Cancelled
      }
    }
    repository Orders for Order { }
  }
`;

describe("when gate — lowering", () => {
  it("lowers the predicate into OperationIR.when", async () => {
    const { model, errors } = await parseString(SRC);
    expect(errors).toEqual([]);
    const ctx = allContexts(lowerModel(model)).find((c) => c.name === "Orders")!;
    const op = ctx.aggregates[0]!.operations.find((o) => o.name === "cancel")!;
    expect(op.when).toBeDefined();
    expect(op.when!.kind).toBe("binary");
  });
});

describe("when gate — language validators", () => {
  const errsOf = async (src: string): Promise<string[]> => {
    const { errors } = await parseString(src);
    return errors ?? [];
  };

  it("rejects a parameter reference in the predicate", async () => {
    const errors = await errsOf(`
      context Orders {
        aggregate Order {
          total: int
          operation pay(amount: int) when amount > 0 { total := amount }
        }
        repository Orders for Order { }
      }
    `);
    expect(errors.some((e) => /references parameter 'amount'/.test(e))).toBe(true);
  });

  it("rejects a non-bool predicate", async () => {
    const errors = await errsOf(`
      context Orders {
        aggregate Order {
          note: string
          operation touch() when this.note { note := "x" }
        }
        repository Orders for Order { }
      }
    `);
    expect(errors.some((e) => /'when' must be of type 'bool'/.test(e))).toBe(true);
  });
});

describe("when gate — backend support (loom.when-unsupported)", () => {
  const sysWith = (platform: string): string => `
    system S {
      subdomain D {
        context Orders {
          enum OrderStatus { Draft, Shipped }
          aggregate Order {
            status: OrderStatus
            operation ship() when this.status != Shipped { status := Shipped }
          }
          repository Orders for Order { }
        }
      }
      storage pg { type: postgres }
      resource s { for: Orders, kind: state, use: pg }
      deployable api { platform: ${platform}, contexts: [Orders], dataSources: [s], port: 4000 }
    }`;

  const codes = async (platform: string): Promise<string[]> => {
    const { model } = await parseString(sysWith(platform), { validate: false });
    return validateLoomModel(enrichLoomModel(lowerModel(model)))
      .filter((d) => d.code === "loom.when-unsupported")
      .map((d) => d.message);
  };

  // All five backends now ship the `when` gate + can_<op> companion, so the
  // `loom.when-unsupported` guard is latent — it can no longer be triggered by
  // a real `platform:` keyword (the grammar's Platform set is closed).  It
  // stays in place as the safety net for any future backend that lands before
  // its `when` emitter does; this test pins that every shipping backend passes.
  it("passes on every backend — node, dotnet, python, elixir and java all emit the gate", async () => {
    expect(await codes("node")).toEqual([]);
    expect(await codes("dotnet")).toEqual([]);
    expect(await codes("python")).toEqual([]);
    expect(await codes("elixir")).toEqual([]);
    expect(await codes("java")).toEqual([]);
  });
});

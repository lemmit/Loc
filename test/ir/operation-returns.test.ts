// Operation `or`-union return types + `return` statements (exception-less.md,
// spike).  Covers the surface (an operation may declare `: X or NotFound` and
// `return` a value), lowering (`OperationIR.returnType` + a `return` StmtIR),
// and the surface-first not-implemented gate (`loom.operation-return-unsupported`)
// that blocks producer-side emission until the next slice.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { allContexts } from "../../src/ir/types/loom-ir.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { isReturnStmt } from "../../src/language/generated/ast.js";
import { parseRaw, parseString } from "../_helpers/parse.js";

const SRC = `
  context Shop {
    error NotFound { resource: string }
    aggregate Order ids guid {
      code: string
      operation lookup(): string or NotFound {
        return code
      }
    }
  }
`;

describe("operation returns — surface (exception-less spike)", () => {
  it("parses an `or`-union return type + a `return` statement", () => {
    const model = parseRaw(SRC);
    const ctx = model.members.find((m) => m.$type === "BoundedContext") as never;
    const agg = (ctx as { members: { $type: string; name: string }[] }).members.find(
      (m) => m.$type === "Aggregate" && m.name === "Order",
    ) as { members: { $type: string; name?: string; returnType?: unknown; body?: unknown[] }[] };
    const op = agg.members.find((m) => m.$type === "Operation" && m.name === "lookup")!;
    expect(op.returnType).toBeTruthy();
    expect((op.body ?? []).some((s) => isReturnStmt(s as never))).toBe(true);
  });
});

describe("operation returns — lowering (exception-less spike)", () => {
  it("lowers the return type to a union TypeIR + a `return` StmtIR", async () => {
    const { model } = await parseString(SRC, { validate: false });
    const ctx = allContexts(lowerModel(model)).find((c) => c.name === "Shop")!;
    const op = ctx.aggregates
      .find((a) => a.name === "Order")!
      .operations.find((o) => o.name === "lookup")!;
    expect(op.returnType).toEqual({
      kind: "union",
      variants: [
        { kind: "primitive", name: "string" },
        { kind: "entity", name: "NotFound" },
      ],
    });
    expect(op.statements.some((s) => s.kind === "return")).toBe(true);
  });
});

describe("operation returns — platform-aware emission gate (exception-less spike)", () => {
  // A return-typed operation served by the named backend platform.
  const sysWith = (platform: string): string => `
    system Shop {
      subdomain Sales {
        context Shop {
          error NotFound { resource: string }
          aggregate Order ids guid {
            code: string
            operation lookup(): string or NotFound { return code }
          }
        }
      }
      storage pg { type: postgres }
      resource shopState { for: Shop, kind: state, use: pg }
      deployable api { platform: ${platform}, contexts: [Shop], dataSources: [shopState], port: 4000 }
    }`;

  const gateDiags = async (platform: string): Promise<string[]> => {
    const { model } = await parseString(sysWith(platform), { validate: false });
    return validateLoomModel(enrichLoomModel(lowerModel(model)))
      .filter((d) => d.code === "loom.operation-return-unsupported")
      .map((d) => d.message);
  };

  it("does NOT gate a return-typed operation served by hono/node (route translation implemented)", async () => {
    expect(await gateDiags("node")).toEqual([]);
  });

  it("does NOT gate a return-typed operation served by dotnet (producer translation implemented)", async () => {
    expect(await gateDiags("dotnet")).toEqual([]);
  });

  it("does NOT gate a return-dominant operation served by elixir (vanilla)", async () => {
    // `platform: elixir` is vanilla; a return-dominant body (`return code`)
    // is served on plain Ecto/Phoenix, so parity is restored.
    expect(await gateDiags("elixir")).toEqual([]);
  });

  it("does NOT gate an `emit`-bodied returning operation on elixir (vanilla)", async () => {
    const sys = `
      system Shop {
        subdomain Sales {
          context Shop {
            error NotFound { resource: string }
            event Accepted { code: string }
            aggregate Order ids guid {
              code: string
              operation accept(): string or NotFound { emit Accepted { code: code }  return code }
            }
          }
        }
        storage pg { type: postgres }
        resource shopState { for: Shop, kind: state, use: pg }
        deployable api { platform: elixir, contexts: [Shop], dataSources: [shopState], port: 4000 }
      }`;
    const { model } = await parseString(sys, { validate: false });
    const diags = validateLoomModel(enrichLoomModel(lowerModel(model))).filter(
      (d) => d.code === "loom.operation-return-unsupported",
    );
    expect(diags).toEqual([]);
  });

  it("does NOT gate an `add`/`remove`-bodied returning operation on elixir (vanilla)", async () => {
    const sys = `
      system Shop {
        subdomain Sales {
          context Shop {
            error NotFound { resource: string }
            aggregate Tag ids guid { label: string }
            aggregate Order ids guid {
              code: string
              tags: Tag id[]
              operation tag(t: Tag id): Order or NotFound { tags += t }
            }
          }
        }
        storage pg { type: postgres }
        resource shopState { for: Shop, kind: state, use: pg }
        deployable api { platform: elixir, contexts: [Shop], dataSources: [shopState], port: 4000 }
      }`;
    const { model } = await parseString(sys, { validate: false });
    const diags = validateLoomModel(enrichLoomModel(lowerModel(model))).filter(
      (d) => d.code === "loom.operation-return-unsupported",
    );
    expect(diags).toEqual([]);
  });

  it("does NOT gate the same mutation-then-return operation on elixir/vanilla", async () => {
    const sys = `
      system Shop {
        subdomain Sales {
          context Shop {
            error NotFound { resource: string }
            aggregate Order ids guid {
              code: string
              reserved: bool
              operation accept(): string or NotFound { reserved := true  return code }
            }
          }
        }
        storage pg { type: postgres }
        resource shopState { for: Shop, kind: state, use: pg }
        deployable api { platform: elixir, contexts: [Shop], dataSources: [shopState], port: 4000 }
      }`;
    const { model } = await parseString(sys, { validate: false });
    const diags = validateLoomModel(enrichLoomModel(lowerModel(model))).filter(
      (d) => d.code === "loom.operation-return-unsupported",
    );
    expect(diags).toEqual([]);
  });

  it("does not fire on a plain mutation operation (no return type)", async () => {
    const { model } = await parseString(
      `context Shop {
        aggregate Order ids guid { code: string  operation rename(c: string) { code := c } }
      }`,
      { validate: false },
    );
    const diags = validateLoomModel(enrichLoomModel(lowerModel(model)));
    expect(diags.some((d) => d.code === "loom.operation-return-unsupported")).toBe(false);
  });
});

describe("operation returns — scalar (non-union) returns stay valid (BUG-003 not gated)", () => {
  // A bare scalar operation return (`operation describe(): string`) compiles on
  // every backend (the op-self-call build fixtures depend on it). Its HTTP wire
  // contract diverges (200-with-body vs 204-discard) — BUG-003 — but that is a
  // real gap to converge, NOT a reason to reject the feature: an earlier gate
  // (`loom.operation-return-scalar-unsupported`) did exactly that and broke the
  // shipped op-self-call pattern. This guards that scalar returns stay valid.
  const scalarSys = (ret: string): string => `
    system Shop {
      subdomain Sales {
        context Shop {
          aggregate Order ids guid {
            code: string
            operation describe(): ${ret} { return code }
            derived display: string = code
          }
        }
      }
      storage pg { type: postgres }
      resource shopState { for: Shop, kind: state, use: pg }
      deployable api { platform: node, contexts: [Shop], dataSources: [shopState], port: 4000 }
    }`;

  it("does NOT reject a bare scalar operation return", async () => {
    const { model } = await parseString(scalarSys("string"), { validate: false });
    const diags = validateLoomModel(enrichLoomModel(lowerModel(model)));
    expect(diags.some((d) => d.code === "loom.operation-return-scalar-unsupported")).toBe(false);
    // No new IR error is introduced for the scalar return.
    expect(diags.filter((d) => d.severity === "error")).toHaveLength(0);
  });

  it("does NOT gate an `or`-union operation return (the supported form)", async () => {
    const { model } = await parseString(
      `system Shop {
        subdomain Sales {
          context Shop {
            error NotFound { resource: string }
            aggregate Order ids guid {
              code: string
              operation lookup(): string or NotFound { return code }
            }
          }
        }
        storage pg { type: postgres }
        resource shopState { for: Shop, kind: state, use: pg }
        deployable api { platform: node, contexts: [Shop], dataSources: [shopState], port: 4000 }
      }`,
      { validate: false },
    );
    const diags = validateLoomModel(enrichLoomModel(lowerModel(model)));
    expect(diags.some((d) => d.code === "loom.operation-return-scalar-unsupported")).toBe(false);
  });
});

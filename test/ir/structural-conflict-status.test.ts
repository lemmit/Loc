// M-T3.4(a) — the structural-conflict built-ins (`UniquenessConflict` /
// `ConcurrencyConflict` / `Disallowed` / `ReferencedInUse`, expressible-builtins
// §3) route their HTTP status through the SAME `httpStatus <Error> <Code>`
// override path as user errors. Absent an override each resolves to 409 (the
// hardcoded literal every backend used to emit); an override retargets BOTH the
// runtime arm and the OpenAPI declaration, so the two can no longer drift.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { generateSystemFiles } from "../_helpers/generate.js";
import { parseString } from "../_helpers/parse.js";

// An Order with a `unique` key (→ UniquenessConflict) and a `when`-gated
// operation (→ Disallowed), surfaced by an api that can carry `httpStatus`
// overrides.
const SYS = (apiBody: string) => `
  system Shop {
    subdomain Sales {
      context Shop {
        enum OrderStatus { Draft, Shipped, Cancelled }
        aggregate Order with crudish {
          code: string
          status: OrderStatus
          unique (code)
          operation cancel() when this.status != Shipped && this.status != Cancelled {
            status := Cancelled
          }
        }
      }
    }
    api SalesApi from Sales ${apiBody}
    storage pg { type: postgres }
    resource shopState { for: Shop, kind: state, use: pg }
    deployable api { platform: node, contexts: [Shop], dataSources: [shopState], port: 4000 }
  }
`;

const fold = async (apiBody: string) => {
  const { model } = await parseString(SYS(apiBody), { validate: false });
  return enrichLoomModel(lowerModel(model)).systems[0]!.structuralErrorStatuses;
};

describe("structural-conflict status — app-wide fold (enrichment)", () => {
  it("defaults every structural conflict to 409 when no `httpStatus` override is declared", async () => {
    expect(await fold("")).toEqual({
      UniquenessConflict: 409,
      ConcurrencyConflict: 409,
      Disallowed: 409,
      ReferencedInUse: 409,
    });
  });

  it("applies a `httpStatus <StructuralConflict> <Code>` override, leaving the rest at 409", async () => {
    expect(
      await fold("{ httpStatus UniquenessConflict -> 422 httpStatus Disallowed -> 423 }"),
    ).toEqual({
      UniquenessConflict: 422,
      ConcurrencyConflict: 409,
      Disallowed: 423,
      ReferencedInUse: 409,
    });
  });
});

describe("structural-conflict status — Hono route translation", () => {
  const orderRoutes = async (apiBody: string) => {
    const files = await generateSystemFiles(SYS(apiBody));
    return [...files.entries()].find(([p]) => p.endsWith("order.routes.ts"))?.[1] ?? "";
  };

  it("emits the hardcoded 409 for the unique + when arms with no override (byte-identical default)", async () => {
    const routes = await orderRoutes("");
    expect(routes).toContain(
      'return problem(409, "Conflict", `A Order with these values already exists.`);',
    );
    expect(routes).toContain('return problem(409, "Disallowed", err.message);');
    // The when-gated operation route declares 409 in OpenAPI (unchanged default).
    expect(routes).toMatch(/409: \{ description: "Conflict"/);
  });

  it("retargets both the runtime arm and the OpenAPI declaration under an override", async () => {
    const routes = await orderRoutes(
      "{ httpStatus UniquenessConflict -> 422 httpStatus Disallowed -> 423 }",
    );
    // Runtime arms move to the overridden status.
    expect(routes).toContain(
      'return problem(422, "Conflict", `A Order with these values already exists.`);',
    );
    expect(routes).toContain('return problem(423, "Disallowed", err.message);');
    // The `problem` helper's status union widens to exactly the emitted set — no
    // concurrency arm here, so 409 is legitimately absent.
    expect(routes).toMatch(/const problem = \(status: 400 \| 403 \| 404 \| 422 \| 423 \| 500,/);
    // The when-gated operation route declares 423 (Disallowed) in OpenAPI, with
    // its real reason phrase.
    expect(routes).toMatch(/423: \{ description: "Locked"/);
  });
});

describe("structural-conflict status — reserved-name guard (validator)", () => {
  const warnings = async (contextBody: string): Promise<string[]> => {
    const src = `
      system Shop {
        subdomain Sales {
          context Shop {
            ${contextBody}
            aggregate Order { code: string }
          }
        }
        api SalesApi from Sales
        storage pg { type: postgres }
        resource shopState { for: Shop, kind: state, use: pg }
        deployable api { platform: node, contexts: [Shop], dataSources: [shopState], port: 4000 }
      }
    `;
    const { model } = await parseString(src, { validate: false });
    return validateLoomModel(enrichLoomModel(lowerModel(model)))
      .filter((d) => d.code === "loom.reserved-structural-error-name")
      .map((d) => d.message);
  };

  it("warns when a user `error` collides with a structural-conflict built-in name", async () => {
    const w = await warnings("error UniquenessConflict { field: string }");
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("UniquenessConflict");
    expect(w[0]).toContain("reserved");
  });

  it("is silent for a non-colliding user error name", async () => {
    expect(await warnings("error OutOfStock { sku: string }")).toEqual([]);
  });
});

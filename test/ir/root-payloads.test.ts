// Root-level (file-scope) payload declarations — the ambient shared kernel for
// transport types (exception-less.md A1).  `error`/`payload`/… declared outside
// any context are visible from every context's `or`-union variants + builder-
// call constructions, mirroring root-level value objects.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { allContexts } from "../../src/ir/types/loom-ir.js";
import { parseString, parseValid } from "../_helpers/parse.js";

describe("root-level payloads — surface + resolution", () => {
  it("resolves an ambient `error` in a find `or`-union variant (no per-context redeclare)", async () => {
    const { errors } = await parseString(
      `
      error NotFound { resource: string }
      context Shop {
        aggregate Order { code: string }
        repository Orders for Order { find recent(): Order or NotFound }
      }
    `,
      { validate: true },
    );
    expect(errors).toEqual([]);
  });

  it("resolves an ambient `error` as an operation-return variant + builder-call construction", async () => {
    const { errors } = await parseString(
      `
      error NotFound { resource: string }
      context Shop {
        aggregate Order {
          code: string
          operation lookup(): string or NotFound { return NotFound { resource: code } }
        }
      }
    `,
      { validate: true },
    );
    expect(errors).toEqual([]);
  });

  it("flags a typo on an ambient payload name (unknown builder type)", async () => {
    const { errors } = await parseString(
      `
      error NotFound { resource: string }
      context Shop {
        aggregate Order {
          code: string
          operation lookup(): string or NotFound { return NotFund { resource: code } }
        }
      }
    `,
      { validate: true },
    );
    expect(errors.some((e) => /Unknown builder type 'NotFund'/.test(e))).toBe(true);
  });
});

describe("root-level payloads — lowering + enrichment", () => {
  const SRC = `
    error NotFound { resource: string }
    context Shop {
      aggregate Order { code: string }
      repository Orders for Order { find recent(): Order or NotFound }
    }
  `;

  it("lowers an ambient payload onto rootPayloads", async () => {
    const loom = lowerModel(await parseValid(SRC));
    expect(loom.rootPayloads.map((p) => p.name)).toContain("NotFound");
    expect(loom.rootPayloads.find((p) => p.name === "NotFound")?.kind).toBe("error");
  });

  it("folds the ambient payload into every context's payloads (enrichment)", async () => {
    const ctx = allContexts(enrichLoomModel(lowerModel(await parseValid(SRC)))).find(
      (c) => c.name === "Shop",
    )!;
    expect(ctx.payloads.some((p) => p.name === "NotFound" && p.kind === "error")).toBe(true);
  });

  it("a context-local payload of the same name shadows the ambient one", async () => {
    const loom = enrichLoomModel(
      lowerModel(
        await parseValid(`
          error NotFound { resource: string }
          context Shop {
            error NotFound { what: string }
            aggregate Order { code: string }
            repository Orders for Order { find recent(): Order or NotFound }
          }
        `),
      ),
    );
    const ctx = allContexts(loom).find((c) => c.name === "Shop")!;
    const nf = ctx.payloads.filter((p) => p.name === "NotFound" && !p.synthesized);
    // Exactly one NotFound — the context-local one (field `what`, not `resource`).
    expect(nf).toHaveLength(1);
    expect(nf[0]!.fields.map((f) => f.name)).toEqual(["what"]);
  });
});

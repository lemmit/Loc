// Python/FastAPI read-mask redaction (`mask unless`, authorization.md §5,
// M-T3.2 item 6). A masked aggregate emits a fail-closed `to_wire_masked`
// serializer (reads the ambient `current_user()` and redacts each masked field
// to `None` unless the predicate holds), its response DTO field admits null,
// and every read route routes through the masked serializer. Compile-verified
// separately (uv/ruff/mypy); this pins the emit shape.

import { NodeFileSystem } from "langium/node";
import { parseHelper } from "langium/test";
import { describe, expect, it } from "vitest";
import {
  aggHasFieldMask,
  buildPyRepositoryFile,
  maskedWireFields,
  toWireMaskedMethod,
} from "../../../src/generator/python/repository-builder.js";
import { buildPyRoutesFile } from "../../../src/generator/python/routes-builder.js";
import { enrichLoomModel } from "../../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../../src/ir/lower/lower.js";
import type {
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
} from "../../../src/ir/types/loom-ir.js";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Model } from "../../../src/language/generated/ast.js";

const SRC = `system S {
  user { id: string  role: string  permissions: string[] }
  subdomain M {
    permissions { unmask }
    context C {
      aggregate P with crudish {
        name: string
        salary: decimal mask unless currentUser.permissions.contains(permissions.unmask)
      }
    }
  }
}`;

async function ctxAndAgg(): Promise<{ ctx: EnrichedBoundedContextIR; agg: EnrichedAggregateIR }> {
  const services = createDddServices(NodeFileSystem);
  const helper = parseHelper<Model>(services.Ddd);
  const doc = await helper(SRC, { validation: true });
  const loom = enrichLoomModel(lowerModel(doc.parseResult.value));
  const ctx = loom.systems.flatMap((s) => s.subdomains.flatMap((sd) => sd.contexts))[0]!;
  const agg = ctx.aggregates.find((a) => a.name === "P") as EnrichedAggregateIR;
  return { ctx, agg };
}

describe("mask unless — Python read redaction", () => {
  it("aggHasFieldMask / maskedWireFields detect the masked field", async () => {
    const { agg } = await ctxAndAgg();
    expect(aggHasFieldMask(agg)).toBe(true);
    expect(maskedWireFields(agg).map((f) => f.name)).toEqual(["salary"]);
  });

  it("emits a fail-closed to_wire_masked that redacts the field unless the predicate holds", async () => {
    const { agg } = await ctxAndAgg();
    const method = toWireMaskedMethod(agg);
    expect(method).toContain("def to_wire_masked(self, root: P) -> dict[str, object]:");
    expect(method).toContain("_mask_user = current_user()");
    // fail-closed: unauthenticated OR failed predicate → redact to None.
    expect(method).toContain("if not (_mask_user is not None and (");
    // The predicate reads the narrowed `_mask_user` local, not the bare getter.
    expect(method).toContain('"m.unmask" in _mask_user.permissions');
    expect(method).toContain('d["salary"] = None');
  });

  it("the repository imports the non-raising current_user getter", async () => {
    const { ctx, agg } = await ctxAndAgg();
    const repo = ctx.repositories.find((r) => r.aggregateName === "P");
    const file = buildPyRepositoryFile(agg, repo, ctx);
    expect(file).toContain("from app.auth.user import current_user");
    expect(file).toContain("def to_wire_masked");
  });

  it("routes read boundaries through to_wire_masked and admits null on the DTO", async () => {
    const { ctx, agg } = await ctxAndAgg();
    const repo = ctx.repositories.find((r) => r.aggregateName === "P");
    const routes = buildPyRoutesFile(agg, repo, ctx);
    // GET by id + the (paged, via crudish) list route both go through the
    // masked serializer.
    expect(routes).toContain("repo.to_wire_masked(await repo.get_by_id(PId(id)))");
    expect(routes).toContain("[repo.to_wire_masked(r) for r in result.items]");
    // The read response DTO's masked field admits null (redaction is fail-closed).
    expect(routes).toContain("class PResponse(BaseModel):");
    expect(routes).toMatch(/salary:[^\n]*\|\s*None/);
  });
});

// Python/FastAPI write-side field gate (`write(...)` / `readonly when`,
// authorization.md §5, M-T3.2 item 6 — the write-side twin of `mask unless`).
// A write-gated field, when its name matches a CLIENT-SUPPLIED create-input
// field or op param, makes the create + operation handlers emit a fail-closed
// 403 (bind `__write_user = current_user()`; reject unless the ambient principal
// satisfies the predicate) BEFORE the domain call.  Compile-verified separately
// (uv/ruff/mypy); this pins the emit shape.

import { NodeFileSystem } from "langium/node";
import { parseHelper } from "langium/test";
import { describe, expect, it } from "vitest";
import { buildPyRoutesFile } from "../../../src/generator/python/routes-builder.js";
import { enrichLoomModel } from "../../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../../src/ir/lower/lower.js";
import type {
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
} from "../../../src/ir/types/loom-ir.js";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Model } from "../../../src/language/generated/ast.js";

// A `salary` field write-gated on `currentUser.permissions.contains(...)` plus a
// non-gated `name`.  `setSalary(salary: decimal)` is an operation whose param
// name matches the gated field → its handler must guard; `rename(name: string)`
// is an op over the non-gated field → no guard.
const SRC = `system S {
  user { id: string  role: string  permissions: string[] }
  subdomain M {
    permissions { setSalary }
    context C {
      aggregate P with crudish {
        name: string
        salary: decimal write(currentUser.permissions.contains(permissions.setSalary))
        operation setSalary(salary: decimal) { }
        operation rename(name: string) { }
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

function routes(ctx: EnrichedBoundedContextIR, agg: EnrichedAggregateIR): string {
  const repo = ctx.repositories.find((r) => r.aggregateName === "P");
  return buildPyRoutesFile(agg, repo, ctx);
}

describe("write(...) — Python write-side field gate", () => {
  it("the routes module imports the non-raising current_user getter", async () => {
    const { ctx, agg } = await ctxAndAgg();
    expect(routes(ctx, agg)).toContain("from app.auth.user import current_user");
  });

  it("the create handler binds __write_user and rejects fail-closed before the domain call", async () => {
    const { ctx, agg } = await ctxAndAgg();
    const file = routes(ctx, agg);
    // Create input carries `salary` (write-gated) → the create handler guards.
    expect(file).toContain("    __write_user = current_user()");
    expect(file).toContain(
      '    if not (__write_user is not None and ("m.setSalary" in __write_user.permissions)):',
    );
    expect(file).toContain('        raise ForbiddenError("Forbidden: write salary")');
    // The guard precedes the aggregate construction (fail-fast, before the call).
    const guardIdx = file.indexOf('raise ForbiddenError("Forbidden: write salary")');
    const createIdx = file.indexOf("created = P.create(");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(createIdx).toBeGreaterThan(guardIdx);
  });

  it("the setSalary operation handler guards before found.set_salary(...)", async () => {
    const { ctx, agg } = await ctxAndAgg();
    const file = routes(ctx, agg);
    const guardIdx = file.indexOf('raise ForbiddenError("Forbidden: write salary")');
    const callIdx = file.indexOf("found.set_salary(");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(callIdx).toBeGreaterThan(guardIdx);
    // Contract declares the 403 outcome for the gated operation route.
    expect(file).toContain('403: {"model": ProblemDetails');
  });

  it("a non-gated operation (rename) emits no write guard", async () => {
    const { ctx, agg } = await ctxAndAgg();
    const file = routes(ctx, agg);
    // The rename op takes only the non-gated `name` param — its handler section
    // must not carry a write guard.  Slice the file at the rename route and
    // assert no ForbiddenError guard appears between it and the next route.
    const renameIdx = file.indexOf("async def rename_p(");
    expect(renameIdx).toBeGreaterThan(-1);
    const afterRename = file.slice(renameIdx);
    const nextRoute = afterRename.indexOf("@router.", 1);
    const renameBody = nextRoute === -1 ? afterRename : afterRename.slice(0, nextRoute);
    expect(renameBody).not.toContain("__write_user");
    expect(renameBody).not.toContain("Forbidden: write");
  });

  it("a mask-free, gate-free aggregate emits neither the guard nor the getter import", async () => {
    const services = createDddServices(NodeFileSystem);
    const helper = parseHelper<Model>(services.Ddd);
    const plain = `system S {
  user { id: string }
  subdomain M {
    context C {
      aggregate Q with crudish {
        name: string
        operation rename(name: string) { }
      }
    }
  }
}`;
    const doc = await helper(plain, { validation: true });
    const loom = enrichLoomModel(lowerModel(doc.parseResult.value));
    const ctx = loom.systems.flatMap((s) => s.subdomains.flatMap((sd) => sd.contexts))[0]!;
    const agg = ctx.aggregates.find((a) => a.name === "Q") as EnrichedAggregateIR;
    const repo = ctx.repositories.find((r) => r.aggregateName === "Q");
    const file = buildPyRoutesFile(agg, repo, ctx);
    expect(file).not.toContain("__write_user");
    expect(file).not.toContain("from app.auth.user import current_user");
  });
});

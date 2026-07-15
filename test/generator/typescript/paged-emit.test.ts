// Generator coverage for paged repository finds (payload-transport-layer.md,
// P3b emission, slice 1 — TS/Hono).  A `find x(): <Agg> paged` emits a
// repository method that runs a `count()` + `limit`/`offset` page query and
// returns the `{ items, page, pageSize, total, totalPages }` envelope, plus a
// route with auto-injected `page`/`pageSize` query controls and a named
// `<Agg>Paged` response DTO.  The generated project compiles under
// `LOOM_TS_BUILD`; these unit tests pin the emitted shape.

import { describe, expect, it } from "vitest";
import { generateHono } from "../../_helpers/generate.js";
import { parseString } from "../../_helpers/parse.js";

const SRC = `
  context Inventory {
    aggregate Warehouse { code: string  region: string }
    repository Warehouses for Warehouse {
      find recent(): Warehouse paged
      find inRegion(region: string): Warehouse paged where this.region == region
    }
  }
`;

describe("typescript generator — paged finds (P3b)", () => {
  it("emits a paged repository method: count + limit/offset + wrapped return", async () => {
    const { model, errors } = await parseString(SRC);
    expect(errors).toEqual([]);
    const repo = generateHono(model).get("db/repositories/warehouse-repository.ts")!;

    // Signature gains page/pageSize + sort/dir and returns the pagination envelope.
    expect(repo).toMatch(
      /async recent\(page: number, pageSize: number, sort: string, dir: string\): Promise<\{ items: Warehouse\[\]; page: number; pageSize: number; total: number; totalPages: number \}>/,
    );
    // Server-side sort (M-T2.6): whitelist map + orderBy on the page query.
    expect(repo).toContain(
      'const sortColumns: Record<string, AnyPgColumn> = { "id": schema.warehouses.id, "code": schema.warehouses.code, "region": schema.warehouses.region };',
    );
    expect(repo).toContain('const orderBy = dir === "desc" ? desc(sortColumn) : asc(sortColumn);');
    // count() for the total, with the same where-clause as the page query.
    expect(repo).toContain(
      "const countRows = await this.db.select({ value: count() }).from(schema.warehouses)",
    );
    expect(repo).toContain("const total = Number(countRows[0]?.value ?? 0);");
    expect(repo).toContain("const totalPages = pageSize > 0 ? Math.ceil(total / pageSize) : 0;");
    // 1-based page → offset, limit/offset on the page query.
    expect(repo).toContain("const offset = (page - 1) * pageSize;");
    expect(repo).toMatch(
      /\.from\(schema\.warehouses\)\.orderBy\(orderBy\)\.limit\(pageSize\)\.offset\(offset\)/,
    );
    expect(repo).toMatch(/return \{ items, page, pageSize, total, totalPages \};/);
    // count is pulled into the drizzle-orm import.
    expect(repo).toMatch(/import \{[^}]*\bcount\b[^}]*\} from "drizzle-orm";/);
  });

  it("threads the find's where-clause into both the count and the page query", async () => {
    const { model } = await parseString(SRC);
    const repo = generateHono(model).get("db/repositories/warehouse-repository.ts")!;
    // count + page query both constrained by the region predicate.
    expect(repo).toContain(
      "select({ value: count() }).from(schema.warehouses).where(eq(schema.warehouses.region, region))",
    );
    expect(repo).toMatch(
      /\.where\(eq\(schema\.warehouses\.region, region\)\)\.orderBy\(orderBy\)\.limit\(pageSize\)\.offset\(offset\)/,
    );
  });

  it("emits a named <Agg>Paged response DTO + page/pageSize query + toWire mapping", async () => {
    const { model } = await parseString(SRC);
    const routes = generateHono(model).get("http/warehouse.routes.ts")!;

    // Named paged DTO wrapping the response items.
    expect(routes).toContain(
      'export const WarehousePaged = z.object({ items: z.array(WarehouseResponse), page: z.number().int(), pageSize: z.number().int(), total: z.number().int(), totalPages: z.number().int() }).openapi("WarehousePaged");',
    );
    // Query schema gains 1-based page + pageSize with defaults 1 / 20, plus the
    // server-side sort controls (M-T2.6): `sort`/`dir` are accepted as plain
    // strings (the scaffold list sends an empty initial sortKey, which an enum
    // would reject) and whitelisted server-side by the repo's `sortColumns`
    // map (`sortColumns[sort] ?? id`).
    expect(routes).toContain("page: z.coerce.number().int().min(1).default(1),");
    expect(routes).toContain("pageSize: z.coerce.number().int().min(1).default(20),");
    expect(routes).toContain('sort: z.string().default("id"),');
    expect(routes).toContain('dir: z.string().default("asc"),');
    // Handler passes the controls through and maps page items via toWire.
    expect(routes).toContain(
      "const result = await repo.recent(params.page, params.pageSize, params.sort, params.dir);",
    );
    expect(routes).toContain(
      "return c.json({ ...result, items: result.items.map((r) => repo.toWire(r)) } as z.infer<typeof WarehousePaged>, 200);",
    );
  });
});

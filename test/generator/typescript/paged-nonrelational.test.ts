// `find … paged` on a NON-RELATIONAL saving shape (F2-CB-C1).
//
// The route layer derives its contract from `pagedReturn(find.returnType)` and
// emits `repo.<find>(…, page, pageSize, sort, dir)` + `result.items.map(…)`
// regardless of how the aggregate is persisted.  The document / embedded /
// event-sourced repository builders classified only `array` and `optional`
// returns, so a `paged` find fell through to the SINGLE-GET branch: a 1-arg
// method returning `Promise<Agg>` behind a 5-arg paged call site — TS2554 +
// TS2339 in the generated project, with no `loom.*` diagnostic refusing it.
//
// The relational shape has always been right, so it is the contract these
// three have to meet; java's `AccountRepositoryImpl.byOwner` (filter → sort
// allowlist → skip/limit → total) is the cross-backend reference for the
// in-memory half.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SOURCE = (persistence: string) => `
system P {
  subdomain S {
    context C {
      event Opened { ledger: Ledger id, owner: string }
      aggregate Emb shape: embedded, with crudish {
        owner: string
        total: money
        contains lines: Line[]
        entity Line { label: string }
      }
      aggregate Doc shape: document, with crudish { region: string  total: money }
      aggregate Ledger persistedAs: eventLog {
        owner: string
        create open(owner: string) { emit Opened { ledger: id, owner: owner } }
        apply(e: Opened) { owner := e.owner }
      }
      repository Embs for Emb { find byOwner(owner: string): Emb paged where this.owner == owner }
      repository Docs for Doc { find inRegion(region: string): Doc paged where this.region == region }
      repository Ledgers for Ledger { find byOwner(owner: string): Ledger paged where this.owner == owner }
    }
  }
  api A from S
  storage pg { type: postgres }
  resource st { for: C, kind: state, use: pg }
  resource lg { for: C, kind: eventLog, use: pg }
  deployable d {
    platform: node${persistence}
    contexts: [C]
    dataSources: [st, lg]
    serves: A
    port: 4000
  }
}`;

/** The paged signature tail + return type every caller assumes. */
const sig = (name: string, param: string, agg: string) =>
  `async ${name}(${param}, page: number, pageSize: number, sort: string, dir: string): Promise<{ items: ${agg}[]; page: number; pageSize: number; total: number; totalPages: number }>`;

for (const [label, persistence] of [
  ["drizzle (default)", ""],
  ["mikroorm", " { persistence: mikroorm }"],
] as const) {
  describe(`paged finds on non-relational shapes — ${label}`, () => {
    it("emits a paged repository method the paged route can actually call", async () => {
      const files = await generateSystemFiles(SOURCE(persistence));
      const get = (n: string) => files.get(`d/db/repositories/${n}-repository.ts`)!;

      // Every one of the three shapes carries the paged arity + wrapper.
      expect(get("emb")).toContain(sig("byOwner", "owner: string", "Emb"));
      expect(get("doc")).toContain(sig("inRegion", "region: string", "Doc"));
      expect(get("ledger")).toContain(sig("byOwner", "owner: string", "Ledger"));
      // …and each returns the wrapper, not a bare aggregate.
      for (const n of ["emb", "doc", "ledger"]) {
        expect(get(n)).toContain("return { items, page, pageSize, total, totalPages };");
        // The single-get spelling (`.find(pred)!`) is exactly the defect.
        expect(get(n)).not.toMatch(/return all\.find\(.*\)!;/);
      }

      // The PORT the concrete implements is extracted from those headers, so it
      // moves with them — this is what the route's `repo` variable is typed as.
      const ports = files.get("d/domain/repository-ports.ts")!;
      expect(ports).toContain(
        "byOwner(owner: string, page: number, pageSize: number, sort: string, dir: string): Promise<{ items: Emb[]; page: number; pageSize: number; total: number; totalPages: number }>;",
      );
      expect(ports).toContain(
        "inRegion(region: string, page: number, pageSize: number, sort: string, dir: string): Promise<{ items: Doc[]; page: number; pageSize: number; total: number; totalPages: number }>;",
      );

      // The call site the repository has to match, unchanged.
      expect(files.get("d/http/doc.routes.ts")!).toContain(
        "await repo.inRegion(params.region, params.page, params.pageSize, params.sort, params.dir)",
      );
    });

    it("pages the BLOB shapes in memory over the `?sort=` whitelist", async () => {
      const doc = (await generateSystemFiles(SOURCE(persistence))).get(
        "d/db/repositories/doc-repository.ts",
      )!;
      // Filter → sort allowlist (unknown key falls back to `id`) → slice →
      // total over the MATCHED set, not the page.
      expect(doc).toContain("const matched = all.filter((x) => x.region === region);");
      expect(doc).toContain('const __base = __cmps[sort] ?? __cmps["id"]!;');
      expect(doc).toContain("const total = matched.length;");
      expect(doc).toContain(
        "const items = [...matched].sort(__cmp).slice(offset, offset + pageSize);",
      );
      // The comparator table is the whitelist: `id` + declared scalars, with
      // money ordered numerically rather than as text.
      expect(doc).toContain("(Number(a.total ?? 0) - Number(b.total ?? 0))");
      expect(doc).not.toContain('"lines":');
    });
  });
}

describe("paged finds on an EMBEDDED shape page in SQL (drizzle)", () => {
  it("counts, orders by the whitelisted column, and limits/offsets", async () => {
    const emb = (await generateSystemFiles(SOURCE(""))).get("d/db/repositories/emb-repository.ts")!;
    // The embedded root keeps real columns, so the page is SQL — the same shape
    // the relational builder emits, not the in-memory fallback.
    expect(emb).toContain(
      "const countRows = await this.db.select({ value: count() }).from(schema.embs).where(eq(schema.embs.owner, owner));",
    );
    expect(emb).toContain('const orderBy = dir === "desc" ? desc(sortColumn) : asc(sortColumn);');
    expect(emb).toContain(".orderBy(orderBy).limit(pageSize).offset(offset);");
    // …and the drizzle helpers + column type it names are imported.
    expect(emb).toContain('import type { AnyPgColumn } from "drizzle-orm/pg-core";');
    expect(emb).toContain('import { and, asc, count, desc, eq, inArray } from "drizzle-orm";');
  });
});

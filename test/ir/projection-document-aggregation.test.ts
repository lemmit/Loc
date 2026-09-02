// Direct-table AGGREGATION over a `shape: document` source — the cell
// `loom.projection-columnless-source` deliberately leaves open, and what is
// actually true inside it.
//
// WHY THIS FILE EXISTS.  `projection-columnless-source.test.ts` gates the
// COLUMN question: a document table is `(id, data, version)`, so any member but
// `id` in a direct-table arm names nothing.  It then explicitly keeps
// `select n = count()` legal, because a row count names only `id` — and
// `scaffoldDashboard` used to synthesise exactly that.  It even asserts that a
// CAPABILITY filter is not read as a named column, on the reasoning that the
// direct-table arms "do not splice them into the SQL at all today".
//
// That reasoning was measured against the emitters on 2026-08-24 and is false
// in both directions.  Four backends DO splice the capability predicates into
// the aggregation, naming columns the document table does not have; the fifth
// does not splice them and does not have a `HasQueryFilter` to fall back on, so
// it silently reads across tenants:
//
//   platform × adapter   `count()` over `with tenantOwned, softDeletable` document
//   -------------------  ---------------------------------------------------------
//   node / drizzle       eq(schema.orders.tenantId, …)         TS2339
//   node / mikroorm      qb.where({ tenantId: … })             not a property of OrderRow
//   python               OrderRow.tenant_id == …               mypy / AttributeError 500
//   elixir               record.tenant_id                      `mix compile` error
//   dotnet / dapper      WHERE tenant_id = @__cu_org           Postgres 42703 → 500
//   dotnet / EF          _db.Orders.GroupBy(_ => 1).Count()    COMPILES — COUNTS EVERY TENANT
//   java                 select count(e) from Order e where …  no @Entity → 500
//
// The EF row is the one that matters most: a document aggregate's capability
// filters live in-app (`_CapabilityVisible` in the repository), NOT in
// `modelBuilder.Entity<T>().HasQueryFilter(…)`, which Loom registers only for a
// relationally-mapped aggregate.  So the aggregation compiles, ships, and
// reports another tenant's rows — a compile gate can never catch it.  Hence a
// universal phase-⑦ refusal, not five per-backend ones.
//
// The BARE case (no capability filter) is genuinely different: a row count over
// a document table is a real query, and four backends emit it correctly.  Only
// java cannot — its aggregation runs JPQL through the `EntityManager` and a
// document aggregate has no JPA entity at all (it round-trips one jsonb column
// through a `JdbcTemplate` repository) — so that one is a per-backend gate in
// the `PROJECTION_AGG_SUPPORTED` shape, and the four working cells must keep
// working (pinned positively by
// `test/fixtures/corpus/projection-document-aggregation.ddd`).
//
// That per-backend refusal reuses the two codes that ALREADY mean "deployable D
// (platform P) cannot generate this aggregation arm" —
// `loom.projection-whole-table-aggregation-unsupported` and
// `loom.projection-groupby-unsupported-backend` — through their `#document`
// message variants, rather than minting a third way to say the same thing.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

const FILTERED = "loom.projection-document-source-capability-filtered";
const BACKEND_SINGLETON = "loom.projection-whole-table-aggregation-unsupported";
const BACKEND_GROUPED = "loom.projection-groupby-unsupported-backend";

/** Every backend platform clause a projection can be hosted on, including both
 *  .NET persistence adapters and both node ones — the filtered gate is
 *  universal, so the adapter axis has to be in the matrix rather than assumed. */
const PLATFORMS = [
  "node",
  "node { persistence: mikroorm }",
  "dotnet",
  "dotnet { persistence: dapper }",
  "java",
  "python",
  "elixir",
];

/** The four backends that DO aggregate a document table correctly. */
const DOCUMENT_AGG_PLATFORMS = PLATFORMS.filter((p) => p !== "java");

/** A tenanted system whose `Order` header and projection body are swappable. */
const SYS = (platform: string, aggHeader: string, projection: string) => `
system S {
  user { id: guid  org: string }
  tenancy by user.org of Tenant
  subdomain Sales {
    context Orders {
      aggregate Tenant with tenantRegistry, crudish { slug: string }
      ${aggHeader}
      repository Tenants for Tenant { }
      repository Orders for Order { }
      ${projection}
    }
  }
  api A from Sales
  storage pg { type: postgres }
  resource s { for: Orders, kind: state, use: pg }
  deployable d { platform: ${platform}, contexts: [Orders], dataSources: [s], serves: A, port: 4000, auth: required }
}`;

/** An UNTENANTED system — no `user`/`tenancy` block at all, so nothing
 *  contributes a capability filter and the bare arm is what is under test. */
const BARE_SYS = (platform: string, aggHeader: string, projection: string) => `
system S {
  subdomain Sales {
    context Orders {
      ${aggHeader}
      repository Orders for Order { }
      ${projection}
    }
  }
  api A from Sales
  storage pg { type: postgres }
  resource s { for: Orders, kind: state, use: pg }
  deployable d { platform: ${platform}, contexts: [Orders], dataSources: [s], serves: A, port: 4000 }
}`;

const DOC_FILTERED = `aggregate Order shape: document, with tenantOwned, softDeletable, crudish { code: string  total: int }`;
const DOC_TENANT_ONLY = `aggregate Order shape: document, with tenantOwned, crudish { code: string  total: int }`;
const DOC_BARE = `aggregate Order shape: document, with crudish { code: string  total: int }`;
const RELATIONAL_FILTERED = `aggregate Order with tenantOwned, softDeletable, crudish { code: string  total: int }`;

/** The row count — the ONLY aggregation a document source can express, since
 *  every other one names a blob key and is refused by the column gate. */
const COUNT = `projection OrderVolume {
        rows: int
        from Order as o
        select rows = count()
      }`;

/** The per-row arm over the same source: goes through the repository, which
 *  applies the capability filters when it hydrates each row. */
const PER_ROW = `projection OrderCodes {
        code: string
        from Order as o
        select code = o.code
      }`;

const countIgnoring = (clause: string) => `projection OrderVolume {
        rows: int
        from Order as o
        ${clause}
        select rows = count()
      }`;

/** A grouped aggregation whose only key is `id` — the one grouped shape the
 *  column gate lets through over a document source (`id` IS a column on the
 *  `(id, data, version)` triple).  The projection field is spelled `orderId`
 *  because `id` is a reserved member name. */
const GROUPED_BY_ID = `projection PerOrder {
        orderId: guid
        rows: int
        from Order as o
        group by o.id
        select orderId = o.id, rows = count()
      }`;

/** Parse, and REFUSE to proceed on a syntax error.
 *
 *  Without this the whole file is vacuous in the worst way: a fixture with a
 *  typo yields an empty `Model`, which lowers to a system with no projections
 *  and therefore no diagnostics — so every `not.toContain` passes and every
 *  `toContain` fails for a reason that has nothing to do with the gate.  One of
 *  the grouped fixtures below did exactly that on first run (`id` is a reserved
 *  field name), which is `experience_gathered.md` §59 in miniature. */
async function irDiagnostics(source: string) {
  const { model, doc } = await parseString(source, { validate: false });
  const syntax = [...doc.parseResult.lexerErrors, ...doc.parseResult.parserErrors];
  if (syntax.length > 0) {
    throw new Error(`fixture does not parse:\n${syntax.map((e) => e.message).join("\n")}`);
  }
  return validateLoomModel(enrichLoomModel(lowerModel(model)));
}

async function codesFor(source: string): Promise<string[]> {
  return (await irDiagnostics(source))
    .filter((d) => d.severity === "error")
    .map((d) => d.code ?? "");
}

async function messagesFor(source: string, code: string): Promise<string[]> {
  return (await irDiagnostics(source))
    .filter((d) => d.severity === "error" && d.code === code)
    .map((d) => d.message);
}

describe("capability-filtered aggregation over a document source", () => {
  describe("is refused on every backend and adapter", () => {
    for (const platform of PLATFORMS) {
      it(`${platform} — 'count()' over a 'tenantOwned, softDeletable' document source`, async () => {
        expect(await codesFor(SYS(platform, DOC_FILTERED, COUNT))).toContain(FILTERED);
      });

      it(`${platform} — one filtering capability is enough`, async () => {
        // `softDeletable` alone is the same defect with no auth involved: a
        // plain wrong number.  The gate must not need BOTH to fire.
        expect(await codesFor(SYS(platform, DOC_TENANT_ONLY, COUNT))).toContain(FILTERED);
      });

      it(`${platform} — the grouped arm over the same source`, async () => {
        // `group by o.id` is the one grouped shape the COLUMN gate allows over
        // a document source, so it is the one that would otherwise slip past
        // both gates carrying the same unappliable predicates.
        expect(await codesFor(SYS(platform, DOC_FILTERED, GROUPED_BY_ID))).toContain(FILTERED);
      });
    }
  });

  it("is the EF cell's only warning — that read COMPILES", async () => {
    // The .NET/EF aggregation over a document source emits
    // `_db.Orders.GroupBy(_ => 1).Select(g => new { … g.Count() })` with NO
    // predicate: a document aggregate gets no `HasQueryFilter`, and its filters
    // live in the repository's `_CapabilityVisible`.  Nothing downstream fails,
    // so if this gate does not fire the model ships a cross-tenant count.
    const codes = await codesFor(SYS("dotnet", DOC_FILTERED, COUNT));
    expect(codes).toContain(FILTERED);
  });

  describe("leaves alone what is genuinely emittable", () => {
    for (const platform of PLATFORMS) {
      it(`${platform} — the RELATIONAL control aggregates fine`, async () => {
        // A relational table has the `tenant_id` / `is_deleted` columns, so the
        // spliced predicates name something (and EF's `HasQueryFilter` covers
        // the .NET cell).  This is `projection-agg-filters.ddd` in the corpus.
        expect(await codesFor(SYS(platform, RELATIONAL_FILTERED, COUNT))).not.toContain(FILTERED);
      });

      it(`${platform} — the PER-ROW arm over a filtered document source`, async () => {
        // Arm-shaped, not source-shaped: the row read hydrates through the
        // repository, which applies the very filters this gate is about.
        expect(await codesFor(SYS(platform, DOC_FILTERED, PER_ROW))).not.toContain(FILTERED);
      });
    }

    it("'ignoring *' waives every filter, so there is nothing to apply", async () => {
      // The documented way out for an author who genuinely wants the unscoped
      // total.  A gate that fired anyway would leave the shape unexpressible.
      expect(await codesFor(SYS("node", DOC_FILTERED, countIgnoring("ignoring *")))).not.toContain(
        FILTERED,
      );
    });

    it("'ignoring <cap>' waives only that one — the rest still gate", async () => {
      // `tenantOwned` is NOT named, so its predicate still has to be applied
      // and still has no column.  A gate that keyed off "any bypass at all"
      // would turn `ignoring softDeletable` into a tenant leak.
      const codes = await codesFor(
        SYS("node", DOC_FILTERED, countIgnoring("ignoring softDeletable")),
      );
      expect(codes).toContain(FILTERED);
    });

    it("'ignoring <cap>' over a source filtered by only that one is fine", async () => {
      expect(
        await codesFor(SYS("node", DOC_TENANT_ONLY, countIgnoring("ignoring tenantOwned"))),
      ).not.toContain(FILTERED);
    });
  });

  it("names the source, the capabilities, and a way out that is a MODEL change", async () => {
    const [message] = await messagesFor(SYS("node", DOC_FILTERED, COUNT), FILTERED);
    expect(message).toContain("'Orders.OrderVolume'");
    expect(message).toContain("'shape: document' aggregate 'Order'");
    expect(message).toContain("'tenantOwned'");
    expect(message).toContain("'softDeletable'");
    // The gate is universal, so no sibling deployable escapes it — the advice
    // must never be "switch adapters".
    expect(message).not.toContain("persistence:");
    expect(message).toContain("ignoring");
  });
});

describe("BARE aggregation over a document source", () => {
  for (const platform of DOCUMENT_AGG_PLATFORMS) {
    it(`${platform} — emits, and must keep emitting`, async () => {
      // A document table really is `(id, data, version)`: `count(*)` over it is
      // a real query on drizzle, mikroorm, SQLAlchemy, Ecto, EF's
      // `DbSet<OrderDocument>` and Dapper's raw SQL alike.  Over-gating this
      // would make the shape unexpressible on four working backends.
      const codes = await codesFor(BARE_SYS(platform, DOC_BARE, COUNT));
      expect(codes).not.toContain(BACKEND_SINGLETON);
      expect(codes).not.toContain(BACKEND_GROUPED);
      expect(codes).not.toContain(FILTERED);
    });
  }

  it("java refuses it — its JPQL has no entity to name", async () => {
    // `select count(e) from Order e` through the `EntityManager`, against an
    // aggregate with no `@Entity` anywhere in the emitted project: Hibernate
    // fails the query with "could not resolve root entity" at request time.
    // Broken with NO capabilities at all, which is why this gate is separate
    // from the filtered one above.
    expect(await codesFor(BARE_SYS("java", DOC_BARE, COUNT))).toContain(BACKEND_SINGLETON);
  });

  it("java refuses the GROUPED arm too, under the grouped code", async () => {
    // The other direct-table arm, and the other already-registered per-backend
    // code.  Routing both through one code would have made the grouped refusal
    // read as a whole-table one; routing the grouped one through the singleton
    // code would have been worse still.
    const codes = await codesFor(BARE_SYS("java", DOC_BARE, GROUPED_BY_ID));
    expect(codes).toContain(BACKEND_GROUPED);
    expect(codes).not.toContain(BACKEND_SINGLETON);
  });

  it("the other four emit the GROUPED arm over a document source", async () => {
    for (const platform of DOCUMENT_AGG_PLATFORMS) {
      const codes = await codesFor(BARE_SYS(platform, DOC_BARE, GROUPED_BY_ID));
      expect(codes, platform).not.toContain(BACKEND_GROUPED);
    }
  });

  it("java is fine over a RELATIONAL source", async () => {
    // The gate is document-shaped, not aggregation-shaped: java's JPQL
    // aggregation over a mapped entity is exactly what
    // `projection-aggregation.ddd` proves on all five.
    expect(
      await codesFor(BARE_SYS("java", `aggregate Order with crudish { total: int }`, COUNT)),
    ).not.toContain(BACKEND_SINGLETON);
  });

  it("java is fine on the PER-ROW arm over a document source", async () => {
    // The row read goes through the `JdbcTemplate` document repository, which
    // has no JPA entity to need.
    expect(await codesFor(BARE_SYS("java", DOC_BARE, PER_ROW))).not.toContain(BACKEND_SINGLETON);
  });

  it("names the deployable, its platform, and the document source", async () => {
    const [message] = await messagesFor(BARE_SYS("java", DOC_BARE, COUNT), BACKEND_SINGLETON);
    expect(message).toContain("'OrderVolume'");
    expect(message).toContain("'shape: document' aggregate 'Order'");
    expect(message).toContain("'d'");
    expect(message).toContain("'java'");
  });
});

describe("`scaffoldDashboard` never synthesises a refused shape", () => {
  // The macro emitted a whole-table aggregation per aggregate, and its
  // `fieldsAreColumns` check kept the ROW COUNT tile for a document source
  // while dropping the per-field sums.  That surviving tile is exactly the
  // shape both gates above refuse — so on a multi-tenant model the default
  // scaffold produced a project that fails `ddd parse`, and before the gates
  // existed, one whose dashboard counted every tenant's rows on .NET.
  //
  // The fix is in the macro (`hasDashboardTable`), not in an exemption: a
  // scaffold whose default output the validator refuses is worse than the
  // silent miscompile it replaced.
  const scaffolded = (platform: string) => `
system S {
  user { id: guid  org: string }
  tenancy by user.org of Tenant
  subdomain Sales {
    context Orders with scaffoldDashboard {
      aggregate Tenant with tenantRegistry, crudish { slug: string }
      aggregate Doc shape: document, with tenantOwned, softDeletable, crudish {
        total: int
        createdAt: datetime
      }
      aggregate Rel with tenantOwned, crudish { total: int  createdAt: datetime }
      repository Tenants for Tenant { }
      repository Docs for Doc { }
      repository Rels for Rel { }
    }
  }
  api A from Sales
  storage pg { type: postgres }
  resource s { for: Orders, kind: state, use: pg }
  deployable d { platform: ${platform}, contexts: [Orders], dataSources: [s], serves: A, port: 4000, auth: required }
}`;

  for (const platform of PLATFORMS) {
    it(`${platform} — a scaffolded dashboard over a filtered document aggregate validates`, async () => {
      const codes = await codesFor(scaffolded(platform));
      expect(codes).not.toContain(FILTERED);
      expect(codes).not.toContain(BACKEND_SINGLETON);
      expect(codes).not.toContain(BACKEND_GROUPED);
      expect(codes).not.toContain("loom.projection-columnless-source");
    });
  }

  it("still scaffolds the RELATIONAL aggregate's dashboard beside it", async () => {
    // The skip must be document-shaped, not context-wide: a mixed context
    // keeps every tile it can legally carry.
    const { model } = await parseString(scaffolded("node"), { validate: false });
    const ir = enrichLoomModel(lowerModel(model));
    const ctx = ir.systems[0]?.subdomains[0]?.contexts[0];
    const names = (ctx?.projections ?? []).map((p) => p.name);
    expect(names).toContain("RelTotals");
    expect(names).toContain("RelPerDay");
    expect(names).not.toContain("DocTotals");
    expect(names).not.toContain("DocPerDay");
  });
});

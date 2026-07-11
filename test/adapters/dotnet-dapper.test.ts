// dapper — minimal-v1 PersistenceAdapter for dotnet (D-REALIZATION-AXES Phase
// 5c).  `persistence: dapper` emits an Npgsql/Dapper Infrastructure (repository,
// DbSchema, connection wiring, deps) reusing the persistence-agnostic Domain
// layer, and the validator gates the unsupported feature surface.

import { NodeFileSystem } from "langium/node";
import { parseHelper } from "langium/test";
import { describe, expect, it } from "vitest";
import { dapperPersistenceAdapter } from "../../src/generator/dotnet/adapters/dapper-persistence.js";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { createDddServices } from "../../src/language/ddd-module.js";
import type { Model } from "../../src/language/generated/ast.js";
import { resolvePersistence } from "../../src/platform/resolve-adapters.js";
import { generateSystems } from "../../src/system/index.js";

/** Lower + enrich + run BOTH the Langium parse diagnostics and the IR-level
 *  validator (where `loom.dapper-unsupported` lives), then emit. */
async function emit(src: string): Promise<{ files: Map<string, string>; errors: string[] }> {
  const services = createDddServices(NodeFileSystem);
  const doc = await parseHelper(services.Ddd)(src, { validation: true });
  const parseErrors = (doc.diagnostics ?? []).filter((d) => d.severity === 1).map((d) => d.message);
  const loom = enrichLoomModel(lowerModel(doc.parseResult.value as Model));
  const irErrors = validateLoomModel(loom)
    .filter((d) => d.severity === "error")
    .map((d) => d.message);
  const errors = [...parseErrors, ...irErrors];
  if (errors.length > 0) return { files: new Map(), errors };
  return { files: generateSystems(doc.parseResult.value as Model).files, errors };
}

const sys = (deployable: string, body = "") => `
system D {
  api A from S
  subdomain S {
    context O {
      enum Status { Draft, Confirmed }
      valueobject Money { amount: int  currency: string }
      aggregate Order with crudish {
        customer: string
        status:   Status
        total:    Money
        note:     string?
        ${body}
      }
      repository Orders for Order {
        find byCustomer(customer: string): Order[] where this.customer == customer
      }
    }
  }
  storage pg { type: postgres }
  resource s { for: O, kind: state, use: pg }
  deployable api { platform: dotnet { persistence: ${deployable} }  contexts: [O]  dataSources: [s]  serves: A  port: 8080 }
}`;

describe("dapper persistence adapter — dotnet (Phase 5c)", () => {
  it("is registered as a real persistence adapter", () => {
    expect(resolvePersistence("dotnet", "dapper")).toBe(dapperPersistenceAdapter);
    expect(dapperPersistenceAdapter.name).toBe("dapper");
    expect(dapperPersistenceAdapter.supportedShapes).toEqual(["relational"]);
    expect(dapperPersistenceAdapter.supportedStrategies).toEqual(["state", "eventLog"]);
  });

  it("emits a Dapper Infrastructure instead of EF Core", async () => {
    const { files, errors } = await emit(sys("dapper"));
    expect(errors).toEqual([]);
    // Dapper schema bootstrap replaces the EF DbContext + migrations.
    expect(files.has("api/Infrastructure/Persistence/DbSchema.cs")).toBe(true);
    expect(files.has("api/Infrastructure/Persistence/AppDbContext.cs")).toBe(false);
    const repo = files.get("api/Infrastructure/Repositories/OrderRepository.cs")!;
    expect(repo).toContain("private readonly NpgsqlDataSource _db;");
    expect(repo).toContain("Order._Create(new Order.State"); // hydration seam
    expect(repo).toContain("ON CONFLICT (id) DO UPDATE SET"); // upsert
    expect(repo).toContain("WHERE (customer = @customer)"); // find → SQL
    expect(repo).not.toContain("AppDbContext"); // no EF
    // schema DDL + Npgsql/Dapper deps + connection wiring.
    expect(files.get("api/Infrastructure/Persistence/DbSchema.cs")).toContain(
      "CREATE TABLE IF NOT EXISTS orders",
    );
    expect(files.get("api/Api.csproj")).toContain('Include="Dapper"');
    expect(files.get("api/Api.csproj")).not.toContain("EntityFrameworkCore");
    expect(files.get("api/Program.cs")).toContain("DbSchema.EnsureAsync");
  });

  it("the efcore default is unchanged (EF DbContext, no DbSchema)", async () => {
    const { files, errors } = await emit(sys("efcore"));
    expect(errors).toEqual([]);
    expect(files.has("api/Infrastructure/Persistence/AppDbContext.cs")).toBe(true);
    expect(files.has("api/Infrastructure/Persistence/DbSchema.cs")).toBe(false);
  });

  // Event sourcing (appliers, Dapper edition): a `persistence: dapper` deployable
  // accepts a `persistedAs(eventLog)` aggregate and emits the raw-Npgsql event
  // store + the `<agg>_events` DbSchema table, reusing the domain fold + CQRS.
  const esSys = `
system D {
  subdomain S {
    context O {
      event Opened { account: Account id, owner: string }
      aggregate Account persistedAs(eventLog) {
        owner: string
        create open(owner: string) { emit Opened { account: id, owner: owner } }
        apply(e: Opened) { owner := e.owner }
      }
      repository Accounts for Account { }
    }
  }
  storage pg { type: postgres }
  resource s { for: O, kind: eventLog, use: pg }
  deployable api { platform: dotnet { persistence: dapper }  contexts: [O]  dataSources: [s]  port: 8080 }
}`;

  it("accepts persistedAs(eventLog) and emits the Dapper event store", async () => {
    const { files, errors } = await emit(esSys);
    expect(errors).toEqual([]);
    const repo = files.get("api/Infrastructure/Repositories/AccountRepository.cs")!;
    expect(repo).toContain("Account._FromEvents(id, __rows.Select(RowToEvent).ToList());");
    expect(repo).toContain("INSERT INTO account_events");
    expect(repo).toContain('"Opened" => System.Text.Json.JsonSerializer.Deserialize<Opened>');
    // The stream table ships in the self-applied schema.
    expect(files.get("api/Infrastructure/Persistence/DbSchema.cs")).toContain(
      "CREATE TABLE IF NOT EXISTS account_events",
    );
  });
});

// Reference collections (`X id[]`) on Dapper: one join table per association
// (DbSchema), a set (membership only, no order) keyed by its composite
// (owner, target) PK — reads ORDER BY the target FK id for deterministic
// read-back — bulk-loaded on every read via LoadRefsAsync, full-list-replaced
// on save (DELETE + re-INSERT — semantically identical to EF's diff-sync for a
// full-list replace).
describe("dapper reference-collection associations", () => {
  const SRC = `
system D {
  api A from S
  subdomain S {
    context O {
      aggregate Tag with crudish { label: string  derived display: string = this.label }
      aggregate Order with crudish {
        customer: string
        tags: Tag id[]
      }
      repository Orders for Order { }
      repository Tags for Tag { }
    }
  }
  storage pg { type: postgres }
  resource s { for: O, kind: state, use: pg }
  deployable api { platform: dotnet { persistence: dapper }  contexts: [O]  dataSources: [s]  serves: A  port: 8080 }
}`;

  it("emits the join table, bulk loader, and save sync", async () => {
    const { files, errors } = await emit(SRC);
    expect(errors).toEqual([]);
    const repo = files.get("api/Infrastructure/Repositories/OrderRepository.cs")!;
    // The root row carries no tags column; the join table does.
    expect(repo).not.toContain("tags { get; set; }");
    expect(files.get("api/Infrastructure/Persistence/DbSchema.cs")).toContain(
      "CREATE TABLE IF NOT EXISTS order_tags",
    );
    // Reads funnel through the bulk loader, ordered by the target FK id.
    expect(repo).toContain(
      "SELECT order_id, tag_id FROM order_tags WHERE order_id = ANY(@ids) ORDER BY order_id, tag_id",
    );
    expect(repo).toContain("await LoadRefsAsync(conn, __one, cancellationToken);"); // GetById
    expect(repo).toContain("await LoadRefsAsync(conn, __roots, cancellationToken);"); // findAll
    // Save replaces the full list (set semantics — no ordinal column).
    expect(repo).toContain('DELETE FROM order_tags WHERE order_id = @id"');
    expect(repo).toContain("INSERT INTO order_tags (order_id, tag_id) VALUES (@o, @t)");
    expect(repo).not.toContain("ordinal");
  });

  it("accepts managed-access fields (wire-projection concern, no gate)", async () => {
    const { files, errors } = await emit(
      sys("dapper", "passwordHash: string secret\n        version: int token"),
    );
    expect(errors).toEqual([]);
    const repo = [...files.entries()].find(([k]) =>
      k.endsWith("Repositories/OrderRepository.cs"),
    )![1];
    // The columns persist like any field; the shared CQRS layer owns the
    // wire stripping.
    expect(repo).toContain("password_hash");
    expect(repo).toContain("version");
  });
});

describe("dapper capability gating (loom.dapper-unsupported)", () => {
  const rejects = async (body: string, needle: RegExp) => {
    const { errors } = await emit(sys("dapper", body));
    expect(errors.some((e) => /persistence: dapper/.test(e) && needle.test(e))).toBe(true);
  };

  it("rejects a provenanced field", () => rejects("provenanced score: int", /provenanced/));

  it("rejects workflow event subscriptions (saga handlers + outbox need the EF AppDbContext)", async () => {
    const src = `
      system D {
        api A from S
        subdomain S { context O {
          aggregate Order with crudish { customer: string }
          repository Orders for Order { }
          event OrderPlaced { order: Order id }
          channel Lifecycle { carries: OrderPlaced  delivery: broadcast  retention: ephemeral }
          workflow W { orderId: Order id  create(p: OrderPlaced) by p.order { } }
        } }
        storage pg { type: postgres }
        resource s { for: O, kind: state, use: pg }
        deployable api { platform: dotnet { persistence: dapper }  contexts: [O]  dataSources: [s]  serves: A  port: 8080 }
      }`;
    const { errors } = await emit(src);
    expect(
      errors.some((e) => /persistence: dapper/.test(e) && /workflow event subscriptions/.test(e)),
    ).toBe(true);
  });
  it("rejects a non-relational saving shape (shape(document))", async () => {
    const src = `
      system D {
        api A from S
        subdomain S { context O {
          aggregate Cart shape(document) with crudish { customer: string }
          repository Carts for Cart { }
        } }
        storage pg { type: postgres }  resource s { for: O, kind: state, use: pg }
        deployable api { platform: dotnet { persistence: dapper }  contexts: [O]  dataSources: [s]  serves: A  port: 8080 } }`;
    const { errors } = await emit(src);
    expect(errors.some((e) => /persistence: dapper/.test(e) && /shape\(document\)/.test(e))).toBe(
      true,
    );
  });

  it("accepts the supported subset (scalar / enum / VO / optional)", async () => {
    const { errors } = await emit(sys("dapper"));
    expect(errors).toEqual([]);
  });
});

// Capability filters on Dapper: a non-principal `filter <expr>` is spliced
// into every SELECT's WHERE (Dapper has no EF HasQueryFilter); the gate only
// rejects principal-referencing predicates (no request-scoped principal
// accessor on the Dapper repository).
describe("dapper capability filters", () => {
  it("ANDs a non-principal filter into every read", async () => {
    const { files, errors } = await emit(
      sys("dapper", "archived: bool\n        filter !this.archived"),
    );
    expect(errors).toEqual([]);
    const repo = [...files.entries()].find(([k]) =>
      k.endsWith("Repositories/OrderRepository.cs"),
    )![1];
    // GetById + FindManyByIds + findAll + the named find all carry it.
    expect(repo).toContain("WHERE id = @id AND (NOT archived)");
    expect(repo).toContain("WHERE id = ANY(@ids) AND (NOT archived)");
    expect(repo).toContain("FROM orders WHERE (NOT archived)");
    expect(repo).toContain("WHERE (customer = @customer) AND (NOT archived)");
  });

  it("applies lifecycle stamps: onUpdate mutates pre-save, onCreate is INSERT-only", async () => {
    const body = `createdAt: datetime
        updatedAt: datetime
        stamp onCreate { createdAt := now() }
        stamp onUpdate { updatedAt := now() }`;
    const { files, errors } = await emit(sys("dapper", body));
    expect(errors).toEqual([]);
    const repo = [...files.entries()].find(([k]) =>
      k.endsWith("Repositories/OrderRepository.cs"),
    )![1];
    // onUpdate mutates the in-memory aggregate (EF-interceptor parity) so
    // both the row and the projected response carry the stamp.
    expect(repo).toContain("aggregate.UpdatedAt = DateTime.UtcNow;");
    // onCreate binds an INSERT-only local …
    expect(repo).toContain("var __create_created_at = DateTime.UtcNow;");
    expect(repo).toContain("created_at = __create_created_at");
    // … and the upsert SET excludes it (an existing row keeps its value)
    // while still updating the onUpdate column.
    expect(repo).toMatch(
      /ON CONFLICT \(id\) DO UPDATE SET (?!.*created_at = excluded).*updated_at = excluded\.updated_at/,
    );
  });

  it("never emits a silent principal-referencing filter (model errors out upstream)", async () => {
    // The selectability validator already rejects `currentUser.<field>` in
    // this fixture shape; the dapper gate's principal check is the
    // defense-in-depth layer behind it.  Either way: errors, no silent drop.
    const { errors } = await emit(
      sys("dapper", "owner: string\n        filter this.owner == currentUser.email"),
    );
    expect(errors.length).toBeGreaterThan(0);
  });
});

// Reified-criteria parity: Dapper now supports `retrieval` bundles — the gate
// is lifted and Run<Name>Async renders as parameterised SQL (where + sort +
// offset/limit paging), with criterion candidate-fields as columns. No Ardalis
// Specification on this axis (that's the EF Core path).
describe("dapper retrievals (parity)", () => {
  const SRC = `
system D {
  api A from S
  subdomain S {
    context O {
      aggregate Customer with crudish { name: string  active: bool }
      repository Customers for Customer { }
      criterion NameIs(n: string) of Customer = name == n
      retrieval ByNameSorted(n: string) of Customer { where: NameIs(n) sort: [name asc] }
    }
  }
  storage pg { type: postgres }
  resource s { for: O, kind: state, use: pg }
  deployable api { platform: dotnet { persistence: dapper }  contexts: [O]  dataSources: [s]  serves: A  port: 8080 }
}`;

  it("no longer rejects retrievals; emits Run<Name>Async as parameterised SQL", async () => {
    const { files, errors } = await emit(SRC);
    expect(errors).toEqual([]); // the dapper retrieval gate is lifted
    const repo = files.get("api/Infrastructure/Repositories/CustomerRepository.cs")!;
    // The retrieval signature carries the two trailing optional filter-bypass
    // params (named-filter-bypass.md §11) uniformly with the EF path; the Dapper
    // body doesn't honor capability filters (raw SQL, no EF query filters), so
    // they are present-but-unused here — a Dapper-specific bypass gate is a later
    // slice's concern.
    expect(repo).toContain(
      "public async Task<IReadOnlyList<Customer>> RunByNameSortedAsync(string n, (int? offset, int? limit)? page = null, bool ignoreAllFilters = false, string[]? ignoreFilters = null, CancellationToken cancellationToken = default)",
    );
    // criterion `where: NameIs(n)` → inline SQL with this-prop → column.
    expect(repo).toContain(
      'var sql = "SELECT id, name, active FROM customers WHERE (name = @n) ORDER BY name ASC";',
    );
    expect(repo).toContain("var p = new DynamicParameters();");
    expect(repo).toContain('p.Add("n", n);');
    expect(repo).toMatch(/sql \+= " LIMIT @__lim"/);
  });

  it("emits no Ardalis Specification / dependency on the Dapper axis", async () => {
    const { files } = await emit(SRC);
    expect([...files.keys()].some((k) => k.endsWith("Spec.cs"))).toBe(false);
    expect(files.get("api/Api.csproj")!).not.toContain("Ardalis");
  });
});

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
import { adaptersFor } from "../../src/platform/resolve-adapters.js";
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
    expect(adaptersFor("dotnet")!.persistence.dapper).toBe(dapperPersistenceAdapter);
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
    // Optimistic concurrency (versioned default-on): the guarded upsert seeds
    // version 1 on INSERT, bumps version = version + 1 on conflict, and CASes
    // the conflict branch on the expected version (client `If-Match`, else the
    // loaded aggregate's own version, read ambiently exactly as the EF path).
    expect(repo).toContain(
      "var __expected = RequestContext.Current?.ExpectedVersion ?? aggregate.Version;",
    );
    expect(repo).toContain(
      "VALUES (@id, @customer, @status, @total::jsonb, @note, 1) ON CONFLICT (id) DO UPDATE SET customer = excluded.customer, status = excluded.status, total = excluded.total, note = excluded.note, version = orders.version + 1 WHERE orders.version = @ExpectedVersion",
    );
    // Zero affected rows ⇒ the CAS failed (stale write / stale precondition) ⇒
    // throw the persistence-neutral conflict exception (→ 409).
    expect(repo).toContain(
      'if (__affected == 0) throw new ConcurrencyConflictException("The resource was modified by another request; reload and retry.");',
    );
    // The persistence-neutral exception is emitted into Domain.Common (Dapper
    // only — EF keys its 409 arm on DbUpdateConcurrencyException).
    expect(files.get("api/Domain/Common/DomainException.cs")!).toContain(
      "public sealed class ConcurrencyConflictException : Exception",
    );
    // The exception filter maps it to the same 409 (status + Problem shape) the
    // EF arm produces — only the caught type differs.
    const filter = files.get("api/Api/DomainExceptionFilter.cs")!;
    expect(filter).toContain("if (context.Exception is ConcurrencyConflictException)");
    expect(filter).not.toContain("DbUpdateConcurrencyException"); // no EF type on the dapper path
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
    // The persistence-neutral ConcurrencyConflictException is Dapper-only — the
    // EF path keys its 409 arm on DbUpdateConcurrencyException, so Domain.Common
    // stays byte-identical (no new exception class).
    expect(files.get("api/Domain/Common/DomainException.cs")!).not.toContain(
      "ConcurrencyConflictException",
    );
    expect(files.get("api/Api/DomainExceptionFilter.cs")!).toContain(
      "DbUpdateConcurrencyException",
    );
  });

  // Event sourcing (appliers, Dapper edition): a `persistence: dapper` deployable
  // accepts a `persistedAs: eventLog` aggregate and emits the raw-Npgsql event
  // store + the `<agg>_events` DbSchema table, reusing the domain fold + CQRS.
  const esSys = `
system D {
  subdomain S {
    context O {
      event Opened { account: Account id, owner: string }
      aggregate Account persistedAs: eventLog {
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

  it("accepts persistedAs: eventLog and emits the Dapper event store", async () => {
    const { files, errors } = await emit(esSys);
    expect(errors).toEqual([]);
    const repo = files.get("api/Infrastructure/Repositories/AccountRepository.cs")!;
    expect(repo).toContain("Account._FromEvents(id, __rows.Select(RowToEvent).ToList());");
    // The aggregate's stream lives in the single per-context event log
    // `<ctx>_events` (context `O`), discriminated by `stream_type`
    // (event-log-architecture.md).
    expect(repo).toContain(
      "INSERT INTO o_events (stream_type, stream_id, version, type, data, occurred_at)",
    );
    // Reconstruction scopes to this aggregate's stream_type — the correctness
    // guard now that streams share one table.
    expect(repo).toContain("WHERE stream_type = @st AND stream_id = @sid");
    expect(repo).toContain('"Opened" => System.Text.Json.JsonSerializer.Deserialize<Opened>');
    // The per-context event table ships in the self-applied schema.
    expect(files.get("api/Infrastructure/Persistence/DbSchema.cs")).toContain(
      "CREATE TABLE IF NOT EXISTS o_events",
    );
  });

  // Wave 4: an event-sourced aggregate that ALSO declares `contains` parts is
  // no longer rejected.  Its parts fold in-memory from the event stream (the
  // `apply(...)` bodies), so the ES Dapper event store emits NO state / child
  // tables for them — only the `<ctx>_events` log.  The relational containment
  // emitters (child tables, HydrateAsync) never run.
  it("accepts contains on an event-sourced aggregate (no state/child tables)", async () => {
    const src = `
system D {
  subdomain S {
    context O {
      event Opened { account: Account id, owner: string }
      aggregate Account persistedAs: eventLog {
        owner: string
        contains lines: LedgerLine[]
        entity LedgerLine { memo: string  amount: int }
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
    const { files, errors } = await emit(src);
    expect(errors).toEqual([]); // the event-sourced-containment gate is lifted
    const repo = files.get("api/Infrastructure/Repositories/AccountRepository.cs")!;
    // Still the raw-Npgsql event store — folds the stream, no child-table load.
    expect(repo).toContain("Account._FromEvents(id, __rows.Select(RowToEvent).ToList());");
    expect(repo).not.toContain("HydrateAsync");
    // No child table for the contained part; only the event log.
    const schema = files.get("api/Infrastructure/Persistence/DbSchema.cs")!;
    expect(schema).not.toContain("CREATE TABLE IF NOT EXISTS ledger_lines");
    expect(schema).toContain("CREATE TABLE IF NOT EXISTS o_events");
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

  it("lowers a `this.<refColl>.contains(x)` find to an EXISTS join subquery", async () => {
    const src = `
system D {
  api A from S
  subdomain S {
    context O {
      aggregate Tag with crudish { label: string  derived display: string = this.label }
      aggregate Order with crudish {
        customer: string
        tags: Tag id[]
      }
      repository Orders for Order {
        find withTag(tag: Tag id): Order[] where this.tags.contains(tag)
      }
      repository Tags for Tag { }
    }
  }
  storage pg { type: postgres }
  resource s { for: O, kind: state, use: pg }
  deployable api { platform: dotnet { persistence: dapper }  contexts: [O]  dataSources: [s]  serves: A  port: 8080 }
}`;
    const { files, errors } = await emit(src);
    expect(errors).toEqual([]); // no longer rejected by the find-predicate gate
    const repo = files.get("api/Infrastructure/Repositories/OrderRepository.cs")!;
    // The membership predicate becomes an EXISTS subquery over the join table,
    // correlated on the owner row's id (the raw-SQL mirror of EF's `.Any(...)`).
    expect(repo).toContain(
      "WHERE EXISTS (SELECT 1 FROM order_tags __j WHERE __j.order_id = orders.id AND __j.tag_id = @tag)",
    );
    // The id param binds its wrapped `.Value` (Dapper has no strongly-typed id
    // handler), exactly like every other id-typed find param.
    expect(repo).toContain("new { tag = tag.Value }");
    // No runtime stub — the predicate is fully lowered.
    expect(repo).not.toContain("Dapper v1 does not support this find's predicate");
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
  it("no longer rejects seed data; emits a Dapper-framed Seed.cs", async () => {
    const src = `
system D {
  api A from S
  subdomain S {
    context O {
      aggregate Customer with crudish { name: string  active: bool }
      repository Customers for Customer { }
      seed default { Customer { name: "Acme", active: true } }
    }
  }
  storage pg { type: postgres }
  resource s { for: O, kind: state, use: pg }
  deployable api { platform: dotnet { persistence: dapper }  contexts: [O]  dataSources: [s]  serves: A  port: 8080 }
}`;
    const { files, errors } = await emit(src);
    expect(errors).toEqual([]); // the dapper seed gate is lifted
    const seed = files.get("api/Infrastructure/Persistence/Seed.cs")!;
    expect(seed).toBeDefined();
    // Framed on Npgsql+Dapper, not the EF AppDbContext.
    expect(seed).toContain(
      "public static async Task RunSeeds(NpgsqlDataSource db, IServiceProvider sp",
    );
    expect(seed).toContain("using Dapper;");
    expect(seed).not.toContain("AppDbContext");
    expect(seed).not.toContain("Microsoft.EntityFrameworkCore");
    // Marker table + idempotency go through Dapper's conn.ExecuteAsync.
    expect(seed).toContain('CREATE TABLE IF NOT EXISTS \\"__loom_seed\\"');
    expect(seed).toContain('INSERT INTO \\"__loom_seed\\" (\\"dataset\\") VALUES (@dataset)');
    // Domain-`Create` path is persistence-agnostic (repository SaveAsync).
    expect(seed).toContain(
      'await customerRepo.SaveAsync(Customer.Create(name: "Acme", active: true), cancellationToken);',
    );
    // Program.cs resolves the singleton NpgsqlDataSource from a scope (which
    // also resolves the scoped I<Agg>Repository the domain path uses).
    const program = files.get("api/Program.cs")!;
    expect(program).toContain(
      "var seedDb = seedScope.ServiceProvider.GetRequiredService<NpgsqlDataSource>();",
    );
  });

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
  it("still rejects a non-relational saving shape outside {document, embedded} (part-in-part on embedded)", async () => {
    // Embedded is supported for FLAT-part containments; a part-in-part stays
    // gated (the conservative v1 embedded surface).
    const src = `
      system D {
        api A from S
        subdomain S { context O {
          aggregate Cart shape: embedded with crudish {
            customer: string
            contains boxes: Box[]
            entity Box { label: string  contains items: Item[]  entity Item { sku: string } }
          }
          repository Carts for Cart { }
        } }
        storage pg { type: postgres }  resource s { for: O, kind: state, use: pg }
        deployable api { platform: dotnet { persistence: dapper }  contexts: [O]  dataSources: [s]  serves: A  port: 8080 } }`;
    const { errors } = await emit(src);
    expect(errors.some((e) => /persistence: dapper/.test(e) && /part-in-part/.test(e))).toBe(true);
  });

  it("accepts the supported subset (scalar / enum / VO / optional)", async () => {
    const { errors } = await emit(sys("dapper"));
    expect(errors).toEqual([]);
  });
});

// Nested entity parts (`contains lineItems: LineItem[]`) on Dapper: one FLAT
// child table per containment (`id` PK + `<agg>_id` FK + the part's own
// columns), bulk-loaded + hydrated through the root's `_Create(State)` seam,
// full-list-replaced on save, cascade-deleted.
describe("dapper nested entity parts (contains)", () => {
  const PARTS = `
system D {
  api A from S
  subdomain S {
    context O {
      valueobject Money { amount: int  currency: string }
      aggregate Order with crudish {
        customer: string
        contains lineItems: LineItem[]
        contains shipping: ShipInfo?
        entity LineItem { sku: string  price: Money  qty: int  note: string? }
        entity ShipInfo { address: string }
      }
      repository Orders for Order { }
    }
  }
  storage pg { type: postgres }
  resource s { for: O, kind: state, use: pg }
  deployable api { platform: dotnet { persistence: dapper }  contexts: [O]  dataSources: [s]  serves: A  port: 8080 }
}`;

  it("emits child tables + a HydrateAsync load/save/delete graph", async () => {
    const { files, errors } = await emit(PARTS);
    expect(errors).toEqual([]);
    const schema = files.get("api/Infrastructure/Persistence/DbSchema.cs")!;
    // One child table per containment, FK-cascaded to the root + indexed.
    expect(schema).toContain("order_id uuid not null references orders (id) on delete cascade");
    expect(schema).toContain("CREATE TABLE IF NOT EXISTS line_items");
    expect(schema).toContain("CREATE TABLE IF NOT EXISTS ship_infos");
    expect(schema).toContain("CREATE INDEX IF NOT EXISTS line_items_order_id_idx");
    const repo = files.get("api/Infrastructure/Repositories/OrderRepository.cs")!;
    // The root has no flat `Map` (reads reconstruct via HydrateAsync); children
    // hydrate through the part's own `_Create(State)` seam.
    expect(repo).not.toContain("private static Order Map(Row r)");
    expect(repo).toContain(
      "private static async Task<List<Order>> HydrateAsync(NpgsqlConnection conn, List<Row> rows, CancellationToken cancellationToken)",
    );
    expect(repo).toContain("LineItem._Create(new LineItem.State");
    expect(repo).toContain(
      "LineItems = __lineItemsByOwner.TryGetValue(r.id, out var __lineItems) ? __lineItems : new List<LineItem>(),",
    );
    // Single optional containment hydrates 0-or-1 and slots null when absent.
    expect(repo).toContain(
      "Shipping = __shippingByOwner.TryGetValue(r.id, out var __shipping) ? __shipping : null,",
    );
    // Save is full-list-replace per containment; each block uses a unique loop
    // var so two save blocks don't collide in the one SaveAsync.
    expect(repo).toContain("DELETE FROM line_items WHERE order_id = @id");
    expect(repo).toContain("foreach (var __lineItemsChild in aggregate.LineItems)");
    expect(repo).toContain("if (aggregate.Shipping is { } __shippingChild)");
    // Delete cascades children first.
    expect(repo).toContain("DELETE FROM line_items WHERE order_id = @id");
    expect(repo).toContain("DELETE FROM ship_infos WHERE order_id = @id");
  });

  it("still rejects a part-in-part (nested containment)", async () => {
    const src = `
system D {
  api A from S
  subdomain S {
    context O {
      aggregate Order with crudish {
        customer: string
        contains boxes: Box[]
        entity Box { label: string  contains items: Item[]  entity Item { sku: string } }
      }
      repository Orders for Order { }
    }
  }
  storage pg { type: postgres }
  resource s { for: O, kind: state, use: pg }
  deployable api { platform: dotnet { persistence: dapper }  contexts: [O]  dataSources: [s]  serves: A  port: 8080 }
}`;
    const { errors } = await emit(src);
    expect(errors.some((e) => /persistence: dapper/.test(e) && /part-in-part/.test(e))).toBe(true);
  });

  it("still rejects nested parts combined with a reference collection", async () => {
    const src = `
system D {
  api A from S
  subdomain S {
    context O {
      aggregate Tag with crudish { label: string }
      aggregate Order with crudish {
        customer: string
        tags: Tag id[]
        contains lineItems: LineItem[]
        entity LineItem { sku: string }
      }
      repository Orders for Order { }
      repository Tags for Tag { }
    }
  }
  storage pg { type: postgres }
  resource s { for: O, kind: state, use: pg }
  deployable api { platform: dotnet { persistence: dapper }  contexts: [O]  dataSources: [s]  serves: A  port: 8080 }
}`;
    const { errors } = await emit(src);
    expect(
      errors.some(
        (e) => /persistence: dapper/.test(e) && /reference-collection associations/.test(e),
      ),
    ).toBe(true);
  });
});

// Document shape (`shape(document)`) on Dapper (M-T6.9 wave 3): the whole
// aggregate persists as one JSONB `data` blob (a `(id, data, version)` table),
// reusing the persistence-agnostic ToSnapshot/FromSnapshot round-trip; contained
// parts + `X id[]` references fold into the blob (no child/join tables).  Finds
// run in-memory over the rehydrated documents.
describe("dapper document shape (contains + finds)", () => {
  const DOC = `
system D {
  api A from S
  subdomain S {
    context O {
      valueobject Money { amount: int  currency: string }
      aggregate Cart shape: document with crudish {
        customer: string
        total:    Money
        contains lines: CartLine[]
        entity CartLine { sku: string  qty: int }
      }
      repository Carts for Cart {
        find byCustomer(customer: string): Cart[] where this.customer == customer
      }
    }
  }
  storage pg { type: postgres }
  resource s { for: O, kind: state, use: pg }
  deployable api { platform: dotnet { persistence: dapper }  contexts: [O]  dataSources: [s]  serves: A  port: 8080 }
}`;

  it("no longer rejects shape(document); emits a (id, data, version) blob table + JSONB repository", async () => {
    const { files, errors } = await emit(DOC);
    expect(errors).toEqual([]); // the dapper document gate is lifted
    // Blob table (no per-field columns, no child/join tables).
    const schema = files.get("api/Infrastructure/Persistence/DbSchema.cs")!;
    expect(schema).toContain("CREATE TABLE IF NOT EXISTS carts (");
    expect(schema).toContain("data jsonb not null");
    expect(schema).toContain("version int not null");
    expect(schema).not.toContain("CREATE TABLE IF NOT EXISTS cart_lines"); // parts fold into the blob
    // The repository (de)serialises the whole aggregate through the snapshot.
    const repo = files.get("api/Infrastructure/Repositories/CartRepository.cs")!;
    expect(repo).toContain(
      "Cart.FromSnapshot(System.Text.Json.JsonSerializer.Deserialize<CartSnapshot>(__d.data, __json)!)",
    );
    expect(repo).toContain(
      "System.Text.Json.JsonSerializer.Serialize(aggregate.ToSnapshot(), __json)",
    );
    expect(repo).toContain(
      "ON CONFLICT (id) DO UPDATE SET data = excluded.data, version = carts.version + 1 WHERE carts.version = @ExpectedVersion",
    );
    // Finds run in-memory over the rehydrated documents (no SQL WHERE).
    expect(repo).toContain("var __all = __rows.Select(__d => Cart.FromSnapshot(");
    expect(repo).toContain(".Where(x => x.Customer == customer).ToList();");
    // Snapshot DTOs are emitted; the EF <Agg>Document POCO / configuration are NOT.
    expect(files.has("api/Domain/Carts/CartSnapshots.cs")).toBe(true);
    expect(files.has("api/Domain/Carts/CartDocument.cs")).toBe(false);
    expect(
      files.has("api/Infrastructure/Persistence/Configurations/CartDocumentConfiguration.cs"),
    ).toBe(false);
    // No EF AppDbContext on the Dapper deployable.
    expect(files.has("api/Infrastructure/Persistence/AppDbContext.cs")).toBe(false);
  });
});

// Embedded shape (`shape(embedded)`) on Dapper (M-T6.9 wave 3): flat root
// columns PLUS one JSONB column per containment (the part sub-graph folds into
// it via the ToSnapshot/FromSnapshot round-trip), no child tables.  The flat
// `Map` hydrates each containment from its JSONB column.
describe("dapper embedded shape (containments as jsonb columns)", () => {
  const EMB = `
system D {
  api A from S
  subdomain S {
    context O {
      enum LineKind { Physical, Digital }
      valueobject Money { amount: int  currency: string }
      aggregate Cart shape: embedded with crudish {
        customer: string
        total:    Money
        contains lines: CartLine[]
        contains coupon: Coupon?
        entity CartLine { sku: string  qty: int  kind: LineKind  price: Money }
        entity Coupon { code: string  percent: int }
      }
      repository Carts for Cart {
        find byCustomer(customer: string): Cart[] where this.customer == customer
      }
    }
  }
  storage pg { type: postgres }
  resource s { for: O, kind: state, use: pg }
  deployable api { platform: dotnet { persistence: dapper }  contexts: [O]  dataSources: [s]  serves: A  port: 8080 }
}`;

  it("no longer rejects shape(embedded); folds containments into JSONB columns (no child tables)", async () => {
    const { files, errors } = await emit(EMB);
    expect(errors).toEqual([]); // the dapper embedded gate is lifted
    const schema = files.get("api/Infrastructure/Persistence/DbSchema.cs")!;
    // Flat root columns + one jsonb column per containment; NO child tables.
    expect(schema).toContain("customer text not null");
    expect(schema).toContain("lines jsonb not null");
    expect(schema).toContain("coupon jsonb"); // single optional → nullable
    expect(schema).not.toContain("CREATE TABLE IF NOT EXISTS cart_lines");
    expect(schema).not.toContain("CREATE TABLE IF NOT EXISTS coupons");
    const repo = files.get("api/Infrastructure/Repositories/CartRepository.cs")!;
    // The JSONB options field + the snapshot (de)serialisation.
    expect(repo).toContain("private static readonly System.Text.Json.JsonSerializerOptions __json");
    expect(repo).toContain(
      "Lines = System.Text.Json.JsonSerializer.Deserialize<List<CartLineSnapshot>>(r.lines, __json)!.Select(CartLine.FromSnapshot).ToList()",
    );
    expect(repo).toContain(
      "Coupon = r.coupon is null ? null : Coupon.FromSnapshot(System.Text.Json.JsonSerializer.Deserialize<CouponSnapshot>(r.coupon, __json)!)",
    );
    expect(repo).toContain(
      "lines = System.Text.Json.JsonSerializer.Serialize(aggregate.Lines.Select(__x => __x.ToSnapshot()).ToList(), __json)",
    );
    // Reads still go through the flat Map (no HydrateAsync child-table load).
    expect(repo).toContain("private static Cart Map(Row r)");
    expect(repo).not.toContain("HydrateAsync");
    // Snapshot DTOs emitted; no EF document/owned config on the Dapper path.
    expect(files.has("api/Domain/Carts/CartSnapshots.cs")).toBe(true);
    expect(files.has("api/Infrastructure/Persistence/AppDbContext.cs")).toBe(false);
  });
});

// TPC (`ownTable`) aggregate inheritance on Dapper (M-T6.9 wave 3): each
// concrete is a standalone table carrying the MERGED base fields (a normal
// Dapper repository); the abstract base owns no table; the polymorphic
// `find all <Base>` base reader is persistence-agnostic (it delegates to each
// concrete's `All()`).  TPH (`sharedTable`) stays gated.
describe("dapper TPC (ownTable) aggregate inheritance", () => {
  const TPC = `
system D {
  api A from Registry
  subdomain Registry {
    context Parties {
      abstract aggregate Party inheritanceUsing: ownTable {
        name: string
        email: string
      }
      aggregate Customer extends Party with crudish {
        creditLimit: int
        operation raiseLimit(by: int) { creditLimit := creditLimit + by }
      }
      aggregate Vendor extends Party with crudish { rating: int }
      repository Customers for Customer {
        find byEmail(email: string): Customer? where this.email == email
      }
      repository Vendors for Vendor { }
    }
  }
  storage pg { type: postgres }
  resource s { for: Parties, kind: state, use: pg }
  deployable api { platform: dotnet { persistence: dapper }  contexts: [Parties]  dataSources: [s]  serves: A  port: 8080 }
}`;

  it("no longer rejects TPC inheritance; each concrete gets a standalone merged-field table", async () => {
    const { files, errors } = await emit(TPC);
    expect(errors).toEqual([]); // the dapper TPC inheritance gate is lifted
    const schema = files.get("api/Infrastructure/Persistence/DbSchema.cs")!;
    // Standalone concrete tables carry base + own columns; the abstract base
    // owns NO table.
    expect(schema).toContain("CREATE TABLE IF NOT EXISTS customers");
    expect(schema).toContain("CREATE TABLE IF NOT EXISTS vendors");
    expect(schema).not.toContain("CREATE TABLE IF NOT EXISTS parties");
    const customer = files.get("api/Infrastructure/Repositories/CustomerRepository.cs")!;
    // The concrete's Map hydrates the merged (inherited + own) State fields.
    expect(customer).toContain("Name = r.name,");
    expect(customer).toContain("Email = r.email,");
    expect(customer).toContain("CreditLimit = r.credit_limit,");
    // The polymorphic base reader delegates to each concrete's All().
    const base = files.get("api/Infrastructure/Repositories/PartyRepository.cs")!;
    expect(base).toContain("result.AddRange(await _customerRepo.All(cancellationToken));");
    expect(base).toContain("result.AddRange(await _vendorRepo.All(cancellationToken));");
  });

  it("still rejects TPH (sharedTable) inheritance", async () => {
    const src = TPC.replace("inheritanceUsing: ownTable", "inheritanceUsing: sharedTable");
    const { errors } = await emit(src);
    expect(errors.some((e) => /persistence: dapper/.test(e) && /TPH \(sharedTable\)/.test(e))).toBe(
      true,
    );
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

  it("applies lifecycle stamps as bound upsert params: onUpdate in the SET, onCreate INSERT-only", async () => {
    const body = `createdAt: datetime
        updatedAt: datetime
        stamp onCreate { createdAt := now() }
        stamp onUpdate { updatedAt := now() }`;
    const { files, errors } = await emit(sys("dapper", body));
    expect(errors).toEqual([]);
    const repo = [...files.entries()].find(([k]) =>
      k.endsWith("Repositories/OrderRepository.cs"),
    )![1];
    // Stamps bind as column params (the entity's fields are `{ get; private
    // set; }`, so the Dapper repo can't mutate them — it computes a local and
    // binds it, reaching both the INSERT and the ON CONFLICT SET).
    expect(repo).not.toContain("aggregate.UpdatedAt =");
    expect(repo).toContain("var __create_created_at = DateTime.UtcNow;");
    expect(repo).toContain("created_at = __create_created_at");
    expect(repo).toContain("var __stamp_updated_at = DateTime.UtcNow;");
    expect(repo).toContain("updated_at = __stamp_updated_at");
    // The upsert SET excludes the onCreate column (an existing row keeps its
    // value) while still updating the onUpdate column.
    expect(repo).toMatch(
      /ON CONFLICT \(id\) DO UPDATE SET (?!.*created_at = excluded).*updated_at = excluded\.updated_at/,
    );
  });

  it("never emits a silent principal filter on a no-auth deployable (errors upstream)", async () => {
    // Without a `user {}`/auth deployable there is no principal to reference, so
    // `currentUser.<field>` is unresolvable upstream (selectability validator).
    // Errors, no silent drop.
    const { errors } = await emit(
      sys("dapper", "owner: string\n        filter this.owner == currentUser.email"),
    );
    expect(errors.length).toBeGreaterThan(0);
  });
});

// Principal-referencing stamps + filters on Dapper: with an auth deployable the
// Dapper repository reaches the request principal through the ambient
// `RequestContext.Current!.CurrentUser!` accessor — the raw-SQL mirror of the EF
// AuditableInterceptor + per-request HasQueryFilter.  A bare `currentUser` stamp
// → the principal id; `currentUser.<claim>` → the claim; a principal `filter`
// lowers `currentUser.<claim>` to a `@__cu_<claim>` Dapper param bound on every
// SELECT.
describe("dapper principal stamps + filters (auth)", () => {
  const AUTH_SRC = `
system D {
  user { id: guid  tenantId: string }
  tenancy by user.tenantId of Org
  subdomain S {
    context O {
      aggregate Invoice with tenantOwned, auditable, crudish {
        number: string
      }
      aggregate Org with crudish { name: string }
      repository Invoices for Invoice {
        find byNumber(n: string): Invoice[] where this.number == n
        find mine(): Invoice[] where this.createdBy == currentUser.id
      }
      repository Orgs for Org { }
    }
  }
  api A from S
  storage pg { type: postgres }
  resource s { for: O, kind: state, use: pg }
  deployable api {
    platform: dotnet { persistence: dapper }
    contexts: [O]  dataSources: [s]  serves: A  port: 8080  auth: required
  }
}`;

  it("no longer rejects principal stamps/filters; binds them from the ambient principal", async () => {
    const { files, errors } = await emit(AUTH_SRC);
    expect(errors).toEqual([]); // both principal gates are lifted
    const repo = files.get("api/Infrastructure/Repositories/InvoiceRepository.cs")!;
    // Principal filter → a `@__cu_tenantId` param bound from the request
    // principal, spliced into every SELECT (GetById shown).
    expect(repo).toContain("WHERE id = @id AND (tenant_id = @__cu_tenantId)");
    expect(repo).toContain("__cu_tenantId = RequestContext.Current!.CurrentUser!.TenantId");
    // The named find carries it too.
    expect(repo).toContain("WHERE (number = @n) AND (tenant_id = @__cu_tenantId)");
    // Member-access principal stamp (tenantId := currentUser.tenantId) → the
    // claim; bare `currentUser` stamp (createdBy/updatedBy := currentUser) → the
    // principal id — both as bound upsert params (no private-setter mutation).
    expect(repo).toContain(
      "var __create_tenant_id = RequestContext.Current!.CurrentUser!.TenantId;",
    );
    expect(repo).toContain("var __create_created_by = RequestContext.Current!.CurrentUser!.Id;");
    expect(repo).toContain("var __stamp_updated_by = RequestContext.Current!.CurrentUser!.Id;");
    expect(repo).not.toContain("aggregate.UpdatedBy =");
    // No EF SaveChangesInterceptor is emitted on the Dapper deployable (it would
    // reference Microsoft.EntityFrameworkCore, absent here).
    expect(files.has("api/Infrastructure/Persistence/AuditableInterceptor.cs")).toBe(false);
  });

  it("widens the find-predicate subset: `currentUser.<claim>` in a find `where`", async () => {
    const { files, errors } = await emit(AUTH_SRC);
    expect(errors).toEqual([]); // the Dapper find-predicate currentUser gate is lifted
    const repo = files.get("api/Infrastructure/Repositories/InvoiceRepository.cs")!;
    // The find carries the shared interface's `User currentUser` param and binds
    // its own `@__cu_id` ref + the inherited capability filter's `@__cu_tenantId`
    // from that parameter (not the ambient accessor).
    expect(repo).toContain(
      "public async Task<List<Invoice>> Mine(User currentUser, CancellationToken cancellationToken = default)",
    );
    expect(repo).toContain("WHERE (created_by = @__cu_id) AND (tenant_id = @__cu_tenantId)");
    expect(repo).toContain("__cu_id = currentUser.Id");
    expect(repo).toContain("__cu_tenantId = currentUser.TenantId");
  });
});

// Provenanced fields on Dapper: the co-located `<field>_provenance` jsonb column
// round-trips the ProvLineage (ProvJson.Options) and SaveAsync flushes the
// drained lineage into the `provenance_records` history table (DbSchema owns the
// DDL) — the raw-Npgsql mirror of the EF value-converter + ProvenanceRecord
// flush.  The shared ProvLineage SDK is emitted; the EF ProvenanceRecord
// POCO/configuration are NOT (they'd reference Microsoft.EntityFrameworkCore).
describe("dapper provenanced fields", () => {
  const PROV_SRC = `
system D {
  api A from S
  subdomain S {
    context O {
      aggregate Order with crudish {
        quantity: int
        price:    int
        total:    int provenanced
        operation reprice(qty: int, unit: int) {
          quantity := qty
          price    := unit
          total    := qty * unit
        }
      }
      repository Orders for Order { }
    }
  }
  storage pg { type: postgres }
  resource s { for: O, kind: state, use: pg }
  deployable api { platform: dotnet { persistence: dapper }  contexts: [O]  dataSources: [s]  serves: A  port: 8080 }
}`;

  it("no longer rejects provenanced fields; round-trips the co-located column + flushes history", async () => {
    const { files, errors } = await emit(PROV_SRC);
    expect(errors).toEqual([]); // the dapper provenance gate is lifted
    const repo = files.get("api/Infrastructure/Repositories/OrderRepository.cs")!;
    // Co-located `total_provenance` jsonb column round-trips the lineage.
    expect(repo).toContain("public string? total_provenance { get; set; }");
    expect(repo).toContain(
      "TotalProvenance = r.total_provenance is null ? null : System.Text.Json.JsonSerializer.Deserialize<ProvLineage>(r.total_provenance, ProvJson.Options)",
    );
    expect(repo).toContain("total_provenance = excluded.total_provenance");
    // SaveAsync flushes the drained lineage into provenance_records.
    expect(repo).toContain("foreach (var __lin in aggregate.DrainProv())");
    expect(repo).toContain("INSERT INTO provenance_records (trace_id, snapshot_id, target_type");
    // The shared lineage SDK is emitted; the EF history POCO/config are not.
    expect(files.has("api/Domain/Common/ProvLineage.cs")).toBe(true);
    expect(files.has("api/Infrastructure/Persistence/ProvenanceRecord.cs")).toBe(false);
    expect(
      files.has("api/Infrastructure/Persistence/Configurations/ProvenanceRecordConfiguration.cs"),
    ).toBe(false);
    // DbSchema owns the history table + co-located column DDL.
    const schema = files.get("api/Infrastructure/Persistence/DbSchema.cs")!;
    expect(schema).toContain("total_provenance jsonb");
    expect(schema).toContain("CREATE TABLE IF NOT EXISTS provenance_records (");
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
    // The retrieval signature carries the domain-termed `FilterBypass` param
    // (named-filter-bypass.md §11 / audit S7) uniformly with the EF path — no EF
    // vocabulary on the port; the Dapper body doesn't honor capability filters
    // (raw SQL, no EF query filters), so it is present-but-unused here — a
    // Dapper-specific bypass gate is a later slice's concern.
    expect(repo).toContain(
      "public async Task<IReadOnlyList<Customer>> RunByNameSortedAsync(string n, (int? offset, int? limit)? page = null, FilterBypass bypass = default, CancellationToken cancellationToken = default)",
    );
    // criterion `where: NameIs(n)` → inline SQL with this-prop → column.
    expect(repo).toContain(
      'var sql = "SELECT id, name, active, version FROM customers WHERE (name = @n) ORDER BY name ASC";',
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

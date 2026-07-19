// mikroorm — minimal-v1 PersistenceAdapter for node/hono (D-REALIZATION-AXES
// Phase 5d).  `persistence: mikroorm` emits an idiomatic MikroORM db/ layer
// (EntitySchema model + EntityManager repositories) alongside the default
// drizzle, reusing the persistence-agnostic domain layer; the validator gates
// the unsupported feature surface.

import { NodeFileSystem } from "langium/node";
import { parseHelper } from "langium/test";
import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { createDddServices } from "../../src/language/ddd-module.js";
import type { Model } from "../../src/language/generated/ast.js";
import { mikroOrmPersistenceAdapter } from "../../src/platform/hono/v4/adapters/mikroorm-persistence.js";
import { adaptersFor } from "../../src/platform/resolve-adapters.js";
import { generateSystems } from "../../src/system/index.js";

/** Lower + enrich + run parse diagnostics AND the IR validator (where
 *  `loom.mikroorm-unsupported` lives), then emit. */
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

const sys = (persistence: string, body = "") => `
system M {
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
  deployable api { platform: node { persistence: ${persistence} }  contexts: [O]  dataSources: [s]  serves: A  port: 8080 }
}`;

describe("mikroorm persistence adapter — node/hono (Phase 5d)", () => {
  it("is registered as a real persistence adapter", () => {
    expect(adaptersFor("node")!.persistence.mikroorm).toBe(mikroOrmPersistenceAdapter);
    expect(mikroOrmPersistenceAdapter.name).toBe("mikroorm");
    expect(mikroOrmPersistenceAdapter.supportedStrategies).toEqual(["state", "eventLog"]);
  });

  it("emits an idiomatic MikroORM db/ layer instead of drizzle", async () => {
    const { files, errors } = await emit(sys("mikroorm"));
    expect(errors).toEqual([]);
    // EntitySchema model + config replace the drizzle schema + migrations.
    expect(files.has("api/db/entities.ts")).toBe(true);
    expect(files.has("api/mikro-orm.config.ts")).toBe(true);
    expect(files.has("api/db/schema.ts")).toBe(false);
    expect(files.has("api/drizzle.config.ts")).toBe(false);
    const entities = files.get("api/db/entities.ts")!;
    expect(entities).toContain("new EntitySchema<OrderRow>");
    expect(entities).toContain("@mikro-orm/core");
    const repo = files.get("api/db/repositories/order-repository.ts")!;
    expect(repo).toContain('import { EntityManager } from "@mikro-orm/postgresql"');
    expect(repo).toContain("this.em.fork({ keepTransactionContext: true })"); // idiomatic isolated unit-of-work
    // Versioning is default-on (M-T3.4): the save is the guarded optimistic-
    // concurrency write (findOne → insert / version-CAS nativeUpdate), not a
    // blind upsert.
    expect(repo).toContain("await em.nativeUpdate(OrderRow,");
    expect(repo).toContain('throw new ConcurrencyError("Order",');
    expect(repo).toContain("Order._rehydrate({"); // shared hydration seam (RS-10: trusts the store)
    expect(repo).not.toContain("drizzle");
    // package.json + index wiring.
    expect(files.get("api/package.json")).toContain("@mikro-orm/postgresql");
    expect(files.get("api/package.json")).not.toContain("drizzle");
    expect(files.get("api/index.ts")).toContain("MikroORM.init");
    expect(files.get("api/index.ts")).toContain("orm.schema.updateSchema()");
  });

  it("the drizzle default is unchanged (drizzle schema, no entities)", async () => {
    const { files, errors } = await emit(sys("drizzle"));
    expect(errors).toEqual([]);
    expect(files.has("api/db/schema.ts")).toBe(true);
    expect(files.has("api/db/entities.ts")).toBe(false);
  });

  // Event sourcing (appliers, MikroORM edition): a `persistence: mikroorm`
  // deployable accepts a `persistedAs: eventLog` aggregate and emits the
  // EntityManager event store over the single per-context `<ctx>_events`
  // EntitySchema (discriminated by `stream_type`), reusing the domain fold + CQRS.
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
  deployable api { platform: node { persistence: mikroorm }  contexts: [O]  dataSources: [s]  port: 8080 }
}`;

  it("accepts persistedAs: eventLog and emits the MikroORM event store", async () => {
    const { files, errors } = await emit(esSys);
    expect(errors).toEqual([]);
    const entities = files.get("api/db/entities.ts")!;
    // One shared per-context event-log row, discriminated by stream_type, with
    // a composite (streamType, streamId, version) PK + inert seq cursor.
    expect(entities).toContain("export class OEventRow");
    expect(entities).toContain('tableName: "o_events"');
    expect(entities).toContain('streamType: { type: "string", primary: true }');
    expect(entities).toContain(
      'seq: { type: "number", columnType: "bigint", autoincrement: true }',
    );
    const repo = files.get("api/db/repositories/account-repository.ts")!;
    expect(repo).toContain("Account._fromEvents(");
    expect(repo).toContain("em.persist(r);");
    expect(repo).toContain("function rowToEvent(");
    // The aggregate's stream is filtered + stamped by its stream_type.
    expect(repo).toContain('{ streamType: "Account", streamId: id as string }');
    expect(repo).toContain('r.streamType = "Account";');
  });
});

// ---------------------------------------------------------------------------
// Context `retrieval` query bundles on mikroorm (DEBT-17) — emitted as
// `run<Name>` repository methods, the MikroORM analogue of the drizzle
// `runMethod`: `where` → FilterQuery, `sort` → `orderBy`, call-site `page` →
// `limit`/`offset`.  An out-of-subset predicate emits a runtime-throwing stub
// (mirrors the find path / the .NET Dapper v1 retrieval path).
// ---------------------------------------------------------------------------
describe("mikroorm — context retrievals (DEBT-17)", () => {
  const RETRIEVAL_SRC = `system M {
  api A from S
  subdomain S {
    context O {
      enum Status { Draft, Confirmed }
      aggregate Order with crudish {
        customer: string
        status:   Status
        quantity: int
        placedAt: datetime
        active:   bool
      }
      repository Orders for Order { }
      retrieval BulkOrders(min: int) of Order {
        where: this.status == Status.Confirmed && this.quantity >= min
        sort: [placedAt desc]
      }
    }
  }
  storage pg { type: postgres }
  resource s { for: O, kind: state, use: pg }
  deployable api { platform: node { persistence: mikroorm }  contexts: [O]  dataSources: [s]  serves: A  port: 8080 }
}`;

  it("no longer trips loom.mikroorm-unsupported for a retrieval", async () => {
    const { errors } = await emit(RETRIEVAL_SRC);
    expect(errors).toEqual([]);
  });

  it("emits a run<Name>(..., page?) method with where + orderBy + limit/offset", async () => {
    const { files } = await emit(RETRIEVAL_SRC);
    const repo = files.get("api/db/repositories/order-repository.ts")!;
    expect(repo).toContain(
      "async runBulkOrders(min: number, page?: { offset?: number; limit?: number }): Promise<Order[]>",
    );
    // where → FilterQuery (enum value + scalar $gte), page → limit/offset,
    // sort → orderBy.
    expect(repo).toContain(
      'await em.find(OrderRow, { status: "Confirmed", quantity: { $gte: min } }, ' +
        '{ limit: page?.limit, offset: page?.offset, orderBy: { placedAt: "desc" } });',
    );
    // Reuses the shared flat hydration seam (no bulk-load of containments).
    expect(repo).toContain("Order._rehydrate({");
  });

  it("lowers a bare-boolean retrieval `where` to `{ col: true }` (wave 1 widening)", async () => {
    // A bare boolean column (`this.active`) is now inside the MikroORM
    // FilterQuery subset — it lowers to `{ active: true }` (drizzle's `col =
    // true` analogue), so the retrieval is accepted and emits a real run method.
    const src = RETRIEVAL_SRC.replace(
      "where: this.status == Status.Confirmed && this.quantity >= min",
      "where: this.active",
    ).replace("BulkOrders(min: int)", "Active()");
    const { files, errors } = await emit(src);
    expect(errors).toEqual([]);
    const repo = files.get("api/db/repositories/order-repository.ts")!;
    expect(repo).toContain("await em.find(OrderRow, { active: true }, ");
  });
});

// ---------------------------------------------------------------------------
// find-predicate subset widening (wave 1) — `whereToMikroFilter` now lowers
// bare boolean columns (`{ col: true }`), negated boolean columns (`{ col:
// false }`) and unary `!` (via `$not` / a `false` entry), in addition to the
// original comparisons + &&/||.  `currentUser` + refColl `contains` stay gated.
// ---------------------------------------------------------------------------
describe("mikroorm — widened find predicates (bare boolean / unary NOT)", () => {
  const BOOL_SRC = `system M {
  api A from S
  subdomain S {
    context O {
      aggregate Order with crudish {
        customer: string
        active: bool
        archived: bool
      }
      repository Orders for Order {
        find live(): Order[] where this.active
        find inactive(): Order[] where !this.active
        find liveOrArchived(): Order[] where this.active || this.archived
        find complex(): Order[] where this.active && !this.archived
      }
    }
  }
  storage pg { type: postgres }
  resource s { for: O, kind: state, use: pg }
  deployable api { platform: node { persistence: mikroorm }  contexts: [O]  dataSources: [s]  serves: A  port: 8080 }
}`;

  it("lowers bare boolean / negated boolean / ||-of-booleans to FilterQuery", async () => {
    const { files, errors } = await emit(BOOL_SRC);
    expect(errors).toEqual([]);
    const repo = files.get("api/db/repositories/order-repository.ts")!;
    expect(repo).toContain("await em.find(OrderRow, { active: true })");
    expect(repo).toContain("await em.find(OrderRow, { active: false })");
    expect(repo).toContain(
      "await em.find(OrderRow, { $or: [{ active: true }, { archived: true }] })",
    );
    expect(repo).toContain("await em.find(OrderRow, { active: true, archived: false })");
  });
});

// ---------------------------------------------------------------------------
// `filter` capability predicates (wave 1) — MikroORM has no global query
// filter, so the repository ANDs each non-principal predicate (a FilterQuery)
// into every root read via `$and`, honoring a read's `ignoring` bypass.
// ---------------------------------------------------------------------------
describe("mikroorm — `filter` capability predicates", () => {
  const FILTER_SRC = `system M {
  api A from S
  subdomain S {
    context O {
      enum Status { Active, Archived }
      aggregate Order with crudish {
        customer: string
        status: Status
        deleted: bool
        filter this.status == Status.Active
        filter !this.deleted
      }
      repository Orders for Order {
        find byCustomer(customer: string): Order[] where this.customer == customer
      }
    }
  }
  storage pg { type: postgres }
  resource s { for: O, kind: state, use: pg }
  deployable api { platform: node { persistence: mikroorm }  contexts: [O]  dataSources: [s]  serves: A  port: 8080 }
}`;

  it("no longer trips loom.mikroorm-unsupported for a filter capability", async () => {
    const { errors } = await emit(FILTER_SRC);
    expect(errors).toEqual([]);
  });

  it("ANDs the filters into findById / findManyByIds / find / findAll", async () => {
    const { files } = await emit(FILTER_SRC);
    const repo = files.get("api/db/repositories/order-repository.ts")!;
    // findById — the `{ id }` base joined with both filters under `$and`.
    expect(repo).toContain(
      'await em.findOne(OrderRow, { $and: [{ id: id as string }, { status: "Active" }, { deleted: false }] });',
    );
    // findManyByIds — the `$in` base joined too.
    expect(repo).toContain(
      'await em.find(OrderRow, { $and: [{ id: { $in: ids as string[] } }, { status: "Active" }, { deleted: false }] });',
    );
    // A declared find — its own `where` joined with the filters.
    expect(repo).toContain(
      'await em.find(OrderRow, { $and: [{ customer: customer }, { status: "Active" }, { deleted: false }] });',
    );
    // The auto-`findAll` (paged, empty base) — the `{}` base is dropped.
    expect(repo).toContain(
      'await em.find(OrderRow, { $and: [{ status: "Active" }, { deleted: false }] }, { limit: pageSize,',
    );
  });

  it("honors `ignoring <Cap>` / `ignoring *` on a read (softDeletable capability)", async () => {
    const src = `system M {
  api A from S
  subdomain S {
    context O {
      aggregate Order with crudish, softDeletable {
        customer: string
      }
      repository Orders for Order {
        find active(customer: string): Order[] where this.customer == customer
        find withDeleted(customer: string): Order[] where this.customer == customer ignoring softDeletable
        find reallyAll(customer: string): Order[] where this.customer == customer ignoring *
      }
    }
  }
  storage pg { type: postgres }
  resource s { for: O, kind: state, use: pg }
  deployable api { platform: node { persistence: mikroorm }  contexts: [O]  dataSources: [s]  serves: A  port: 8080 }
}`;
    const { files, errors } = await emit(src);
    expect(errors).toEqual([]);
    const repo = files.get("api/db/repositories/order-repository.ts")!;
    // The softDeletable filter (`!this.isDeleted` → `{ isDeleted: false }`) is
    // applied to the plain read…
    expect(repo).toContain(
      "async active(customer: string): Promise<Order[]> {\n    const em = this.em.fork({ keepTransactionContext: true });\n    const rows = await em.find(OrderRow, { $and: [{ customer: customer }, { isDeleted: false }] });",
    );
    // …and dropped when the read bypasses it by name or with `*`.
    expect(repo).toContain(
      "async withDeleted(customer: string): Promise<Order[]> {\n    const em = this.em.fork({ keepTransactionContext: true });\n    const rows = await em.find(OrderRow, { customer: customer });",
    );
    expect(repo).toContain(
      "async reallyAll(customer: string): Promise<Order[]> {\n    const em = this.em.fork({ keepTransactionContext: true });\n    const rows = await em.find(OrderRow, { customer: customer });",
    );
  });
});

// ---------------------------------------------------------------------------
// `Id[]` reference-collection associations (wave 1) — persist as composite-PK
// pivot Row entities (the MikroORM analogue of the drizzle join table): bulk-
// loaded on read, full-list-replaced on save, pivot rows cleared on delete.
// ---------------------------------------------------------------------------
describe("mikroorm — reference-collection associations (Id[] pivot tables)", () => {
  const ASSOC_SRC = `system M {
  api A from S
  subdomain S {
    context O {
      aggregate Pokemon with crudish {
        name: string
      }
      aggregate Trainer with crudish {
        name: string
        party: Pokemon id[]
      }
      repository Pokemons for Pokemon { }
      repository Trainers for Trainer {
        find byName(name: string): Trainer[] where this.name == name
      }
    }
  }
  storage pg { type: postgres }
  resource s { for: O, kind: state, use: pg }
  deployable api { platform: node { persistence: mikroorm }  contexts: [O]  dataSources: [s]  serves: A  port: 8080 }
}`;

  it("no longer trips loom.mikroorm-unsupported for an Id[] association", async () => {
    const { errors } = await emit(ASSOC_SRC);
    expect(errors).toEqual([]);
  });

  it("emits a composite-PK pivot Row entity for the association", async () => {
    const { files } = await emit(ASSOC_SRC);
    const entities = files.get("api/db/entities.ts")!;
    expect(entities).toContain("export class TrainerPartyRow");
    expect(entities).toContain('tableName: "trainer_party"');
    expect(entities).toContain('trainerId: { type: "string", primary: true }');
    expect(entities).toContain('pokemonId: { type: "string", primary: true }');
    // The pivot schema joins the entities registry.
    expect(entities).toContain("TrainerPartyRowSchema]");
  });

  it("bulk-loads on read, full-replaces on save, and clears pivot rows on delete", async () => {
    const { files } = await emit(ASSOC_SRC);
    const repo = files.get("api/db/repositories/trainer-repository.ts")!;
    // findById — inline load of the target-id list.
    expect(repo).toContain(
      'const party = (await em.find(TrainerPartyRow, { trainerId: id as string }, { orderBy: { pokemonId: "asc" } })).map((jr) => Ids.PokemonId(jr.pokemonId));',
    );
    // Array read — bulk-load into a per-owner map.
    expect(repo).toContain("const partyByOwner = new Map<string, Ids.PokemonId[]>();");
    expect(repo).toContain("const party = partyByOwner.get(row.id) ?? [];");
    // Save — full-list replace (delete owner rows, insert the current set).
    expect(repo).toContain(
      "await em.nativeDelete(TrainerPartyRow, { trainerId: aggregate.id as string });",
    );
    expect(repo).toContain(
      "await em.insert(TrainerPartyRow, { trainerId: aggregate.id as string, pokemonId: t as string });",
    );
    // Delete — clear pivot rows (no FK cascade) then the root.
    expect(repo).toContain("await em.nativeDelete(TrainerPartyRow, { trainerId: id as string });");
    // The `party` column is NOT on the aggregate Row (it lives in the pivot).
    const entities = files.get("api/db/entities.ts")!;
    expect(entities).not.toContain("party:");
  });
});

// ---------------------------------------------------------------------------
// `seed` data (wave 1) — the mikro seed path threads the same dataset
// functions (domain `create` → `<Agg>Repository.save`) through the
// EntityManager, with raw INSERTs + the `__loom_seed` marker via
// `em.getConnection().execute`.
// ---------------------------------------------------------------------------
describe("mikroorm — `seed` data", () => {
  const SEED_SRC = `system M {
  api A from S
  subdomain S {
    context Catalog {
      enum Tier { Free, Pro }
      aggregate Widget with crudish {
        name: string
        size: int
        tier: Tier
      }
      aggregate Gadget with crudish {
        widgetId: Widget id
        label: string
      }
      repository Widgets for Widget { }
      repository Gadgets for Gadget { }
      seed default {
        Widget { name: "Alpha", size: 1, tier: Free }
      }
      seed wired raw {
        Widget { id: "11111111-1111-1111-1111-111111111111", name: "Anchor", size: 4, tier: Free }
        Gadget { id: "22222222-2222-2222-2222-222222222222", widgetId: "11111111-1111-1111-1111-111111111111", label: "g1" }
      }
    }
  }
  storage pg { type: postgres }
  resource s { for: Catalog, kind: state, use: pg }
  deployable api { platform: node { persistence: mikroorm }  contexts: [Catalog]  dataSources: [s]  serves: A  port: 8080 }
}`;

  it("no longer trips loom.mikroorm-unsupported for a seed block", async () => {
    const { errors } = await emit(SEED_SRC);
    expect(errors).toEqual([]);
  });

  it("emits an EntityManager-typed db/seed.ts + mikro seed-cli", async () => {
    const { files } = await emit(SEED_SRC);
    const seed = files.get("api/db/seed.ts")!;
    expect(seed).toBeDefined();
    // EntityManager-typed, no drizzle.
    expect(seed).toContain('import { EntityManager } from "@mikro-orm/postgresql";');
    expect(seed).not.toContain("drizzle");
    expect(seed).toContain("type Db = EntityManager;");
    // Domain-`create` path via the mikro repository.
    expect(seed).toContain(
      "const widgetRepo = new WidgetRepository(db, NoopDomainEventDispatcher);",
    );
    expect(seed).toContain(
      'await widgetRepo.save(Widget.create({ name: "Alpha", size: 1, tier: Tier.Free }));',
    );
    // Raw path + the __loom_seed marker via the connection.
    expect(seed).toContain('await db.getConnection().execute("INSERT INTO \\"widgets\\"');
    expect(seed).toContain('db.getConnection().execute(\'SELECT 1 FROM "__loom_seed"');
    // Mikro CLI inits the ORM + applies the schema before seeding.
    const cli = files.get("api/db/seed-cli.ts")!;
    expect(cli).toContain('import { MikroORM } from "@mikro-orm/postgresql";');
    expect(cli).toContain("await orm.schema.updateSchema();");
    expect(cli).toContain("await runSeeds(orm.em);");
    // Boot path runs the seeds after schema update.
    expect(files.get("api/index.ts")).toContain("await runSeeds(db);");
  });
});

describe("mikroorm capability gating (loom.mikroorm-unsupported)", () => {
  // Nested parts (part-in-part) are now supported (recursive child tables).
  it("no longer rejects a nested entity part (part-in-part)", async () => {
    const { errors } = await emit(
      sys(
        "mikroorm",
        "contains lines: Line[]  entity Line { contains sub: Sub[] }  entity Sub { x: int }",
      ),
    );
    expect(errors.filter((e) => /persistence: mikroorm/.test(e))).toEqual([]);
  });

  // A collection field INSIDE a part is now supported (jsonb column).
  it("no longer rejects a collection-bearing entity part (array-typed part field)", async () => {
    const { errors } = await emit(
      sys("mikroorm", "contains lines: Line[]  entity Line { tags: string[] }"),
    );
    expect(errors.filter((e) => /persistence: mikroorm/.test(e))).toEqual([]);
  });

  it("accepts the supported subset (scalar / enum / VO / optional)", async () => {
    const { errors } = await emit(sys("mikroorm"));
    expect(errors).toEqual([]);
  });

  it("no longer rejects a provenanced field (wave 3)", async () => {
    const { errors } = await emit(sys("mikroorm", "total: int provenanced"));
    expect(errors.filter((e) => /persistence: mikroorm/.test(e))).toEqual([]);
  });

  it("no longer rejects a per-operation `audited` flag (wave 3)", async () => {
    const { errors } = await emit(
      sys("mikroorm", "operation ship() audited { status := Confirmed }"),
    );
    expect(errors.filter((e) => /persistence: mikroorm/.test(e))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Provenanced fields + per-op `audited` on mikroorm — wave 3.  The history flush
// the SHARED routes-builder writes in the save transaction is ported to the
// EntityManager: `db.transactional(...)` + `em.insert(AuditRecordRow /
// ProvenanceRecordRow, {...})` over the mikro history-Row entities, with the
// save joining the same transaction via the repos' `keepTransactionContext`
// fork.  A provenanced field also rides a co-located `<field>_provenance` jsonb
// column on the aggregate Row.  Drizzle is untouched (usingMikro-gated).
// ---------------------------------------------------------------------------
describe("mikroorm — provenanced fields + audited ops (wave 3)", () => {
  const AP_SRC = `system M {
  api A from S
  subdomain S {
    context O {
      aggregate Order with crudish {
        reference: string
        quantity: int
        unitPrice: int
        total: int provenanced
        operation reprice(qty: int, price: int) audited {
          quantity := qty
          unitPrice := price
          total := qty * price
        }
      }
      repository Orders for Order { }
    }
  }
  storage pg { type: postgres }
  resource s { for: O, kind: state, use: pg }
  deployable api { platform: node { persistence: mikroorm }  contexts: [O]  dataSources: [s]  serves: A  port: 8080 }
}`;

  it("emits the AuditRecordRow + ProvenanceRecordRow history entities", async () => {
    const { files, errors } = await emit(AP_SRC);
    expect(errors).toEqual([]);
    const entities = files.get("api/db/entities.ts")!;
    expect(entities).toContain("export class AuditRecordRow {");
    expect(entities).toContain('tableName: "audit_records"');
    expect(entities).toContain('auditId: { type: "string", primary: true }');
    expect(entities).toContain("export class ProvenanceRecordRow {");
    expect(entities).toContain('tableName: "provenance_records"');
    expect(entities).toContain(
      "export const entities = [OrderRowSchema, AuditRecordRowSchema, ProvenanceRecordRowSchema];",
    );
  });

  it("rides a co-located <field>_provenance jsonb column on the aggregate Row + save projection", async () => {
    const { files } = await emit(AP_SRC);
    const entities = files.get("api/db/entities.ts")!;
    expect(entities).toContain(
      'total_provenance!: import("../domain/provenance").ProvLineage | null;',
    );
    expect(entities).toContain(
      'total_provenance: { type: "json", columnType: "jsonb", nullable: true }',
    );
    const repo = files.get("api/db/repositories/order-repository.ts")!;
    expect(repo).toContain("total_provenance: aggregate.total_provenance");
    expect(repo).toContain("total_provenance: row.total_provenance ?? null");
  });

  it("runs the history flush on the EntityManager (db.transactional + em.insert), not drizzle", async () => {
    const { files } = await emit(AP_SRC);
    const routes = files.get("api/http/order.routes.ts")!;
    expect(routes).toContain(
      'import { AuditRecordRow, ProvenanceRecordRow } from "../db/entities";',
    );
    expect(routes).toContain('import type { EntityManager } from "@mikro-orm/postgresql";');
    expect(routes).toContain("db: EntityManager");
    expect(routes).toContain("await db.transactional(async (tx) => {");
    expect(routes).toContain("await tx.insert(AuditRecordRow, {");
    expect(routes).toContain("await tx.insert(ProvenanceRecordRow, {");
    // The drizzle transaction seam is gone on the mikro emission.
    expect(routes).not.toContain("db.transaction(");
    expect(routes).not.toContain("schema.auditRecords");
    expect(routes).not.toContain("NodePgDatabase");
  });

  it("the transactional repo joins the ambient transaction (keepTransactionContext fork)", async () => {
    const { files } = await emit(AP_SRC);
    const repo = files.get("api/db/repositories/order-repository.ts")!;
    expect(repo).toContain("this.em.fork({ keepTransactionContext: true })");
  });
});

// ---------------------------------------------------------------------------
// Aggregate inheritance (aggregate-inheritance.md) on mikroorm — wave 2.
// TPH (`sharedTable`) maps the hierarchy to ONE shared Row discriminated by a
// `kind` column; TPC (`ownTable`) gives each concrete its own table.  Both
// mirror the drizzle inheritance slice and emit a polymorphic `<Base>Repository`
// read home.  No longer gated.
// ---------------------------------------------------------------------------
describe("mikroorm — aggregate inheritance (wave 2)", () => {
  const inh = (layout: "sharedTable" | "ownTable") => `system M {
  api A from S
  subdomain S {
    context O {
      enum CardNetwork { Visa, Mastercard, Amex }
      abstract aggregate PaymentMethod inheritanceUsing: ${layout} {
        holderName: string
        last4: string
      }
      aggregate CreditCard extends PaymentMethod with crudish {
        network: CardNetwork
        expiryMonth: int
      }
      aggregate BankAccount extends PaymentMethod with crudish {
        routingNumber: string
      }
      repository CreditCards for CreditCard {
        find byNetwork(network: CardNetwork): CreditCard[] where this.network == network
      }
      repository BankAccounts for BankAccount { }
    }
  }
  storage pg { type: postgres }
  resource s { for: O, kind: state, use: pg }
  deployable api { platform: node { persistence: mikroorm }  contexts: [O]  dataSources: [s]  serves: A  port: 8080 }
}`;

  it("TPH no longer trips loom.mikroorm-unsupported", async () => {
    const { errors } = await emit(inh("sharedTable"));
    expect(errors).toEqual([]);
  });

  it("TPH emits ONE shared Row with a kind discriminator + every concrete's columns nullable", async () => {
    const { files } = await emit(inh("sharedTable"));
    const entities = files.get("api/db/entities.ts")!;
    // The abstract base owns the single shared table…
    expect(entities).toContain('tableName: "payment_methods"');
    expect(entities).toContain("kind!: string;");
    // …base columns keep their nullability, concrete-own columns are nullable.
    expect(entities).toContain("holderName!: string;");
    expect(entities).toContain("network!: string | null;");
    expect(entities).toContain("routingNumber!: string | null;");
    // No per-concrete Row table under TPH.
    expect(entities).not.toContain("CreditCardRow");
    expect(entities).not.toContain("BankAccountRow");
  });

  it("TPH concrete repo reads/writes the shared Row scoped to its kind", async () => {
    const { files } = await emit(inh("sharedTable"));
    const repo = files.get("api/db/repositories/creditCard-repository.ts")!;
    expect(repo).toContain("PaymentMethodRow");
    expect(repo).toContain('{ kind: "CreditCard" }');
    // save stamps the discriminator.
    expect(repo).toContain('kind: "CreditCard"');
  });

  it("TPH emits a polymorphic base reader dispatching on kind", async () => {
    const { files } = await emit(inh("sharedTable"));
    const reader = files.get("api/db/repositories/paymentMethod-repository.ts")!;
    expect(reader).toContain("class PaymentMethodRepository");
    expect(reader).toContain("switch (row.kind)");
    expect(reader).toContain('case "CreditCard":');
    expect(reader).toContain("em.find(PaymentMethodRow, {})");
  });

  it("TPC gives each concrete its own table + a delegating base reader", async () => {
    const { errors, files } = await emit(inh("ownTable"));
    expect(errors).toEqual([]);
    const entities = files.get("api/db/entities.ts")!;
    expect(entities).toContain('tableName: "credit_cards"');
    expect(entities).toContain('tableName: "bank_accounts"');
    // TPC concrete tables carry the merged base fields.
    expect(entities).toContain("holderName!: string;");
    const reader = files.get("api/db/repositories/paymentMethod-repository.ts")!;
    expect(reader).toContain("new CreditCardRepository(em, events)");
    expect(reader).toContain("this.creditCardRepo.all()");
    expect(reader).toContain("results.flat()");
  });
});

// ---------------------------------------------------------------------------
// Contained entity parts (`contains`) on mikroorm — wave 2.  Relational shape:
// each part is a parent-scoped `<Part>Row` child table, bulk-loaded on read and
// diff-synced on save (mirrors the drizzle containment path).  Bounded to
// single-level flat parts.
// ---------------------------------------------------------------------------
describe("mikroorm — contained entity parts (wave 2)", () => {
  const CONTAINS_SRC = `system M {
  api A from S
  subdomain S {
    context O {
      valueobject Money { amount: int  currency: string }
      aggregate Order with crudish {
        customer: string
        contains shipping: Address?
        contains lines: OrderLine[]
        entity Address { city: string  zip: string }
        entity OrderLine { sku: string  price: Money }
      }
      repository Orders for Order { }
    }
  }
  storage pg { type: postgres }
  resource s { for: O, kind: state, use: pg }
  deployable api { platform: node { persistence: mikroorm }  contexts: [O]  dataSources: [s]  serves: A  port: 8080 }
}`;

  it("no longer trips loom.mikroorm-unsupported for single-level flat parts", async () => {
    const { errors } = await emit(CONTAINS_SRC);
    expect(errors).toEqual([]);
  });

  it("emits a parent-scoped child Row per part (VO fields flattened)", async () => {
    const { files } = await emit(CONTAINS_SRC);
    const entities = files.get("api/db/entities.ts")!;
    expect(entities).toContain("export class AddressRow");
    expect(entities).toContain("export class OrderLineRow");
    expect(entities).toContain('tableName: "order_lines"');
    expect(entities).toContain("parentId!: string;");
    expect(entities).toContain("price_amount!: number;");
  });

  it("bulk-loads parts by parent on reads and diff-syncs them on save", async () => {
    const { files } = await emit(CONTAINS_SRC);
    const repo = files.get("api/db/repositories/order-repository.ts")!;
    // Collection containment → ByParent map on the array reads.
    expect(repo).toContain("const linesByParent = new Map<string, OrderLine[]>();");
    expect(repo).toContain("em.find(OrderLineRow, { parentId: { $in: rootIds } }");
    // Singular optional containment → nullable local.
    expect(repo).toContain("const shipping = shippingByParent.get(row.id) ?? null;");
    // Save diff-syncs: delete removed child rows, upsert current.
    expect(repo).toContain("await em.upsert(OrderLineRow,");
    expect(repo).toContain("if (!currentIdsLines.has(r.id)) await em.nativeDelete(OrderLineRow");
    // Delete clears child rows before the root.
    expect(repo).toContain("await em.nativeDelete(OrderLineRow, { parentId: id as string });");
  });

  const NESTED_SRC = `system M {
  api A from S
  subdomain S {
    context O {
      aggregate Order with crudish {
        customer: string
        contains boxes: Box[]
        entity Box {
          label: string
          contains items: Item[]
        }
        entity Item { sku: string }
      }
      repository Orders for Order { }
    }
  }
  storage pg { type: postgres }
  resource s { for: O, kind: state, use: pg }
  deployable api { platform: node { persistence: mikroorm }  contexts: [O]  dataSources: [s]  serves: A  port: 8080 }
}`;

  it("no longer trips loom.mikroorm-unsupported for a part-in-part (nested)", async () => {
    const { errors } = await emit(NESTED_SRC);
    expect(errors.filter((e) => /persistence: mikroorm/.test(e))).toEqual([]);
  });

  it("emits a child Row per nested part, keyed by its DIRECT parent", async () => {
    const { files } = await emit(NESTED_SRC);
    const entities = files.get("api/db/entities.ts")!;
    expect(entities).toContain("export class BoxRow");
    expect(entities).toContain("export class ItemRow");
    expect(entities).toContain('tableName: "boxes"');
    expect(entities).toContain('tableName: "items"');
  });

  it("recursively bulk-loads + hydrates the nested level keyed by the direct parent", async () => {
    const { files } = await emit(NESTED_SRC);
    const repo = files.get("api/db/repositories/order-repository.ts")!;
    // Deepest-first bulk-load: Box rows, then Item rows scoped to the box ids.
    expect(repo).toContain("const itemsByParent = new Map<string, Item[]>();");
    expect(repo).toContain(
      "await em.find(ItemRow, { parentId: { $in: boxesRows.map((r) => r.id) } }",
    );
    // Nested Item brands its parentId to BoxId (its direct parent), not OrderId.
    expect(repo).toContain("parentId: Ids.BoxId(r.parentId)");
  });

  it("recursively diff-syncs + cascade-deletes the nested level on save/delete", async () => {
    const { files } = await emit(NESTED_SRC);
    const repo = files.get("api/db/repositories/order-repository.ts")!;
    // Save recurses into box.items, stamping the nested FK from tree position.
    expect(repo).toContain("for (const child of aggregate.boxes)");
    expect(repo).toContain("for (const child1 of child.items)");
    expect(repo).toContain("parentId: child.id as string");
    // Delete cascades deepest-first (no DB FK): collect box ids, clear items.
    expect(repo).toContain("const boxesDelIds = (await em.find(BoxRow,");
    expect(repo).toContain("await em.nativeDelete(ItemRow, { parentId: { $in: boxesDelIds } });");
    expect(repo).toContain("await em.nativeDelete(BoxRow, { parentId: id as string });");
  });
});

// ---------------------------------------------------------------------------
// Collection-bearing contained parts on mikroorm — a part field of array type
// (scalar / enum / VO / id) folds into ONE jsonb column on the part's child Row,
// (de)serialised through the shared serialise/deserialise helpers (the mirror
// of the Dapper part-collection path).  Closes the last containment gate.
// ---------------------------------------------------------------------------
describe("mikroorm — collection-bearing contained parts", () => {
  const COLL_SRC = `system M {
  api A from S
  subdomain S {
    context O {
      valueobject Money { amount: int  currency: string }
      enum Tag { Red, Blue }
      aggregate Product with crudish { name: string }
      aggregate Order with crudish {
        customer: string
        contains lines: OrderLine[]
        entity OrderLine {
          sku: string
          labels: string[]
          amounts: Money[]
          flags: Tag[]
          related: Product id[]
          notes: string[]?
        }
      }
      repository Orders for Order { }
      repository Products for Product { }
    }
  }
  storage pg { type: postgres }
  resource s { for: O, kind: state, use: pg }
  deployable api { platform: node { persistence: mikroorm }  contexts: [O]  dataSources: [s]  serves: A  port: 8080 }
}`;

  it("no longer trips loom.mikroorm-unsupported for a collection-bearing part", async () => {
    const { errors } = await emit(COLL_SRC);
    expect(errors.filter((e) => /persistence: mikroorm/.test(e))).toEqual([]);
  });

  it("emits one jsonb column per collection field (optional → nullable)", async () => {
    const { files } = await emit(COLL_SRC);
    const entities = files.get("api/db/entities.ts")!;
    expect(entities).toContain('labels: { type: "json", columnType: "jsonb" }');
    expect(entities).toContain('amounts: { type: "json", columnType: "jsonb" }');
    expect(entities).toContain('flags: { type: "json", columnType: "jsonb" }');
    expect(entities).toContain('related: { type: "json", columnType: "jsonb" }');
    expect(entities).toContain('notes: { type: "json", columnType: "jsonb", nullable: true }');
    // Row TS types carry the DOC shape of each array.
    expect(entities).toContain("amounts!: { amount: number; currency: string }[];");
    expect(entities).toContain("related!: string[];");
    expect(entities).toContain("notes!: string[] | null;");
  });

  it("serialises on save and (de)serialises the element type on read", async () => {
    const { files } = await emit(COLL_SRC);
    const repo = files.get("api/db/repositories/order-repository.ts")!;
    // Save: VO array parenthesised as an object-literal arrow return; id → string.
    expect(repo).toContain(
      "amounts: child.amounts.map((x) => ({ amount: x.amount, currency: x.currency }))",
    );
    expect(repo).toContain("related: child.related.map((x) => x as string)");
    // Read: VO reconstructed, enum cast, id re-branded, optional guarded.
    expect(repo).toContain(
      "amounts: (r.amounts ?? []).map((x) => new Money(x.amount, x.currency))",
    );
    expect(repo).toContain("flags: (r.flags ?? []).map((x) => x as Tag)");
    expect(repo).toContain("related: (r.related ?? []).map((s: string) => Ids.ProductId(s))");
    expect(repo).toContain("notes: (r.notes == null ? null : (r.notes ?? []).map((x) => x))");
  });
});

// ---------------------------------------------------------------------------
// shape(embedded) on mikroorm — wave 2.  The root stays queryable columns and
// each containment folds into a jsonb column, (de)serialised through the shared
// `<part>ToDoc`/`<part>FromDoc` helpers.  shape(document) stays gated.
// ---------------------------------------------------------------------------
describe("mikroorm — shape(embedded) (wave 2)", () => {
  const EMB_SRC = `system M {
  api A from S
  subdomain S {
    context O {
      valueobject Money { amount: int  currency: string }
      aggregate TagList shape: embedded with crudish {
        owner: string
        contains lines: TagItem[]
        entity TagItem { name: string  price: Money }
      }
      repository TagLists for TagList { }
    }
  }
  storage pg { type: postgres }
  resource s { for: O, kind: state, use: pg }
  deployable api { platform: node { persistence: mikroorm }  contexts: [O]  dataSources: [s]  serves: A  port: 8080 }
}`;

  it("no longer trips loom.mikroorm-unsupported for shape(embedded)", async () => {
    const { errors } = await emit(EMB_SRC);
    expect(errors).toEqual([]);
  });

  it("emits root columns + a jsonb containment column (typed unknown on the Row)", async () => {
    const { files } = await emit(EMB_SRC);
    const entities = files.get("api/db/entities.ts")!;
    expect(entities).toContain("owner!: string;");
    expect(entities).toContain("lines!: unknown;");
    expect(entities).toContain('lines: { type: "json", columnType: "jsonb" }');
    // No relational child table under embedded.
    expect(entities).not.toContain("TagItemRow");
  });

  it("(de)serialises the containment through <part>ToDoc/<part>FromDoc", async () => {
    const { files } = await emit(EMB_SRC);
    const repo = files.get("api/db/repositories/tagList-repository.ts")!;
    expect(repo).toContain("type TagItemDoc = {");
    expect(repo).toContain("function tagItemToDoc");
    expect(repo).toContain("function tagItemFromDoc");
    // Read casts the jsonb cell, save serialises via toDoc, upsert on the Row.
    expect(repo).toContain("((row.lines ?? []) as TagItemDoc[]).map((x) => tagItemFromDoc(x))");
    expect(repo).toContain("lines: aggregate.lines.map((e) => tagItemToDoc(e))");
    expect(repo).toContain("await em.upsert(TagListRow, rootRow)");
  });
});

// ---------------------------------------------------------------------------
// shape(document) on mikroorm — wave 3.  The whole aggregate tree collapses to
// ONE opaque `(id, data, version)` jsonb blob (Marten-style), round-tripped
// through the shared `<agg>ToDoc`/`<agg>FromDoc` (de)serialisers the drizzle
// document repository uses — so contained parts nest in the blob (no child
// tables), `Id[]` references ride as id strings (no pivot tables), and finds /
// capability filters evaluate in-app over the rehydrated read model.
// ---------------------------------------------------------------------------
describe("mikroorm — shape(document) (wave 3)", () => {
  const DOC_SRC = `system M {
  api A from S
  subdomain S {
    context O {
      aggregate Article shape: document, with crudish {
        title: string
        viewCount: int
        contains sections: Section[]
        entity Section { heading: string  body: string }
        operation addSection(heading: string, body: string) {
          sections += Section { heading: heading, body: body }
        }
      }
      repository Articles for Article {
        find popular(min: int): Article[] where this.viewCount >= min
      }
    }
  }
  storage pg { type: postgres }
  resource s { for: O, kind: state, use: pg }
  deployable api { platform: node { persistence: mikroorm }  contexts: [O]  dataSources: [s]  serves: A  port: 8080 }
}`;

  it("no longer trips loom.mikroorm-unsupported for shape(document)", async () => {
    const { errors } = await emit(DOC_SRC);
    expect(errors).toEqual([]);
  });

  it("collapses the aggregate to a single (id, data, version) jsonb Row — no child/pivot tables", async () => {
    const { files } = await emit(DOC_SRC);
    const entities = files.get("api/db/entities.ts")!;
    expect(entities).toContain("export class ArticleRow {");
    expect(entities).toContain('id: { type: "string", primary: true }');
    expect(entities).toContain('data: { type: "json", columnType: "jsonb" }');
    expect(entities).toContain('version: { type: "number" }');
    // The contained Section part rides inside the blob — no relational child Row.
    expect(entities).not.toContain("SectionRow");
    expect(entities).toContain("export const entities = [ArticleRowSchema];");
  });

  it("round-trips the whole tree through <agg>ToDoc/<agg>FromDoc on the EntityManager", async () => {
    const { files } = await emit(DOC_SRC);
    const repo = files.get("api/db/repositories/article-repository.ts")!;
    // Doc (de)serialisers recurse into the contained part.
    expect(repo).toContain("type ArticleDoc = {");
    expect(repo).toContain("type SectionDoc = {");
    expect(repo).toContain("function articleToDoc");
    expect(repo).toContain("function sectionToDoc");
    // Read casts the jsonb blob; the versioned root takes the authoritative
    // version COLUMN (not the stale blob copy).
    expect(repo).toContain("articleFromDoc(row.data as ArticleDoc, row.version)");
    // Save is the version-CAS write over the blob (default-on versioning).
    expect(repo).toContain("const data = articleToDoc(aggregate);");
    expect(repo).toContain(
      "await em.insert(ArticleRow, { id: aggregate.id as string, data, version: 1 });",
    );
    expect(repo).toContain(
      "await em.nativeUpdate(ArticleRow, { id: aggregate.id as string, version: expected }, { data, version: expected + 1 })",
    );
    expect(repo).toContain('throw new ConcurrencyError("Article", aggregate.id as string)');
  });

  it("evaluates finds in-app over the rehydrated read model (blob fields aren't columns)", async () => {
    const { files } = await emit(DOC_SRC);
    const repo = files.get("api/db/repositories/article-repository.ts")!;
    expect(repo).toContain("const rows = await em.find(ArticleRow, {});");
    expect(repo).toContain("const result = all.filter((x) => x.viewCount >= min);");
  });
});

// ---------------------------------------------------------------------------
// Server-managed access fields (token / internal / secret) on mikroorm — the
// access modifier shapes only the API wire surface, so the data-mapper stores
// the field as an ordinary column that round-trips through the shared save /
// hydrate seams (like drizzle).  No longer gated (wave 1).
// ---------------------------------------------------------------------------
describe("mikroorm — server-managed access fields round-trip as columns", () => {
  const MANAGED_SRC = `system M {
  api A from S
  subdomain S {
    context O {
      aggregate Order with crudish {
        customer: string
        token apiKey: string
        internal note2: string
        secret pin: string
      }
      repository Orders for Order { }
    }
  }
  storage pg { type: postgres }
  resource s { for: O, kind: state, use: pg }
  deployable api { platform: node { persistence: mikroorm }  contexts: [O]  dataSources: [s]  serves: A  port: 8080 }
}`;

  it("accepts a token / internal / secret field (no loom.mikroorm-unsupported)", async () => {
    const { files, errors } = await emit(MANAGED_SRC);
    expect(errors).toEqual([]);
    // Each server-managed field is a real persisted column on the Row entity…
    const entities = files.get("api/db/entities.ts")!;
    expect(entities).toContain("apiKey!: string");
    expect(entities).toContain("note2!: string");
    expect(entities).toContain("pin!: string");
    // …and rides the save projection + hydrate seam.
    const repo = files.get("api/db/repositories/order-repository.ts")!;
    expect(repo).toContain("apiKey: aggregate.apiKey");
    expect(repo).toContain("apiKey: row.apiKey");
  });
});

// ---------------------------------------------------------------------------
// Persist-time audit stamping on mikroorm (node-persist-time-auditing, 2nd
// adapter).  The save-layer stamp (`stampInsert` injected into `em.upsert`,
// createdAt/createdBy held immutable via `onConflictExcludeFields`) replaces
// the old "uses audit stamping" gate, mirroring the drizzle relocation.
// ---------------------------------------------------------------------------
describe("mikroorm — persist-time audit stamping", () => {
  // Full `auditable`-shaped stamp set (the four fields) on an auth deployable
  // (a `currentUser` stamp needs a request-scoped principal).
  const AUDIT_SRC = `system M {
  user { id: guid  name: string }
  api A from S
  subdomain S {
    context O {
      stamp onCreate { createdAt := now()  createdBy := currentUser }
      stamp onUpdate { updatedAt := now()  updatedBy := currentUser }
      aggregate Order with crudish {
        customer: string
        createdAt: datetime
        createdBy:  guid
        updatedAt: datetime
        updatedBy:  guid
      }
      repository Orders for Order { }
    }
  }
  storage pg { type: postgres }
  resource s { for: O, kind: state, use: pg }
  deployable api { platform: node { persistence: mikroorm }  contexts: [O]  dataSources: [s]  serves: A  port: 8080  auth: required }
}`;

  it("an auditable aggregate on mikroorm NO LONGER trips loom.mikroorm-unsupported", async () => {
    const { errors } = await emit(AUDIT_SRC);
    // No 'uses audit stamping' nor 'server-managed access' rejection for the
    // four stamp-target fields.
    expect(errors.filter((e) => /persistence: mikroorm/.test(e))).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("emits the shared db/audit-stamp.ts helper (was drizzle-only)", async () => {
    const { files } = await emit(AUDIT_SRC);
    const helper = files.get("api/db/audit-stamp.ts")!;
    expect(helper).toBeDefined();
    // Adapter-agnostic principal source.
    expect(helper).toContain('import { requestContext } from "../obs/als";');
    expect(helper).toContain("export function stampInsert");
    expect(helper).toContain("createdBy: ctx.actorId");
  });

  it("the mikro versioned save wraps insert in stampInsert and the CAS update in stampUpdate (M-T3.4)", async () => {
    const { files } = await emit(AUDIT_SRC);
    const repo = files.get("api/db/repositories/order-repository.ts")!;
    expect(repo).toContain('import { stampInsert, stampUpdate } from "../audit-stamp";');
    // Default-on versioning turns the blind upsert into a guarded write: the
    // create branch stamps + seeds version 1; the update branch is a version-CAS
    // `nativeUpdate` whose `stampUpdate` only touches updatedAt/updatedBy, so the
    // create-only createdAt/createdBy stay at their loaded values (immutable).
    expect(repo).toMatch(/await em\.insert\(OrderRow, stampInsert\([\s\S]*?version: 1 \}\)\);/);
    expect(repo).toMatch(
      /await em\.nativeUpdate\(OrderRow, \{ id: aggregate\.id as string, version: expected \}, stampUpdate\([\s\S]*?version: expected \+ 1 \}\)\);/,
    );
  });

  it("a non-audited versioned mikro aggregate emits the guarded save without stamping (M-T3.4)", async () => {
    const { files } = await emit(sys("mikroorm"));
    const repo = files.get("api/db/repositories/order-repository.ts")!;
    expect(repo).toContain("await em.insert(OrderRow,");
    expect(repo).toContain("await em.nativeUpdate(OrderRow,");
    expect(repo).toContain('throw new ConcurrencyError("Order",');
    expect(repo).not.toContain("stampInsert");
    expect(repo).not.toContain("onConflictExcludeFields");
  });
});

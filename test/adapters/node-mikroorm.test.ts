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
    expect(repo).toContain("this.em.fork()"); // idiomatic isolated unit-of-work
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

  it("cleanly rejects an out-of-subset retrieval predicate (loom.find-predicate-unsupported)", async () => {
    // A bare boolean column (`this.active`) is a valid retrieval `where`
    // generally, but it's outside the MikroORM FilterQuery comparison subset.
    // `validateFindPredicateAdapterSupport` already iterates retrievals, so it's
    // rejected at validate time (not a runtime stub) — better than the Dapper
    // path.  (The emitter still carries a defensive try/catch stub, mirroring
    // the find path, in case the two subset notions ever diverge.)
    const src = RETRIEVAL_SRC.replace(
      "where: this.status == Status.Confirmed && this.quantity >= min",
      "where: this.active",
    ).replace("BulkOrders(min: int)", "Active()");
    const { errors } = await emit(src);
    expect(
      errors.some((e) => /persistence: mikroorm/.test(e) && /cannot lower to SQL/.test(e)),
    ).toBe(true);
  });
});

describe("mikroorm capability gating (loom.mikroorm-unsupported)", () => {
  const rejects = async (body: string, needle: RegExp) => {
    const { errors } = await emit(sys("mikroorm", body));
    expect(errors.some((e) => /persistence: mikroorm/.test(e) && needle.test(e))).toBe(true);
  };

  it("rejects a provenanced field", () => rejects("provenanced score: int", /provenanced/));
  it("rejects a non-relational saving shape (shape: document)", async () => {
    const src = `
      system M {
        api A from S
        subdomain S { context O {
          aggregate Cart shape: document with crudish { customer: string }
          repository Carts for Cart { }
        } }
        storage pg { type: postgres }  resource s { for: O, kind: state, use: pg }
        deployable api { platform: node { persistence: mikroorm }  contexts: [O]  dataSources: [s]  serves: A  port: 8080 } }`;
    const { errors } = await emit(src);
    expect(errors.some((e) => /persistence: mikroorm/.test(e) && /shape\(document\)/.test(e))).toBe(
      true,
    );
  });

  it("accepts the supported subset (scalar / enum / VO / optional)", async () => {
    const { errors } = await emit(sys("mikroorm"));
    expect(errors).toEqual([]);
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

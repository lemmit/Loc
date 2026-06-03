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
import { resolvePersistence } from "../../src/platform/resolve-adapters.js";
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
  deployable api { platform: hono { persistence: ${persistence} }  contexts: [O]  dataSources: [s]  serves: A  port: 8080 }
}`;

describe("mikroorm persistence adapter — node/hono (Phase 5d)", () => {
  it("is registered as a real persistence adapter", () => {
    expect(resolvePersistence("node", "mikroorm")).toBe(mikroOrmPersistenceAdapter);
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
    expect(repo).toContain("await em.upsert(OrderRow,");
    expect(repo).toContain("Order._create({"); // shared hydration seam
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
  // deployable accepts a `persistedAs(eventLog)` aggregate and emits the
  // EntityManager event store + the `<agg>_events` EntitySchema, reusing the
  // domain fold + CQRS.
  const esSys = `
system D {
  subdomain S {
    context O {
      event Opened { account: Account id, owner: string }
      aggregate Account ids guid persistedAs(eventLog) {
        owner: string
        create open(owner: string) { emit Opened { account: id, owner: owner } }
        apply(e: Opened) { owner := e.owner }
      }
      repository Accounts for Account { }
    }
  }
  storage pg { type: postgres }
  resource s { for: O, kind: eventLog, use: pg }
  deployable api { platform: hono { persistence: mikroorm }  contexts: [O]  dataSources: [s]  port: 8080 }
}`;

  it("accepts persistedAs(eventLog) and emits the MikroORM event store", async () => {
    const { files, errors } = await emit(esSys);
    expect(errors).toEqual([]);
    const entities = files.get("api/db/entities.ts")!;
    expect(entities).toContain("export class AccountEventRow");
    expect(entities).toContain('tableName: "account_events"');
    const repo = files.get("api/db/repositories/account-repository.ts")!;
    expect(repo).toContain("Account._fromEvents(");
    expect(repo).toContain("em.persist(r);");
    expect(repo).toContain("function rowToEvent(");
  });
});

describe("mikroorm capability gating (loom.mikroorm-unsupported)", () => {
  const rejects = async (body: string, needle: RegExp) => {
    const { errors } = await emit(sys("mikroorm", body));
    expect(errors.some((e) => /persistence: mikroorm/.test(e) && needle.test(e))).toBe(true);
  };

  it("rejects a provenanced field", () => rejects("provenanced score: int", /provenanced/));
  it("rejects a non-relational saving shape (shape(document))", async () => {
    const src = `
      system M {
        api A from S
        subdomain S { context O {
          aggregate Cart shape(document) with crudish { customer: string }
          repository Carts for Cart { }
        } }
        storage pg { type: postgres }  resource s { for: O, kind: state, use: pg }
        deployable api { platform: hono { persistence: mikroorm }  contexts: [O]  dataSources: [s]  serves: A  port: 8080 } }`;
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

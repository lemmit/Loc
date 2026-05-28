import { NodeFileSystem } from "langium/node";
import { describe, expect, it } from "vitest";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Model, Storage } from "../../../src/language/generated/ast.js";

describe("storage instance/connection extensions", () => {
  async function parse(src: string) {
    const { parseHelper } = await import("langium/test");
    const services = createDddServices(NodeFileSystem);
    const helper = parseHelper(services.Ddd);
    const doc = await helper(src, { validation: true });
    const errors = (doc.diagnostics ?? []).filter((d) => d.severity === 1).map((d) => d.message);
    return { model: doc.parseResult.value as Model, errors };
  }

  function firstStorage(model: Model): Storage {
    const sys = model.members.find((m) => m.$type === "System") as
      | import("../../../src/language/generated/ast.js").System
      | undefined;
    return sys!.members.find((m) => m.$type === "Storage") as Storage;
  }

  it("parses storage with only type", async () => {
    const { model, errors } = await parse(`
      system S { storage pg { type: postgres } }
    `);
    expect(errors).toEqual([]);
    const s = firstStorage(model);
    expect(s.type).toBe("postgres");
    expect(s.instance).toBeUndefined();
    expect(s.connection).toBeUndefined();
  });

  it("parses storage with instance", async () => {
    const { model, errors } = await parse(`
      system S { storage pg { type: postgres, instance: appDb } }
    `);
    expect(errors).toEqual([]);
    expect(firstStorage(model).instance).toBe("appDb");
  });

  it("parses storage with connection env()", async () => {
    const { model, errors } = await parse(`
      system S { storage pg { type: postgres, connection: env("PG_URL") } }
    `);
    expect(errors).toEqual([]);
    const c = firstStorage(model).connection!;
    expect(c.$type).toBe("EnvConnectionSource");
    if (c.$type === "EnvConnectionSource") expect(c.env).toBe("PG_URL");
  });

  it("parses storage with connection service()", async () => {
    const { model, errors } = await parse(`
      system S { storage pg { type: postgres, connection: service(db) } }
    `);
    expect(errors).toEqual([]);
    const c = firstStorage(model).connection!;
    expect(c.$type).toBe("ServiceConnectionSource");
    if (c.$type === "ServiceConnectionSource") expect(c.service).toBe("db");
  });

  it("parses storage with connection secret()", async () => {
    const { model, errors } = await parse(`
      system S { storage pg { type: postgres, connection: secret(dbUrl) } }
    `);
    expect(errors).toEqual([]);
    const c = firstStorage(model).connection!;
    expect(c.$type).toBe("SecretConnectionSource");
    if (c.$type === "SecretConnectionSource") expect(c.secret).toBe("dbUrl");
  });

  it("parses storage with connection literal()", async () => {
    const { model, errors } = await parse(`
      system S { storage pg { type: postgres, connection: literal("postgres://x") } }
    `);
    expect(errors).toEqual([]);
    const c = firstStorage(model).connection!;
    expect(c.$type).toBe("LiteralConnectionSource");
    if (c.$type === "LiteralConnectionSource") {
      expect(c.literal).toBe("postgres://x");
    }
  });

  it("parses storage with both instance and connection", async () => {
    const { model, errors } = await parse(`
      system S { storage pg { type: postgres, instance: appDb, connection: env("PG_URL") } }
    `);
    expect(errors).toEqual([]);
    const s = firstStorage(model);
    expect(s.instance).toBe("appDb");
    expect(s.connection?.$type).toBe("EnvConnectionSource");
  });
});

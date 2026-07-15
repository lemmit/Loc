// `shape(relational | embedded | document)` saving-shape modifier
// (D-DOCUMENT-AXIS).  Surface + IR coverage: the aggregate header
// modifier and the `dataSource` `shape:` knob parse, and both thread
// through to `AggregateIR.savingShape` / `DataSourceIR.shape`.

import { NodeFileSystem } from "langium/node";
import { describe, expect, it } from "vitest";
import { lowerModel } from "../../../src/ir/lower/lower.js";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Aggregate, Model } from "../../../src/language/generated/ast.js";
import { parseValid } from "../../_helpers/parse.js";

async function parse(src: string) {
  const { parseHelper } = await import("langium/test");
  const services = createDddServices(NodeFileSystem);
  const helper = parseHelper(services.Ddd);
  const doc = await helper(src, { validation: true });
  const errors = (doc.diagnostics ?? []).filter((d) => d.severity === 1).map((d) => d.message);
  return { model: doc.parseResult.value as Model, errors };
}

function firstAgg(model: Model): Aggregate {
  const ctx = model.members[0] as
    | import("../../../src/language/generated/ast.js").BoundedContext
    | undefined;
  return ctx?.members.find((m) => m.$type === "Aggregate") as Aggregate;
}

describe("aggregate shape(…) saving shape (D-DOCUMENT-AXIS)", () => {
  it("parses shape: document on the header", async () => {
    const { model, errors } = await parse(`
      context T { aggregate Cart shape: document { name: string } }
    `);
    expect(errors).toEqual([]);
    expect(firstAgg(model).shape).toBe("document");
  });

  it("parses shape: embedded and shape: relational", async () => {
    const e = await parse(`context T { aggregate Cart shape: embedded { name: string } }`);
    expect(e.errors).toEqual([]);
    expect(firstAgg(e.model).shape).toBe("embedded");
    const r = await parse(`context T { aggregate Cart shape: relational { name: string } }`);
    expect(r.errors).toEqual([]);
    expect(firstAgg(r.model).shape).toBe("relational");
  });

  it("coexists with persistedAs in header order (persistedAs, then shape)", async () => {
    const { model, errors } = await parse(`
      context T { aggregate Cart persistedAs: eventLog shape: document { name: string } }
    `);
    expect(errors).toEqual([]);
    expect(firstAgg(model).persistedAs).toBe("eventLog");
    expect(firstAgg(model).shape).toBe("document");
  });

  it("omits shape when not declared (default relational at resolution)", async () => {
    const { model, errors } = await parse(`
      context T { aggregate Cart { name: string } }
    `);
    expect(errors).toEqual([]);
    expect(firstAgg(model).shape).toBeUndefined();
  });

  it("rejects an unknown shape value", async () => {
    const { errors } = await parse(`
      context T { aggregate Cart shape(blobby) { name: string } }
    `);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe("shape threads to the IR (aggregate + dataSource)", () => {
  const SRC = `
system Sys {
  subdomain Sales {
    context Shopping {
      aggregate Cart persistedAs: eventLog shape: document { name: string }
    }
  }
  storage pg { type: postgres }
  resource cartEvents   { for: Shopping, kind: eventLog, use: pg }
  resource cartSnapshot { for: Shopping, kind: snapshot, use: pg, shape: embedded }
  deployable api {
    platform: dotnet
    contexts: [Shopping]
    dataSources: [cartEvents, cartSnapshot]
    port: 5000
  }
}
`;

  it("AggregateIR.savingShape === document for a shape: document aggregate", async () => {
    const loom = lowerModel(await parseValid(SRC));
    const ctx = loom.systems[0]!.subdomains[0]!.contexts.find((c) => c.name === "Shopping")!;
    const cart = ctx.aggregates.find((a) => a.name === "Cart")!;
    expect(cart.savingShape).toBe("document");
    expect(cart.persistedAs).toBe("eventLog");
  });

  it("DataSourceIR.shape === embedded for a `shape: embedded` snapshot binding", async () => {
    const loom = lowerModel(await parseValid(SRC));
    const ds = loom.systems[0]!.dataSources.find((d) => d.name === "cartSnapshot")!;
    expect(ds.shape).toBe("embedded");
  });
});

// Slice C — `normalised(true | false)` saving-shape modifier
// (D-DOCUMENT-AXIS).  Surface + IR coverage: the aggregate header
// modifier and the `dataSource` `normalised:` knob parse, and both
// thread through to `AggregateIR.normalised` / `DataSourceIR.normalised`.
// The document persistence *emission* is a later slice; here we only
// assert the flag is accepted and carried.

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

describe("aggregate normalised(…) saving shape (D-DOCUMENT-AXIS)", () => {
  it("parses normalised(false) on the header", async () => {
    const { model, errors } = await parse(`
      context T { aggregate Cart normalised(false) { name: string } }
    `);
    expect(errors).toEqual([]);
    expect(firstAgg(model).normalised).toBe("false");
  });

  it("parses normalised(true)", async () => {
    const { model, errors } = await parse(`
      context T { aggregate Cart normalised(true) { name: string } }
    `);
    expect(errors).toEqual([]);
    expect(firstAgg(model).normalised).toBe("true");
  });

  it("coexists with persistedAs in header order (persistedAs, then normalised)", async () => {
    const { model, errors } = await parse(`
      context T { aggregate Cart persistedAs(eventLog) normalised(false) { name: string } }
    `);
    expect(errors).toEqual([]);
    expect(firstAgg(model).persistedAs).toBe("eventLog");
    expect(firstAgg(model).normalised).toBe("false");
  });

  it("omits normalised when not declared (default true at resolution)", async () => {
    const { model, errors } = await parse(`
      context T { aggregate Cart { name: string } }
    `);
    expect(errors).toEqual([]);
    expect(firstAgg(model).normalised).toBeUndefined();
  });

  it("rejects a non-boolean value", async () => {
    const { errors } = await parse(`
      context T { aggregate Cart normalised(maybe) { name: string } }
    `);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe("normalised threads to the IR (aggregate + dataSource)", () => {
  const SRC = `
system Sys {
  subdomain Sales {
    context Shopping {
      aggregate Cart persistedAs(eventLog) normalised(false) { name: string }
    }
  }
  storage pg { type: postgres }
  resource cartEvents   { for: Shopping, kind: eventLog, use: pg }
  resource cartSnapshot { for: Shopping, kind: snapshot, use: pg, normalised: false }
  deployable api {
    platform: dotnet
    contexts: [Shopping]
    dataSources: [cartEvents, cartSnapshot]
    port: 5000
  }
}
`;

  it("AggregateIR.normalised === false for a normalised(false) aggregate", async () => {
    const loom = lowerModel(await parseValid(SRC));
    const ctx = loom.systems[0]!.subdomains[0]!.contexts.find((c) => c.name === "Shopping")!;
    const cart = ctx.aggregates.find((a) => a.name === "Cart")!;
    expect(cart.normalised).toBe(false);
    expect(cart.persistedAs).toBe("eventLog");
  });

  it("DataSourceIR.normalised === false for a `normalised: false` snapshot binding", async () => {
    const loom = lowerModel(await parseValid(SRC));
    const ds = loom.systems[0]!.dataSources.find((d) => d.name === "cartSnapshot")!;
    expect(ds.normalised).toBe(false);
  });
});

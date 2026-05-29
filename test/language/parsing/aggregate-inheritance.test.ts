// Aggregate-inheritance surface (aggregate-inheritance.md, phase I1).
// Covers the grammar (`abstract` prefix, `extends <Base>`,
// `inheritanceUsing(sharedTable | ownTable)` header modifier), the IR
// threading (`isAbstract` / `extendsAggregate` / `inheritanceUsing`), and
// the I1 validator rules (extends-non-abstract, modifier placement,
// abstract has no behaviour / no repository, and the D-ES-TPH forced
// `ownTable`).  No emission semantics yet — that is I2/I3.

import { NodeFileSystem } from "langium/node";
import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../../src/ir/validate/validate.js";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Aggregate, Model } from "../../../src/language/generated/ast.js";
import { parseValid } from "../../_helpers/parse.js";

async function parse(src: string) {
  const { parseHelper } = await import("langium/test");
  const services = createDddServices(NodeFileSystem);
  const helper = parseHelper(services.Ddd);
  const doc = await helper(src, { validation: true });
  const errors = (doc.diagnostics ?? []).filter((d) => d.severity === 1);
  return { model: doc.parseResult.value as Model, errors };
}

function aggs(model: Model): Aggregate[] {
  const ctx = model.members[0] as
    | import("../../../src/language/generated/ast.js").BoundedContext
    | undefined;
  return (ctx?.members.filter((m) => m.$type === "Aggregate") ?? []) as Aggregate[];
}

describe("aggregate inheritance — grammar (I1)", () => {
  it("parses an abstract base and a concrete subtype that extends it", async () => {
    const { model, errors } = await parse(`
      context Parties {
        abstract aggregate Party inheritanceUsing(sharedTable) { name: string }
        aggregate Customer extends Party { creditLimit: decimal }
      }
    `);
    expect(errors.map((e) => e.message)).toEqual([]);
    const [party, customer] = aggs(model);
    expect(party.isAbstract).toBe(true);
    expect(party.inheritanceUsing).toBe("sharedTable");
    expect(customer.isAbstract).toBe(false);
    expect(customer.superType?.ref?.name).toBe("Party");
  });

  it("parses inheritanceUsing(ownTable) and coexists with persistedAs / shape", async () => {
    const { model, errors } = await parse(`
      context Parties {
        abstract aggregate Party inheritanceUsing(ownTable) { name: string }
        aggregate Ledger extends Party persistedAs(eventLog) inheritanceUsing(ownTable) { n: int }
      }
    `);
    expect(errors.map((e) => e.message)).toEqual([]);
    const [party, ledger] = aggs(model);
    expect(party.inheritanceUsing).toBe("ownTable");
    expect(ledger.persistedAs).toBe("eventLog");
    expect(ledger.inheritanceUsing).toBe("ownTable");
  });

  it("omits inheritance fields on a plain aggregate", async () => {
    const { model, errors } = await parse(`context T { aggregate Cart { name: string } }`);
    expect(errors.map((e) => e.message)).toEqual([]);
    const [cart] = aggs(model);
    expect(cart.isAbstract).toBe(false);
    expect(cart.superType).toBeUndefined();
    expect(cart.inheritanceUsing).toBeUndefined();
  });

  it("rejects an unknown inheritanceUsing value", async () => {
    const { errors } = await parse(`
      context T { abstract aggregate Party inheritanceUsing(tpt) { name: string } }
    `);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe("aggregate inheritance — IR threading (I1)", () => {
  const SRC = `
system Sys {
  subdomain Sales {
    context Parties {
      abstract aggregate Party inheritanceUsing(sharedTable) { name: string }
      aggregate Customer extends Party { creditLimit: decimal }
    }
  }
}
`;

  it("threads isAbstract / extendsAggregate / inheritanceUsing onto AggregateIR", async () => {
    const loom = lowerModel(await parseValid(SRC));
    const ctx = loom.systems[0]!.subdomains[0]!.contexts.find((c) => c.name === "Parties")!;
    const party = ctx.aggregates.find((a) => a.name === "Party")!;
    const customer = ctx.aggregates.find((a) => a.name === "Customer")!;
    expect(party.isAbstract).toBe(true);
    expect(party.inheritanceUsing).toBe("sharedTable");
    expect(party.extendsAggregate).toBeUndefined();
    expect(customer.isAbstract).toBeUndefined();
    expect(customer.extendsAggregate).toBe("Party");
  });
});

describe("aggregate inheritance — validator (I1)", () => {
  const codes = (es: { code?: string | number }[]) =>
    es.map((e) => e.code).filter((c): c is string => typeof c === "string");

  it("rejects extending a non-abstract aggregate (loom.extends-non-abstract)", async () => {
    const { errors } = await parse(`
      context T {
        aggregate Party { name: string }
        aggregate Customer extends Party { creditLimit: decimal }
      }
    `);
    expect(codes(errors)).toContain("loom.extends-non-abstract");
  });

  it("rejects inheritanceUsing(…) on a plain aggregate (loom.inheritance-modifier-misplaced)", async () => {
    const { errors } = await parse(`
      context T { aggregate Cart inheritanceUsing(sharedTable) { name: string } }
    `);
    expect(codes(errors)).toContain("loom.inheritance-modifier-misplaced");
  });

  it("rejects a create/operation on an abstract base (loom.abstract-aggregate-behavior)", async () => {
    const { errors } = await parse(`
      context T {
        abstract aggregate Party {
          name: string
          operation rename(to: string) { this.name = to }
        }
      }
    `);
    expect(codes(errors)).toContain("loom.abstract-aggregate-behavior");
  });

  it("rejects a repository for an abstract base (loom.abstract-repository)", async () => {
    const { errors } = await parse(`
      context T {
        abstract aggregate Party { name: string }
        aggregate Customer extends Party { creditLimit: decimal }
        repository Parties for Party { }
      }
    `);
    expect(codes(errors)).toContain("loom.abstract-repository");
  });

  it("forces ownTable for an eventLog concrete of a sharedTable base (loom.es-tph-forced-own-table)", async () => {
    const { errors } = await parse(`
      context T {
        abstract aggregate Party inheritanceUsing(sharedTable) { name: string }
        aggregate Ledger extends Party persistedAs(eventLog) { n: int }
      }
    `);
    expect(codes(errors)).toContain("loom.es-tph-forced-own-table");
  });

  it("accepts the eventLog concrete once it declares inheritanceUsing(ownTable)", async () => {
    const { errors } = await parse(`
      context T {
        abstract aggregate Party inheritanceUsing(sharedTable) { name: string }
        aggregate Ledger extends Party persistedAs(eventLog) inheritanceUsing(ownTable) { n: int }
      }
    `);
    expect(codes(errors)).not.toContain("loom.es-tph-forced-own-table");
  });
});

describe("aggregate inheritance — field inheritance into wireShape (I2 foundation)", () => {
  const SRC = `
system Sys {
  subdomain Sales {
    context Parties {
      abstract aggregate Party inheritanceUsing(ownTable) { name: string email: string }
      aggregate Customer extends Party inheritanceUsing(ownTable) { creditLimit: decimal }
    }
  }
}
`;

  it("merges base fields ahead of own fields in the concrete's wireShape", async () => {
    const enriched = enrichLoomModel(lowerModel(await parseValid(SRC)));
    const ctx = enriched.systems[0]!.subdomains[0]!.contexts.find((c) => c.name === "Parties")!;
    const customer = ctx.aggregates.find((a) => a.name === "Customer")!;
    const names = customer.wireShape!.map((f) => f.name);
    // id first, then inherited base fields, then own.
    expect(names).toEqual(["id", "name", "email", "creditLimit"]);
  });

  it("does not duplicate a base field the concrete redeclares (own shadows)", async () => {
    const SRC2 = `
system Sys {
  subdomain Sales {
    context Parties {
      abstract aggregate Party inheritanceUsing(ownTable) { name: string }
      aggregate Customer extends Party inheritanceUsing(ownTable) { name: string tier: int }
    }
  }
}
`;
    const enriched = enrichLoomModel(lowerModel(await parseValid(SRC2)));
    const ctx = enriched.systems[0]!.subdomains[0]!.contexts.find((c) => c.name === "Parties")!;
    const customer = ctx.aggregates.find((a) => a.name === "Customer")!;
    const names = customer.wireShape!.map((f) => f.name);
    expect(names.filter((n) => n === "name")).toHaveLength(1);
    expect(names).toEqual(["id", "name", "tier"]);
  });

  it("warns that inheritance storage emission is not wired yet (IR-validate)", async () => {
    const diags = validateLoomModel(enrichLoomModel(lowerModel(await parseValid(SRC))));
    const warns = diags.filter(
      (d) =>
        d.severity === "warning" && /inheritance storage emission is not wired/.test(d.message),
    );
    // one for the abstract base, one for the concrete subtype.
    expect(warns.map((w) => w.source).sort()).toEqual(["Parties/Customer", "Parties/Party"]);
  });
});

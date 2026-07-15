// `Self id` — the anchored capability type (typed-capabilities.md).
//
// `Self` inside a `capability` body resolves to the implementing aggregate's
// own type when the capability is applied: the expander rewrites `Self id` →
// `<Host> id` at splice time, so lowering and the backends only ever see a
// concrete `X id`.  These tests pin resolution (per implementor), the id-kind
// recovery, equivalence to a hand-written self-ref, and the out-of-capability
// guard.

import { describe, expect, it } from "vitest";
import type { AggregateIR } from "../../../src/ir/types/loom-ir.js";
import { buildLoomModel } from "../../_helpers/ir.js";
import { parseString } from "../../_helpers/parse.js";

function findAgg(
  ir: { systems: { subdomains: { contexts: { aggregates: AggregateIR[] }[] }[] }[] },
  name: string,
): AggregateIR {
  for (const s of ir.systems)
    for (const m of s.subdomains)
      for (const c of m.contexts) for (const a of c.aggregates) if (a.name === name) return a;
  throw new Error(`aggregate ${name} not found`);
}

const parentType = (agg: AggregateIR) => agg.fields.find((f) => f.name === "parent")?.type;

describe("`Self id` anchored capability type (typed-capabilities.md)", () => {
  it("resolves to the implementing aggregate's own type", async () => {
    const ir = await buildLoomModel(`
      capability tenantRegistry { parent: Self id? }
      system D { subdomain M { context C {
        aggregate Org with tenantRegistry { name: string }
      }}}
    `);
    expect(parentType(findAgg(ir, "Org"))).toEqual({
      kind: "optional",
      inner: { kind: "id", targetName: "Org", valueType: "guid" },
    });
  });

  it("resolves per implementor (one capability, two aggregates)", async () => {
    const ir = await buildLoomModel(`
      capability tenantRegistry { parent: Self id? }
      system D { subdomain M { context C {
        aggregate Org    with tenantRegistry { name: string }
        aggregate Region with tenantRegistry { label: string }
      }}}
    `);
    expect(
      (parentType(findAgg(ir, "Org")) as { inner: { targetName: string } }).inner.targetName,
    ).toBe("Org");
    expect(
      (parentType(findAgg(ir, "Region")) as { inner: { targetName: string } }).inner.targetName,
    ).toBe("Region");
  });

  it("`with <Cap>`(Self) == a hand-written self-referential field", async () => {
    const viaCapability = await buildLoomModel(`
      capability tenantRegistry { parent: Self id? }
      system D { subdomain M { context C {
        aggregate Org with tenantRegistry { name: string }
      }}}
    `);
    const handWritten = await buildLoomModel(`
      system D { subdomain M { context C {
        aggregate Org { name: string  parent: Org id? }
      }}}
    `);
    expect(parentType(findAgg(viaCapability, "Org"))).toEqual(
      parentType(findAgg(handWritten, "Org")),
    );
  });

  it("`Self id` outside a capability is an error", async () => {
    const { errors } = await parseString(`
      system D { subdomain M { context C {
        aggregate X { parent: Self id }
      }}}
    `);
    expect(errors.join("\n")).toMatch(/`Self id` is only valid inside a `capability`/);
  });
});

describe("capability membership (AggregateIR.capabilities)", () => {
  it("records every applied capability (with + implements, deduped + sorted)", async () => {
    const ir = await buildLoomModel(`
      capability trashable { isDeleted: bool  filter !this.isDeleted }
      system D { subdomain M { context C {
        aggregate Order with auditable, trashable { subject: string }
        aggregate Doc { subject: string  implements trashable }
        aggregate Plain { subject: string }
      }}}
    `);
    // Versioning is default-on (M-T3.4): every aggregate also carries the
    // auto-applied `versioned` capability, sorted into the membership list.
    expect(findAgg(ir, "Order").capabilities).toEqual(["auditable", "trashable", "versioned"]);
    expect(findAgg(ir, "Doc").capabilities).toEqual(["trashable", "versioned"]);
    expect(findAgg(ir, "Plain").capabilities).toEqual(["versioned"]);
  });

  it("context-level `with <Cap>` records membership on every aggregate", async () => {
    const ir = await buildLoomModel(`
      capability trashable { isDeleted: bool  filter !this.isDeleted }
      system D { subdomain M {
        context C with trashable {
          aggregate Order { subject: string }
          aggregate Invoice { total: int }
        }
      }}
    `);
    expect(findAgg(ir, "Order").capabilities).toEqual(["trashable", "versioned"]);
    expect(findAgg(ir, "Invoice").capabilities).toEqual(["trashable", "versioned"]);
  });
});

// Member typing across `extends` (the F2-CB-C4 root cause).
//
// A subtype's inherited fields are merged onto its `fields` by the ENRICH pass
// (phase ⑥).  Expression lowering and member typing run BEFORE that, in phase
// ⑤b, and `memberOnEntity` walked only the subtype's OWN AST members — so
// `this.<baseField>` anywhere in a subtype's body typed as the `string`
// FALLBACK rather than its declared type.
//
// That is not cosmetic.  The IR contract is "fully resolved: backends never
// re-resolve", so a lying `memberType` is believed by every consumer.  The
// observed casualty was security-relevant: `criterion Live of Car =
// !this.retired` where `retired: bool` lives on the abstract base typed as
// `string`, the Drizzle boolean-column lowering rejected it, and the capability
// filter was dropped from every emitted read with no compile error and no
// diagnostic.  The type is asserted HERE, at the one place all five backends
// read it from, rather than per-backend.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import type { ExprIR, TypeIR } from "../../src/ir/types/loom-ir.js";
import { walkExprDeep } from "../../src/ir/util/walk.js";
import { parseString } from "../_helpers/parse.js";

/** The IR type of `this.<field>` inside `expr`, however it lowered (a `member`
 *  access or the equivalent `this-prop` ref). */
function typeOfThisField(expr: ExprIR, field: string): TypeIR | undefined {
  let found: TypeIR | undefined;
  walkExprDeep(expr, (n) => {
    if (n.kind === "member" && n.receiver.kind === "this" && n.member === field) {
      found = n.memberType;
    }
    if (n.kind === "ref" && n.refKind === "this-prop" && n.name === field) found = n.type;
  });
  return found;
}

async function criterionBody(source: string, name: string): Promise<ExprIR> {
  const { model } = await parseString(source, { validate: false });
  const loom = enrichLoomModel(lowerModel(model));
  for (const mod of loom.systems[0]!.subdomains) {
    for (const ctx of mod.contexts) {
      const c = ctx.criteria.find((x) => x.name === name);
      if (c) return c.body;
    }
  }
  throw new Error(`criterion ${name} not found`);
}

const src = (body: string) => `
  system Fleets {
    subdomain D {
      context Fleet {
        criterion Probe of Car = ${body}
        abstract aggregate Vehicle {
          name: string
          retired: bool
          capacity: int
        }
        aggregate Car extends Vehicle {
          doors: int
        }
        repository Cars for Car { }
      }
    }
  }
`;

describe("a subtype's `this.<baseField>` carries the base's declared type", () => {
  it("a bool base field types as bool, not the string fallback", async () => {
    const body = await criterionBody(src("!this.retired"), "Probe");
    expect(typeOfThisField(body, "retired")).toEqual({ kind: "primitive", name: "bool" });
  });

  it("an int base field types as int", async () => {
    const body = await criterionBody(src("this.capacity > 2"), "Probe");
    expect(typeOfThisField(body, "capacity")).toEqual({ kind: "primitive", name: "int" });
  });

  it("the subtype's OWN field still resolves (the chain walk did not displace it)", async () => {
    const body = await criterionBody(src("this.doors > 0"), "Probe");
    expect(typeOfThisField(body, "doors")).toEqual({ kind: "primitive", name: "int" });
  });

  it("a subtype field SHADOWS a like-named base field", async () => {
    // Own members come first in the walk, matching the enrich pass's own
    // `mergedFieldsFor` precedence — a redeclaration wins.
    const body = await criterionBody(
      `
      system Fleets {
        subdomain D {
          context Fleet {
            criterion Probe of Car = this.tag > 1
            abstract aggregate Vehicle { tag: string }
            aggregate Car extends Vehicle { tag: int }
            repository Cars for Car { }
          }
        }
      }
    `,
      "Probe",
    );
    expect(typeOfThisField(body, "tag")).toEqual({ kind: "primitive", name: "int" });
  });

  it("resolves through a MULTI-LEVEL chain, not just the direct base", async () => {
    const body = await criterionBody(
      `
      system Fleets {
        subdomain D {
          context Fleet {
            criterion Probe of Sedan = !this.retired
            abstract aggregate Vehicle { retired: bool }
            abstract aggregate Car extends Vehicle { doors: int }
            aggregate Sedan extends Car { trimLevel: string }
            repository Sedans for Sedan { }
          }
        }
      }
    `,
      "Probe",
    );
    expect(typeOfThisField(body, "retired")).toEqual({ kind: "primitive", name: "bool" });
  });
});

import { NodeFileSystem } from "langium/node";
import { parseHelper } from "langium/test";
import { describe, expect, it } from "vitest";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { createDddServices } from "../../src/language/ddd-module.js";
import type { Model } from "../../src/language/generated/ast.js";

// ---------------------------------------------------------------------------
// Parameter defaults — `param: T = <expr>` on an operation lowers onto
// `ParamIR.default`, resolving in the aggregate env so a `this`-relative
// default (`to: date = this.eta`) binds the target instance.  The parameter
// analogue of the aggregate field default (`field: T = <expr>` → FieldIR.default).
// ---------------------------------------------------------------------------

const services = createDddServices(NodeFileSystem);
const parse = parseHelper<Model>(services.Ddd);

const SYSTEM = (op: string) => `
system S {
  subdomain M {
    context C {
      aggregate Shipment {
        eta:    datetime
        status: string
        ${op}
      }
      repository Shipments for Shipment { }
    }
  }
}
`;

async function lowerOp(src: string) {
  const doc = await parse(src, { validation: true });
  const errors = (doc.diagnostics ?? []).filter((d) => d.severity === 1).map((d) => d.message);
  const agg = lowerModel(doc.parseResult.value).systems[0]!.subdomains[0]!.contexts[0]!
    .aggregates[0]!;
  return { errors, ops: agg.operations };
}

describe("parameter defaults (param: T = <expr>)", () => {
  it("lowers a constant default onto ParamIR.default", async () => {
    const { errors, ops } = await lowerOp(
      SYSTEM(`operation cancel(reason: string = "customer request") { status := "cancelled" }`),
    );
    expect(errors).toEqual([]);
    const p = ops.find((o) => o.name === "cancel")!.params.find((x) => x.name === "reason")!;
    expect(p.default).toBeDefined();
    expect(p.default).toMatchObject({ kind: "literal", lit: "string", value: "customer request" });
  });

  it("lowers a this-relative default resolving against the target instance", async () => {
    const { errors, ops } = await lowerOp(
      SYSTEM(`operation reschedule(to: datetime = this.eta) { eta := to }`),
    );
    expect(errors).toEqual([]);
    const p = ops.find((o) => o.name === "reschedule")!.params.find((x) => x.name === "to")!;
    expect(p.default).toBeDefined();
    // `this.eta` resolves as a this-prop member access, not an unresolved ref.
    expect(p.default).toMatchObject({
      kind: "member",
      member: "eta",
      receiver: { kind: "this" },
    });
  });

  it("leaves params without a default unchanged", async () => {
    const { errors, ops } = await lowerOp(
      SYSTEM(`operation touch(note: string) { status := note }`),
    );
    expect(errors).toEqual([]);
    const p = ops.find((o) => o.name === "touch")!.params.find((x) => x.name === "note")!;
    expect(p.default).toBeUndefined();
  });
});

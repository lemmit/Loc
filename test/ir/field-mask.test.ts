// `mask unless` IR gates (authorization.md §5, M-T3.2 item 6 foundation slice):
//   - the predicate is lowered onto FieldIR.maskUnless;
//   - it must reference only currentUser (loom.field-mask-not-current-user);
//   - it is compile-gated until per-backend read redaction lands
//     (loom.field-mask-unsupported) — no unenforced mask ships.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

const sys = (fieldClause: string, plat = "node") => `system S {
  user { id: string  role: string  permissions: string[] }
  subdomain M {
    permissions { unmask }
    context C {
      aggregate P with crudish {
        name: string
        salary: decimal ${fieldClause}
      }
    }
  }
  storage db { type: postgres }
  resource st { for: C, kind: state, use: db }
  deployable api { platform: ${plat}  contexts: [C]  dataSources: [st]  port: 8080  auth: required }
}`;

async function diags(fieldClause: string, plat = "node"): Promise<string[]> {
  const { model } = await parseString(sys(fieldClause, plat), { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model))).map((d) => d.code);
}

describe("field mask — IR gates", () => {
  it("lowers the predicate onto FieldIR.maskUnless", async () => {
    const { model } = await parseString(
      sys("mask unless currentUser.permissions.contains(permissions.unmask)"),
      { validate: false },
    );
    const ir = enrichLoomModel(lowerModel(model));
    const salary = ir.systems[0]!.subdomains[0]!.contexts[0]!.aggregates[0]!.fields.find(
      (f) => f.name === "salary",
    )!;
    expect(salary.maskUnless).toBeDefined();
    expect(salary.maskUnless!.kind).toBe("method-call");
  });

  it.each(["node", "dotnet"])("%s emits read redaction — no unsupported gate", async (plat) => {
    const codes = await diags(
      "mask unless currentUser.permissions.contains(permissions.unmask)",
      plat,
    );
    expect(codes).not.toContain("loom.field-mask-unsupported");
  });

  it("still gates the backends whose redaction hasn't landed (java)", async () => {
    const codes = await diags(
      "mask unless currentUser.permissions.contains(permissions.unmask)",
      "java",
    );
    expect(codes).toContain("loom.field-mask-unsupported");
  });

  it("rejects a mask predicate that references the row", async () => {
    const codes = await diags('mask unless name == "x"');
    expect(codes).toContain("loom.field-mask-not-current-user");
  });

  it("a field with no mask emits neither diagnostic", async () => {
    const codes = await diags("");
    expect(codes).not.toContain("loom.field-mask-unsupported");
    expect(codes).not.toContain("loom.field-mask-not-current-user");
  });

  it("rejects a masked aggregate as a query-time projection source (would leak)", async () => {
    const src = `system S {
  user { id: string  role: string  permissions: string[] }
  subdomain M {
    permissions { unmask }
    context C {
      aggregate P with crudish {
        name: string
        salary: decimal mask unless currentUser.permissions.contains(permissions.unmask)
      }
      projection Earners {
        from P
        select name
      }
    }
  }
  storage db { type: postgres }
  resource st { for: C, kind: state, use: db }
  deployable api { platform: node  contexts: [C]  dataSources: [st]  port: 8080  auth: required }
}`;
    const { model } = await parseString(src, { validate: false });
    const codes = validateLoomModel(enrichLoomModel(lowerModel(model))).map((d) => d.code);
    expect(codes).toContain("loom.field-mask-projection-source");
  });
});

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

  it.each([
    "node",
    "dotnet",
    "python",
    "java",
    "elixir",
  ])("%s emits read redaction — no unsupported gate", async (plat) => {
    const codes = await diags(
      "mask unless currentUser.permissions.contains(permissions.unmask)",
      plat,
    );
    expect(codes).not.toContain("loom.field-mask-unsupported");
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
        from P as p
        select who = p.name
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

  // A `join` reaches the masked aggregate just as directly as `from` does.
  // Before this was checked, `select leaked = c.ssn` off a join alias VALIDATED
  // CLEAN and emitted the raw column on all five backends, while the identical
  // read through `from` was a hard error — so the bound was bypassable by
  // adding a join.  Verified on node before the fix: the emitted projection
  // route read `customerById.get(...)!.ssn` in the clear, while the same
  // aggregate's own `GET /{id}` went through `repo.toWireMasked(...)`.
  it("rejects a masked aggregate reached through a `join`, not just through `from`", async () => {
    const src = `system S {
  user { id: string  role: string }
  subdomain M {
    context C {
      aggregate Customer with crudish {
        name: string
        ssn: string mask unless currentUser.role == "admin"
      }
      aggregate Order with crudish {
        customerId: Customer id
        total: int
      }
      projection OrderLeak keyed by orderId {
        orderId: Order id
        who: string
        leaked: string
        from Order as o
        join Customer as c on o.customerId
        select orderId = o.id, who = c.name, leaked = c.ssn
      }
    }
  }
  storage db { type: postgres }
  resource st { for: C, kind: state, use: db }
  deployable api { platform: node  contexts: [C]  dataSources: [st]  port: 8080  auth: required }
}`;
    const { model } = await parseString(src, { validate: false });
    const diags = validateLoomModel(enrichLoomModel(lowerModel(model)));
    expect(diags.map((d) => d.code)).toContain("loom.field-mask-projection-source");
    // The message must name the JOINED aggregate, not the `from` source —
    // pointing at `Order` would send the author to the wrong declaration.
    const d = diags.find((x) => x.code === "loom.field-mask-projection-source")!;
    expect(d.message).toContain("joins aggregate 'Customer'");
  });

  // M-T3.15 B0 — the FOLD bypass.  The query-time bound above refuses a
  // projection that READS a masked aggregate; an `emit` carrying the masked
  // value into a folded read model reached exactly the same cleartext row on
  // all five backends, with no unusual syntax and a clean `ddd parse`.
  const foldSystem = (emitFields: string) => `system S {
  user { id: string  role: string  permissions: string[] }
  subdomain M {
    permissions { unmask }
    context C {
      event Raised { who: P id  newSalary: money }
      aggregate P {
        who: string
        salary: money mask unless currentUser.permissions.contains(permissions.unmask)
        create(who: string, salary: money) { }
        operation raise(amount: money) {
          salary := amount
          emit Raised { ${emitFields} }
        }
      }
      repository Ps for P { }
      projection SalaryBoard keyed by who {
        who: P id
        newSalary: money
        on(e: Raised) by e.who {
          who := e.who
          newSalary := e.newSalary
        }
      }
    }
  }
  storage db { type: postgres }
  resource st { for: C, kind: state, use: db }
  deployable api { platform: node  contexts: [C]  dataSources: [st]  port: 8080  auth: required }
}`;

  async function foldDiags(emitFields: string) {
    const { model } = await parseString(foldSystem(emitFields), { validate: false });
    return validateLoomModel(enrichLoomModel(lowerModel(model)));
  }

  it("rejects a projection that folds an event laundering a masked field", async () => {
    const ds = await foldDiags("who: id, newSalary: salary");
    expect(ds.map((d) => d.code)).toContain("loom.field-mask-projection-source");
    const d = ds.find((x) => x.code === "loom.field-mask-projection-source")!;
    expect(d.message).toContain("folds event 'Raised'");
    expect(d.message).toContain("'P.salary'");
  });

  it("follows the masked value through a `let` binding into the emit", async () => {
    const src = foldSystem("who: id, newSalary: hidden").replace(
      "          emit Raised",
      "          let hidden = salary\n          emit Raised",
    );
    const { model } = await parseString(src, { validate: false });
    const ds = validateLoomModel(enrichLoomModel(lowerModel(model)));
    expect(ds.map((d) => d.code)).toContain("loom.field-mask-projection-source");
  });

  it("leaves a fold that carries no masked value alone", async () => {
    // Same aggregate, same mask, same projection — the emit carries the
    // operation PARAM, not the masked column.  A gate that fired here would
    // ban every read model built off a masked aggregate.
    const ds = await foldDiags("who: id, newSalary: amount");
    expect(ds.map((d) => d.code)).not.toContain("loom.field-mask-projection-source");
  });
});

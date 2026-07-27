// `loom.create-field-type` (M-T6.18 gap #3) — the VALUE-type twin of the
// factory create-input NAME gate (`loom.create-unknown-field` /
// `loom.create-server-field`).  An `Agg.create({ field: value })` entry whose
// name IS a valid create-input field but whose value type mismatches
// (`Order.create({ qty: "abc" })` where `qty: int`) names a valid field, so the
// name gate passes it — then the emitted backend's create-input DTO fails its
// own tsc/gradle/mix.  Model-wide, so it fires wherever the call lives — test
// blocks, aggregate operations, and workflow `create`/`handle` bodies.

import { describe, expect, it } from "vitest";
import { parseString } from "../../_helpers/parse.js";

const codesOf = (diags: { code?: string }[]) =>
  diags.map((d) => d.code).filter((c): c is string => c !== undefined);

const sys = (body: string) => `
system Demo {
  subdomain S {
    context C {
      enum Status { Open, Done }
      aggregate Task with crudish {
        title: string
        qty: int
        price: money
        status: Status
        createdAt: datetime managed
        ${body}
      }
    }
  }
  storage primary { type: postgres }
  resource st { for: C, kind: state, use: primary }
  deployable api { platform: node contexts: [C] dataSources: [st] port: 3000 }
}`;

async function codes(body: string): Promise<string[]> {
  const { diagnostics } = await parseString(sys(body), { validate: true });
  return codesOf(diagnostics);
}

const TYPE = "loom.create-field-type";
const UNKNOWN = "loom.create-unknown-field";

describe("loom.create-field-type (factory create-input value types, M-T6.18)", () => {
  it("rejects a string value in an int create-input field", async () => {
    expect(
      await codes(
        'test "t" { let x = Task.create({ title: "a", qty: "oops", price: 0, status: Open }) }',
      ),
    ).toContain(TYPE);
  });

  it("is CLEAN when every entry value type matches", async () => {
    expect(
      await codes(
        'test "t" { let x = Task.create({ title: "a", qty: 3, price: 0, status: Open }) }',
      ),
    ).not.toContain(TYPE);
  });

  it("admits int-literal promotion into a money field", async () => {
    // `price: 5` (an int literal) into a `money` field — same ergonomic promotion
    // defaults / `:=` / construction values accept.
    expect(
      await codes(
        'test "t" { let x = Task.create({ title: "a", qty: 3, price: 5, status: Open }) }',
      ),
    ).not.toContain(TYPE);
  });

  it("does not add a type error for an UNKNOWN field name (name gate owns it)", async () => {
    const c = await codes(
      'test "t" { let x = Task.create({ title: "a", qty: 3, price: 0, status: Open, bogus: "x" }) }',
    );
    expect(c).toContain(UNKNOWN);
    expect(c).not.toContain(TYPE);
  });

  it("suppresses on an unresolvable (unknown) value", async () => {
    expect(
      await codes(
        'test "t" { let x = Task.create({ title: "a", qty: nope, price: 0, status: Open }) }',
      ),
    ).not.toContain(TYPE);
  });

  // The marquee case: the same factory call inside a WORKFLOW create body — a
  // site the statement walk never reaches, so this model-wide gate is what
  // catches it there.
  it("flags a wrong-typed create-input value inside a workflow `create` body", async () => {
    const { diagnostics } = await parseString(
      `
system Demo {
  subdomain S {
    context C {
      enum Status { Open, Done }
      aggregate Task with crudish {
        title: string
        qty: int
        status: Status
      }
      workflow W {
        create(label: string) {
          let o = Task.create({ title: "a", qty: "abc", status: Open })
        }
      }
    }
  }
  storage primary { type: postgres }
  resource st { for: C, kind: state, use: primary }
  deployable api { platform: node contexts: [C] dataSources: [st] port: 3000 }
}`,
      { validate: true },
    );
    expect(codesOf(diagnostics)).toContain(TYPE);
  });
});

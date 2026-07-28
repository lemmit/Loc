// `field: T mask unless <expr>` read mask — parsing, bool check, round-trip
// (authorization.md §5, M-T3.2 item 6 foundation slice).

import { AstUtils } from "langium";
import { describe, expect, it } from "vitest";
import { isAggregate } from "../../src/language/generated/ast.js";
import { printStructural } from "../../src/language/print/print-structural.js";
import { parseString } from "../_helpers/index.js";

const wrap = (field: string) => `system S {
  user { id: string  role: string  permissions: string[] }
  subdomain M {
    permissions { unmask }
    context C {
      aggregate P with crudish {
        name: string
        ${field}
      }
    }
  }
}`;

const errs = async (field: string): Promise<string[]> =>
  (await parseString(wrap(field), { validate: true })).errors;

describe("field mask — parsing + bool check", () => {
  it("parses + accepts a bare currentUser permission mask", async () => {
    const e = await errs(
      "salary: decimal mask unless currentUser.permissions.contains(permissions.unmask)",
    );
    // (the backend-unsupported gate is an IR check, tested separately; here we
    // only assert the AST-level surface + bool typing accept it)
    expect(e.filter((s) => /mask.*bool|Expecting/.test(s)).join("\n")).toBe("");
  });

  it("rejects a non-bool mask predicate", async () => {
    const e = await errs("salary: decimal mask unless currentUser.id");
    expect(e.some((s) => /'mask unless' on 'salary' must be of type 'bool'/.test(s))).toBe(true);
  });

  it("coexists with a default + check on the same field", async () => {
    const e = await errs(
      'salary: decimal = 0 check salary >= 0 mask unless currentUser.role == "admin"',
    );
    expect(e.filter((s) => /Expecting|mask.*bool/.test(s)).join("\n")).toBe("");
  });
});

describe("field mask — printer round-trip", () => {
  it("re-emits the `mask unless` clause", async () => {
    const { model } = await parseString(
      wrap('salary: decimal mask unless currentUser.role == "admin"'),
      { validate: false },
    );
    const agg = [...AstUtils.streamAllContents(model)].find(isAggregate)!;
    const printed = printStructural(agg);
    expect(printed).toContain('mask unless currentUser.role == "admin"');
  });
});

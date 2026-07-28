// `field: T write(<expr>)` / `readonly when <expr>` write-side gate — parsing,
// bool check, round-trip (authorization.md §5, M-T3.2 item 6 foundation slice).

import { AstUtils } from "langium";
import { describe, expect, it } from "vitest";
import { isAggregate } from "../../src/language/generated/ast.js";
import { printStructural } from "../../src/language/print/print-structural.js";
import { parseString } from "../_helpers/index.js";

const wrap = (field: string) => `system S {
  user { id: string  role: string  permissions: string[] }
  subdomain M {
    permissions { setSalary }
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

describe("field write gate — parsing + bool check", () => {
  it("parses + accepts a bare currentUser `write(...)` gate", async () => {
    const e = await errs(
      "salary: decimal write(currentUser.permissions.contains(permissions.setSalary))",
    );
    // (the backend-unsupported gate is an IR check, tested separately; here we
    // only assert the AST-level surface + bool typing accept it)
    expect(e.filter((s) => /write.*bool|Expecting/.test(s)).join("\n")).toBe("");
  });

  it("parses + accepts a `readonly when` gate", async () => {
    const e = await errs('salary: decimal readonly when currentUser.role == "viewer"');
    expect(e.filter((s) => /readonly.*bool|Expecting/.test(s)).join("\n")).toBe("");
  });

  it("rejects a non-bool `write(...)` predicate", async () => {
    const e = await errs("salary: decimal write(currentUser.id)");
    expect(e.some((s) => /'write\(\.\.\.\)' on 'salary' must be of type 'bool'/.test(s))).toBe(
      true,
    );
  });

  it("rejects a non-bool `readonly when` predicate", async () => {
    const e = await errs("salary: decimal readonly when currentUser.id");
    expect(e.some((s) => /'readonly when' on 'salary' must be of type 'bool'/.test(s))).toBe(true);
  });

  it("reserves `write` / `readonly` as field names (taken as clause keywords)", async () => {
    // Both moved out of the soft-keyword identifier set when they became trailing
    // Property clause keywords (see the grammar note + the coverage snapshot).
    const e = await errs("write: string");
    expect(e.some((s) => /Expecting/.test(s))).toBe(true);
  });

  it("coexists with a default + check + mask on the same field", async () => {
    const e = await errs(
      'salary: decimal = 0 check salary >= 0 mask unless currentUser.role == "admin" ' +
        "write(currentUser.permissions.contains(permissions.setSalary))",
    );
    expect(e.filter((s) => /Expecting|bool/.test(s)).join("\n")).toBe("");
  });
});

describe("field write gate — printer round-trip", () => {
  it("re-emits the `write(...)` clause", async () => {
    const { model } = await parseString(
      wrap("salary: decimal write(currentUser.permissions.contains(permissions.setSalary))"),
      { validate: false },
    );
    const agg = [...AstUtils.streamAllContents(model)].find(isAggregate)!;
    expect(printStructural(agg)).toContain(
      "write(currentUser.permissions.contains(permissions.setSalary))",
    );
  });

  it("re-emits the `readonly when` clause", async () => {
    const { model } = await parseString(
      wrap('salary: decimal readonly when currentUser.role == "viewer"'),
      { validate: false },
    );
    const agg = [...AstUtils.streamAllContents(model)].find(isAggregate)!;
    expect(printStructural(agg)).toContain('readonly when currentUser.role == "viewer"');
  });
});

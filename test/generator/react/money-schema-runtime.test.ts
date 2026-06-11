// Behavioural test for the emitted `moneySchema` — the money primitive's
// zod schema accepts BOTH of its real inbound shapes:
//
//   - wire JSON: a decimal-formatted string, parsed to a Decimal;
//   - form state: an already-constructed Decimal instance, passed
//     through unchanged.  The money input control converts on change
//     (`field.onChange(new Decimal(...))`), so the zodResolver sees the
//     instance — under the previous `z.string()`-only schema every
//     money-primitive form failed validation on submit with
//     "Expected string, received object".
//
// The template string is transpiled and EXECUTED here (same harness as
// frontend-acl-emit.test.ts) so the fix is pinned by semantics, not text.

import ts from "typescript";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { REACT_LIB_SCHEMAS_MONEY_TS } from "../../../src/generator/react/emit-templates.js";
import { SVELTE_LIB_SCHEMAS_MONEY } from "../../../src/generator/svelte/emit-templates.js";

/** Stand-in for decimal.js (not a dependency of the toolchain repo) —
 *  the schema only constructs and instanceof-checks it. */
class FakeDecimal {
  readonly value: string;
  constructor(s: string) {
    if (!/^-?\d+(\.\d+)?$/.test(s)) throw new Error(`bad decimal ${s}`);
    this.value = s;
  }
}

type MoneySchema = z.ZodType<FakeDecimal, z.ZodTypeDef, unknown>;

/** Strip the template's imports, transpile, and evaluate with the repo's
 *  zod + the Decimal stand-in injected. */
function loadMoneySchema(src: string): MoneySchema {
  const trimmed = src
    .replace(/import Decimal from "decimal\.js";\s*\n/, "")
    .replace(/import \{ z \} from "zod";\s*\n/, "");
  const js = ts.transpileModule(trimmed, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const factory = new Function(
    "exports",
    "module",
    "z",
    "Decimal",
    `${js}\nreturn exports.moneySchema;`,
  );
  const mod = { exports: {} as Record<string, unknown> };
  return factory(mod.exports, mod, z, FakeDecimal) as MoneySchema;
}

for (const [label, template] of [
  ["react", REACT_LIB_SCHEMAS_MONEY_TS],
  ["svelte", SVELTE_LIB_SCHEMAS_MONEY],
] as const) {
  describe(`moneySchema runtime — ${label} template`, () => {
    const schema = loadMoneySchema(template);

    it("parses a wire decimal string to a Decimal", () => {
      const out = schema.parse("123.4500");
      expect(out).toBeInstanceOf(FakeDecimal);
      expect((out as FakeDecimal).value).toBe("123.4500");
    });

    it("passes an existing Decimal instance through unchanged (form-state shape)", () => {
      const d = new FakeDecimal("42.10");
      expect(schema.parse(d)).toBe(d);
    });

    it("rejects a malformed string with a typed issue, not a throw", () => {
      const r = schema.safeParse("not-a-number");
      expect(r.success).toBe(false);
    });

    it("rejects non-string non-Decimal input", () => {
      expect(schema.safeParse(42).success).toBe(false);
      expect(schema.safeParse(null).success).toBe(false);
    });
  });
}

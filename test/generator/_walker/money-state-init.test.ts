// A money-typed `state {}` field must be seeded with a `Decimal`, whichever
// spelling the author used for the literal.
//
// `money` is a decimal.js `Decimal` on every JS frontend, but a state field's
// init is rendered from the literal as written — and the two spellings lower
// differently:
//
//   m: money = money("1.50")   → a MONEY literal   (lit: "money")
//   m: money = 1.50            → a DECIMAL literal (lit: "decimal")
//
// The second rendered as the bare number, seeding `useState<Decimal>(1.50)` /
// `ref(1.50)` / `$state<Decimal>(1.50)` / `signal(1.50)`.  That is a type error
// on its own, and every `.toDecimalPlaces(…)` / `Decimal.min(…)` read off the
// field compounds it — the money intrinsics landed in #2499 are precisely what
// makes such a field worth reading.
//
// The coercion is keyed on the field's DECLARED TYPE rather than on the
// literal kind, because that is the fact that makes it necessary: whatever the
// author wrote, a money-typed field has to hold a `Decimal`.  It lives in one
// shared helper (`coerceMoneyStateInit`) that all four page shells call, since
// each renders its own state declaration.
//
// The numeric literal is QUOTED on the way in — `new Decimal("1.50")`, not
// `new Decimal(1.50)` — so the decimal string is parsed exactly rather than
// round-tripping through a float, matching every other money emission.

import { describe, expect, it } from "vitest";
import { coerceMoneyStateInit } from "../../../src/generator/_expr/js-intrinsics.js";
import type { TypeIR } from "../../../src/ir/types/loom-ir.js";
import { generateSystemFiles } from "../../_helpers/index.js";

const money: TypeIR = { kind: "primitive", name: "money" } as TypeIR;
const decimal: TypeIR = { kind: "primitive", name: "decimal" } as TypeIR;

const SYSTEM = (framework: string): string => `
system S {
  subdomain D {
    context C {
      aggregate A { name: string  price: money }
      repository As for A { }
    }
  }
  api Api from D
  storage pg { type: postgres }
  resource st { for: C, kind: state, use: pg }
  ui W {
    framework: ${framework}
    api C: Api
    page P {
      route: "/p"
      state {
        bare: money = 1.50
        conv: money = money("2.50")
        plain: decimal = 3.5
      }
      body: Stack {
        Stat { "a", string(bare.round(2)) },
        Stat { "b", string(conv.abs()) },
        Stat { "c", string(plain.floor()) }
      }
    }
  }
  deployable api { platform: node, contexts: [C], dataSources: [st], serves: Api, port: 3000 }
  deployable web { platform: static, targets: api, ui: W { C: api }, port: 3001 }
}
`;

const PAGE_OF: Record<string, RegExp> = {
  react: /\/src\/pages\/p\.tsx$/,
  vue: /\/src\/pages\/p\.vue$/,
  svelte: /\+page\.svelte$/,
  angular: /\/src\/app\/pages\/p\.component\.ts$/,
};

async function page(framework: string): Promise<string> {
  const files = await generateSystemFiles(SYSTEM(framework));
  const found = [...files].find(([k]) => PAGE_OF[framework]!.test(k))?.[1];
  expect(found, `no page emitted for ${framework}`).toBeDefined();
  return found!;
}

describe("coerceMoneyStateInit — the shared rule", () => {
  it("wraps a bare numeric init on a money field, quoted for exactness", () => {
    expect(coerceMoneyStateInit(money, "1.50")).toBe('new Decimal("1.50")');
    expect(coerceMoneyStateInit(money, "-0.01")).toBe('new Decimal("-0.01")');
  });

  it("leaves an init that already names the binding alone", () => {
    // The `money("2.50")` conversion form was always correct — it must stay
    // byte-identical, not become `new Decimal(new Decimal("2.50"))`.
    expect(coerceMoneyStateInit(money, 'new Decimal("2.50")')).toBe('new Decimal("2.50")');
  });

  it("does not touch a non-money field", () => {
    // `decimal` is a plain JS number on this surface; wrapping it would be the
    // mirror-image bug.
    expect(coerceMoneyStateInit(decimal, "3.5")).toBe("3.5");
  });

  it("sees through an optional money type", () => {
    const opt: TypeIR = { kind: "optional", inner: money } as TypeIR;
    expect(coerceMoneyStateInit(opt, "1.50")).toBe('new Decimal("1.50")');
  });
});

describe("a money state field is seeded with a Decimal on every JS frontend", () => {
  for (const framework of ["react", "vue", "svelte", "angular"] as const) {
    it(`${framework}: both literal spellings seed a Decimal, and decimal stays a number`, async () => {
      const src = await page(framework);
      expect(src, `${framework}: bare decimal literal on a money field`).toContain(
        'new Decimal("1.50")',
      );
      expect(src, `${framework}: money(...) conversion form`).toContain('new Decimal("2.50")');
      // The negative half: a `decimal` field must NOT be wrapped.
      expect(src, `${framework}: decimal must stay a plain number`).not.toContain(
        'new Decimal("3.5")',
      );
    }, 120_000);
  }
});

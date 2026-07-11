// RS-2 · Enum values use declared casing on the wire — cross-backend, static.
//
// The first executable enforcement of the runtime-semantics contract
// (docs/conformance-semantics.md). An enum value declared `Confirmed` must
// serialize/cast as "Confirmed" on every backend — never a backend-idiomatic
// re-casing (`confirmed`, `CONFIRMED`).
//
// This is a T0 (static) gate: the wire value an enum serializes to is fixed by
// the emitted enum definition, so the guarantee is assertable against
// generated source with NO boot and NO docker — it runs per-PR in the fast
// suite. It is the exact regression #1622 fixed: Ecto.Enum was snake-casing
// `:passed` while the cross-backend wire contract wanted "Passed", so a POST
// of the declared casing returned 422. That bug compiled green and passed the
// structural OpenAPI parity diff (which is casing-tolerant) — this gate is
// what would have caught it per-PR.
//
// Lives in the always-on `test` gate alongside the other cross-backend parity
// pins. When A6.2 lands a second booted backend, the runtime round-trip
// becomes the T1/T2 companion; until then this static pin is the net.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/generate.js";

/** One enum + a field that carries it, per backend. `Confirmed` is the
 *  multi-... no — a single distinctive PascalCase value whose re-casing
 *  (`confirmed`) is unambiguous to grep for at the wire site. */
function system(platform: string): string {
  return `
system S {
  subdomain Sales {
    context Orders {
      enum OrderStatus { Draft, Confirmed, Cancelled }
      aggregate Order { code: string  status: OrderStatus }
      repository Orders for Order { }
    }
  }
  api OrdersApi from Sales
  storage pg { type: postgres }
  resource s { for: Orders, kind: state, use: pg }
  deployable d {
    platform: ${platform}
    contexts: [Orders]
    dataSources: [s]
    serves: OrdersApi
    port: 4000
  }
}`;
}

type Backend = {
  platform: string;
  /** The emitted file that fixes the enum's wire value. */
  file: string;
  /** Must appear: the declared casing at the wire-serialization site. */
  present: RegExp;
  /** Must NOT appear in that file: the re-cased wire value — the regression
   *  shape. Anchored tightly enough to avoid snake table-name false hits
   *  (`order_status` contains no `confirmed`). */
  reCased: RegExp;
};

const BACKENDS: Backend[] = [
  {
    platform: "node",
    file: "d/db/schema.ts",
    // pgEnum("order_status", ["Draft", "Confirmed", "Cancelled"])
    present: /"Confirmed"/,
    reCased: /"confirmed"|"CONFIRMED"/,
  },
  {
    platform: "python",
    file: "d/app/domain/value_objects.py",
    // Confirmed = "Confirmed"  (StrEnum member value IS the wire value)
    present: /Confirmed\s*=\s*"Confirmed"/,
    reCased: /=\s*"confirmed"|=\s*"CONFIRMED"/,
  },
  {
    platform: "dotnet",
    file: "d/Domain/Enums/OrderStatus.cs",
    // public enum OrderStatus { Draft, Confirmed, Cancelled }
    // (member name is the wire value under the string-enum converter)
    present: /\bConfirmed\b/,
    reCased: /\bconfirmed\b|\bCONFIRMED\b/,
  },
  {
    platform: "java",
    file: "d/src/main/java/com/loom/d/domain/enums/OrderStatus.java",
    // public enum OrderStatus { Draft, Confirmed, Cancelled }
    present: /\bConfirmed\b/,
    reCased: /\bconfirmed\b|\bCONFIRMED\b/,
  },
  {
    platform: "elixir",
    file: "d/lib/d/orders/order.ex",
    // field :status, Ecto.Enum, values: [:Draft, :Confirmed, :Cancelled]
    // #1622: this was `:confirmed` (snake) and broke the wire cast.
    present: /:Confirmed\b/,
    reCased: /:confirmed\b/,
  },
];

describe("RS-2 · enum values use declared casing on the wire (static, all backends)", () => {
  for (const b of BACKENDS) {
    it(`${b.platform}: emits the declared casing at the wire site`, async () => {
      const files = await generateSystemFiles(system(b.platform));
      const src = files.get(b.file);
      expect(src, `expected ${b.file} in the generated ${b.platform} project`).toBeDefined();
      expect(src, `${b.platform}: declared enum casing missing from ${b.file}`).toMatch(b.present);
      expect(
        b.reCased.test(src ?? ""),
        `${b.platform}: enum wire value re-cased in ${b.file} (RS-2 regression, cf #1622)`,
      ).toBe(false);
    });
  }
});

import { describe, expect, it } from "vitest";
import type { Model } from "../../../src/language/generated/ast.js";
import { printStructural } from "../../../src/language/print/index.js";
import { parseRawResult } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// Focused round-trip coverage for structural-printer surface that the
// corpus round-trip test does not currently exercise (the example corpus
// uses these constructs, but not in every shape).  Each case is a minimal,
// parse-valid `.ddd`: print every top-level member, splice the printed text
// back over its own CST range, re-parse, and assert the AST is structurally
// identical.  Printing a top-level `system` recurses through every nested
// printer, so these gate:
//   - aggregate inheritance header modifiers (`abstract`, `extends`,
//     `inheritanceUsing:`)
//   - the D-REALIZATION-AXES `platform: <plat> { … }` block (`directoryLayout`)
//   - the payload family (`payload` / `command` / `query` / `response` / `error`)
//   - `channel` (context member) and `channelSource` (system member)
// ---------------------------------------------------------------------------

// Comparable projection of an AST: keep `$type`, own non-`$` fields, and
// references as `{ $ref }`; drop positions / containers / documents.
// (Mirrors print-structural-roundtrip.test.ts.)
function norm(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(norm);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.$refText === "string") return { $ref: o.$refText };
    if (typeof o.$type === "string") {
      const out: Record<string, unknown> = { $type: o.$type };
      for (const k of Object.keys(o)) if (!k.startsWith("$")) out[k] = norm(o[k]);
      return out;
    }
  }
  return v;
}

function expectRoundTrips(src: string): void {
  const original = parseRawResult(src);
  expect(original.parserErrors, `source must parse:\n${src}`).toEqual([]);
  const normOrig = norm(original.value);
  const members = (original.value as Model).members;
  expect(members.length).toBeGreaterThan(0);
  for (const member of members) {
    const cst = member.$cstNode;
    if (!cst) continue;
    const printed = printStructural(member);
    const spliced = src.slice(0, cst.offset) + printed + src.slice(cst.end);
    const re = parseRawResult(spliced);
    expect(re.parserErrors, `printed member must parse:\n${printed}`).toEqual([]);
    expect(norm(re.value), `printed member must round-trip:\n${printed}`).toEqual(normOrig);
  }
}

describe("print-structural round-trip — payload / channel / inheritance / axes", () => {
  it("aggregate inheritance: abstract + extends + inheritanceUsing: ownTable", () => {
    expectRoundTrips(`system S {
  subdomain D {
    context C {
      abstract aggregate Account inheritanceUsing: ownTable {
        owner: string
      }
      aggregate CheckingAccount extends Account inheritanceUsing: ownTable with crudish {
        overdraftLimit: int
      }
    }
  }
}
`);
  });

  it("aggregate inheritance: inheritanceUsing: sharedTable", () => {
    expectRoundTrips(`system S {
  subdomain D {
    context C {
      abstract aggregate PaymentMethod inheritanceUsing: sharedTable {
        label: string
      }
      aggregate CreditCard extends PaymentMethod with crudish {
        last4: string
      }
    }
  }
}
`);
  });

  it("payload family: payload / command / query / response / error", () => {
    expectRoundTrips(`system S {
  subdomain D {
    context C {
      payload  OrderLine    { sku: string, qty: int }
      command  PlaceOrder   { reference: string }
      query    FindByStatus { status: string }
      response OrderSummary { reference: string, total: decimal }
      error    OrderRejected { reference: string, reason: string }
    }
  }
}
`);
  });

  it("channel (context member) + channelSource (system member)", () => {
    expectRoundTrips(`system S {
  subdomain D {
    context C {
      event OrderPlaced    { at: datetime }
      event OrderEscalated { at: datetime }
      channel OrderEvents {
        carries: OrderPlaced, OrderEscalated
        delivery: broadcast
        retention: log
        key: order
      }
    }
  }
  storage bus { type: kafka }
  channelSource orderBus { for: OrderEvents, use: bus }
}
`);
  });

  it("channel with only the required carries: axis", () => {
    expectRoundTrips(`system S {
  subdomain D {
    context C {
      event OrderPlaced { at: datetime }
      channel OrderEvents {
        carries: OrderPlaced
      }
    }
  }
}
`);
  });

  it("deployable realization-axes block: platform { directoryLayout }", () => {
    expectRoundTrips(`system S {
  subdomain D {
    context C {
      aggregate Order with crudish {
        reference: string
      }
    }
  }
  deployable api {
    platform: dotnet {
      directoryLayout: byFeature
    }
    contexts: [C]
    port: 8080
  }
}
`);
  });
});

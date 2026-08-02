// RS-29 — a declared error variant's fields reach the RFC 7807 body as
// camelCase extension members, on all five backends.
//
// Found by the M-T9.25 casing/absence census sweep, and it is the ONE casing
// divergence in the whole sweep: at the six mainstream wire sites (read DTO,
// create input, paged carrier, projection read, workflow-instance read, nested
// parts and value objects) all five backends agree, camelCase, in identical
// `wireShape` order.  `wireShape` is doing exactly its job everywhere it is
// consulted.
//
// This site is not consulted.  An `error` payload's fields become §3.2
// extension members on the problem body, and elixir built that map by running
// the value through the shared `object` expression leaf — which snakes names,
// correctly, because every OTHER object literal in elixir is a domain-side Ecto
// map.  So `error PriceTooLow { minAmount: int, … }` shipped as:
//
//   elixir  %{min_amount: 10, offered_amount: offered, currency_code: "USD"}
//   node    { minAmount: 10, offeredAmount: offered, currencyCode: "USD" }
//   python  {"minAmount": 10, …}
//   dotnet  problem.Extensions["minAmount"] = v.MinAmount
//   java    problem.setProperty("minAmount", v.minAmount())
//
// Two things made it invisible:
//
//  1. The only wire golden that records a declared-error body
//     (`operation-returns.json`) uses `error NotFound { resource: string }` — a
//     SINGLE-WORD field, where snake and camel are the same string.  A one-word
//     fixture cannot test a casing rule.
//  2. `conformance-parity` compares declared response SHAPES, and extension
//     members are not in the declared `ProblemDetails` component.
//
// It was also an INTRA-backend break, which is the sharper half: elixir's own
// emitted OpenAPI schema declares `minAmount` / `offeredAmount` /
// `currencyCode`, so the spec it published and the body it sent disagreed with
// each other inside one generated app.
//
// The fixture therefore uses deliberately MULTI-WORD field names. A rule about
// casing tested with single-word names asserts nothing.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/generate.js";
import { parseString } from "../_helpers/parse.js";

const SOURCE = (platform: string) => `
system E {
  subdomain S {
    context S {
      error PriceTooLow { minAmount: int, offeredAmount: int, currencyCode: string }
      aggregate Item with crudish {
        name: string
        qty: int
        operation quote(offered: int): string or PriceTooLow {
          return PriceTooLow { minAmount: 10, offeredAmount: offered, currencyCode: "USD" }
        }
      }
      repository Items for Item { }
    }
  }
  api A from S
  storage pg { type: postgres }
  resource st { for: S, kind: state, use: pg }
  deployable api {
    platform: ${platform}
    contexts: [S]
    dataSources: [st]
    serves: A
    port: 8080
  }
}
`;

const PLATFORMS = ["node", "dotnet", "java", "python", "elixir"] as const;

/** The snake_case spelling of each declared field — the shape that must NOT
 *  appear anywhere the body is built. Kept as its own list so the failure
 *  message can name which field leaked. */
const SNAKE = ["min_amount", "offered_amount", "currency_code"] as const;
const CAMEL = ["minAmount", "offeredAmount", "currencyCode"] as const;

async function joined(platform: string): Promise<string> {
  return [...(await generateSystemFiles(SOURCE(platform))).values()].join("\n");
}

describe("RS-29 — declared-error extension members are camelCase on the wire", () => {
  it("the fixture parses clean — an error-recovered AST proves nothing", async () => {
    // `generateSystemFiles` tolerates diagnostics, and Langium error recovery
    // still yields enough AST to emit plausible-looking output. An earlier draft
    // of this fixture used `if <cond> { … }`, which is NOT a statement in the
    // DSL — no corpus fixture has one — and it emitted the expected string
    // anyway. Assert the fixture is valid rather than trusting that it is.
    for (const p of PLATFORMS) {
      const { errors } = await parseString(SOURCE(p));
      expect(errors, `${p}: fixture has validation errors`).toEqual([]);
    }
  });

  it("no backend spells an extension member in snake_case", async () => {
    const offenders: Record<string, string[]> = {};
    for (const p of PLATFORMS) {
      const out = await joined(p);
      const leaked = SNAKE.filter((s) => out.includes(s));
      if (leaked.length > 0) offenders[p] = [...leaked];
    }
    expect(
      offenders,
      "a declared error's fields reach the RFC 7807 body as extension members — " +
        "snake_case there is a cross-backend wire break, and on elixir it also " +
        "contradicts the OpenAPI schema the same app publishes",
    ).toEqual({});
  });

  it("every backend emits all three members in camelCase", async () => {
    // The positive half: absence of snake_case would also be satisfied by a
    // backend that stopped emitting the members at all.
    for (const p of PLATFORMS) {
      const out = await joined(p);
      for (const c of CAMEL) {
        expect(out, `${p}: extension member ${c} is not emitted anywhere`).toContain(c);
      }
    }
  });

  it("elixir's emitted body agrees with the schema elixir itself publishes", async () => {
    // The intra-backend assertion, stated directly rather than inferred from
    // the two above: the runtime map and the OpenApiSpex schema are built by
    // different emitters and only one of them was ever wire-aware.
    const files = await generateSystemFiles(SOURCE("elixir"));
    const body = [...files.entries()].find(([k]) => k.endsWith("/s.ex"))?.[1];
    const schema = [...files.entries()].find(([k]) =>
      k.includes("schemas/string_or_price_too_low"),
    )?.[1];
    expect(body, "elixir emitted no context module").toBeDefined();
    expect(schema, "elixir emitted no union schema").toBeDefined();
    for (const c of CAMEL) {
      expect(body!, `elixir's runtime error map does not carry ${c}`).toContain(`${c}:`);
      expect(schema!, `elixir's published schema does not carry ${c}`).toContain(c);
    }
  });
});

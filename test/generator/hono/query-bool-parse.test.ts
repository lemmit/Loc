// A `bool` arriving as TEXT — a query-string value or a path segment.
//
// Both tables used `z.coerce.boolean()`, i.e. `Boolean(input)`.  A query value
// is ALWAYS a string, and every non-empty string is truthy, so `?f=false`,
// `?f=0` and `/flag/false` all bound `true`: the find answered with exactly
// the rows the caller asked to exclude, at 200, with no diagnostic anywhere.
// Only an ABSENT key differed.
//
// .NET, FastAPI and Spring all parse `"false"` as false, so this was a
// cross-backend wire divergence as well as a wrong answer.  #2566 fixed the
// same class for BODIES (`BODY_PRIMITIVE`, uncoerced); this is the query/path
// half of the same rule.
//
// The assertions come in two layers, because grepping the emitted string alone
// would not catch a chain that PARSES wrongly: the emitted zod source is
// EXECUTED here against the real `zod` the toolchain has on hand, and the
// published OpenAPI type is pinned too — the cross-backend spec diff compares
// it against four backends that declare a boolean query param as a boolean.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { QUERY_BOOL } from "../../../src/platform/hono/v4/routes-builder.js";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SRC = `
system Shop {
  subdomain Sales {
    context Ordering {
      aggregate Order {
        code: string
        flagged: bool
        operation mark(wanted: bool) { flagged := wanted }
      }
      repository Orders for Order {
        find byFlag(f: bool): Order[] where this.flagged == f
      }
      queryHandler CountFlagged(wanted: bool): int {
        let all = Orders.findAll()
        return all.count()
      }
    }
  }
  api SalesApi from Sales {
    route GET "/orders/flagged/{wanted}" -> Ordering.CountFlagged
  }
  storage pg { type: postgres }
  resource st { for: Ordering, kind: state, use: pg }
  deployable api { platform: node, contexts: [Ordering], dataSources: [st], serves: SalesApi, port: 5001 }
}
`;

async function file(suffix: string): Promise<string> {
  const m = await generateSystemFiles(SRC);
  const key = [...m.keys()].find((k) => k.endsWith(suffix));
  expect(key, `${suffix} not emitted`).toBeDefined();
  return m.get(key!)!;
}

/** Build the schema the emitter WROTE, from its own source text. */
const compiled = new Function("z", `return (${QUERY_BOOL});`)(z) as z.ZodType<unknown>;

describe("the emitted textual-bool schema parses text, never `Boolean(input)`", () => {
  it("accepts exactly the four legal spellings, with the right values", () => {
    expect(compiled.parse("true")).toBe(true);
    expect(compiled.parse("1")).toBe(true);
    // The whole bug: `Boolean("false") === true`.
    expect(compiled.parse("false")).toBe(false);
    expect(compiled.parse("0")).toBe(false);
  });

  it("refuses anything else — no silent truthiness", () => {
    for (const bad of ["yes", "no", "", "TRUE", "2", "on"]) {
      expect(compiled.safeParse(bad).success, `"${bad}" must not parse`).toBe(false);
    }
  });

  it('still publishes `{"type":"boolean"}` — the cross-backend spec diff depends on it', () => {
    // A `z.enum([...]).transform(...)` would have parsed correctly and then
    // published `{"type":"string","enum":[…]}`, diverging from the four other
    // backends.  Both io directions, since the request side is the input one.
    for (const io of ["input", "output"] as const) {
      const schema = z.toJSONSchema(compiled, { io, unrepresentable: "any" }) as {
        type?: string;
      };
      expect(schema.type, `io=${io}`).toBe("boolean");
    }
  });
});

describe("every textual-bool slot uses it — query params and path segments", () => {
  it("a `bool` find parameter is not coerced", async () => {
    const routes = await file("http/order.routes.ts");
    expect(routes).toContain(`f: ${QUERY_BOOL}`);
    expect(routes, "no query/path slot may coerce a bool").not.toContain("z.coerce.boolean()");
  });

  it("a `bool` PATH segment is not coerced either", async () => {
    const router = await file("http/salesApi-routes.ts");
    expect(router).toContain(QUERY_BOOL);
    expect(router).not.toContain("z.coerce.boolean()");
  });

  it("a BODY bool stays the strict, UNCOERCED `z.boolean()` it already was", async () => {
    // The two halves must not converge on the query spelling: JSON carries
    // real booleans, so a body has nothing to parse from text.
    const routes = await file("http/order.routes.ts");
    expect(routes).toMatch(/flagged: z\.boolean\(\)/);
  });
});

// Two schemathesis root causes on the request boundary of the Hono emitter,
// gated structurally (the fuzzer that found them runs nightly).
//
// F1 — hono's zod validator is CONTENT-TYPE GATED: on an absent or foreign
// `Content-Type` it SKIPS validation rather than failing it, so the shared 422
// `defaultHook` never fires and `c.req.valid("json")` hands the handler
// `undefined`, which it then dereferences → 500.  Every body-carrying handler
// must therefore refuse the media type explicitly, with the declared 415.
//
// F7 — the request validators COERCED (`z.coerce.number()` is `Number(input)`),
// so a body field declared `{"type":"number"}` accepted `false` (→ 0) and
// `"12"`, and a `{"format":"date-time"}` field accepted `false` (→ the epoch).
// A JSON body carries real types; only a QUERY (or path) value genuinely
// arrives as a string, so that is the only place the coercion belongs.
//
// Register: docs/audits/schemathesis-findings-2026-08.md (F1, F7).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const SRC = `
system Acme {
  subdomain Sales {
    context S {
      aggregate Order with crudish {
        placedAt: datetime
        qty: int
        note: string
        operation bump(by: int, at: datetime) {
          qty := qty + by
          placedAt := at
        }
      }
      repository Orders for Order {
        find byQty(min: int): Order[]
      }
      workflow reorder {
        create(qty: int) {
          precondition qty > 0
          let order = Order.create({ placedAt: now(), qty: qty, note: "auto" })
        }
      }
    }
  }
  api SalesApi from Sales
  storage primarySql { type: postgres }
  resource sState { for: S, kind: state, use: primarySql }
  deployable api {
    platform: node
    contexts: [S]
    dataSources: [sState]
    serves: SalesApi
    port: 3001
  }
}
`;

/** `http/order.routes.ts` + `http/workflows.ts` from one generation. */
async function routers(): Promise<{ agg: string; workflows: string }> {
  const files = await generateSystemFiles(SRC);
  const pick = (suffix: string): string => {
    const hit = [...files.entries()].find(([p]) => p.endsWith(suffix))?.[1];
    expect(hit, suffix).toBeDefined();
    return hit as string;
  };
  return { agg: pick("http/order.routes.ts"), workflows: pick("http/workflows.ts") };
}

/** The `const <name> = z.object({ … })` block, up to its `.openapi("<name>")`
 *  terminator — slicing on a bare `});` would run past it into the next
 *  schema and make a `not.toContain` assertion meaningless. */
function schemaBlock(src: string, name: string): string {
  const start = src.indexOf(`const ${name} = z.object({`);
  expect(start, `${name} schema`).toBeGreaterThan(-1);
  const end = src.indexOf(`.openapi("${name}")`, start);
  expect(end, `${name} .openapi terminator`).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe("hono request boundary — media-type gate (F1)", () => {
  it("every validated-body read is guarded by requireJsonContentType first", async () => {
    const { agg, workflows } = await routers();
    for (const [name, src] of [
      ["order.routes.ts", agg],
      ["workflows.ts", workflows],
    ] as const) {
      const ls = src.split("\n");
      const bodyReads = ls
        .map((l, i) => [l, i] as const)
        .filter(([l]) => /const body = \w+\.req\.valid\("json"\)/.test(l));
      expect(bodyReads.length, `${name} has no validated-body read to guard`).toBeGreaterThan(0);
      for (const [, i] of bodyReads) {
        // The guard is the line immediately above: it has to run BEFORE the
        // `undefined` body is read, not merely somewhere in the file.
        expect(
          ls[i - 1],
          `${name}:${i + 1} reads the validated body with no media-type guard above it`,
        ).toMatch(/requireJsonContentType\(\w+\);/);
      }
    }
  });

  it("the routers import the guard from ./problem-details", async () => {
    const { agg, workflows } = await routers();
    for (const src of [agg, workflows]) {
      expect(src).toMatch(/import \{[^}]*requireJsonContentType[^}]*\} from "\.\/problem-details"/);
    }
  });

  it("problem-details.ts defines the guard against hono's own json regex", async () => {
    const files = await generateSystemFiles(SRC);
    const pd = [...files.entries()].find(([p]) => p.endsWith("http/problem-details.ts"))?.[1];
    expect(pd, "http/problem-details.ts").toBeDefined();
    // Character-for-character hono's `jsonRegex` (minus two redundant escapes):
    // a wider test would pass a request whose body the validator never saw.
    expect(pd).toContain(
      "const JSON_MEDIA_TYPE = /^application\\/([a-z-.]+\\+)?json(;\\s*[a-zA-Z0-9\\-]+=([^;]+))*$/;",
    );
    expect(pd).toContain("throw new HTTPException(415,");
  });

  it("415 is DECLARED on every body-carrying route, and only those", async () => {
    const { agg, workflows } = await routers();
    // create (POST /orders), the named operation, and the crudish update all
    // carry a body; the workflow command route does too.
    const declared = (src: string): number => (src.match(/^ +415: \{ description:/gm) ?? []).length;
    const bodies = (src: string): number =>
      (src.match(/const body = \w+\.req\.valid\("json"\)/g) ?? []).length;
    expect(bodies(agg), "the fixture must exercise several body routes").toBeGreaterThan(1);
    expect(declared(agg)).toBe(bodies(agg));
    expect(declared(workflows)).toBe(bodies(workflows));
    expect(agg).toContain('415: { description: "Unsupported Media Type"');
    // A read/delete route has no body to refuse — the GET-by-id route block
    // must not have picked one up.
    const getById = agg.slice(agg.indexOf('method: "get"'));
    expect(getById.slice(0, getById.indexOf("app.openapi(") + 1)).not.toContain("415:");
  });
});

describe("hono request boundary — body validators are strict (F7)", () => {
  it("a JSON body field is validated at its declared type, not coerced", async () => {
    const { agg, workflows } = await routers();
    const createSchema = schemaBlock(agg, "CreateOrderRequest");
    expect(createSchema).toContain("qty: z.number().int()");
    expect(createSchema).toContain(
      "placedAt: z.string().datetime({ offset: true, local: true }).transform((s: string) => new Date(s))",
    );
    expect(createSchema, "a create body must not coerce").not.toContain("z.coerce.");
    // The operation schema: `bump(by: int, at: datetime)`.
    const bumpSchema = schemaBlock(agg, "BumpOrderRequest");
    expect(bumpSchema).toContain("by: z.number().int()");
    expect(bumpSchema).toContain("at: z.string().datetime({ offset: true, local: true })");
    expect(bumpSchema, "an operation body must not coerce").not.toContain("z.coerce.");
    // The workflow command body is a JSON body too.
    expect(schemaBlock(workflows, "ReorderRequest")).toContain("qty: z.number().int()");
  });

  it("a QUERY parameter keeps its coercion — the value really is a string there", async () => {
    const { agg } = await routers();
    expect(schemaBlock(agg, "ByQtyQuery")).toContain("min: z.coerce.number().int()");
    // And a path id stays the uuid-format string it already was.
    expect(agg).toContain("z.object({ id: z.string().uuid() })");
  });
});

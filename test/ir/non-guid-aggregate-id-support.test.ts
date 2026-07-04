// Non-guid aggregate id capability validator
// (docs/plans/non-guid-id-http-params.md).  The grammar admits
// `aggregate X ids int|long|string`, but only the .NET / Java / Elixir backends
// emit it end-to-end (PK column type, id value class, wire DTO id field, and
// `/{id}` path-param schema all follow `idValueType`).  Hono (`node`) and
// Python (`fastapi`) still hardcode a guid/uuid assumption, so a non-guid id
// there mis-emits a broken app (a randomUUID minted into an integer column, a
// `/tickets/42` that 422s).  The check turns that silent footgun into a hard
// error instead of emitting the broken app.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

async function idErrors(source: string): Promise<string[]> {
  const { model } = await parseString(source, { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model)))
    .filter((d) => d.severity === "error" && d.code === "loom.non-guid-aggregate-id-unsupported")
    .map((d) => d.message);
}

function sys(platform: string, ids: string): string {
  const idsMod = ids ? ` ids ${ids}` : "";
  return `
system Shop {
  subdomain Sales {
    context Shop {
      aggregate Ticket${idsMod} { subject: string }
      repository Tickets for Ticket { }
    }
  }
  api A from Sales
  storage pg { type: postgres }
  resource shopState { for: Shop, kind: state, use: pg }
  deployable api { platform: ${platform}, contexts: [Shop], serves: A, dataSources: [shopState], port: 4000 }
}
`;
}

describe("non-guid aggregate id capability validation", () => {
  it("accepts a non-guid id on the backends that emit it end-to-end", async () => {
    expect(await idErrors(sys("dotnet", "int"))).toEqual([]);
    expect(await idErrors(sys("java", "long"))).toEqual([]);
    expect(await idErrors(sys("elixir", "string"))).toEqual([]);
  });

  it("accepts a guid id (the default) on every backend", async () => {
    expect(await idErrors(sys("node", "guid"))).toEqual([]);
    expect(await idErrors(sys("python", "guid"))).toEqual([]);
    expect(await idErrors(sys("node", ""))).toEqual([]); // no `ids` clause ⇒ guid
  });

  it("rejects `ids int` on a Hono (node) deployable", async () => {
    const errs = await idErrors(sys("node", "int"));
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("platform node");
    expect(errs[0]).toContain("`ids int`");
    expect(errs[0]).toContain("only emits guid aggregate ids");
  });

  it("rejects `ids string` on a Python (fastapi) deployable", async () => {
    const errs = await idErrors(sys("python", "string"));
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("platform python");
    expect(errs[0]).toContain("`ids string`");
  });
});

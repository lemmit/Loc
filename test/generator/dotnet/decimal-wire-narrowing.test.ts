// .NET — a declared `decimal` narrows to its wire `double` CORRECTLY ROUNDED
// (F10 / M-T6.47, the continuation of #2631).
//
// #2563/RS-24 retyped .NET wire `decimal` RESPONSE fields to `double`, because
// the other four backends carry the JSON number through an IEEE-754 double.
// The narrowing itself was a C# `(double)d` cast — and that cast is NOT
// correctly rounded.  `DecCalc.VarR8FromDec` computes `(double)mantissa /
// 10^scale`; once the mantissa exceeds 2^53 (every value whose shortest
// round-trip repr needs 17 significant digits) the NUMERATOR is rounded to a
// double first and the quotient is rounded again — a double rounding, so the
// answer need not be the nearest double to the stored decimal.  MEASURED on
// .NET 10.0.11 over 3M random doubles in [0,100), written out as the digits a
// Postgres `numeric` column holds: 9.2% (275,923 of 3,000,000) fail to
// round-trip through the cast
// (`99.52989333734583` returns as `99.52989333734584`); zero fail through
// `double.Parse`.
//
// #2631 fixed ONE of the three hops — the dapper aggregate — at the provider
// seam, by casting to `double precision` in the SQL so Npgsql hands back a real
// `float8`.  That fix is not available at the other two:
//
//   - PER-ROW (`projectToResponse`): the DOMAIN property must stay
//     `System.Decimal` for domain arithmetic, so nothing can be narrowed at the
//     provider seam; the narrowing belongs at the wire boundary, once.
//   - EF AGGREGATE (`csCoerce`): forcing the cast into the LINQ `GroupBy` either
//     fails to translate or moves the ACCUMULATION into float8 — the divergence
//     #2631 explicitly rejected.
//
// So both go through `csDecimalToWireDouble`: `decimal.ToString` is exact (a
// base-10 type carries no hidden precision) and `double.Parse` is correctly
// rounded on the generated `net10.0` TFM, so the pair yields the nearest double
// to the stored value — the same number node reads out of the same column.
//
// This suite pins the per-row arm and the "no untranslatable LINQ" property.
// The EF aggregate arm is pinned in
// `test/generator/projection-aggregation-backends.test.ts`; that dapper stays
// on its SQL cast and grows NO Parse (a second conversion on an already-`double`
// value) is pinned in `dapper-query-projection-emission.test.ts`.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

/** The correctly-rounded narrowing, as `csDecimalToWireDouble` renders it. */
const parse = (expr: string) =>
  `double.Parse(${expr}.ToString(System.Globalization.CultureInfo.InvariantCulture), ` +
  `System.Globalization.CultureInfo.InvariantCulture)`;

// One aggregate carrying every shape the per-row funnel can see a decimal in:
// a plain field, an OPTIONAL field (the null-guarding ternary), and a field
// nested inside a value object — plus the two neighbours that must NOT move,
// `money` (a fixed-scale string, RS-12) and `int`.
const SOURCE = (persistence: string) => `system Shop {
  subdomain Sales {
    context Orders {
      valueobject Reading { celsius: decimal  label: string }
      aggregate Sample {
        code: string
        price: decimal
        rate: decimal?
        fee: money
        count: int
        reading: Reading
      }
      repository Samples for Sample { }
      projection PriceStats {
        avgPrice: decimal
        orders: int
        from Sample as o
        select avgPrice = avg(o.price), orders = count()
      }
    }
  }
  api SalesApi from Sales
  storage pg { type: postgres }
  resource ordersState { for: Orders, kind: state, use: pg }
  deployable api {
    platform: dotnet { persistence: ${persistence} }
    contexts: [Orders]
    dataSources: [ordersState]
    serves: SalesApi
    port: 8080
  }
}`;

async function csFiles(persistence: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const [path, content] of await generateSystemFiles(SOURCE(persistence)))
    if (path.endsWith(".cs")) out.set(path, content);
  return out;
}

describe("the per-row response funnel narrows decimal correctly", () => {
  it("a plain `decimal` field parses through its exact decimal digits, not a `(double)` cast", async () => {
    const all = (await csFiles("efcore")).get(
      "api/Application/Samples/Queries/GetSampleByIdHandler.cs",
    )!;
    expect(all).toContain(parse("found.Price"));
    // The defect, stated so a regression reads as itself: the CLR cast is a
    // double rounding and disagrees with node on ~9% of stored doubles.
    expect(all, "the raw CLR decimal->double cast is not correctly rounded").not.toContain(
      "(double)found.Price",
    );
  });

  it("an OPTIONAL `decimal` keeps its null guard and narrows the unwrapped value", async () => {
    const all = (await csFiles("efcore")).get(
      "api/Application/Samples/Queries/GetSampleByIdHandler.cs",
    )!;
    expect(all).toContain(`(found.Rate is null ? null : ${parse("found.Rate.Value")})`);
  });

  it("a `decimal` nested in a VALUE OBJECT narrows through the same helper", async () => {
    // The recursion is the point: the VO's own Response is built by the same
    // `projectToResponse`, so a per-primitive fix reaches every nesting depth.
    // (`test/fixtures/baseline-output/.../AllHandler.cs` shows the live shape on
    // a `Money` VO.)
    const all = (await csFiles("efcore")).get("api/Application/Samples/Queries/AllHandler.cs")!;
    expect(all).toContain(`new ReadingResponse(${parse("d.Reading.Celsius")}, d.Reading.Label)`);
  });

  it("leaves `money` and `int` exactly as they were", async () => {
    const all = (await csFiles("efcore")).get("api/Application/Samples/Queries/AllHandler.cs")!;
    // money is a FIXED-scale wire STRING (RS-12) — never a JSON number, so it
    // never narrows.  Parsing it into a double is precisely the bug.
    expect(all).toContain(
      'd.Fee.ToString("F4", System.Globalization.CultureInfo.InvariantCulture)',
    );
    expect(all).not.toContain("double.Parse(d.Fee");
    // `int` crosses as itself.
    expect(all).toContain("d.Count,");
    expect(all).not.toContain("double.Parse(d.Count");
  });

  it("does NOT touch the request direction — a request `decimal` stays a decimal", async () => {
    // `wireType` keeps `decimal` on REQUESTS by design; that direction has no
    // double hop to correct (it would be the documented 15-digit round).
    const req = (await csFiles("efcore")).get("api/Application/Samples/Requests/SampleRequests.cs");
    expect(req, "the request DTO file is emitted").toBeDefined();
    expect(req!).toContain("decimal Celsius");
    expect(req!).not.toContain("double.Parse");
  });
});

describe("no emitted `double.Parse` can reach an EF expression tree", () => {
  // The one way this change could break a RUNNING app rather than a compiling
  // one: `double.Parse` has no SQL translation, so an occurrence inside an
  // un-materialised `IQueryable` chain would throw at request time and no
  // compile gate would see it.  Both call sites are believed to run after
  // materialisation (`projectToResponse` maps already-loaded domain objects;
  // `csCoerce` runs on the result of `FirstOrDefaultAsync`/`ToListAsync`) — this
  // verifies it over the whole emitted C# surface instead of asserting it.
  const QUERYABLE_ROOTS = ["_db.", "AsNoTracking()", "IQueryable"];

  it("every emitted Parse sits in a statement with no live IQueryable in it", async () => {
    for (const persistence of ["efcore", "dapper"]) {
      const files = await csFiles(persistence);
      let seen = 0;
      for (const [path, content] of files) {
        // C# statement granularity is enough: an EF chain and its
        // materialisation are one statement, and the projection that follows is
        // the next one.
        for (const stmt of content.split(";")) {
          if (!stmt.includes("double.Parse(")) continue;
          seen++;
          for (const root of QUERYABLE_ROOTS)
            expect(
              stmt.includes(root),
              `${path} (${persistence}): a double.Parse shares a statement with '${root}' — ` +
                `it would have to translate to SQL`,
            ).toBe(false);
        }
      }
      expect(seen, `${persistence}: the scan actually reached emitted Parse sites`).toBeGreaterThan(
        0,
      );
    }
  });

  it("every file that emits a Parse also materialises first", async () => {
    const BOUNDARIES = [
      "ToListAsync(",
      "FirstOrDefaultAsync(",
      "QuerySingleAsync<",
      "QueryAsync<",
      "await _repo.",
    ];
    for (const persistence of ["efcore", "dapper"]) {
      for (const [path, content] of await csFiles(persistence)) {
        if (!content.includes("double.Parse(")) continue;
        const at = Math.min(
          ...BOUNDARIES.map((b) => content.indexOf(b))
            .filter((i) => i >= 0)
            .concat(Number.MAX_SAFE_INTEGER),
        );
        expect(
          at,
          `${path} (${persistence}): emits double.Parse with no materialisation boundary in the file`,
        ).toBeLessThan(content.indexOf("double.Parse("));
      }
    }
  });
});

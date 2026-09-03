// A value-object field on a CONTAINMENT PART must have its columns NAMED to
// the migration's snake convention — exactly as an aggregate-root VO field does.
//
// The aggregate-root path has always threaded the system's `valueObjects` into
// `fieldConfigLines`, which emits
//
//     builder.OwnsOne<Money>(x => x.Price, o => {
//         o.Property(x => x.Amount).HasColumnName("price_amount");
//         o.Property(x => x.Currency).HasColumnName("price_currency");
//     });
//
// `containmentConfigLines` did NOT. Its part fields went through the same
// function with `voLookup` undefined, so a part's VO field fell to the unnamed
// fallback arm — `o.OwnsOne<Money>(x => x.UnitPrice);` — and EF applied its
// DEFAULT owned-type naming, `UnitPrice_Amount` / `UnitPrice_Currency`, while
// the migration had created `unit_price_amount` / `unit_price_currency`.
//
// ── Why this was invisible to every compile gate ───────────────────────────
// The C# compiles. The app BOOTS (EF validates the model, not the database).
// It fails on the first query that touches the part:
//
//     Npgsql.PostgresException: column o0.UnitPrice_Amount does not exist
//     GET /api/orders  →  500
//
// So the ENTIRE `Order` route family 500s on .NET — list, detail, and destroy
// (which loads before deleting) — while `Product` and `Wallet`, whose Money
// sits on the aggregate root, are fine. That asymmetry is the signature.
// Schemathesis reported it as six findings (three routes × `not_a_server_error`
// + `status_code_conformance`), unwaived, on every nightly.
//
// ── Verified on a booted stack, not just the emitted string ────────────────
// storefront-system + postgres + `dotnet run`, the same fixture the leg uses:
//
//                                          before   after
//   GET    /api/orders                       500     200
//   GET    /api/orders/{id}                  500     404   (absent id)
//   DELETE /api/orders/{id}                  500     404
//   GET    /api/{products,customers,wallets} 200     200    ← root VOs, unaffected
//
// and a full round-trip: `POST /api/orders/{id}/add_line` with a `unitPrice`
// (204) then reading the order back returns
// `"unitPrice":{"amount":9.99,"currency":"USD"}` — the column is genuinely
// written and read, which an empty list would not have proved.
//
// Reverting the emitter reproduces `column o0.UnitPrice_Amount does not exist`
// verbatim.

import { describe, expect, it } from "vitest";
import { generateDotnet, generateSystemFiles } from "../../_helpers/generate.js";
import { parseValid } from "../../_helpers/parse.js";

const SRC = `
  context Shop {
    valueobject Money { amount: decimal  currency: string }
    aggregate Order {
      code: string
      price: Money
      contains lines: OrderLine[]
      entity OrderLine { productCode: string  unitPrice: Money }
    }
    repository Orders for Order { }
  }
`;

/** The same model as a full system — `generate system` is what derives the
 *  migration DDL the config has to agree with. */
const SYSTEM = `
system Shop {
  subdomain D {
    ${SRC}
  }
  api A from D
  storage pg { type: postgres }
  resource shopState { for: Shop, kind: state, use: pg }
  deployable d { platform: dotnet, contexts: [Shop], dataSources: [shopState], serves: A, port: 4000 }
}
`;

async function orderConfig(): Promise<string> {
  const model = await parseValid(SRC);
  const cfg = generateDotnet(model).get(
    "Infrastructure/Persistence/Configurations/OrderConfiguration.cs",
  );
  expect(cfg, "OrderConfiguration.cs not emitted").toBeDefined();
  return cfg as string;
}

/** Just the `OwnsMany<OrderLine>` block — the part's own configuration. The
 *  aggregate root configures a `Money` too, so a whole-file assertion cannot
 *  tell which of the two emitted a given line. */
function partBlock(cfg: string): string {
  const start = cfg.indexOf('builder.OwnsMany<OrderLine>("_lines"');
  expect(start, "the part is not configured at all").toBeGreaterThan(-1);
  return cfg.slice(start);
}

describe("dotnet — a value object on a containment part names its columns", () => {
  it("the part's Money maps to the migration's snake_case columns", async () => {
    const part = partBlock(await orderConfig());
    expect(part).toContain("o.OwnsOne<Money>(x => x.UnitPrice, o => {");
    expect(part).toContain('o.Property(x => x.Amount).HasColumnName("unit_price_amount");');
    expect(part).toContain('o.Property(x => x.Currency).HasColumnName("unit_price_currency");');
  });

  it("the unnamed fallback is not emitted for the part", async () => {
    const part = partBlock(await orderConfig());
    // The exact broken output. With no column names EF defaults to
    // `UnitPrice_Amount`, which no migration ever creates.
    expect(part).not.toContain("o.OwnsOne<Money>(x => x.UnitPrice);");
  });

  it("the column names match what the migration actually creates", async () => {
    // The two halves have to agree, and asserting the emitted DDL here is what
    // makes this a CONTRACT rather than two independent guesses about casing.
    // Migrations are derived in phase ⑨ (`buildMigrations`), so this half needs
    // the SYSTEM pipeline — `generateDotnet` alone emits no DDL to compare against.
    const files = await generateSystemFiles(SYSTEM);
    const migration = [...files].find(([p]) => p.includes("Migrations/"))?.[1];
    expect(migration, "no migration emitted").toBeDefined();
    expect(migration as string).toContain("unit_price_amount");
    expect(migration as string).toContain("unit_price_currency");
    // …and never EF's default spelling, which is what the config used to ask for.
    expect(migration as string).not.toContain("UnitPrice_Amount");

    // Same run, both halves: the EF config in THIS system emission asks for the
    // very columns the migration above creates.
    const cfg = [...files].find(([p]) => p.endsWith("Configurations/OrderConfiguration.cs"))?.[1];
    expect(cfg, "no OrderConfiguration.cs in the system emission").toBeDefined();
    expect(partBlock(cfg as string)).toContain(
      'o.Property(x => x.Amount).HasColumnName("unit_price_amount");',
    );
  });

  it("the aggregate ROOT's own value object still maps as before", async () => {
    // Narrowness guard: the root path was already correct and must not move.
    const cfg = await orderConfig();
    expect(cfg).toContain("builder.OwnsOne<Money>(x => x.Price, o => {");
    expect(cfg).toContain('o.Property(x => x.Amount).HasColumnName("price_amount");');
  });
});

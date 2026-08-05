import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// vanilla Phoenix — the WIRE-FORM boundary of a named operation and a declared
// find.  Three separate 500s / silent-wrong-answers, one cause: elixir handed
// the domain a value straight off the wire, in the wire's own form, where every
// other backend deserializes into a TYPED DTO first (zod / pydantic / jackson /
// System.Text.Json).
//
// All three were invisible until the caller census (#2380) gave the routes their
// first runtime callers:
//
//   1. OP PARAM.  `Map.get(params, "amount")` for a `money` param is the raw
//      JSON value; the body `force_change`s it, and `force_change` bypasses
//      casting — `** (Ecto.ChangeError) value "7.25" ... does not match type
//      :decimal`, a 500.  (`corpus/embedded`'s `retotal`.)
//   2. `now()` INTO A datetime COLUMN.  `DateTime.utc_now()` carries
//      microseconds and the column is `:utc_datetime` (second precision), so
//      the same `force_change` path yields `** (ArgumentError) :utc_datetime
//      expects microseconds to be empty`.  `stamp-emit` (B7), `audit-emit` and
//      `provenance-emit` already truncate their own writes — the OPERATION
//      assignment arm never reached the rule.  (`corpus/scaffold-macros`'
//      `softDelete`.)
//   3. FIND PARAM.  Phoenix delivers query params as STRINGS.  On the
//      relational path Ecto casts them against the schema, so it never showed;
//      an in-memory filter (`shape: document`) compares directly, and Erlang's
//      term order makes `6 >= "6"` false — the find silently answers `[]` for
//      every row.  The emitter already knew this for paging (`page_param/3`);
//      the find's own params were the arm that did not.  (`corpus/document`'s
//      `popular`.)
// ---------------------------------------------------------------------------

const SOURCE = `
system Shop {
  subdomain Sales {
    context Catalog {
      aggregate Item with crudish, softDeletable, softDelete {
        name: string
        price: money
        viewCount: int
        operation reprice(amount: money) { price := amount }
        operation rename(to: string) { name := to }
      }
      repository Items for Item {
        find popular(min: int): Item[] where this.viewCount >= min
        find named(label: string): Item[] where this.name == label
      }
    }
  }
  api CatalogApi from Sales
  storage pg { type: postgres }
  resource s { for: Catalog, kind: state, use: pg }
  deployable d { platform: elixir, contexts: [Catalog], dataSources: [s], port: 4000 }
}
`;

const fileEndingWith = async (suffix: string): Promise<string> => {
  const files = await generateSystemFiles(SOURCE);
  const hit = [...files.entries()].find(([p]) => p.endsWith(suffix));
  expect(hit, `no generated file ending ${suffix}`).toBeDefined();
  return hit![1];
};

describe("vanilla Phoenix — operation params are coerced to their declared type", () => {
  it("a `money` param becomes a Decimal; a `string` param binds bare", async () => {
    const ctxMod = await fileEndingWith("catalog.ex");

    // Premise: both operations exist, so a failure below is about the BINDING.
    expect(ctxMod).toContain("def reprice_item(%D.Catalog.Item{} = record, params)");
    expect(ctxMod).toContain("def rename_item(%D.Catalog.Item{} = record, params)");

    // The money param is coerced — `to_string` first so a JSON number and a JSON
    // string both land on the same Decimal.
    expect(ctxMod).toContain(
      'amount = (if is_nil(Map.get(params, "amount")), do: nil, else: Decimal.new(to_string(Map.get(params, "amount"))))',
    );
    // The string param is NOT — a coercion there would be gratuitous output
    // churn, and is what a fix that stringified everything would produce.
    expect(ctxMod).toContain('to = Map.get(params, "to")');
    expect(ctxMod).not.toContain('Decimal.new(to_string(Map.get(params, "to")))');
  });

  it("a datetime column assigned by an operation is truncated to :second", async () => {
    const ctxMod = await fileEndingWith("catalog.ex");
    // `softDelete()` assigns `deletedAt := now()`.
    expect(ctxMod).toContain("def soft_delete_item(%D.Catalog.Item{} = record, params)");
    expect(ctxMod).toContain(
      "Ecto.Changeset.force_change(:deleted_at, __truncate_dt(record.deleted_at))",
    );
    // …through the shared helper, emitted once.
    expect(ctxMod).toContain(
      "defp __truncate_dt(%DateTime{} = dt), do: DateTime.truncate(dt, :second)",
    );
    // A NON-datetime column on the same persist pipeline is untouched — the
    // scope guard against truncating everything.
    expect(ctxMod).toContain("Ecto.Changeset.force_change(:is_deleted, record.is_deleted)");
  });
});

describe("vanilla Phoenix — find query params are coerced to their declared type", () => {
  it("an `int` find param parses; a `string` find param binds bare", async () => {
    const ctrl = await fileEndingWith("item_controller.ex");

    // Premise: both finds are routed.
    expect(ctrl).toContain("def popular(conn, params)");
    expect(ctrl).toContain("def named(conn, params)");

    expect(ctrl).toContain('Catalog.popular_item(__find_int(params["min"]))');
    expect(ctrl).toContain("defp __find_int(v) when is_integer(v), do: v");
    // The string param keeps the bare read.
    expect(ctrl).toContain('Catalog.named_item(params["label"])');
    expect(ctrl).not.toContain('__find_int(params["label"])');
  });

  it("emits no coercion helper a controller does not use", async () => {
    // The helpers are gated on need so a string-only controller stays
    // byte-identical and no unused private fn trips
    // `mix compile --warnings-as-errors`.
    const ctrl = await fileEndingWith("item_controller.ex");
    expect(ctrl).not.toContain("__find_decimal");
    expect(ctrl).not.toContain("__find_bool");
  });
});

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// Vanilla (plain Ecto) derived-read inlining in operation bodies (#1765).
//
// A `derived` property is COMPUTED — it is NOT a stored Ecto column.  The OO
// backends (TS/.NET/Python/Java) render a `this-derived` read as a computed
// class-member accessor (`get doubled()`), which resolves at runtime.  Elixir
// structs carry no computed field, so `record.doubled` reads a NON-EXISTENT
// struct key → runtime `KeyError` → 500 the moment a domain body touches a
// derived.  The fix inlines the derived's DEFINING expression (parity with the
// wire serializer, which renders the same `DerivedIR.expr` off `record`), so an
// executable op body reads the underlying columns, never the phantom key.
//
// This only became end-to-end observable once #1796 (force_change) landed — a
// derived-reading op that never persisted couldn't be caught by a round-trip.
// ---------------------------------------------------------------------------

const SRC = `
system Shop {
  subdomain Sales {
    context Shop {
      aggregate Cart shape(relational) with crudish {
        total: int
        derived doubled: int = total * 2
        derived quad: int = doubled * 2
        operation snap() { total := doubled }
        operation snapQuad() { total := quad }
      }
      repository Carts for Cart { }
    }
  }
  api ShopApi from Sales
  storage pg { type: postgres }
  resource shopState { for: Shop, kind: state, use: pg }
  deployable api { platform: elixir, contexts: [Shop], dataSources: [shopState], serves: ShopApi, port: 4000 }
}
`;

function facadeOf(files: Map<string, string>): string {
  const key = [...files.keys()].find((k) => k.endsWith("/shop.ex"));
  expect(key, "context facade not emitted").toBeDefined();
  return files.get(key!)!;
}

describe("vanilla op body — derived read inlining", () => {
  it("inlines a `this-derived` read as its defining expression, not a phantom struct key", async () => {
    const facade = facadeOf(await generateSystemFiles(SRC));
    const snap = facade.slice(
      facade.indexOf("def snap_cart("),
      facade.indexOf("def snap_quad_cart("),
    );
    // `total := doubled` renders `doubled`'s expression (`total * 2`) off the
    // struct column, NOT `record.doubled` (a non-existent key → KeyError).
    expect(snap).toContain("record = %{record | total: (record.total * 2)}");
    expect(snap).not.toContain("record.doubled");
  });

  it("recurses through a derived-of-derived (guarded against cycles)", async () => {
    const facade = facadeOf(await generateSystemFiles(SRC));
    const snapQuad = facade.slice(facade.indexOf("def snap_quad_cart("));
    // `quad = doubled * 2`, `doubled = total * 2` → both inline down to the column.
    expect(snapQuad).toContain("record = %{record | total: ((record.total * 2) * 2)}");
    expect(snapQuad).not.toContain("record.quad");
    expect(snapQuad).not.toContain("record.doubled");
  });
});

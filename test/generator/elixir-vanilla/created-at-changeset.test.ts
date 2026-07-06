import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// A PLAIN declared `createdAt` field is a normal client-supplied column — it
// must be cast + validated + persisted like any other, exactly as every other
// backend does.  The vanilla emitter historically excluded any field NAMED
// `createdAt`/`updatedAt` from the changeset cast (treating it as an
// audit-managed timestamp).  For a plain field the migration still emitted the
// column `NOT NULL`, so an insert left `created_at` unpopulated →
// `23502 not_null_violation` (Postgrex.Error 500 on create).
//
// The exclusion now fires ONLY when the field is genuinely server-managed —
// a `stamp onCreate { createdAt := now() }` target or `access: managed`.
// ---------------------------------------------------------------------------

function csFor(files: Map<string, string>, snakeAgg: string): string {
  const key = [...files.keys()].find((k) => k.endsWith(`/${snakeAgg}_changeset.ex`));
  expect(key, `changeset for ${snakeAgg}`).toBeDefined();
  return files.get(key!)!;
}

describe("vanilla — plain declared createdAt is cast (not silently dropped)", () => {
  it("a plain `createdAt: datetime` field lands in @all_fields/@required_fields", async () => {
    const source = `
system Shop {
  subdomain Sales {
    context Orders {
      aggregate Order with crudish {
        label: string
        createdAt: datetime
      }
      repository Orders for Order { }
    }
  }
  api OrdersApi from Sales
  storage primary { type: postgres }
  resource ordersState { for: Orders, kind: state, use: primary }
  deployable api {
    platform: elixir
    contexts: [Orders]
    dataSources: [ordersState]
    serves: OrdersApi
    port: 4000
  }
}
`;
    const files = await generateSystemFiles(source);
    const cs = csFor(files, "order");
    expect(cs).toContain("@all_fields [:label, :created_at]");
    expect(cs).toContain("@required_fields [:label, :created_at]");
    expect(cs).toContain("|> cast(attrs, @all_fields)");
  });

  it("a stamp-managed createdAt stays OUT of the cast (lifecycle owns it)", async () => {
    const source = `
system Shop {
  subdomain Sales {
    context Orders {
      aggregate Order with crudish {
        label: string
        createdAt: datetime
        stamp onCreate { createdAt := now() }
      }
      repository Orders for Order { }
    }
  }
  api OrdersApi from Sales
  storage primary { type: postgres }
  resource ordersState { for: Orders, kind: state, use: primary }
  deployable api {
    platform: elixir
    contexts: [Orders]
    dataSources: [ordersState]
    serves: OrdersApi
    port: 4000
  }
}
`;
    const files = await generateSystemFiles(source);
    const cs = csFor(files, "order");
    // Excluded from the cast allow-list…
    expect(cs).toContain("@all_fields [:label]");
    expect(cs).not.toMatch(/@all_fields \[[^\]]*:created_at/);
    expect(cs).not.toMatch(/@required_fields \[[^\]]*:created_at/);
    // …and from every per-action cast: a stamp target is server-owned, so
    // it is never client input on create OR update (S1(b) — the crudish
    // update op excludes stamp targets from its params).  The changeset
    // module therefore never touches the column at all…
    expect(cs).not.toContain(":created_at");
    // …because the lifecycle stamp writes it at persist time instead.
    const repoKey = [...files.keys()].find((k) => k.endsWith("/order_repository.ex"));
    expect(repoKey, "order repository").toBeDefined();
    expect(files.get(repoKey!)!).toContain("put_change(:created_at");
  });
});

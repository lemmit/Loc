import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// Vanilla (plain Ecto) named-operation persistence regression.
//
// A scalar operation body rebinds `record = %{record | field: newval}` BEFORE
// the persist changeset is built, so the changeset's DATA already carries the
// new value.  `Ecto.Changeset.put_change/3` DROPS a change whose value equals
// the data (`Ecto.Type.equal?`), leaving an EMPTY changeset — `Repo.update`
// then runs NO SQL and the operation's write is silently lost (compile-green,
// boot-red: the op returns `{:ok, record}` but the row never changes).  The
// persist tail therefore uses `force_change/3`, which stores the change
// regardless, so the assigned column actually persists.  Boot-verified:
// `inc()` twice on `total: 5` → GET `total: 7` (an UPDATE runs); with the old
// `put_change` it stayed `5` (no UPDATE at all).
// ---------------------------------------------------------------------------

const SRC = `
system Shop {
  subdomain Sales {
    context Shop {
      aggregate Cart shape: relational with crudish {
        total: int
        operation inc() { total := total + 1 }
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

function file(files: Map<string, string>, suffix: string): string {
  const key = [...files.keys()].find((k) => k.endsWith(suffix));
  expect(key, `${suffix} not emitted`).toBeDefined();
  return files.get(key!)!;
}

describe("vanilla named-op persistence (force_change)", () => {
  it("persists an assigned scalar column via force_change, not the change-dropping put_change", async () => {
    const facade = file(await generateSystemFiles(SRC), "/shop.ex");
    const inc = facade.slice(facade.indexOf("def inc_cart("));
    // The body rebinds record to the new value…
    expect(inc).toContain("record = %{record | total: record.total + 1}");
    // …so the persist MUST force the change (put_change would drop it as a no-op
    // vs the already-mutated changeset data → empty changeset → no UPDATE).
    expect(inc).toContain("|> Ecto.Changeset.force_change(:total, record.total)");
    expect(inc).not.toContain("|> Ecto.Changeset.put_change(:total, record.total)");
    expect(inc).toContain("|> Api.Shop.CartRepository.persist_change()");
  });
});

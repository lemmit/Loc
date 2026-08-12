import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// M-T6.27 — the NAMED-OPERATION write path carries the optimistic lock.
//
// Before this, a `versioned` aggregate CAS-guarded the generic `PUT` seam
// (`update_changeset` → `optimistic_lock(:version)` → `Ecto.StaleEntryError`
// rescued to `{:error, :conflict}` → 409) and NOT its own operation route:
// the op path did a plain `change(%{version: … + 1})` through
// `persist_change/1` (a bare `Repo.update`), so two writers racing
// `POST /orders/{id}/cancel` both landed — a silent lost update on elixir
// where the other four backends answer 409.  Same aggregate, two answers.
//
// The honest gate for this class is a two-writer behavioural case (fetch,
// fire two ops, assert exactly one 409) — the behavioural tier drives one
// client serially today, so per the mission text these static per-path
// assertions are the stand-in, plus `mix compile --warnings-as-errors` for
// the emitted shapes.
// ---------------------------------------------------------------------------

const SRC = `
system RU {
  subdomain D {
    context Shop {
      error NotFound { resource: string }
      aggregate Order {
        code: string
        reserved: bool
        operation accept(): string or NotFound { reserved := true  return code }
        operation touch() { reserved := false }
      }
      repository Orders for Order { }
    }
  }
  api A from D
  storage pg { type: postgres }
  resource s { for: Shop, kind: state, use: pg }
  deployable d { platform: elixir, contexts: [Shop], dataSources: [s], port: 4000 }
}
`;

const get = (files: Map<string, string>, tail: string): string => {
  const hit = [...files.entries()].find(([p]) => p.endsWith(tail));
  expect(hit, `no file ending ${tail}`).toBeDefined();
  return hit![1];
};

describe("M-T6.27 — elixir named-operation optimistic lock", () => {
  it("the op persist pipes through optimistic_lock and never a plain bump", async () => {
    const ctx = get(await generateSystemFiles(SRC), "lib/d/shop.ex");
    const touch = ctx.slice(ctx.indexOf("def touch_order(%"));
    const touchBody = touch.slice(0, touch.indexOf("\n  end"));
    expect(touchBody).toContain("|> Ecto.Changeset.optimistic_lock(:version)");
    expect(touchBody).not.toContain("version + 1");
  });

  it("persist_change rescues the stale write to {:error, :conflict} and says so in its spec", async () => {
    const repo = get(await generateSystemFiles(SRC), "lib/d/shop/order_repository.ex");
    const persist = repo.slice(repo.indexOf("def persist_change("));
    const persistFn = persist.slice(0, persist.indexOf("\n  end") + 6);
    expect(persistFn).toContain("rescue");
    expect(persistFn).toContain("Ecto.StaleEntryError -> {:error, :conflict}");
    expect(repo).toContain(
      "@spec persist_change(Ecto.Changeset.t()) ::\n          {:ok, D.Shop.Order.t()} | {:error, Ecto.Changeset.t() | :conflict}",
    );
  });

  it("the op controller action maps {:error, :conflict} to the 409 responder", async () => {
    const controller = get(await generateSystemFiles(SRC), "order_controller.ex");
    const touch = controller.slice(controller.indexOf("def touch(conn"));
    const action = touch.slice(0, touch.indexOf("\n  end"));
    expect(action).toContain("{:error, :conflict} ->");
    expect(action).toContain("ProblemDetails.conflict_response(conn)");
  });

  it("a RETURNING op's result mapper carries the :conflict → 409 clause", async () => {
    const controller = get(await generateSystemFiles(SRC), "order_controller.ex");
    expect(controller).toContain(
      "def accept_order_result(conn, {:error, :conflict}),\n    do: ProblemDetails.conflict_response(conn)",
    );
  });
});

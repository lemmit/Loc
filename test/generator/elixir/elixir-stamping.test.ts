// ---------------------------------------------------------------------------
// Elixir / Phoenix (vanilla Ecto) backend — lifecycle stamps (`stamp onCreate`/
// `onUpdate`, the audit / softDelete capability stamps).  `contextStamps` become
// `Ecto.Changeset.put_change` pipe lines on the changeset right before
// `Repo.insert` / `Repo.update`.  A non-principal value renders directly
// (`now()` → `DateTime.utc_now()`); a bare `currentUser` value resolves to the
// principal id read off the threaded actor map (`current_user.<idKey>`, nil-safe).
// Two cases stay fail-fast (loom.elixir-stamp-unsupported): a principal stamp on
// a deployable WITHOUT auth, and stamps on an event-sourced aggregate.  Mirrors
// test/generator/java/generator-java-stamps.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { validateLoomModel } from "../../../src/ir/validate/validate.js";
import { generateSystemFiles } from "../../_helpers/generate.js";
import { buildLoomModel } from "../../_helpers/ir.js";

// Non-principal stamps (now()), on a vanilla elixir deployable.
const NON_PRINCIPAL = `system ST {
  subdomain D {
    context Shop {
      stamp onCreate { createdAt := now() }
      stamp onUpdate { updatedAt := now() }
      aggregate Order with crudish {
        code: string
        createdAt: datetime
        updatedAt: datetime
      }
      repository Orders for Order { }
    }
  }
  api A from D
  storage primary { type: postgres }
  resource st { for: Shop, kind: state, use: primary }
  deployable api1 { platform: elixir, contexts: [Shop], dataSources: [st], serves: A, port: 8081 }
}`;

// Principal stamps (`with auditable` → createdBy/updatedBy := currentUser) on an
// auth deployable with a system `user { id: guid }` block.
const PRINCIPAL = `system PS {
  user { id: guid  name: string }
  subdomain D {
    context Shop {
      aggregate Order with auditable, crudish { code: string }
      repository Orders for Order { }
    }
  }
  api A from D
  storage primary { type: postgres }
  resource st { for: Shop, kind: state, use: primary }
  deployable api1 { platform: elixir, contexts: [Shop], dataSources: [st], serves: A, port: 8081, auth: required }
}`;

const MIGRATION = "api1/priv/repo/migrations/20260101000000_create_orders.exs";

// ---------------------------------------------------------------------------
// Vanilla (plain Ecto) foundation — stamps applied via `Ecto.Changeset.put_change`
// pipe lines on the changeset right before `Repo.insert` / `Repo.update`, threaded
// through `create_<agg>`/`update_<agg>`.  `now()` → `DateTime.utc_now()`; a
// `currentUser` value resolves to the principal id off the threaded actor map
// (`current_user.<idKey>`, nil-safe).  onUpdate stamps run on insert too (so a
// NOT-NULL `updated_*` is filled on create).  Same two fail-fast gates apply.
// ---------------------------------------------------------------------------

const VANILLA_NON_PRINCIPAL = NON_PRINCIPAL.replace("platform: elixir,", "platform: elixir,");
const VANILLA_PRINCIPAL = PRINCIPAL.replace("platform: elixir,", "platform: elixir,");
const VANILLA_REPO = "api1/lib/api1/shop/order_repository.ex";
const VANILLA_SCHEMA = "api1/lib/api1/shop/order.ex";
const VANILLA_CONTEXT = "api1/lib/api1/shop.ex";

describe("elixir/vanilla generator — lifecycle stamps", () => {
  it("put_changes the audit columns in the changeset insert/update path", async () => {
    const files = await generateSystemFiles(VANILLA_NON_PRINCIPAL);
    const repo = files.get(VANILLA_REPO)!;
    // onCreate + onUpdate stamps both apply on insert (NOT-NULL updated_at on
    // create); onUpdate-only on update.
    expect(repo).toContain("def insert(attrs) when is_map(attrs) do");
    expect(repo).toContain("|> Ecto.Changeset.put_change(:created_at, DateTime.utc_now())");
    expect(repo).toContain("|> Ecto.Changeset.put_change(:updated_at, DateTime.utc_now())");
    expect(repo).toContain("|> Repo.insert()");
    // A non-principal stamp threads no actor (byte-identical seam).
    expect(repo).not.toContain("current_user");

    // The audit timestamp fields are REAL schema fields (so put_change is valid)
    // and the bundled `timestamps()` is dropped (it would collide on updated_at).
    const schema = files.get(VANILLA_SCHEMA)!;
    expect(schema).toContain("field :created_at, :utc_datetime");
    expect(schema).toContain("field :updated_at, :utc_datetime");
    expect(schema).not.toContain("timestamps(");
  });

  it("a currentUser stamp resolves to the threaded actor's principal id", async () => {
    const files = await generateSystemFiles(VANILLA_PRINCIPAL);
    const repo = files.get(VANILLA_REPO)!;
    // The principal id reads off the threaded `current_user` map, nil-safe.
    expect(repo).toContain("def insert(attrs, current_user \\\\ nil) when is_map(attrs) do");
    expect(repo).toContain(
      "|> Ecto.Changeset.put_change(:created_by, current_user && current_user.id)",
    );
    expect(repo).toContain(
      "|> Ecto.Changeset.put_change(:updated_by, current_user && current_user.id)",
    );

    // The context delegate threads `current_user` through to the repo seam.
    const context = files.get(VANILLA_CONTEXT)!;
    expect(context).toContain(
      "defdelegate create_order(attrs, current_user \\\\ nil), to: Api1.Shop.OrderRepository, as: :insert",
    );

    // The controller pulls the actor off conn.assigns and threads it.
    const controller = files.get("api1/lib/api1_web/controllers/order_controller.ex")!;
    expect(controller).toContain("current_user = Map.get(conn.assigns, :current_user)");
    expect(controller).toContain("Shop.create_order(params, current_user)");

    // Managed audit columns (`created_by`/`updated_by`) are NOT cast from client
    // attrs — the stamp owns them.
    const changeset = files.get("api1/lib/api1/shop/order_changeset.ex")!;
    expect(changeset).not.toContain(":created_by");
    expect(changeset).not.toContain(":updated_by");
  });

  it("drops timestamps() entirely when auditable (audit columns are the only timestamps)", async () => {
    // The vanilla Ecto schema drops the bundled `timestamps()` when an explicit
    // `updated_at` field is present (it would collide); the migration must
    // mirror that or `ecto.migrate` aborts with a duplicate `updated_at`.
    const mig = (await generateSystemFiles(VANILLA_NON_PRINCIPAL)).get(MIGRATION)!;
    expect(mig).toContain("add :updated_at, :utc_datetime, null: false");
    expect(mig).not.toContain("timestamps(");
    expect(mig.match(/:updated_at/g)?.length).toBe(1);
  });

  it("a CLAIM-valued principal stamp put_changes the claim, nil-safe like the bare case", async () => {
    // `tenantId := currentUser.tenantId` — the stamp is the CLAIM read off the
    // threaded actor (`current_user.tenant_id`), never the actor id, and it
    // carries the same nil-guard as the bare-`currentUser` case so an internal
    // caller that didn't thread an actor stamps nil instead of raising.
    const claim = `system TS {
      user { id: guid  tenantId: string }
      subdomain D { context Ledger {
        stamp onCreate { tenantId := currentUser.tenantId }
        aggregate Account {
          tenantId: string internal
          balance: int
          filter this.tenantId == currentUser.tenantId
        }
        repository Accounts for Account { }
      }}
      api A from D
      storage primary { type: postgres }
      resource st { for: Ledger, kind: state, use: primary }
      deployable api1 { platform: elixir, contexts: [Ledger], dataSources: [st], serves: A, port: 8081, auth: required }
    }`;
    const repo = (await generateSystemFiles(claim)).get(
      "api1/lib/api1/ledger/account_repository.ex",
    )!;
    expect(repo).toContain(
      "|> Ecto.Changeset.put_change(:tenant_id, current_user && current_user.tenant_id)",
    );
    // Not the actor id, and not the unguarded raw member access.
    expect(repo).not.toContain("put_change(:tenant_id, current_user.tenant_id)");
    expect(repo).not.toContain("put_change(:tenant_id, current_user && current_user.id)");
  });

  it("gates a currentUser stamp on a vanilla deployable WITHOUT auth fail-fast", async () => {
    const noAuth = VANILLA_PRINCIPAL.replace(", auth: required", "");
    const loom = await buildLoomModel(noAuth);
    const errors = validateLoomModel(loom).filter(
      (d) => d.code === "loom.elixir-stamp-unsupported",
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.message).toContain("no auth");
  });

  it("gates a stamp on an event-sourced vanilla aggregate fail-fast", async () => {
    const eventSourced = `system ES {
      subdomain D {
        context Shop {
          stamp onCreate { createdAt := now() }
          event OrderPlaced { order: Order id, code: string }
          aggregate Order persistedAs(eventLog) {
            code: string
            createdAt: datetime
            create place(code: string) { emit OrderPlaced { order: id, code: code } }
            apply(e: OrderPlaced) { code := e.code }
          }
          repository Orders for Order { }
        }
      }
      api A from D
      storage primary { type: postgres }
      resource el { for: Shop, kind: eventLog, use: primary }
      deployable api1 { platform: elixir, contexts: [Shop], dataSources: [el], serves: A, port: 8081 }
    }`;
    const loom = await buildLoomModel(eventSourced);
    const errors = validateLoomModel(loom).filter(
      (d) => d.code === "loom.elixir-stamp-unsupported",
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.message).toContain("event-sourced");
  });
});

// ---------------------------------------------------------------------------
// Elixir / Phoenix (Ash 3.x) backend — lifecycle stamps (`stamp onCreate`/
// `onUpdate`, the audit / softDelete capability stamps).  `contextStamps` become
// Ash `change fn ... end, on: [:create|:update]` blocks in the resource that
// `force_change_attribute` the audit columns before save — closing the prior
// silent-drop (createdAt stayed null).  A non-principal value renders directly
// (`now()` → `DateTime.utc_now()`); a bare `currentUser` value resolves to the
// principal id read from the threaded Ash actor (`current_user.<idKey>` =
// `context.actor.<idKey>`).  Two cases stay fail-fast (loom.elixir-stamp-
// unsupported): a principal stamp on a deployable WITHOUT auth, and stamps on an
// event-sourced aggregate.  Mirrors test/generator/java/generator-java-stamps.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { validateLoomModel } from "../../../src/ir/validate/validate.js";
import { generateSystemFiles } from "../../_helpers/generate.js";
import { buildLoomModel } from "../../_helpers/ir.js";

// Non-principal stamps (now()), on an Ash elixir deployable.
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

const RESOURCE = "api1/lib/api1/shop/order.ex";

describe("elixir/Ash generator — lifecycle stamps", () => {
  it("emits an on:[:create] / on:[:update] change block stamping the fields with now()", async () => {
    const res = (await generateSystemFiles(NON_PRINCIPAL)).get(RESOURCE)!;
    expect(res).toContain("changes do");
    expect(res).toContain("change fn changeset, _context ->");
    expect(res).toContain(
      "|> Ash.Changeset.force_change_attribute(:created_at, DateTime.utc_now())",
    );
    expect(res).toContain("on: [:create]");
    expect(res).toContain(
      "|> Ash.Changeset.force_change_attribute(:updated_at, DateTime.utc_now())",
    );
    // onUpdate stamps run on create too (mirrors the .NET interceptor's
    // `Added || Modified`) so a NOT-NULL updated_at is populated on insert.
    expect(res).toContain("on: [:create, :update]");
  });

  it("a currentUser stamp resolves to the threaded actor's principal id", async () => {
    const files = await generateSystemFiles(PRINCIPAL);
    const res = files.get(RESOURCE)!;
    // Principal stamps read the actor and stamp the id.
    expect(res).toContain("change fn changeset, context ->");
    expect(res).toContain("current_user = context.actor");
    expect(res).toContain("|> Ash.Changeset.force_change_attribute(:created_by, current_user.id)");
    expect(res).toContain("|> Ash.Changeset.force_change_attribute(:updated_by, current_user.id)");
    // The controller threads the request principal as the Ash actor on the
    // create call so the change block's `context.actor` is populated.
    const controller = files.get("api1/lib/api1_web/controllers/orders_controller.ex")!;
    expect(controller).toContain("actor: conn.assigns.current_user");
  });

  it("gates a currentUser stamp on a deployable WITHOUT auth fail-fast", async () => {
    // Drop `auth: required` (keep the `user {}` block so `currentUser` still
    // resolves to the principal type): the deployable then has no request-scoped
    // actor to thread, so the principal stamp must fail fast.
    const noAuth = PRINCIPAL.replace(", auth: required", "");
    const loom = await buildLoomModel(noAuth);
    const errors = validateLoomModel(loom).filter(
      (d) => d.code === "loom.elixir-stamp-unsupported",
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.message).toContain("no auth");
  });

  it("gates a lifecycle stamp on an event-sourced aggregate fail-fast", async () => {
    const eventSourced = `system ES {
      subdomain D {
        context Shop {
          stamp onCreate { createdAt := now() }
          event OrderPlaced { order: Order id, code: string }
          aggregate Order ids guid persistedAs(eventLog) {
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

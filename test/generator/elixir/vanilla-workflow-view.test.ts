// Vanilla foundation — workflow-sourced `view` emission
// (workflow-instance-views.md).  A shorthand `view X = <Workflow> where <pred>`
// over an observable (correlation-bearing) workflow emits a plain Ecto read of
// the saga-state `<Wf>State` schema with the filter, projecting
// `instanceWireShape` (camelCase wire key ← snake struct field) — the read-side
// sibling of the instance endpoints, and the vanilla analogue of the Hono /
// .NET / Python workflow views.  The project-wide `ViewsController` already
// emits an action per view, so this closes the latent gap where that action
// referenced a never-emitted module.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = fs.readFileSync(
  path.resolve(here, "../../e2e/fixtures/elixir-vanilla-build/vanilla-channels.ddd"),
  "utf8",
);

async function build(): Promise<Map<string, string>> {
  const { model, errors } = await parseString(FIXTURE);
  if (errors.length) throw new Error(`fixture has validation errors:\n${errors.join("\n")}`);
  return generateSystems(model).files;
}

describe("vanilla foundation — workflow-sourced view", () => {
  it("emits the view module reading the saga-state schema with the lowered filter", async () => {
    const files = await build();
    const view = files.get("api/lib/api/fulfillment/views/busy_fulfillments.ex");
    expect(view, "workflow view module not emitted").toBeDefined();
    // Reads the saga-state Ecto schema (not an aggregate), filtered.
    expect(view).toContain(
      "from(record in Api.Fulfillment.Workflows.OrderFulfillmentState, where: record.attempts > 0)",
    );
    expect(view).toContain("|> Repo.all()");
    // Projects instanceWireShape: camelCase wire key ← snake struct field.
    expect(view).toContain(
      "|> Enum.map(fn record -> %{orderId: record.order_id, attempts: record.attempts} end)",
    );
    expect(view).toContain("@spec run(any()) :: [map()]");
  });

  it("wires the view into the project-wide ViewsController + route", async () => {
    const files = await build();
    const controller = files.get("api/lib/api_web/controllers/views_controller.ex")!;
    expect(controller).toContain('@doc "GET /api/views/busy_fulfillments"');
    expect(controller).toContain("def busy_fulfillments(conn, _params) do");
    expect(controller).toContain("Api.Fulfillment.Views.BusyFulfillments.run(current_user)");
    // The saga-state schema the view reads is emitted.
    expect(
      files.get("api/lib/api/fulfillment/workflows/order_fulfillment_state.ex"),
      "saga-state schema not emitted",
    ).toBeDefined();
  });
});

// An event-sourced workflow has no `<Wf>State` Ecto table, so a `view =
// <ESWorkflow>` can't push its filter into an `from(.. where: ..)` query.  The
// view module group-folds the `<wf>_events` stream via `<Wf>Stream.list_instances/0`
// (the same helper the ES instance LIST uses) and applies the SAME filter
// IN-MEMORY with `Enum.filter`.  The folded `<Wf>State` struct exposes the same
// `record.<f>` fields, so projection / route paths / wire keys stay identical.
const ES_FIXTURE = fs.readFileSync(
  path.resolve(here, "../../e2e/fixtures/elixir-vanilla-build/vanilla-eventsourced-workflow.ddd"),
  "utf8",
);

async function buildEs(): Promise<Map<string, string>> {
  const { model, errors } = await parseString(ES_FIXTURE);
  if (errors.length) throw new Error(`fixture has validation errors:\n${errors.join("\n")}`);
  return generateSystems(model).files;
}

describe("vanilla foundation — event-sourced workflow-sourced view", () => {
  it("group-folds the stream via list_instances/0 and filters IN-MEMORY", async () => {
    const files = await buildEs();
    const view = files.get("api/lib/api/fulfillment/views/paid_fulfillments.ex");
    expect(view, "ES workflow view module not emitted").toBeDefined();
    // Reads the group-fold instance read model — NOT an Ecto saga-state query.
    expect(view).toContain("Api.Fulfillment.Workflows.OrderFulfillmentStream.list_instances()");
    expect(view).toContain("|> Enum.filter(fn record -> record.paid > 0 end)");
    expect(view).not.toContain("from(record in");
    expect(view).not.toContain("|> Repo.all()");
    // No Ecto.Query / Repo import on the ES path.
    expect(view).not.toContain("import Ecto.Query");
    // Projects instanceWireShape: camelCase wire key ← snake struct field.
    expect(view).toContain(
      "|> Enum.map(fn record -> %{orderId: record.order_id, paid: record.paid, cancelled: record.cancelled} end)",
    );
  });

  it("emits no mutable saga-state schema, and the stream exposes list_instances/0", async () => {
    const files = await buildEs();
    const state = files.get("api/lib/api/fulfillment/workflows/order_fulfillment_state.ex")!;
    // ES fold struct, not an Ecto schema.
    expect(state).not.toContain("use Ecto.Schema");
    const stream = files.get("api/lib/api/fulfillment/workflows/order_fulfillment_stream.ex")!;
    expect(stream).toContain("def list_instances do");
  });

  it("wires the ES view into the ViewsController under the same route", async () => {
    const controller = (await buildEs()).get("api/lib/api_web/controllers/views_controller.ex")!;
    expect(controller).toContain('@doc "GET /api/views/paid_fulfillments"');
    expect(controller).toContain("def paid_fulfillments(conn, _params) do");
    expect(controller).toContain("Api.Fulfillment.Views.PaidFulfillments.run(current_user)");
  });
});

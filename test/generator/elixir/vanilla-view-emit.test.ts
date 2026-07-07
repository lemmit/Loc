// Vanilla foundation — aggregate-sourced `view` emission (vanilla-foundation
// -tdd-plan.md slice 5; D-VANILLA-PHOENIX-FOUNDATION).
//
// On `foundation: vanilla` a `view` lowers to a plain Ecto query (no
// `Ash.Query`): `from(record in <Agg>, where: <filter>) |> Repo.all()` for
// the shorthand form, and a `Repo.all |> Enum.map` projection for the full
// form.  The enum-value / filter divergence is handled by render-expr: in a
// query (`filterArgs`) `status == Confirmed` renders as the dumped DECLARED
// string `record.status == "Confirmed"` (text column), not an atom.
//
// A single project-wide `ViewsController` exposes `GET /api/views/<snake>`
// per view, mirroring the ash path's route shape.

import { describe, expect, it } from "vitest";
import {
  emitVanillaViewModules,
  emitVanillaViewsController,
} from "../../../src/generator/elixir/vanilla/view-emit.js";
import type { BoundedContextIR, ExprIR, ViewIR } from "../../../src/ir/types/loom-ir.js";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

const filterIR: ExprIR = {
  kind: "binary",
  op: "==",
  left: { kind: "ref", name: "status", refKind: "this-prop" },
  right: { kind: "ref", name: "Confirmed", refKind: "enum-value" },
};

const orderAgg = {
  name: "Order",
  idValueType: "guid" as const,
  fields: [
    { name: "status", type: { kind: "enum", name: "OrderStatus" } as const, optional: false },
  ],
  contains: [],
  derived: [],
  invariants: [],
  functions: [],
  operations: [],
  parts: [],
  tests: [],
  creates: [],
  destroys: [],
};

function ctxWith(views: ViewIR[]): BoundedContextIR {
  return {
    name: "Sales",
    enums: [{ name: "OrderStatus", values: ["Draft", "Confirmed", "Cancelled"] }],
    valueObjects: [],
    events: [],
    aggregates: [orderAgg],
    repositories: [],
    workflows: [],
    views,
  } as unknown as BoundedContextIR;
}

const shorthand: ViewIR = {
  name: "ActiveOrders",
  source: { kind: "aggregate", name: "Order" },
  filter: filterIR,
} as unknown as ViewIR;

function emitModule(view: ViewIR): string {
  const out = new Map<string, string>();
  emitVanillaViewModules("acme", "Acme", ctxWith([view]), out);
  const file = out.get("lib/acme/sales/views/active_orders.ex");
  if (!file) throw new Error("expected view module at lib/acme/sales/views/active_orders.ex");
  return file;
}

describe("vanilla foundation — view emit (Ecto, no Ash.Query)", () => {
  it("emits the view module at lib/<app>/<ctx>/views/<view>.ex", () => {
    const out = new Map<string, string>();
    emitVanillaViewModules("acme", "Acme", ctxWith([shorthand]), out);
    expect(out.has("lib/acme/sales/views/active_orders.ex")).toBe(true);
  });

  it("renders a plain Ecto query — no Ash anywhere", () => {
    const src = emitModule(shorthand);
    expect(src).toContain("defmodule Acme.Sales.Views.ActiveOrders do");
    expect(src).toContain("import Ecto.Query");
    expect(src).toContain("alias Acme.Repo");
    expect(src).not.toContain("Ash.Query");
    expect(src).not.toContain("Ash.read");
    expect(src).not.toContain("require Ash");
  });

  it("renders the filter against string columns with the DECLARED enum casing (query context)", () => {
    const src = emitModule(shorthand);
    // An Ecto `where` is a query context: the enum literal is the dumped DECLARED
    // string ("Confirmed"), matching the stored text — Ecto won't cast an inline
    // atom through Ecto.Enum.  (In-memory comparisons render the atom instead.)
    expect(src).toContain("from(record in Acme.Sales.Order");
    expect(src).toContain('record.status == "Confirmed"');
    expect(src).not.toContain(":Confirmed");
    expect(src).not.toContain('"confirmed"');
    expect(src).toContain("|> Repo.all()");
  });

  it("a filterless shorthand view reads the whole table", () => {
    const noFilter = {
      name: "AllOrders",
      source: { kind: "aggregate", name: "Order" },
    } as unknown as ViewIR;
    const out = new Map<string, string>();
    emitVanillaViewModules("acme", "Acme", ctxWith([noFilter]), out);
    const src = out.get("lib/acme/sales/views/all_orders.ex")!;
    expect(src).toContain("Repo.all(Acme.Sales.Order)");
    expect(src).not.toContain("where:");
  });

  it("emits one ViewsController with a GET /views/<snake> action + route per view", () => {
    const out = new Map<string, string>();
    const routes = emitVanillaViewsController(
      "acme",
      "Acme",
      [{ ctx: ctxWith([shorthand]), view: shorthand }],
      out,
    );
    const ctrl = out.get("lib/acme_web/controllers/views_controller.ex");
    expect(ctrl, "ViewsController not emitted").toBeDefined();
    expect(ctrl!).toContain("defmodule AcmeWeb.ViewsController do");
    expect(ctrl!).toContain("def active_orders(conn, _params) do");
    expect(ctrl!).toContain("Acme.Sales.Views.ActiveOrders.run(");
    expect(ctrl!).not.toContain("Ash");
    expect(routes).toContainEqual({
      method: "get",
      path: "/views/active_orders",
      controller: "ViewsController",
      action: ":active_orders",
    });
  });

  it("wires through the full pipeline (parse → lower → generateSystems)", async () => {
    const SRC = `
      system Sys {
        subdomain Ops {
          context Ops {
            enum OrderStatus { Draft, Confirmed }
            aggregate Order { total: int  status: OrderStatus }
            repository Orders for Order {}
            view ActiveOrders = Order where status == Confirmed
          }
        }
        storage primary { type: postgres }
        deployable api { platform: elixir  contexts: [Ops]  port: 4000 }
      }
    `;
    const { model } = await parseString(SRC, { validate: false });
    const files = generateSystems(model).files;
    const keys = [...files.keys()];
    const viewModule = keys.find((k) => k.endsWith("/ops/views/active_orders.ex"));
    const viewsController = keys.find((k) => k.endsWith("/controllers/views_controller.ex"));
    const router = keys.find((k) => k.endsWith("_web/router.ex"));
    expect(viewModule, "view module not emitted").toBeDefined();
    expect(viewsController, "ViewsController not emitted").toBeDefined();
    expect(files.get(viewModule!)!).toContain("import Ecto.Query");
    expect(files.get(viewModule!)!).toContain('record.status == "Confirmed"');
    expect(files.get(viewModule!)!).not.toContain("Ash");
    expect(files.get(router!)!).toContain("/views/active_orders");
  });
});

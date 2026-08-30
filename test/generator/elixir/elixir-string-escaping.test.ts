// ---------------------------------------------------------------------------
// The Elixir `#{` escaping funnel, reached through the EMITTERS (F2-ELX-ESCAPE-
// FUNNEL).
//
// `test/generator/hostile-inputs.test.ts` names this hazard in its header ("a
// value like `\"hi#{System.cmd(...)}\"` executes at Elixir compile time") but
// only exercises `renderElixirExpr` / `elixirString` directly — so four emit
// sites that spliced a `.ddd` string with a bare `JSON.stringify` were never
// reached by it (the `experience_gathered.md` §59/§63 "check that never reaches
// the thing it names" shape):
//
//   1. the Ecto schema `default:`      — `schema-emit.ts` `renderEctoDefault`
//      (interpolates in the module BODY, i.e. at `mix compile` time)
//   2. the wire-validation 422 entry   — `denial.ts` `wireValidationTerm`
//   3. the residual-invariant message  — `changeset-invariant-emit.ts`
//   4. the realtime LiveView toast     — `realtime-liveview.ts`
//
// This suite asserts on the GENERATED Elixir, so it fails if any one of them
// stops routing through `elixirString`.  Fixtures carry a real payload
// (`:erlang.halt/1`, `System.halt/1`) so the failure mode is unambiguous.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

/** No `#{` may appear unescaped (i.e. not preceded by a backslash). */
function expectNoLiveInterpolation(line: string): void {
  expect(line).toMatch(/#\{/); // the payload really is in the line under test
  expect(line).not.toMatch(/(^|[^\\])#\{/);
}

// Default + residual invariant message + wire-translatable precondition message,
// all on one elixir deployable.
const HOSTILE = `system Hostile {
  subdomain Catalog {
    context Catalog {
      aggregate Product with crudish {
        name: string
        stock: int
        note: string = "boot #{:erlang.halt(3)} end"
        invariant name != "safe" message "bad #{:erlang.halt()} name"
        operation restock(amount: int) {
          precondition amount >= 1 message "at least 1 - #{System.halt(1)}"
          stock := stock + amount
        }
      }
      repository Products for Product { }
    }
  }
  api CatalogApi from Catalog
  storage primary { type: postgres }
  resource catalogState { for: Catalog, kind: state, use: primary }
  deployable d { platform: elixir  contexts: [Catalog]  dataSources: [catalogState]  serves: CatalogApi  port: 4000 }
}`;

// A realtime channel subscription with a `toast(...)` whose literal carries the
// payload — the LiveView `handle_info` → `put_flash` path.
const HOSTILE_TOAST = `system HostileToast {
  subdomain Sales {
    context Orders {
      aggregate Order with crudish {
        code: string
        status: string = "Draft"
        operation place() {
          precondition status == "Draft"
          status := "Placed"
          emit OrderPlaced { order: id, at: now() }
        }
      }
      repository Orders for Order { }
      event OrderPlaced { order: Order id, at: datetime }
      channel Live { carries: OrderPlaced  delivery: broadcast  retention: ephemeral }
    }
  }
  api OrdersApi from Sales
  ui Admin with scaffold(subdomains: [Sales]) {
    api Orders: OrdersApi
    channel Live: Orders.Live
    on Live.OrderPlaced(e) { toast("Order placed #{System.halt(9)}") }
  }
  storage pg { type: postgres }
  storage bus { type: redis }
  resource ordersState { for: Orders, kind: state, use: pg }
  channelSource liveBus { for: Live, use: bus }
  deployable d {
    platform: elixir
    contexts: [Orders]
    dataSources: [ordersState]
    channels: [liveBus]
    serves: OrdersApi
    ui: Admin { Orders: d }
    port: 4000
  }
}`;

function findLine(files: Map<string, string>, suffix: string, needle: string): string {
  const path = [...files.keys()].find((p) => p.endsWith(suffix));
  expect(path, `no emitted file ends with ${suffix}`).toBeTruthy();
  const line = (files.get(path as string) as string).split("\n").find((l) => l.includes(needle));
  expect(line, `no line containing '${needle}' in ${suffix}`).toBeTruthy();
  return line as string;
}

describe("Elixir emitters route `.ddd` strings through the escaping funnel", () => {
  it("the Ecto schema `default:` does not interpolate at compile time", async () => {
    const files = await generateSystemFiles(HOSTILE);
    const line = findLine(files, "lib/d/catalog/product.ex", "field :note");
    expectNoLiveInterpolation(line);
  });

  it("the residual-invariant `add_error` message does not interpolate", async () => {
    const files = await generateSystemFiles(HOSTILE);
    const line = findLine(
      files,
      "lib/d/catalog/product_changeset.ex",
      "add_error(changeset, :name",
    );
    expectNoLiveInterpolation(line);
  });

  it("the wire-validation 422 message does not interpolate", async () => {
    const files = await generateSystemFiles(HOSTILE);
    const line = findLine(files, "lib/d/catalog.ex", ":validation_failed");
    expectNoLiveInterpolation(line);
  });

  it("the realtime LiveView toast does not interpolate", async () => {
    const files = await generateSystemFiles(HOSTILE_TOAST);
    const line = findLine(files, "lib/d_web/live/home_live.ex", "put_flash(:info,");
    expectNoLiveInterpolation(line);
  });
});

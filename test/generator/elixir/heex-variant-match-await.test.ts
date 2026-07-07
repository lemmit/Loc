// HEEx `match await` (async-actions-and-effects.md Stage 2) — server-side render.
//
// The four JS frontends render an awaited variant-match as a client-side async
// handler (await the mutation, reify the thrown error into the error variant,
// `switch` on the union tag).  LiveView's async boundary is SERVER-SIDE: the
// `handle_event` clause loads the route-id record, runs the aggregate's
// returning-op context fn, and `case`s on the tagged Result tuple — the same
// `{:ok, v}` / `{:error, "<tag>", data}` shape the returning-op controller action
// produces (operation-returns-emit), re-shaped to a socket-piped `then/2` step.
//
// This test pins that emission.  (It replaces the earlier "reviewed parity gap"
// no-op pin now that the server-side path is implemented.)

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const SOURCE = `
  error Failed { reason: string }
  system Demo {
    subdomain S { context C {
      aggregate Order { code: string
        operation confirm(): Order or Failed { return Failed { reason: code } }
      }
    } }
    api CApi from C
    ui Web {
      api C: CApi
      page Detail {
        route: "/orders/:id"
        state { message: string = "" }
        action submit() {
          match await C.Order.confirm() {
            Order o  => { message := o.code }
            Failed f => { message := f.reason }
          }
        }
        body: Stack { Button { "Go", onClick: submit } }
      }
    }
    storage primary { type: postgres }
    resource cState { for: C, kind: state, use: primary }
    deployable phoenixApp {
      platform: elixir
      contexts: [C]
      dataSources: [cState]
      serves: CApi
      ui: Web { C: phoenixApp }
      port: 4000
    }
  }
`;

describe("HEEx `match await` (Stage 2) — server-side variant-match", () => {
  it("emits a socket-piped `then` step: load record, run op via apply, case on the tuple", async () => {
    const files = await generateSystemFiles(SOURCE);
    const src = files.get("phoenix_app/lib/phoenix_app_web/live/detail_live.ex");
    expect(src, "detail_live.ex not emitted").toBeDefined();

    // Server-side envelope, not a client-side await/switch (which would be
    // invalid Elixir) and not the old reviewed no-op marker.
    expect(src!).not.toContain("mutateAsync");
    expect(src!).not.toContain("switch (");
    expect(src!).not.toContain("LiveView server-side async not yet emitted");

    // Load the route-id record from the aggregate's context, then run the op.
    expect(src!).toContain("case PhoenixApp.C.get_order(socket.assigns.id) do");
    // The op is dispatched through `apply/3` so Elixir 1.18's type checker can't
    // narrow an always-rejecting op's result and flag the `{:ok, _}` arm unused.
    expect(src!).toContain("case apply(PhoenixApp.C, :confirm_order, [record, %{}]) do");
    // Success variant → `{:ok, binder}`, the arm body threads socket assigns.
    expect(src!).toContain("{:ok, o} ->");
    expect(src!).toContain("|> assign(:message, o.code)");
    // Error variant → `{:error, "<tag>", binder}` (re-classified from the union;
    // the aggregate's own type is the success variant, everything else an error).
    expect(src!).toContain('{:error, "Failed", f} ->');
    expect(src!).toContain("|> assign(:message, f.reason)");
    // A missing record flashes rather than crashing the LiveView.
    expect(src!).toContain("{:error, :not_found} ->");
    expect(src!).toContain("put_flash(socket, :error,");
  });

  it('emits one `{:error, "<tag>", …}` clause per named error variant', async () => {
    const files = await generateSystemFiles(`
      error Failed { reason: string }
      error Declined { code: int }
      system Demo {
        subdomain S { context C {
          aggregate Order { code: string
            operation confirm(): Order or Failed or Declined { return Failed { reason: code } }
          }
        } }
        api CApi from C
        ui Web {
          api C: CApi
          page Detail {
            route: "/orders/:id"
            state { message: string = "" }
            action submit() {
              match await C.Order.confirm() {
                Order o    => { message := o.code }
                Failed f   => { message := f.reason }
                Declined d => { message := "declined" }
              }
            }
            body: Stack { Button { "Go", onClick: submit } }
          }
        }
        storage primary { type: postgres }
        resource cState { for: C, kind: state, use: primary }
        deployable phoenixApp {
          platform: elixir
          contexts: [C]
          dataSources: [cState]
          serves: CApi
          ui: Web { C: phoenixApp }
          port: 4000
        }
      }
    `);
    const src = files.get("phoenix_app/lib/phoenix_app_web/live/detail_live.ex")!;
    expect(src).toContain('{:error, "Failed", f} ->');
    // `Declined d` binds `d` but the arm body never uses it — Elixir's
    // `--warnings-as-errors` would reject a bound-but-unused var, so it is
    // rendered `_d`.
    expect(src).toContain('{:error, "Declined", _d} ->');
    expect(src).toContain("{:ok, o} ->");
  });
});

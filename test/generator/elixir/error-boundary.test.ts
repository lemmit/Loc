// M-T1.8 — global error boundary + failure sink, HEEx arm.
//
// LiveView has no `componentDidCatch`-style hook and no client-mounted
// element tree Loom owns the way React/Vue/Svelte do, so this closes the one
// genuinely OPEN half: `render_errors`' `formats:` list carried `json` only,
// so an HTML-accepting request that errors BELOW the router (a bad path, a
// plug crash before `mount/3`, the initial disconnected/"dead" render) fell
// through to Phoenix's own bare built-in fallback instead of anything this
// app styles.
//
// A CONNECTED LiveView crash is deliberately NOT touched: `phoenix_live_view.js`
// already shows its own reconnect/error overlay client-side, and the crashed
// process's exit is logged through the same `:logger` pipeline
// (`log_formatter.ex`) every other backend's failure sink writes through —
// OTP supervision gives that half of the contract for free.
//
// `mix compile --warnings-as-errors` (hexpm/elixir docker) is the compile leg
// this suite cannot see: the DEAD-render page is only reachable by an actual
// HTTP error, never by anything a string test evaluates.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const LIVEVIEW_SYS = `
system ErrBoundary {
  subdomain Sales {
    context Sales {
      aggregate Customer { name: string  derived display: string = name }
      repository Customers for Customer { }
    }
  }
  api SalesApi from Sales
  ui Admin with scaffold(subdomains: [Sales]) { }
  storage primary { type: postgres }
  resource salesState { for: Sales, kind: state, use: primary }
  deployable phoenixApp {
    platform: elixir
    contexts: [Sales]
    dataSources: [salesState]
    serves: SalesApi
    ui: Admin
    port: 4000
  }
}
`;

const API_ONLY_SYS = `
system ErrBoundaryApi {
  subdomain Sales {
    context Sales {
      aggregate Customer { name: string }
      repository Customers for Customer { }
    }
  }
  api SalesApi from Sales
  storage primary { type: postgres }
  resource salesState { for: Sales, kind: state, use: primary }
  deployable api {
    platform: elixir
    contexts: [Sales]
    dataSources: [salesState]
    serves: SalesApi
    port: 4000
  }
}
`;

describe("HEEx error boundary (M-T1.8) — LiveView deployable", () => {
  it("emits an ErrorHTML view rendering a styled fallback page, not the framework default", async () => {
    const files = await generateSystemFiles(LIVEVIEW_SYS);
    const key = [...files.keys()].find((p) => p.endsWith("controllers/error_html.ex"));
    expect(key, "error_html.ex emitted").toBeDefined();
    const src = files.get(key!)!;
    expect(src).toContain("defmodule PhoenixAppWeb.ErrorHTML do");
    expect(src).toContain("def render(template, _assigns) do");
    expect(src).toContain('status = template |> String.split(".") |> hd() |> String.to_integer()');
    expect(src).toContain("title = Phoenix.Controller.status_message_from_template(template)");
    // Raw markup wrapped so Phoenix.HTML.Safe doesn't escape the tags.
    expect(src).toContain('Phoenix.HTML.raw("""');
    expect(src).toContain("<!DOCTYPE html>");
    // Never leaks an exception message on the page (mirrors ErrorJSON's own
    // `detail_for(status, _, _) when status >= 500, do: "internal"` rule) —
    // only the templated status/title, no `assigns.reason`.
    expect(src).not.toContain("reason");
  });

  it("registers the html format on render_errors, alongside json", async () => {
    const files = await generateSystemFiles(LIVEVIEW_SYS);
    const key = [...files.keys()].find((p) => p.endsWith("config/config.exs"));
    const src = files.get(key!)!;
    expect(src).toContain(
      "formats: [json: PhoenixAppWeb.ErrorJSON, html: PhoenixAppWeb.ErrorHTML]",
    );
  });
});

describe("HEEx error boundary (M-T1.8) — JSON-API-only deployable (strict additivity)", () => {
  it("ships no ErrorHTML module and no html render_errors format", async () => {
    const files = await generateSystemFiles(API_ONLY_SYS);
    expect([...files.keys()].some((p) => p.endsWith("controllers/error_html.ex"))).toBe(false);
    const key = [...files.keys()].find((p) => p.endsWith("config/config.exs"));
    const src = files.get(key!)!;
    expect(src).toContain("formats: [json: ApiWeb.ErrorJSON]");
    expect(src).not.toContain("ErrorHTML");
  });
});

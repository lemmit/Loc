import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// HEEx api-call routing must follow the aggregate's bounded CONTEXT, not the
// UI-local api HANDLE alias.
//
// `renderApiCall` used to emit `<AppModule>.<Handle>.<fn>(...)`, which is
// correct only when the UI's `api <handle>: <Api>` alias happens to equal the
// aggregate's context name (as it does in acme.ddd — `api Sales: SalesApi`,
// context `Sales`).  A UI that aliases the api to any other name produced a
// path to a module that does not exist (`<App>.<Handle>`), i.e. silent
// uncompilable Elixir.  The resource lives in `<App>.<Ctx>`, which
// `contextModuleByAggName` resolves — the same map every other Elixir emit
// site routes through.
// ---------------------------------------------------------------------------

const systemWith = (handle: string): string => `
system Demo {
  subdomain M {
    context Sales {
      aggregate Doc { name: string  derived display: string = name }
      repository Docs for Doc { }
    }
  }
  storage primary { type: postgres }
  resource st { for: Sales, kind: state, use: primary }
  api DemoApi from M
  ui DemoUi {
    api ${handle}: DemoApi
    page Board {
      route: "/board"
      body: QueryView {
        of: ${handle}.Doc.all,
        loading: Loader {},
        empty: Empty { "none" },
        data: docs => Stack { Text { "ok" } }
      }
    }
  }
  deployable app { platform: elixir contexts: [Sales] dataSources: [st] serves: DemoApi ui: DemoUi port: 4000 }
}
`;

async function boardHeex(handle: string): Promise<string> {
  const files = await generateSystemFiles(systemWith(handle));
  for (const [path, content] of files) {
    if (path.endsWith("/board_live.ex")) return content;
  }
  throw new Error("Board LiveView not found");
}

describe("HEEx api-call routing follows the context, not the handle alias", () => {
  it("routes through the aggregate's context module when the handle equals the context", async () => {
    const heex = await boardHeex("Sales");
    // The resource module is `<App>.Sales` (context `Sales`).
    expect(heex).toMatch(/\.Sales\.list_docs\(/);
  });

  it("routes through the context module even when the handle is aliased away from it", async () => {
    const heex = await boardHeex("Shop");
    // Must still be `<App>.Sales.…` — routed by the aggregate's context, not
    // the UI-local `Shop` alias.  The old code emitted `<App>.Shop.…`, a
    // module that does not exist → uncompilable Elixir.
    expect(heex).toMatch(/\.Sales\.list_docs\(/);
    expect(heex).not.toMatch(/\.Shop\.list_docs\(/);
  });
});

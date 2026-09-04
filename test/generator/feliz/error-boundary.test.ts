// M-T1.8 — global error boundary + failure sink, feliz arm.
//
// Elmish/Feliz has no React class-component machinery to hook
// `componentDidCatch` the way the JSX frontends' `ErrorBoundary` (React) does.
// Instead `App.fs` wraps the ONE function `Program.mkProgram` actually mounts
// (`view`, whether it's the plain page-dispatch root or the `authUi` gate that
// delegates to `appView`) in an ordinary `try`/`with` — a render-time
// exception renders a fallback panel instead of crashing to a blank screen —
// and adds Elmish's own `Program.withErrorHandler` as the update-phase
// failure sink (an exception raised while processing a dispatched `Msg`,
// including an async effect's continuation, is caught centrally rather than
// silently dropped — the MVU analogue of an unhandled-promise-rejection
// handler).  Fable-compile-verified (SDK 8.0 container, `dotnet fable`).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SYS = (auth = ""): string => `
system ErrBoundary {
  ${auth ? "user { id: string  role: string }" : ""}
  api ShopApi from Catalog
  subdomain Catalog {
    context Cat {
      aggregate Product { name: string }
      repository Products for Product { }
    }
  }
  storage db { type: postgres }
  resource catState { for: Cat, kind: state, use: db }
  ui WebApp {
    api Shop: ShopApi
    page Home { route: "/"  body: Heading { "Home", level: 1 } }
  }
  deployable api { platform: node contexts: [Cat] dataSources: [catState] serves: ShopApi port: 3000 ${auth ? "auth: required" : ""} }
  deployable web { platform: feliz targets: api ui: WebApp { Shop: api } port: 3005 ${auth ? "auth: ui" : ""} }
}
`;

async function appFs(source: string): Promise<string> {
  const files = await generateSystemFiles(source);
  return [...files.entries()].find(([p]) => p.endsWith("src/App.fs"))![1];
}

describe("feliz error boundary + failure sink (M-T1.8)", () => {
  it("wraps `view` in a try/with rendering a fallback panel", async () => {
    const src = await appFs(SYS());
    expect(src).toContain("let private safeView (model: Model) (dispatch: Msg -> unit) =");
    expect(src).toContain("  try");
    expect(src).toContain("    view model dispatch");
    expect(src).toContain("  with ex ->");
    expect(src).toContain('Fable.Core.JS.console.error ("Uncaught render error:", ex)');
    expect(src).toContain(
      'Html.h2 [ prop.className "text-red-700 font-semibold"; prop.text "Something went wrong." ]',
    );
  });

  it("mounts safeView, not the raw view, on Program.mkProgram", async () => {
    const src = await appFs(SYS());
    expect(src).toContain("Program.mkProgram init update safeView");
    expect(src).not.toMatch(/Program\.mkProgram init update view\b/);
  });

  it("adds Program.withErrorHandler as the update-phase failure sink", async () => {
    const src = await appFs(SYS());
    expect(src).toContain(
      'Program.withErrorHandler (fun (msg, ex) -> Fable.Core.JS.console.error ($"Unhandled error in {msg}:", ex))',
    );
  });

  it("under an auth gate, safeView wraps the GATE (`view`), not `appView` directly — Checking/Anon still render", async () => {
    const src = await appFs(SYS("auth"));
    expect(src).toContain("let private safeView (model: Model) (dispatch: Msg -> unit) =");
    // The gate is still named `view` and still owns the Checking/Anon arms —
    // safeView's try body calls it by that name, not `appView`.
    expect(src).toContain("    view model dispatch");
    expect(src).not.toContain("    appView model dispatch");
    expect(src).toContain("| Authed -> appView model dispatch");
    expect(src).toContain("Program.mkProgram init update safeView");
  });
});

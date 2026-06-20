import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// HEEx Tabs (parity finding #5).  `Tabs(Tab(label, body), …)` renders a
// client-side tab switcher: all panels rendered, switching via
// `Phoenix.LiveView.JS` (JS.hide/JS.show + active-class) — no server
// round-trip, no verified-route plumbing.  ARIA roles match Mantine's, so a
// role-based e2e spec is portable across React and HEEx.
// ---------------------------------------------------------------------------

const SRC = `
system Demo {
  subdomain M {
    context C {
      aggregate Doc { name: string  derived display: string = name }
      repository Docs for Doc { }
    }
  }
  api DemoApi from M
  ui DemoUi {
    page Landing {
      route: "/"
      body: Tabs {
        Tab("Overview", Text { "the overview" }),
        Tab("Settings", Stack { Text { "the settings" } })
      }
    }
  }
  deployable phoenixApp {
    platform: elixir, contexts: [C], serves: DemoApi,
    ui: DemoUi, port: 4000
  }
}
`;

async function landingHeex(): Promise<string> {
  const files = await generateSystemFiles(SRC);
  for (const [p, c] of files) {
    if (p.endsWith("/landing_live.ex")) return c;
  }
  throw new Error("landing_live.ex not found");
}

describe("HEEx Tabs (parity finding #5)", () => {
  it("renders a tablist with one role=tab button per tab", async () => {
    const heex = await landingHeex();
    expect(heex).toMatch(/role="tablist"/);
    expect((heex.match(/role="tab"/g) ?? []).length).toBe(2);
    expect(heex).toContain(">Overview</button>");
    expect(heex).toContain(">Settings</button>");
  });

  it("switches tabs with a Phoenix.LiveView.JS toggle (no server round-trip)", async () => {
    const heex = await landingHeex();
    // The Settings trigger hides the scoped panels then shows its own.
    expect(heex).toMatch(
      /phx-click=\{JS\.hide\(to: "\[data-tabs='tabs-1'\]"\) \|> JS\.show\(to: "#tabs-1-panel-settings"\)/,
    );
    // No handle_event clause for tab switching (it's pure client JS).
    expect(heex).not.toMatch(/handle_event\("(select|switch)_tab/);
  });

  it("renders all panels, first visible and the rest hidden", async () => {
    const heex = await landingHeex();
    expect(heex).toMatch(/role="tabpanel" id="tabs-1-panel-overview"[^>]*class="tab-panel"/);
    expect(heex).toMatch(/role="tabpanel" id="tabs-1-panel-settings"[^>]*class="tab-panel hidden"/);
    expect(heex).toContain("the overview");
    expect(heex).toContain("the settings");
  });
});

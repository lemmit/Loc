import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// HEEx standalone controlled inputs (parity finding #5).  A page-`state`-bound
// input (`Field("L", bind: x)`) renders the app's `<.input>` with a
// `phx-change` that writes the value back to the assign via a hoisted
// `handle_event` — the LiveView analogue of a React controlled input.
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
      state {
        draft: string = ""
        count: int = 0
        region: string = "EU"
        active: bool = false
      }
      body: Stack {
        Field("Name", bind: draft),
        NumberField("Count", bind: count),
        SelectField("Region", bind: region, options: ["EU", "US"]),
        Toggle("Active", bind: active)
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

describe("HEEx standalone form inputs (parity finding #5)", () => {
  it("renders <.input> bound to the page-state assign with a phx-change", async () => {
    const heex = await landingHeex();
    expect(heex).toContain(
      `<.input type="text" name="draft" value={@draft} label="Name" phx-change="update_draft" />`,
    );
    expect(heex).toMatch(/<\.input type="number" name="count" value=\{@count\}/);
    expect(heex).toMatch(/<\.input type="select" name="region"[^>]*options=\{\["EU", "US"\]\}/);
    expect(heex).toMatch(/<\.input type="checkbox" name="active"[^>]*phx-change="toggle_active"/);
  });

  it("hoists a write-back handle_event per bound field", async () => {
    const heex = await landingHeex();
    expect(heex).toMatch(
      /def handle_event\("update_draft", %\{"draft" => value\}, socket\) do\s*\{:noreply, assign\(socket, :draft, value\)\}/,
    );
    // checkbox writes a boolean.
    expect(heex).toMatch(
      /def handle_event\("toggle_active",[^)]*\) do\s*\{:noreply, assign\(socket, :active, value == "true"\)\}/,
    );
  });
});

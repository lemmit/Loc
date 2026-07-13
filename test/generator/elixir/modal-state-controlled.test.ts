// Feature: state-controlled `Modal { open: <state> }` on Phoenix LiveView.
//
// HEEx runs a parallel walker (not walkBody), and LiveView's state model is
// socket assigns + handle_event — not useState. So the controlled modal is an
// assign-driven conditional render: `<%= if @open do %> … <% end %>`, with the
// `open:` ref reading the page-state assign and the close driven by a child
// button that writes the state (the existing handle_event machinery).
// See docs/old/proposals/state-controlled-modal.md.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const SRC = `
system Acme {
  subdomain Sales { context S { aggregate Order { sku: string } repository Orders for Order { } } }
  api SalesApi from Sales
  ui Admin with scaffold(subdomains: [Sales]) {
    page Confirm {
      route: "/confirm"
      title: "Confirm"
      state { archiveOpen: bool = false }
      body: Stack {
        Button { "Archive", onClick: e => { archiveOpen := true } },
        Modal { Text { "Confirm archive?" }, open: archiveOpen, title: "Archive" }
      }
    }
  }
  storage primary { type: postgres }
  resource sState { for: S, kind: state, use: primary }
  deployable phoenixApp {
    platform: elixir
    contexts: [S]
    dataSources: [sState]
    serves: SalesApi
    ui: Admin
    port: 4000
  }
}
`;

describe("phoenix LiveView — state-controlled Modal { open: <state> }", () => {
  it("renders an assign-driven conditional modal, not the op-form/stub form", async () => {
    const files = await generateSystemFiles(SRC);
    const live = [...files.entries()].find(([p]) => /live\/confirm_live\.ex$/.test(p))?.[1];
    expect(live, "confirm_live.ex").toBeDefined();
    // State assign defaulted in mount.
    expect(live).toMatch(/assign\(:archive_open, false\)/);
    // Visibility is the assign, rendered via an `if` block in HEEx.
    expect(live).toMatch(/<%= if @archive_open do %>/);
    expect(live).toContain("<% end %>");
    expect(live).toContain("Confirm archive?");
    // Not the op-form modal nor the malformed stub.
    expect(live).not.toContain("malformed Modal");
    expect(live).not.toContain("<.modal");
  });
});

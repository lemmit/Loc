// Regression: a boolean aggregate field must render as readable text, not a
// raw `{row.active}` JSX expression.
//
// React renders a bare boolean as nothing (`{true}` → ""), so scaffolded list /
// detail cells for a `bool` field showed up blank.  The scaffold cell dispatch
// (`columnAccessorFor` / `typedCellFor`) routed id/datetime/enum through their
// display primitives but fell through to a plain `Text { row.<field> }` for
// bool.  There was no test over the bool cell path.
//
// Fix: bool cells render a `Yes`/`No` ternary (matching the pack `BoolValue`
// helper's labels) inside Text — a shared `ternary` ExprIR, so it works on every
// frontend + Phoenix without a new per-pack primitive.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const SRC = `
system Acme {
  subdomain People {
    context P {
      aggregate Engineer {
        handle: string
        onCall: bool
      }
      repository Engineers for Engineer { }
    }
  }
  api PeopleApi from People
  ui WebApp with scaffold(subdomains: [People]) {
    api People: PeopleApi
  }
  storage primarySql { type: postgres }
  resource pState { for: P, kind: state, use: primarySql }
  deployable api {
    platform: node
    contexts: [P]
    dataSources: [pState]
    serves: PeopleApi
    port: 3001
  }
  deployable web_app {
    platform: static
    targets: api
    ui: WebApp { People: api }
    port: 5173
  }
}
`;

describe("react — scaffolded boolean cells render readable text", () => {
  it("renders a bool field as a Yes/No ternary, never a bare boolean expression", async () => {
    const files = await generateSystemFiles(SRC);
    // Display pages only — list/detail render values; new/edit forms use a
    // <Switch> control, which legitimately doesn't go through the cell ternary.
    const displayPages = [...files.entries()].filter(
      ([p]) => p.startsWith("web_app/") && /\/pages\/.*\/(list|detail)\.tsx$/.test(p),
    );
    const onCallPages = displayPages.filter(([, c]) => c.includes("onCall"));
    expect(onCallPages.length, "list + detail both render onCall").toBe(2);
    for (const [path, content] of onCallPages) {
      // The bool field goes through the Yes/No ternary.
      expect(content, `${path} renders onCall via Yes/No ternary`).toMatch(
        /onCall \? "Yes" : "No"/,
      );
      // ...and never as a bare boolean JSX child (which renders blank).
      expect(content, `${path} has no bare {…onCall} child`).not.toMatch(/\{\s*\w+\.onCall\s*\}/);
    }
  });
});

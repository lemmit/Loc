// Regression for #1029: the scaffolded Phoenix home page ("Welcome" /
// `home_live.ex`) emits an "Open workflows → /workflows" card only when a
// `/workflows` route exists.  Post-#1029, an event-triggered-only workflow
// (every `create` carries a `by` correlation) gets no form page and no
// WorkflowsIndex route — so the home card must be suppressed, or the generated
// `~p"/workflows"` link dangles and fails `mix compile --warnings-as-errors`.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SYS = (workflowBody: string) => `
  system S {
    subdomain D {
      context C {
        aggregate Order { code: string }
        repository Orders for Order { }
        event Placed { order: Order id, at: datetime }
        channel Ch { carries: Placed  delivery: broadcast  retention: ephemeral }
        workflow Flow {
          ${workflowBody}
        }
      }
    }
    ui U with scaffold(subdomains: [D]) { }
    storage pg { type: postgres }
    resource st { for: C, kind: state, use: pg }
    deployable app {
      platform: elixir
      contexts: [C]
      dataSources: [st]
      ui: U
      port: 4000
    }
  }
`;

function homeLive(files: Map<string, string>): string {
  const hit = [...files.entries()].find(([p]) => p.endsWith("home_live.ex"));
  if (!hit) throw new Error("no home_live.ex emitted");
  return hit[1];
}

describe("phoenix home page — workflows link gating (#1029 regression)", () => {
  it("omits the `/workflows` link for an event-triggered-only workflow (no route)", async () => {
    // `create(p: Placed) by p.order` → event-triggered-only → no WorkflowsIndex
    // route, so the home card + its `~p"/workflows"` link must not be emitted.
    const files = await generateSystemFiles(
      SYS(`
        orderId: Order id
        create(p: Placed) by p.order { }
      `),
    );
    expect(homeLive(files)).not.toContain("/workflows");
  });

  it("keeps the `/workflows` link for a command-routed workflow (route exists)", async () => {
    // A plain command `create(...)` (no `by`) gets a form page + the
    // WorkflowsIndex `/workflows` route, so the home card is valid.
    const files = await generateSystemFiles(
      SYS(`
        amount: int
        create(amount: int) { attempts := 0 }
        attempts: int
      `),
    );
    expect(homeLive(files)).toContain('~p"/workflows"');
  });
});

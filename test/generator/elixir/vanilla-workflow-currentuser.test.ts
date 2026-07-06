import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// §11a (vanilla-phoenix-gaps.md) — workflow-level `currentUser` threading.
//
// A workflow whose guard/body references `currentUser` rendered the bare token
// `current_user` inside the generated workflow function, but `current_user`
// was not a parameter there → `mix compile` failed with
// "undefined variable current_user".  Mirrors the op-level fix (#1568):
//
//   - the workflow `run/1` (+ `run_inner` on the transactional path) thread
//     `current_user \\ nil`,
//   - the `WorkflowsController` action binds `conn.assigns[:current_user]`
//     and passes it through,
//   - a workflow that does NOT name `currentUser` but DOES call a
//     `currentUser`-gated op still threads `current_user` so the op-call
//     resolves (the op context fn takes the trailing actor),
//   - a workflow that references no actor renders byte-identically (no arg).
// ---------------------------------------------------------------------------

const SOURCE = `
system Sales {
  user {
    id: string
    role: string
  }

  subdomain Sales {
    context Sales {
      aggregate Order {
        total: int
        status: string
        operation confirm() {
          requires currentUser.role == "manager"
          status := "confirmed"
        }
      }
      repository Orders for Order { }

      workflow approveOrder transactional {
        create(orderId: Order id) {
          requires currentUser.role == "manager"
          let o = Orders.getById(orderId)
          o.confirm()
        }
      }

      workflow autoConfirm transactional {
        create(orderId: Order id) {
          let o = Orders.getById(orderId)
          o.confirm()
        }
      }

      workflow plainCreate transactional {
        create() {
          let o = Order.create({ total: 0, status: "new" })
        }
      }
    }
  }

  api SalesApi from Sales
  storage primary { type: postgres }
  resource salesState { for: Sales, kind: state, use: primary }
  deployable phoenixApp {
    platform: elixir
    contexts: [Sales]
    dataSources: [salesState]
    serves: SalesApi
    port: 4000
    auth: required
  }
}
`;

async function loadWorkflows() {
  const files = await generateSystemFiles(SOURCE);
  const get = (suffix: string) => files.get([...files.keys()].find((k) => k.endsWith(suffix))!)!;
  return {
    approve: get("/workflows/approve_order.ex"),
    auto: get("/workflows/auto_confirm.ex"),
    plain: get("/workflows/plain_create.ex"),
    controller: get("/controllers/workflows_controller.ex"),
  };
}

describe("vanilla — workflow-level currentUser threading (§11a)", () => {
  it("threads `current_user \\\\ nil` into run/1 of a currentUser-guarded workflow", async () => {
    const { approve } = await loadWorkflows();
    expect(approve).toContain("def run(params, current_user \\\\ nil) when is_map(params) do");
  });

  it("threads current_user into run_inner and passes it through the transaction fn", async () => {
    const { approve } = await loadWorkflows();
    expect(approve).toContain("commit_result(run_inner(params, current_user))");
    expect(approve).toContain("defp run_inner(params, current_user) when is_map(params) do");
  });

  it("renders the guard against the now-bound current_user", async () => {
    const { approve } = await loadWorkflows();
    expect(approve).toMatch(
      /:ok <- \(if current_user\.role == "manager", do: :ok, else: \{:error, :forbidden\}\)/,
    );
  });

  it("passes current_user through to the currentUser-gated op call", async () => {
    const { approve } = await loadWorkflows();
    expect(approve).toContain("Context.confirm_order(o, %{}, current_user)");
  });

  it("threads current_user even when only a gated op (not the body) uses it", async () => {
    const { auto } = await loadWorkflows();
    // autoConfirm never names currentUser, but calls the gated `confirm` op.
    expect(auto).toContain("def run(params, current_user \\\\ nil) when is_map(params) do");
    expect(auto).toContain("Context.confirm_order(o, %{}, current_user)");
  });

  it("the controller binds conn.assigns[:current_user] and passes it through", async () => {
    const { controller } = await loadWorkflows();
    expect(controller).toMatch(
      /def approve_order\(conn, params\) do\n\s+current_user = Map\.get\(conn\.assigns, :current_user\)\n\s+respond\(conn, [\w.]+\.ApproveOrder\.run\(params, current_user\)\)/,
    );
    expect(controller).toMatch(
      /def auto_confirm\(conn, params\) do\n\s+current_user = Map\.get\(conn\.assigns, :current_user\)\n\s+respond\(conn, [\w.]+\.AutoConfirm\.run\(params, current_user\)\)/,
    );
  });

  it("a workflow with no currentUser usage is unchanged (no extra arg, no bind)", async () => {
    const { plain, controller } = await loadWorkflows();
    expect(plain).toContain("def run(params) when is_map(params) do");
    expect(plain).toContain("commit_result(run_inner(params))");
    expect(plain).toContain("defp run_inner(params) when is_map(params) do");
    expect(plain).not.toContain("current_user");
    // The plainCreate controller action carries no current_user bind.
    expect(controller).toMatch(
      /def plain_create\(conn, params\) do\n\s+respond\(conn, [\w.]+\.PlainCreate\.run\(params\)\)/,
    );
  });
});

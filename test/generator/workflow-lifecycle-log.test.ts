// S3 of the domain-seam structured-log parity drain
// (docs/audits/domain-seam-log-parity.md): the catalog `info` events
// `workflow_started` / `workflow_completed` (field `workflow`) must fire at a
// workflow's entry + success tail on EVERY backend.  Before this, only the Ash
// Phoenix foundation emitted them; Hono, .NET, Python, Java, and the vanilla
// Elixir foundation were silent.  Each backend logs through its own catalog
// renderer, so a dashboard pivots on one event name across all of them.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/index.js";

const SRC = (deployable: string) => `
system Acme {
  subdomain Sales {
    context S {
      aggregate Order with crudish {
        sku: string
        operation ship() { active := true }
        active: bool
      }
      repository Orders for Order { }
      workflow shipOrder {
        create(orderId: Order id) {
          let o = Orders.getById(orderId)
          o.ship()
        }
      }
    }
  }
  api SalesApi from Sales
  storage primarySql { type: postgres }
  resource sState { for: S, kind: state, use: primarySql }
  deployable api {
    ${deployable}
    contexts: [S]
    dataSources: [sState]
    serves: SalesApi
    port: 8080
  }
}
`;

const fileEndingWith = async (deployable: string, suffix: string): Promise<string> => {
  const files = await generateSystemFiles(SRC(deployable));
  const hit = [...files.entries()].find(([p]) => p.endsWith(suffix))?.[1];
  expect(hit, `file ending ${suffix}`).toBeDefined();
  return hit as string;
};

describe("workflow lifecycle log events — emitted on every backend (S3)", () => {
  it("Hono logs workflow_started + workflow_completed via the request logger", async () => {
    const wf = await fileEndingWith("platform: node", "http/workflows.ts");
    expect(wf).toContain(
      'requestLog().info({ event: "workflow_started", workflow: "shipOrder" });',
    );
    expect(wf).toContain(
      'requestLog().info({ event: "workflow_completed", workflow: "shipOrder" });',
    );
  });

  it(".NET logs both lifecycle events via the injected ILogger", async () => {
    const handler = await fileEndingWith("platform: dotnet", "ShipOrderHandler.cs");
    expect(handler).toContain("private readonly ILogger<ShipOrderHandler> _log;");
    expect(handler).toContain(
      '_log.LogInformation("{Event} workflow={Workflow}", "workflow_started", "shipOrder");',
    );
    expect(handler).toContain(
      '_log.LogInformation("{Event} workflow={Workflow}", "workflow_completed", "shipOrder");',
    );
  });

  it("Python logs both lifecycle events via the log() facade", async () => {
    const wf = await fileEndingWith("platform: python", "workflows_routes.py");
    // The router imports the `log` facade; execution-context dispatch also pulls in
    // `in_child_context` from the same module (`from app.obs.log import in_child_context, log`),
    // so match the `log` import without pinning the co-import set.
    expect(wf).toMatch(/from app\.obs\.log import [^\n]*\blog\b/);
    expect(wf).toContain('log("info", "workflow_started", workflow="shipOrder")');
    expect(wf).toContain('log("info", "workflow_completed", workflow="shipOrder")');
  });

  it("Java logs both lifecycle events via CatalogLog", async () => {
    const svc = await fileEndingWith("platform: java", "SWorkflows.java");
    expect(svc).toContain("import com.loom.api.config.CatalogLog;");
    expect(svc).toContain('CatalogLog.event("workflow_started", "info", "workflow", "shipOrder");');
    expect(svc).toContain(
      'CatalogLog.event("workflow_completed", "info", "workflow", "shipOrder");',
    );
  });

  it("Elixir (vanilla) logs both lifecycle events and requires Logger", async () => {
    const mod = await fileEndingWith("platform: elixir", "ship_order.ex");
    expect(mod).toContain("require Logger");
    expect(mod).toContain(
      'Logger.info("workflow_started", event: "workflow_started", workflow: "shipOrder")',
    );
    expect(mod).toContain(
      'Logger.info("workflow_completed", event: "workflow_completed", workflow: "shipOrder")',
    );
    // workflow_completed sits on the with-chain's success (do) branch, before
    // the `{:ok, o}` result — not on an `{:error, _}` short-circuit.
    expect(mod).toMatch(/workflow_completed[\s\S]*\{:ok, o\}/);
  });
});

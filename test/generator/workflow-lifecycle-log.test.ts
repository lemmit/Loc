// The TERMINAL half was added later: `workflow_failed` (level `error`, fields
// `workflow` + `error`).  A field-test backend logged `workflow_started` x3,
// `workflow_completed` x3 and `workflow_failed` x0 — a workflow that threw
// logged its start and then NOTHING, so "started but never finished" was
// indistinguishable from "still running" in the log stream, and every
// started/completed pairing in a dashboard leaked one row per failure.  On the
// Hono backend the failure did not even reach the structured pipeline: it fell
// through to a bare `console.error(err)` on raw stderr.
//
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

describe("workflow_failed — the terminal event of a FAILED run", () => {
  it("Hono logs it from the router's onError, naming the workflow off the context", async () => {
    const wf = await fileEndingWith("platform: node", "http/workflows.ts");
    // The command route parks its name on the request context...
    expect(wf).toContain('httpCtx.set("workflow", "shipOrder");');
    // ...and the ONE onError serving every route in the file reads it back, so
    // the failure is attributed without closing over a single workflow.
    expect(wf).toContain('const failedWorkflow = c.get("workflow");');
    expect(wf).toContain(
      'c.get("log").error({ event: "workflow_failed", workflow: failedWorkflow, error: err instanceof Error ? err.message : String(err) });',
    );
    // And the whole ladder is on the structured pipeline now — no arm of it
    // dumps the raw exception to stderr behind pino's back.
    expect(wf).not.toContain("console.error");
    expect(wf).toContain('c.get("log").error({ event: "internal_error"');
  });

  it("Java logs it from a catch on the child-frame try, then re-throws", async () => {
    const svc = await fileEndingWith("platform: java", "SWorkflows.java");
    expect(svc).toContain("} catch (RuntimeException __e) {");
    expect(svc).toContain(
      'CatalogLog.event("workflow_failed", "error", "workflow", "shipOrder", "error", String.valueOf(__e.getMessage()));',
    );
    // Re-thrown unchanged: the @ControllerAdvice status mapping is untouched.
    expect(svc).toMatch(/workflow_failed[\s\S]{0,200}throw __e;/);
  });

  it("Python logs it from an except around the body, then bare-raises", async () => {
    const wf = await fileEndingWith("platform: python", "workflows_routes.py");
    expect(wf).toContain("    try:");
    expect(wf).toContain("    except Exception as exc:");
    expect(wf).toContain(
      '        log("error", "workflow_failed", workflow="shipOrder", error=str(exc))',
    );
    // A BARE `raise` — the original exception and traceback continue to
    // FastAPI's handler, so the response status is exactly what it was.
    expect(wf).toMatch(/workflow_failed[\s\S]{0,120}\n {8}raise\n/);
    // The body really did move inside the try (8-space pad), not stay beside it.
    expect(wf).toContain("        return Response(status_code=204)");
  });

  it("Elixir reports it off the run/1 result, which is result-tuple shaped", async () => {
    const mod = await fileEndingWith("platform: elixir", "ship_order.ex");
    // No `catch` to hang this on — the body's with-chain short-circuits to
    // `{:error, reason}`, so the RESULT is piped through a reporter.
    expect(mod).toContain("|> report_result()");
    expect(mod).toContain("def report_result({:error, reason} = result) do");
    expect(mod).toContain(
      'Logger.error("workflow_failed", event: "workflow_failed", workflow: "shipOrder", error: inspect(reason))',
    );
    // The success clause passes the result through untouched.
    expect(mod).toContain("def report_result(result), do: result");
  });

  // .NET is the one backend still silent on failure, and deliberately so: its
  // handler body is assembled as one string and the non-transactional path
  // would have to be RE-INDENTED to sit inside a try.  `--sourcemap` anchors a
  // .NET workflow's statement fragments by EXACT-TEXT search
  // (`SourceMapRecorder.fragment` → `content.indexOf(fragmentText)`, which
  // silently gives up on a miss), so the extra indent would quietly drop every
  // workflow fragment from the map.  Trading a debugger seam for a log line is
  // the wrong trade; the honest fix is a Mediator pipeline behavior, which is
  // its own slice.  This assertion is the RECORD of that gap — delete it in the
  // PR that closes it.
  it(".NET does not yet log it (recorded gap — see comment)", async () => {
    const handler = await fileEndingWith("platform: dotnet", "ShipOrderHandler.cs");
    expect(handler).toContain('"workflow_started"');
    expect(handler).not.toContain('"workflow_failed"');
  });
});

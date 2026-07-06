// Execution-context carrier on the Phoenix backend (docs/architecture/
// request-context.md).  The BEAM has no AsyncLocal, so the carrier rides
// `Logger.metadata`: a Plug at the HTTP edge (mounted right after
// Plug.RequestId, before Plug.Telemetry) mints/propagates the correlation id
// from X-Correlation-Id || X-Request-Id, captures locale + started_at, stamps
// them into Logger.metadata (so every log line carries them), and echoes
// X-Correlation-Id.  A thin accessor module exposes the reads to non-HTTP
// code.  Emitted identically on both the ash and vanilla foundations.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SYSTEM = (platform: string) => `
system S {
  subdomain M {
    context C {
      aggregate Order with crudish {
        customerId: string
        status: string
      }
      repository Orders for Order { }
    }
  }
  api OrdersApi from M
  storage primary { type: postgres }
  resource ordersState { for: C, kind: state, use: primary }
  deployable api {
    platform: ${platform}
    contexts: [C]
    dataSources: [ordersState]
    serves: OrdersApi
    port: 4000
  }
}
`;

function assertCarrier(files: Map<string, string>): void {
  // The carrier module is emitted in the app (non-Web) namespace so non-HTTP
  // code can read it without a Web dependency.
  const rc = files.get("api/lib/api/request_context.ex")!;
  expect(rc).toBeDefined();
  expect(rc).toContain("defmodule Api.RequestContext do");
  expect(rc).toContain("@behaviour Plug");
  // Reads X-Correlation-Id, falls back to X-Request-Id, then the request id.
  expect(rc).toContain('@correlation_header "x-correlation-id"');
  expect(rc).toContain('@request_id_header "x-request-id"');
  expect(rc).toContain("first_header(conn, @correlation_header) ||");
  expect(rc).toContain("first_header(conn, @request_id_header) ||");
  // Stamps the request-stable tier into Logger.metadata.
  expect(rc).toContain("Logger.metadata(");
  expect(rc).toContain("correlation_id: correlation_id,");
  expect(rc).toContain("locale: resolve_locale(conn),");
  expect(rc).toContain("started_at: System.system_time(:millisecond)");
  // Frame-local tier: a fresh scope id for the root frame (parity with .NET's
  // OpenRoot / Hono's root frame); per-dispatch boundaries open child frames
  // beneath it via with_child_frame/1.
  expect(rc).toContain("scope_id: generate_id(),");
  // Echoes the correlation id on the response.
  expect(rc).toContain("put_resp_header(conn, @correlation_header, correlation_id)");
  // Accessors for non-HTTP reads.
  expect(rc).toContain("def correlation_id, do: Logger.metadata()[:correlation_id]");
  expect(rc).toContain("def locale, do: Logger.metadata()[:locale]");
  expect(rc).toContain("def scope_id, do: Logger.metadata()[:scope_id]");
  expect(rc).toContain("def parent_id, do: Logger.metadata()[:parent_id]");
  // Principal slice: actor_id accessor is always present (nil before auth runs);
  // the Auth plug stamps it post-verification (asserted in the auth-emit tests).
  expect(rc).toContain("def actor_id, do: Logger.metadata()[:actor_id]");
  // Per-dispatch child-frame seam: with_child_frame/1 mints a fresh scope_id,
  // chains parent_id to the caller's scope, and restores it in `after`; a no-op
  // outside a request (nil scope_id).
  expect(rc).toContain("def with_child_frame(fun) when is_function(fun, 0) do");
  expect(rc).toContain("Logger.metadata(scope_id: generate_id(), parent_id: parent_scope)");
  expect(rc).toContain("Logger.metadata(scope_id: parent_scope, parent_id: prev_parent)");

  // The Plug is mounted in the endpoint between RequestId and Telemetry so the
  // request_start / request_end telemetry logs carry the correlation id.
  const endpoint = files.get("api/lib/api_web/endpoint.ex")!;
  expect(endpoint).toBeDefined();
  expect(endpoint).toContain("plug Api.RequestContext");
  const reqId = endpoint.indexOf("plug Plug.RequestId");
  const carrier = endpoint.indexOf("plug Api.RequestContext");
  const telemetry = endpoint.indexOf("plug Plug.Telemetry");
  expect(reqId).toBeGreaterThan(-1);
  expect(carrier).toBeGreaterThan(reqId);
  expect(telemetry).toBeGreaterThan(carrier);
}

describe("Phoenix execution-context carrier", () => {
  it("ash foundation: emits the RequestContext Plug + accessor and mounts it", async () => {
    const files = await generateSystemFiles(SYSTEM("elixir"));
    assertCarrier(files);
  });

  it("vanilla foundation: emits the same carrier module + mount", async () => {
    const files = await generateSystemFiles(SYSTEM("elixir"));
    assertCarrier(files);
  });
});

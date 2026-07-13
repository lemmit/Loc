import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// Slice 4 of docs/old/plans/vanilla-foundation-tdd-plan.md — exception-less
// alignment: per-variant `with`-block / `case` dispatch + shared
// `<App>Web.ProblemDetails` module emitting RFC 7807 envelopes
// byte-aligned with the Ash backend's helper module (and Hono / .NET).
//
// The envelope shape that has to match across backends:
//   * type: "about:blank"
//   * title: "Validation failed" (lowercase "failed")
//   * status: 422
//   * detail: "One or more fields are invalid."
//   * instance: conn.request_path
//   * errors: [%{pointer: "/<camelizedField>", message: "..."}]
//   * application/problem+json content type
//   * x-request-id header propagation
// ---------------------------------------------------------------------------

const VANILLA_SOURCE = `
system Tasks {
  subdomain Productivity {
    context Tracker {
      aggregate Task with crudish {
        title: string
        done: bool
      }
      repository Tasks for Task { }
    }
  }
  api TrackerApi from Productivity
  storage primary { type: postgres }
  resource trackerState { for: Tracker, kind: state, use: primary }
  deployable api {
    platform: elixir
    contexts: [Tracker]
    dataSources: [trackerState]
    serves: TrackerApi
    port: 4000
  }
}
`;

describe("vanilla — Slice 4 RFC 7807 ProblemDetails parity", () => {
  it("emits a shared <App>Web.ProblemDetails module", async () => {
    const files = await generateSystemFiles(VANILLA_SOURCE);
    const pdKey = [...files.keys()].find((k) => k.endsWith("/problem_details.ex"));
    expect(pdKey).toBeDefined();
    const pd = files.get(pdKey!)!;
    expect(pd).toContain("defmodule ApiWeb.ProblemDetails");
    expect(pd).toContain("import Plug.Conn");
  });

  it("ProblemDetails module exposes the three public entry points", async () => {
    const files = await generateSystemFiles(VANILLA_SOURCE);
    const pd = files.get([...files.keys()].find((k) => k.endsWith("/problem_details.ex"))!)!;
    expect(pd).toContain("def validation_error_response(conn, %Ecto.Changeset{} = changeset)");
    expect(pd).toContain("def not_found_response(conn, kind, id)");
    expect(pd).toContain("def problem_response(conn, status, title, detail)");
  });

  it("envelope shape: type: about:blank, title: Validation failed, detail: One or more fields are invalid.", async () => {
    const files = await generateSystemFiles(VANILLA_SOURCE);
    const pd = files.get([...files.keys()].find((k) => k.endsWith("/problem_details.ex"))!)!;
    expect(pd).toContain('type: "about:blank"');
    expect(pd).toContain('title: "Validation failed"');
    expect(pd).toContain('detail: "One or more fields are invalid."');
    expect(pd).toContain("status: 422");
    expect(pd).toContain("instance: conn.request_path");
  });

  it("validation_error_response emits errors: [%{pointer, message}] entries", async () => {
    const files = await generateSystemFiles(VANILLA_SOURCE);
    const pd = files.get([...files.keys()].find((k) => k.endsWith("/problem_details.ex"))!)!;
    expect(pd).toContain("%{pointer: pointer_of([field]), message: interpolated}");
    expect(pd).toContain("errors: pointer_errors");
  });

  it("ProblemDetails sets application/problem+json content type and x-request-id header", async () => {
    const files = await generateSystemFiles(VANILLA_SOURCE);
    const pd = files.get([...files.keys()].find((k) => k.endsWith("/problem_details.ex"))!)!;
    expect(pd).toContain('put_resp_content_type("application/problem+json")');
    expect(pd).toContain('put_resp_header("x-request-id", trace_id)');
    expect(pd).toContain('get_resp_header("x-request-id")');
  });

  it("ProblemDetails camelizes snake_case field names in JSON pointers (matches JasonCamelCase)", async () => {
    const files = await generateSystemFiles(VANILLA_SOURCE);
    const pd = files.get([...files.keys()].find((k) => k.endsWith("/problem_details.ex"))!)!;
    expect(pd).toContain("defp camelize(str)");
    expect(pd).toContain("Enum.map_join(rest");
    expect(pd).toContain("escape_segment");
    // RFC 6901 escapes (~ → ~0, / → ~1)
    expect(pd).toContain('String.replace("~", "~0")');
    expect(pd).toContain('String.replace("/", "~1")');
  });

  it("Controller now aliases <App>Web.ProblemDetails and uses the shared helpers", async () => {
    const files = await generateSystemFiles(VANILLA_SOURCE);
    const ctl = files.get(
      [...files.keys()].find((k) => k.endsWith("/controllers/task_controller.ex"))!,
    )!;
    expect(ctl).toContain("alias ApiWeb.ProblemDetails");
    expect(ctl).toContain('ProblemDetails.not_found_response(conn, "Task", id)');
    expect(ctl).toContain("ProblemDetails.validation_error_response(conn, changeset)");
    // Inline helpers from Slice 2 are now gone (replaced by alias):
    expect(ctl).not.toContain("defp not_found");
    expect(ctl).not.toContain("defp validation_error");
    expect(ctl).not.toContain("Ecto.Changeset.traverse_errors");
  });
});

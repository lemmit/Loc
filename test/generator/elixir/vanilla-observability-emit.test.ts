import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// Observability surface on vanilla — parity with the Ash shell.
//
// Vanilla now emits the same cross-backend log-event catalog over the same
// JSON-per-line envelope as the Ash, Hono, .NET, Java, and Python backends.
// This test pins the emission shape; the boot-and-hit gate that asserts the
// events actually land on stdout under `mix phx.server` lives in
// `test/e2e/observability-events-elixir-vanilla.test.ts` (LOOM_OBS_E2E_PHOENIX_VANILLA=1).
// ---------------------------------------------------------------------------

const SOURCE = `
system Tasks {
  subdomain Productivity {
    context Tracker {
      aggregate Task with crudish {
        title: string
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

async function load(): Promise<Map<string, string>> {
  return generateSystemFiles(SOURCE);
}

describe("vanilla — application boot emits the catalog server lifecycle", () => {
  it("emits server_starting / server_listening / server_shutdown / server_drained from Application.start/stop", async () => {
    const files = await load();
    const app = files.get("api/lib/api/application.ex")!;
    expect(app).toContain('Logger.info("server_starting"');
    expect(app).toContain('Logger.info("server_listening"');
    expect(app).toContain('Logger.info("server_shutdown"');
    expect(app).toContain('Logger.info("server_drained"');
    // event metadata rides every line so the catalog identity survives
    // the Logger pipeline.
    expect(app).toContain('event: "server_starting"');
    expect(app).toContain('event: "server_listening"');
  });

  it("references Api.Telemetry (the catalog translator) in the children list, not the legacy ApiWeb.Telemetry", async () => {
    const files = await load();
    const app = files.get("api/lib/api/application.ex")!;
    expect(app).toContain("Api.Telemetry");
    expect(app).not.toContain("ApiWeb.Telemetry");
  });
});

describe("vanilla — log_formatter.ex carries the JSON envelope", () => {
  it("emits lib/<app>/log_formatter.ex with the format/4 entrypoint", async () => {
    const files = await load();
    const formatter = files.get("api/lib/api/log_formatter.ex");
    expect(formatter).toBeDefined();
    expect(formatter!).toContain("defmodule Api.LogFormatter do");
    expect(formatter!).toContain("def format(level, message, timestamp, metadata)");
  });

  it("config/config.exs wires :logger's default formatter to <App>.LogFormatter", async () => {
    const files = await load();
    const cfg = files.get("api/config/config.exs")!;
    expect(cfg).toContain("config :logger, :default_formatter");
    expect(cfg).toContain("format: {Api.LogFormatter, :format}");
    expect(cfg).toContain("metadata: :all");
  });
});

describe("vanilla — telemetry.ex translates Phoenix endpoint events into the catalog", () => {
  it("emits lib/<app>/telemetry.ex (relocated from lib/<app>_web/telemetry.ex)", async () => {
    const files = await load();
    expect(files.get("api/lib/api/telemetry.ex")).toBeDefined();
    expect(files.get("api/lib/api_web/telemetry.ex")).toBeUndefined();
  });

  it("attaches to phoenix.endpoint events and renders request_start / request_end log calls", async () => {
    const files = await load();
    const tel = files.get("api/lib/api/telemetry.ex")!;
    expect(tel).toContain("defmodule Api.Telemetry do");
    expect(tel).toContain("[:phoenix, :endpoint, :start]");
    expect(tel).toContain("[:phoenix, :endpoint, :stop]");
    expect(tel).toContain('Logger.info("request_start"');
    expect(tel).toContain('Logger.info("request_end"');
    expect(tel).toContain("duration_ms");
  });

  it("does NOT subscribe to Ash domain events (foundation-agnostic — emitTrace stays off on vanilla)", async () => {
    const files = await load();
    const tel = files.get("api/lib/api/telemetry.ex")!;
    expect(tel).not.toContain("[:ash, :validation");
    expect(tel).not.toContain("[:ash, :change");
    expect(tel).not.toContain("invariant_evaluated");
  });
});

describe("vanilla — observability surface is foundation-agnostic", () => {
  it("no emitted file references Ash anywhere on the obs path", async () => {
    const files = await load();
    for (const p of [
      "api/lib/api/application.ex",
      "api/lib/api/log_formatter.ex",
      "api/lib/api/telemetry.ex",
      "api/lib/api/request_context.ex",
      "api/config/config.exs",
    ]) {
      const body = files.get(p)!;
      expect(body).not.toContain("AshPostgres");
      expect(body).not.toContain("use Ash.Resource");
    }
  });

  it("mix.exs drops the legacy telemetry_metrics / telemetry_poller deps (catalog translator uses :telemetry directly)", async () => {
    const files = await load();
    const mix = files.get("api/mix.exs")!;
    expect(mix).not.toContain(":telemetry_metrics");
    expect(mix).not.toContain(":telemetry_poller");
  });
});

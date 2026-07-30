import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AGENT_SETTINGS_STORAGE_KEY } from "../../web/src/agent/provider.js";
import { withLiveCrash } from "../../web/src/util/crash-context.js";
import {
  buildCrashReport,
  type CrashReportInput,
  crashIssueUrl,
  fingerprintFiles,
  ISSUE_LABEL,
  ISSUE_TEMPLATE,
  ISSUE_URL_BUDGET,
  redact,
  stripUrl,
  TRUNCATION_NOTE,
} from "../../web/src/util/crash-report.js";
import type { DiagSnapshot } from "../../web/src/util/diagnostics.js";

// ---------------------------------------------------------------------------
// M-T8.14 slice 2 — the report artifact.
//
// The playground is a static site with no beacon, so the report IS the
// transport: everything a triager gets, the user pastes.  These tests pin the
// two properties that makes that workable — it is COMPLETE (build SHA, crash
// class, message, stack, component stack, pressure, fingerprint) and it is
// SAFE (no source text, no credentials, and structurally no access to the
// BYOK key).
// ---------------------------------------------------------------------------

const BUILD = { sha: "abc123def456", builtAt: "2026-07-30T09:00:00.000Z" };

function snap(over: Partial<DiagSnapshot> = {}): DiagSnapshot {
  return {
    t: "2026-07-30T10:00:00.000Z",
    reason: "hidden",
    build: BUILD,
    ua: "Mozilla/5.0 (X11; Linux x86_64) Chrome/140",
    vw: 1280,
    vh: 720,
    hashLen: 0,
    ...over,
  };
}

function crashSnap(over: Partial<DiagSnapshot> = {}): DiagSnapshot {
  return snap({
    reason: "react-error-pane",
    detail: {
      message: "Cannot read properties of undefined (reading 'kind')",
      stack:
        "Error: boom\n    at Pane (index-9f2.js:12:44)\n    at renderWithHooks (react-9f2.js:1:2)",
      componentStack: "\n    at BuilderPane\n    at PaneErrorBoundary",
      pane: "Builder",
    },
    ...over,
  });
}

function input(over: Partial<CrashReportInput> = {}): CrashReportInput {
  return {
    snapshots: [snap(), crashSnap()],
    build: BUILD,
    ua: "Mozilla/5.0 (X11; Linux x86_64) Chrome/140",
    viewport: { w: 1280, h: 720 },
    url: "https://lemmit.github.io/Loc/playground/?x=1#project=eJyrVkrLz1eyUlAqSy0qzszPUwjJz1MAAJbfB4E",
    generatedAt: "2026-07-30T10:00:01.000Z",
    ...over,
  };
}

describe("crash report — completeness", () => {
  it("carries build SHA, crash class, message, stack and component stack", () => {
    const report = buildCrashReport(input());
    expect(report).toContain("abc123def456");
    expect(report).toContain("`react-error-pane`");
    expect(report).toContain("Cannot read properties of undefined");
    expect(report).toContain("at renderWithHooks");
    expect(report).toContain("at PaneErrorBoundary");
    expect(report).toContain("pane: `Builder`");
  });

  it("carries UA, viewport and the pressure readings the ring already held", () => {
    const report = buildCrashReport(
      input({
        snapshots: [
          crashSnap({
            mem: { usedMB: 120, totalMB: 200, limitMB: 2200 },
            storage: { usageMB: 3, quotaMB: 500, pct: 1 },
          }),
        ],
      }),
    );
    expect(report).toContain("Chrome/140");
    expect(report).toContain("1280×720");
    expect(report).toContain("heap 120/2200 MB");
    expect(report).toContain("storage 3/500 MB (1%)");
  });

  it("separates error-class entries from pressure breadcrumbs", () => {
    const report = buildCrashReport(input());
    const crashes = report.indexOf("#### Crashes");
    const crumbs = report.indexOf("#### Breadcrumbs");
    expect(crashes).toBeGreaterThan(-1);
    expect(crumbs).toBeGreaterThan(crashes);
    // The `hidden` breadcrumb is listed as one, not as a crash.
    expect(report.slice(crumbs)).toContain("`hidden`");
    expect(report.slice(crashes, crumbs)).not.toContain("`hidden`");
  });

  it("says so, rather than lying, when the ring holds no error", () => {
    const report = buildCrashReport(input({ snapshots: [snap()] }));
    expect(report).toContain("_No error-class entries in the ring._");
  });

  it("is deterministic — same input, byte-identical output", () => {
    expect(buildCrashReport(input())).toBe(buildCrashReport(input()));
  });

  it("notes when a crash came from a DIFFERENT build than the one reporting", () => {
    const stale = crashSnap({ build: { sha: "0000deadbeef", builtAt: "" } });
    const report = buildCrashReport(input({ snapshots: [stale] }));
    expect(report).toContain("captured on build: `0000deadbeef`");
  });
});

describe("crash report — redaction (normative)", () => {
  it("never contains .ddd source text — the workspace is a fingerprint", async () => {
    const source = "system Shop { module Sales { aggregate Order { total Money } } }";
    const workspace = await fingerprintFiles([{ path: "/workspace/main.ddd", content: source }]);
    const report = buildCrashReport(input({ workspace }));
    expect(report).not.toContain("aggregate Order");
    expect(report).not.toContain(source);
    expect(report).toContain("/workspace/main.ddd");
    expect(report).toContain(String(source.length));
    // 12 hex chars of SHA-256, not the content.
    expect(report).toMatch(/\| `[0-9a-f]{12}` \|/);
  });

  it("strips query and hash from URLs — the share hash encodes the model", () => {
    expect(stripUrl("https://host/playground/?a=1#project=SECRET")).toBe(
      "https://host/playground/",
    );
    const report = buildCrashReport(input());
    expect(report).not.toContain("#project=");
    expect(report).not.toContain("eJyrVkrLz1eyUlAqSy0qzszPUwjJz1MAAJbfB4E");
  });

  it.each([
    ["openai/anthropic", "sk-ant-api03-QQQQQQQQQQQQQQQQQQQQQQQQ"],
    ["github classic PAT", "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"],
    ["github fine-grained", "github_pat_11AAAAAAA0abcdefghijklmnop"],
    ["aws access key", "AKIAIOSFODNN7EXAMPLE"],
    ["slack", "xoxb-1234567890-ABCDEFGHIJKL"],
    [
      "jwt",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    ],
  ])("redacts a %s credential shape out of free text", (_name, secret) => {
    expect(redact(`failed with ${secret} in the header`)).not.toContain(secret);
    const report = buildCrashReport(
      input({ snapshots: [crashSnap({ detail: { message: `boom: ${secret}` } })] }),
    );
    expect(report).not.toContain(secret);
    expect(report).toContain("[redacted]");
  });

  it("redacts `key=` / `token:` / bearer parameter shapes", () => {
    expect(redact("apiKey=hunter2hunter2")).not.toContain("hunter2hunter2");
    expect(redact("token: abcd1234efgh")).not.toContain("abcd1234efgh");
    expect(redact("Authorization: Bearer abcd1234efghij")).not.toContain("abcd1234efghij");
    expect(redact("password=correcthorsebattery")).not.toContain("correcthorsebattery");
    // The key NAME survives so the shape is still recognisable in triage.
    expect(redact("apiKey=hunter2hunter2")).toContain("apiKey");
  });

  it("is idempotent — re-redacting a report changes nothing", () => {
    const report = buildCrashReport(input());
    expect(redact(report)).toBe(report);
  });

  it("cannot leak the BYOK key: the assembler never touches storage", () => {
    // The exact localStorage entry that holds `apiKey` (agent/provider.ts).
    // Pinned here so a rename there breaks THIS test rather than quietly
    // widening what a report is allowed to read.
    expect(AGENT_SETTINGS_STORAGE_KEY).toBe("loom.agent.settings");

    const read = (rel: string): string =>
      readFileSync(fileURLToPath(new URL(`../../web/src/util/${rel}`, import.meta.url)), "utf8");

    const assembler = read("crash-report.ts");
    // Structural guarantee, not a spot-check: the assembler has NO ambient
    // read at all, so there is no code path from settings to a report.
    expect(assembler).not.toContain("localStorage");
    expect(assembler).not.toContain("sessionStorage");
    expect(assembler).not.toContain(AGENT_SETTINGS_STORAGE_KEY);

    // The collector is the one module that reads ambient state; it must read
    // the diagnostics ring and nothing else.
    const collector = read("crash-context.ts");
    expect(collector).not.toContain(AGENT_SETTINGS_STORAGE_KEY);
    expect(collector).not.toContain("apiKey");
  });

  it("redacts an apiKey-shaped value even if one reaches a stack frame", () => {
    const leaked = 'loadAgentSettings({"apiKey":"sk-or-v1-9f2ab7c0d1e2f3a4b5c6"})';
    const report = buildCrashReport(
      input({ snapshots: [crashSnap({ detail: { message: leaked } })] }),
    );
    expect(report).not.toContain("sk-or-v1-9f2ab7c0d1e2f3a4b5c6");
  });
});

describe("crash report — truncation budgets", () => {
  const saturated = (): DiagSnapshot[] =>
    Array.from({ length: 12 }, (_, i) =>
      crashSnap({
        t: `2026-07-30T10:00:${String(i).padStart(2, "0")}.000Z`,
        detail: {
          message: `crash number ${i} `.repeat(20),
          stack: Array.from(
            { length: 60 },
            (_, f) => `    at frame${f} (index-9f2.js:${f}:1)`,
          ).join("\n"),
          componentStack: Array.from({ length: 40 }, (_, f) => `    at Comp${f}`).join("\n"),
          pane: "Builder",
        },
      }),
    );

  it("keeps the NEWEST snapshots and says how many it dropped", () => {
    const report = buildCrashReport(input({ snapshots: saturated(), maxSnapshots: 4 }));
    expect(report).toContain("2026-07-30T10:00:11.000Z"); // newest
    expect(report).not.toContain("2026-07-30T10:00:00.000Z"); // oldest
    expect(report).toContain(TRUNCATION_NOTE);
    expect(report).toContain("8 older snapshot(s) omitted");
  });

  it("caps stack frames per crash", () => {
    const report = buildCrashReport(input({ snapshots: [saturated()[0]!], maxStackFrames: 15 }));
    expect(report).toContain("at frame14");
    expect(report).not.toContain("at frame15");
    expect(report).toContain("more frame(s) truncated");
  });

  it("keeps the prefill URL under budget for a saturated ring", () => {
    const url = crashIssueUrl(input({ snapshots: saturated() }));
    expect(url.length).toBeLessThanOrEqual(ISSUE_URL_BUDGET);
    expect(url).toContain(`template=${ISSUE_TEMPLATE}`);
    expect(url).toContain(`labels=${ISSUE_LABEL}`);
    expect(url).toContain("report=");
    expect(url.startsWith("https://github.com/lemmit/Loc/issues/new?")).toBe(true);
  });

  it("stays under budget even for one pathological stack", () => {
    const monster = crashSnap({
      detail: {
        message: "x".repeat(500),
        stack: Array.from({ length: 15 }, () => `    at ${"y".repeat(400)}`).join("\n"),
      },
    });
    const url = crashIssueUrl(input({ snapshots: [monster] }));
    expect(url.length).toBeLessThanOrEqual(ISSUE_URL_BUDGET);
    // `URLSearchParams` encodes spaces as `+`, so decode via the parser.
    expect(new URL(url).searchParams.get("report")).toContain(TRUNCATION_NOTE);
  });

  it("prefills by FIELD ID — an issue form ignores `?body=`", () => {
    const url = new URL(crashIssueUrl(input()));
    expect(url.searchParams.get("body")).toBeNull();
    expect(url.searchParams.get("report")).toContain("Loom playground crash report");
  });

  it("the clipboard artifact is unbounded — it keeps what the URL sheds", () => {
    const full = buildCrashReport(input({ snapshots: saturated() }));
    expect(full).toContain("2026-07-30T10:00:00.000Z"); // the oldest survives
    expect(full.length).toBeGreaterThan(ISSUE_URL_BUDGET);
  });
});

describe("crash report — live-crash splice", () => {
  const live = { reason: "react-error", detail: { message: "boom" } };

  it("adds a just-caught crash the async ring write hasn't persisted yet", () => {
    const out = withLiveCrash([snap()], live, "2026-07-30T10:00:05.000Z");
    expect(out).toHaveLength(2);
    expect(out[1]?.reason).toBe("react-error");
  });

  it("does not double-report one already in the ring", () => {
    const ring = [snap(), crashSnap({ reason: "react-error", detail: { message: "boom" } })];
    expect(withLiveCrash(ring, live, "2026-07-30T10:00:05.000Z")).toHaveLength(2);
  });

  it("is a no-op without a live crash", () => {
    const ring = [snap()];
    expect(withLiveCrash(ring, undefined, "t")).toBe(ring);
  });
});

describe("workspace fingerprint", () => {
  it("emits path + byte length + 12 hex chars, sorted by path", async () => {
    const fp = await fingerprintFiles([
      { path: "/workspace/z.ddd", content: "bb" },
      { path: "/workspace/a.ddd", content: "a" },
    ]);
    expect(fp.map((f) => f.path)).toEqual(["/workspace/a.ddd", "/workspace/z.ddd"]);
    expect(fp[0]?.bytes).toBe(1);
    expect(fp[0]?.sha).toMatch(/^[0-9a-f]{12}$/);
    expect(fp.map((f) => f.sha)).not.toContain("a");
  });

  it("counts BYTES, not characters", async () => {
    const fp = await fingerprintFiles([{ path: "/workspace/x.ddd", content: "€" }]);
    expect(fp[0]?.bytes).toBe(3);
  });
});

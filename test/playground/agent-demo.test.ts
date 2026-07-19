import { describe, expect, it } from "vitest";
import type { GenerateReport, ValidateReport } from "../../src/api/index.js";
import { callTool } from "../../src/tools/index.js";
import { type AgentMessage, runAgentDemo, TASK_TRACKER_DDD } from "../../web/src/agent/demo.js";

// The deterministic agent demo (M-T8.3 wedge: prose → .ddd → generate → green).
// Headless-testable by construction: the driver runs the real browser-safe
// tools, so this locks BOTH that the authored source stays valid/generatable
// AND that the scripted loop reaches a green conclusion.

describe("agent demo", () => {
  it("TASK_TRACKER_DDD validates clean and generates a node+react stack", async () => {
    const v = (await callTool("loom_validate", { source: TASK_TRACKER_DDD })) as ValidateReport;
    expect(v.ok).toBe(true);
    expect(v.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const g = (await callTool("loom_generate", { source: TASK_TRACKER_DDD })) as GenerateReport;
    expect(g.ok).toBe(true);
    expect(g.deployables.map((d) => d.platform).sort()).toEqual(["node", "react"]);
  });

  it("runAgentDemo plays the scripted loop to a green conclusion", async () => {
    let messages: AgentMessage[] = [];
    let appliedSource = "";
    let generated = false;
    await runAgentDemo({
      setMessages: (fn) => {
        messages = fn(messages);
      },
      applySource: (ddd) => {
        appliedSource = ddd;
      },
      triggerGenerate: () => {
        generated = true;
      },
      delayMs: 0,
    });

    // Opens with the user's prompt.
    expect(messages[0]?.role).toBe("user");
    // The agent authored the model into the editor and kicked a real generate.
    expect(appliedSource).toBe(TASK_TRACKER_DDD);
    expect(generated).toBe(true);
    // The real tool calls landed their results.
    const tools = messages.flatMap((m) => m.toolCalls ?? []);
    expect(tools.find((t) => t.tool === "loom_validate")?.result).toBe("0 errors");
    expect(tools.find((t) => t.tool === "loom_generate")?.status).toBe("ok");
    // No dangling "running"/pending state at the end.
    expect(tools.every((t) => t.status !== "running")).toBe(true);
    expect(messages.every((m) => !m.pending)).toBe(true);
    // Concludes green.
    expect(messages.at(-1)?.text).toMatch(/Done/);
  });

  it("aborts cleanly when signalled", async () => {
    let messages: AgentMessage[] = [];
    const signal = { cancelled: true };
    await runAgentDemo({
      setMessages: (fn) => {
        messages = fn(messages);
      },
      applySource: () => {},
      triggerGenerate: () => {},
      delayMs: 0,
      signal,
    });
    // Cancelled up front ⇒ never gets past the user turn.
    expect(messages.length).toBeLessThanOrEqual(2);
  });
});

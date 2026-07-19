// ---------------------------------------------------------------------------
// Deterministic agent demo — the M-T8.3 "wedge": prose → `.ddd` → generate →
// green, driven by a SCRIPTED agent (no live LLM, so it's reproducible enough
// to double as a Playwright e2e).  The script is canned, but every step runs
// the REAL browser-safe agent tools (`callTool` over `src/api/`) against the
// evolving source, so the results (validation, deployable manifest) are
// genuine — the same `loom_validate` / `loom_generate` an MCP client would get.
//
// This is intentionally the deterministic variant of the chat loop: the live-
// LLM transport (`Complete`) is a separate, decision-bearing slice.  Here the
// value is showing the loop end-to-end, faithfully, on a fixed transcript.
// ---------------------------------------------------------------------------

import type { GenerateReport, ValidateReport } from "../../../src/api/index.js";
import { callTool } from "../../../src/tools/index.js";

/** The model the scripted agent "authors" from the prompt.  Validated + full-
 *  system-generated in CI (`agent-demo.test.ts`) so the demo can't rot into a
 *  broken source. */
export const TASK_TRACKER_DDD = `system TaskTracker {
  subdomain Work {
    context Work {
      enum Status { Todo, Doing, Done }

      aggregate Task with crudish {
        title: string
        status: Status
        invariant title.length > 0
        derived isDone: bool = status == Done
      }
    }
  }

  ui Board with scaffold(subdomains: [Work]) {
  }

  storage primary { type: postgres }
  resource workState { for: Work, kind: state, use: primary }

  deployable api {
    platform: node
    contexts: [Work]
    dataSources: [workState]
    port: 3000
  }

  deployable board {
    platform: react
    targets: api
    ui: Board
    port: 3001
  }
}
`;

/** The user's opening prompt, shown as the first chat turn. */
export const DEMO_PROMPT =
  "Build a task tracker: a Task with a title and a status (Todo / Doing / Done), " +
  "plus a done flag derived from the status. Generate a Node/Hono API and a React board.";

export type AgentRole = "user" | "assistant";
export type ToolStatus = "running" | "ok" | "error";

/** One tool invocation shown inline in an assistant turn — the real
 *  `callTool` result, rendered to a short human summary. */
export interface AgentToolCall {
  tool: string;
  /** What the call is doing, in prose. */
  label: string;
  status: ToolStatus;
  /** Rendered result summary (filled once the call resolves). */
  result?: string;
}

export interface AgentMessage {
  id: string;
  role: AgentRole;
  text: string;
  toolCalls?: AgentToolCall[];
  /** True while the agent is still producing this turn. */
  pending?: boolean;
}

/** Mutations the driver performs on the outside world. */
export interface AgentDemoDeps {
  /** Replace the chat message list (React setState updater form). */
  setMessages: (fn: (prev: AgentMessage[]) => AgentMessage[]) => void;
  /** Push the authored `.ddd` into the editor / LSP (the source sink). */
  applySource: (ddd: string) => void;
  /** Kick the real playground generate so the Files pane populates. */
  triggerGenerate: () => void;
  /** Pacing between steps (ms).  0 in tests for speed. */
  delayMs?: number;
  /** Cooperative cancellation (set `.cancelled` to abort mid-run). */
  signal?: { cancelled: boolean };
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let seq = 0;
const nextId = (): string => `m${++seq}`;

/** Run the scripted demo end to end.  Deterministic: the transcript is fixed
 *  and every tool call runs the real `callTool`, so a given run always
 *  produces the same messages + results (timing aside). */
export async function runAgentDemo(deps: AgentDemoDeps): Promise<void> {
  const { setMessages, applySource, triggerGenerate, signal } = deps;
  const delayMs = deps.delayMs ?? 550;
  const pace = (): Promise<void> => wait(delayMs);
  const stopped = (): boolean => signal?.cancelled === true;

  const push = (m: AgentMessage): string => {
    setMessages((prev) => [...prev, m]);
    return m.id;
  };
  const patch = (id: string, p: Partial<AgentMessage>): void => {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...p } : m)));
  };

  // 0) Reset to just the user's prompt.
  seq = 0;
  const userId = nextId();
  setMessages(() => [{ id: userId, role: "user", text: DEMO_PROMPT }]);
  await pace();
  if (stopped()) return;

  // 1) The agent explains the model it will author.
  const planId = push({
    id: nextId(),
    role: "assistant",
    text:
      "Here's the Loom model — one `Task` aggregate in a `Work` context, a `Status` " +
      "enum, and `isDone` derived from the status. I'll wire a Node/Hono API and a " +
      "React board over it.",
  });
  await pace();
  if (stopped()) return;

  // 2) Author the source (push it into the editor).
  patch(planId, { toolCalls: [{ tool: "edit", label: "Writing main.ddd", status: "running" }] });
  applySource(TASK_TRACKER_DDD);
  await pace();
  patch(planId, {
    toolCalls: [{ tool: "edit", label: "Wrote main.ddd", status: "ok", result: `${TASK_TRACKER_DDD.trim().split("\n").length} lines` }],
  });
  if (stopped()) return;

  // 3) Validate — the repair loop's oracle (real loom_validate).
  const valId = push({
    id: nextId(),
    role: "assistant",
    text: "Validating the model…",
    toolCalls: [{ tool: "loom_validate", label: "loom_validate(main.ddd)", status: "running" }],
    pending: true,
  });
  const validate = (await callTool("loom_validate", { source: TASK_TRACKER_DDD })) as ValidateReport;
  const errors = validate.diagnostics.filter((d) => d.severity === "error").length;
  patch(valId, {
    text: validate.ok ? "The model is valid — no errors." : "The model has errors.",
    pending: false,
    toolCalls: [
      {
        tool: "loom_validate",
        label: "loom_validate(main.ddd)",
        status: validate.ok ? "ok" : "error",
        result: validate.ok ? "0 errors" : `${errors} error(s)`,
      },
    ],
  });
  await pace();
  if (stopped() || !validate.ok) return;

  // 4) Report the deployable manifest (real loom_generate).
  const genId = push({
    id: nextId(),
    role: "assistant",
    text: "Deriving the deployable stack…",
    toolCalls: [{ tool: "loom_generate", label: "loom_generate(main.ddd)", status: "running" }],
    pending: true,
  });
  const gen = (await callTool("loom_generate", { source: TASK_TRACKER_DDD })) as GenerateReport;
  const manifest = gen.deployables.map((d) => `${d.name} (${d.platform}:${d.port})`).join(", ");
  patch(genId, {
    text: `That's ${gen.deployables.length} deployable${gen.deployables.length === 1 ? "" : "s"}: ${manifest}.`,
    pending: false,
    toolCalls: [
      {
        tool: "loom_generate",
        label: "loom_generate(main.ddd)",
        status: gen.ok ? "ok" : "error",
        result: manifest,
      },
    ],
  });
  await pace();
  if (stopped()) return;

  // 5) Emit the real project tree into the Files pane, and conclude.
  triggerGenerate();
  push({
    id: nextId(),
    role: "assistant",
    text:
      "✅ Done — prose to a validated model to a generated stack. The full project tree is " +
      "in the Files pane; open Preview to boot the Hono API + React board in-browser.",
  });
}

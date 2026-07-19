import { describe, expect, it } from "vitest";
import type { Message } from "../../src/tools/index.js";
import type { AgentMessage } from "../../web/src/agent/demo.js";
import {
  foldTranscript,
  latestSourceFrom,
  runLiveAgent,
  seedUserText,
  summarizeToolResult,
} from "../../web/src/agent/live.js";
import { createOpenAiCompatibleComplete } from "../../web/src/agent/openai-transport.js";

// ---------------------------------------------------------------------------
// Live agent chat orchestration (M-T8.3) — the pure fold/summary/source-recovery
// helpers, and an end-to-end `runLiveAgent` driven by a scripted transport (no
// network).  This is the browser-safe engine the Agent dock tab's live mode runs.
// ---------------------------------------------------------------------------

const CLEAN = `context Sales {
  aggregate Order { total: int }
}
`;

function oaiResponse(message: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ choices: [{ message }] }),
    text: async () => JSON.stringify({ choices: [{ message }] }),
  } as unknown as Response;
}

describe("summarizeToolResult", () => {
  it("reads the common tools' results", () => {
    expect(summarizeToolResult("loom_validate", '{"ok":true}')).toBe("0 errors");
    expect(summarizeToolResult("loom_validate", '{"ok":false,"summary":{"errors":3}}')).toBe(
      "3 error(s)",
    );
    expect(summarizeToolResult("loom_generate", '{"ok":true,"deployables":[{},{}]}')).toBe(
      "2 deployables",
    );
    expect(summarizeToolResult("loom_apply_patch", '{"ok":true,"text":"x"}')).toBe("patched");
    expect(summarizeToolResult("loom_read_model", "{}")).toBe("ok");
  });

  it("degrades gracefully on errors + non-JSON", () => {
    expect(summarizeToolResult("loom_validate", "boom: kaput", true)).toBe("boom: kaput");
    expect(summarizeToolResult("loom_nope", "plain text")).toBe("plain text");
  });
});

describe("latestSourceFrom", () => {
  it("prefers the newest source seen — a patch result over an earlier call arg", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "a", name: "loom_validate", input: { source: "V1" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "a", content: '{"ok":false}' }],
      },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "b", name: "loom_apply_patch", input: { source: "V1" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "b", content: '{"ok":true,"text":"V2"}' }],
      },
    ];
    expect(latestSourceFrom(messages)).toBe("V2");
  });

  it("returns null when no source appears", () => {
    expect(
      latestSourceFrom([{ role: "user", content: [{ type: "text", text: "hi" }] }]),
    ).toBeNull();
  });
});

describe("foldTranscript", () => {
  it("renders user + assistant bubbles and fills tool-call cards from results", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "make an Order" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Validating." },
          { type: "tool_use", id: "v", name: "loom_validate", input: { source: CLEAN } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "v", content: '{"ok":true}' }],
      },
      { role: "assistant", content: [{ type: "text", text: "All good." }] },
    ];
    const bubbles = foldTranscript(messages, false);

    expect(bubbles.map((b) => b.role)).toEqual(["user", "assistant", "assistant"]);
    expect(bubbles[0].text).toBe("make an Order");
    const card = bubbles[1].toolCalls?.[0];
    expect(card?.tool).toBe("loom_validate");
    expect(card?.status).toBe("ok");
    expect(card?.result).toBe("0 errors");
    expect(bubbles[2].text).toBe("All good.");
    // Not running ⇒ nothing pending.
    expect(bubbles.every((b) => !b.pending)).toBe(true);
  });

  it("marks the trailing assistant bubble pending while running", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "working…" }] },
    ];
    const bubbles = foldTranscript(messages, true);
    expect(bubbles.at(-1)?.pending).toBe(true);
  });
});

describe("seedUserText", () => {
  it("injects the current source only on the first turn", () => {
    expect(seedUserText("add a field", CLEAN, true)).toContain("Current model");
    expect(seedUserText("add a field", CLEAN, true)).toContain("add a field");
    expect(seedUserText("add a field", CLEAN, false)).toBe("add a field");
    expect(seedUserText("start fresh", "", true)).toBe("start fresh");
  });
});

describe("runLiveAgent (scripted transport)", () => {
  it("drives a real validate loop, reflects source into the editor, and generates", async () => {
    let turn = 0;
    const fetchImpl = (async () => {
      turn++;
      if (turn === 1) {
        return oaiResponse({
          role: "assistant",
          content: "Here's an Order model — validating it.",
          tool_calls: [
            {
              id: "v1",
              type: "function",
              function: { name: "loom_validate", arguments: JSON.stringify({ source: CLEAN }) },
            },
          ],
        });
      }
      return oaiResponse({ role: "assistant", content: "Validated clean — 0 errors." });
    }) as unknown as typeof fetch;

    const complete = createOpenAiCompatibleComplete({
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "sk-test",
      model: "anthropic/claude-sonnet-4",
      fetchImpl,
    });

    let display: AgentMessage[] = [];
    let appliedSource = "";
    let generated = false;

    const transcript = await runLiveAgent({
      complete,
      prompt: "Build an Order aggregate with a total.",
      currentSource: "",
      history: [],
      setMessages: (m) => {
        display = m;
      },
      applySource: (s) => {
        appliedSource = s;
      },
      triggerGenerate: () => {
        generated = true;
      },
    });

    // The agent's model landed in the editor and a generate was kicked.
    expect(appliedSource).toBe(CLEAN);
    expect(generated).toBe(true);
    // The display opens with the user's RAW prompt (not the source-seeded text).
    expect(display[0]?.role).toBe("user");
    expect(display[0]?.text).toBe("Build an Order aggregate with a total.");
    // The validate card resolved ok with the real result.
    const card = display.flatMap((m) => m.toolCalls ?? []).find((t) => t.tool === "loom_validate");
    expect(card?.status).toBe("ok");
    expect(card?.result).toBe("0 errors");
    // Nothing left pending, and the transcript is returned for the next turn.
    expect(display.every((m) => !m.pending)).toBe(true);
    expect(transcript.length).toBeGreaterThan(1);
  });

  it("continues an existing conversation without re-seeding source", async () => {
    const fetchImpl = (async () =>
      oaiResponse({ role: "assistant", content: "Sure." })) as unknown as typeof fetch;
    const complete = createOpenAiCompatibleComplete({
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "sk-test",
      model: "m",
      fetchImpl,
    });
    const history: Message[] = [
      { role: "user", content: [{ type: "text", text: "first" }] },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ];
    let display: AgentMessage[] = [];
    const transcript = await runLiveAgent({
      complete,
      prompt: "now add a status",
      currentSource: CLEAN,
      history,
      setMessages: (m) => {
        display = m;
      },
      applySource: () => {},
      triggerGenerate: () => {},
    });
    // History preserved + the new turn appended (user + assistant).
    expect(transcript.length).toBe(4);
    expect(display.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    // Follow-up turn is NOT source-seeded.
    const seeded = transcript[2];
    expect(seeded.content[0].type === "text" && seeded.content[0].text).toBe("now add a status");
  });
});

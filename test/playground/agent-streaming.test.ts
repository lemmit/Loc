import { describe, expect, it } from "vitest";
import type { Message } from "../../src/tools/index.js";
import type { AgentMessage } from "../../web/src/agent/demo.js";
import { runLiveAgent } from "../../web/src/agent/live.js";
import {
  accumulateSseStream,
  createOpenAiCompatibleComplete,
} from "../../web/src/agent/openai-transport.js";

// ---------------------------------------------------------------------------
// Token-level streaming (M-T8.3) — the SSE accumulation, the streaming transport
// path, and the provisional streamed-text bubble in the live chat.  Headless:
// SSE bodies are built as in-memory ReadableStreams, no network.
// ---------------------------------------------------------------------------

const CLEAN = `context Sales {
  aggregate Order { total: int }
}
`;

/** Build an SSE body from a list of `delta` objects (+ the trailing [DONE]). */
function sseStream(deltas: object[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const lines = [
    ...deltas.map((d) => `data: ${JSON.stringify({ choices: [{ delta: d }] })}\n\n`),
    "data: [DONE]\n\n",
  ];
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < lines.length) controller.enqueue(enc.encode(lines[i++]));
      else controller.close();
    },
  });
}

function streamResponse(deltas: object[]): Response {
  return { ok: true, status: 200, body: sseStream(deltas) } as unknown as Response;
}

describe("accumulateSseStream", () => {
  it("surfaces text fragments and accumulates the full turn", async () => {
    const deltas: string[] = [];
    const completion = await accumulateSseStream(
      sseStream([{ content: "Hel" }, { content: "lo" }, { content: " world" }]),
      (t) => deltas.push(t),
    );
    expect(deltas).toEqual(["Hel", "lo", " world"]);
    expect(completion.stop_reason).toBe("end_turn");
    expect(completion.content).toEqual([{ type: "text", text: "Hello world" }]);
  });

  it("reassembles a tool call whose arguments stream across chunks", async () => {
    const completion = await accumulateSseStream(
      sseStream([
        {
          tool_calls: [{ index: 0, id: "c1", function: { name: "loom_validate", arguments: "" } }],
        },
        { tool_calls: [{ index: 0, function: { arguments: '{"source":"x' } }] },
        { tool_calls: [{ index: 0, function: { arguments: '"}' } }] },
      ]),
    );
    expect(completion.stop_reason).toBe("tool_use");
    expect(completion.content).toContainEqual({
      type: "tool_use",
      id: "c1",
      name: "loom_validate",
      input: { source: "x" },
    });
  });
});

describe("createOpenAiCompatibleComplete (streaming)", () => {
  it("sets stream:true and drives onTextDelta from the SSE body", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return streamResponse([{ content: "Hi " }, { content: "there" }]);
    }) as unknown as typeof fetch;

    const complete = createOpenAiCompatibleComplete({
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "sk-test",
      model: "m",
      stream: true,
      fetchImpl,
    });

    const deltas: string[] = [];
    const completion = await complete({
      messages: [],
      tools: [],
      onTextDelta: (t) => deltas.push(t),
    });
    expect(body.stream).toBe(true);
    expect(deltas).toEqual(["Hi ", "there"]);
    expect(completion.content).toEqual([{ type: "text", text: "Hi there" }]);
  });
});

describe("runLiveAgent (streaming)", () => {
  it("shows a provisional streamed bubble before the turn settles", async () => {
    let turn = 0;
    const fetchImpl = (async () => {
      turn++;
      if (turn === 1) {
        return streamResponse([
          { content: "Authoring an Order model — " },
          { content: "validating." },
          {
            tool_calls: [
              {
                index: 0,
                id: "v1",
                function: { name: "loom_validate", arguments: JSON.stringify({ source: CLEAN }) },
              },
            ],
          },
        ]);
      }
      return streamResponse([{ content: "All good — " }, { content: "0 errors." }]);
    }) as unknown as typeof fetch;

    const complete = createOpenAiCompatibleComplete({
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "sk-test",
      model: "m",
      stream: true,
      fetchImpl,
    });

    const snapshots: AgentMessage[][] = [];
    let appliedSource = "";
    let generated = false;

    await runLiveAgent({
      complete,
      prompt: "Build an Order aggregate.",
      currentSource: "",
      history: [] as Message[],
      setMessages: (m) => {
        snapshots.push(m);
      },
      applySource: (s) => {
        appliedSource = s;
      },
      triggerGenerate: () => {
        generated = true;
      },
    });

    // A provisional streaming bubble (id "streaming") appeared mid-turn…
    const sawStreaming = snapshots.some((s) => s.some((b) => b.id === "streaming" && b.text));
    expect(sawStreaming).toBe(true);
    // …and a partial-text render preceded the final full text.
    const sawPartial = snapshots.some((s) =>
      s.some((b) => b.text === "Authoring an Order model — "),
    );
    expect(sawPartial).toBe(true);

    // The turn still settled correctly: source reflected + generated + card ok.
    expect(appliedSource).toBe(CLEAN);
    expect(generated).toBe(true);
    const final = snapshots.at(-1) ?? [];
    const card = final.flatMap((m) => m.toolCalls ?? []).find((t) => t.tool === "loom_validate");
    expect(card?.status).toBe("ok");
    expect(card?.result).toBe("0 errors");
    // No dangling provisional bubble at the end.
    expect(final.some((b) => b.id === "streaming")).toBe(false);
  });
});

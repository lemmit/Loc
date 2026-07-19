import { describe, expect, it } from "vitest";
import { type Message, runAgent } from "../../src/tools/index.js";
import {
  createOpenAiCompatibleComplete,
  fromOpenAiMessage,
  toOpenAiMessages,
  toOpenAiTools,
} from "../../web/src/agent/openai-transport.js";
import {
  defaultAgentSettings,
  loadAgentSettings,
  PROVIDER_PRESETS,
  presetById,
  settingsReady,
} from "../../web/src/agent/provider.js";
import { buildSystemPrompt } from "../../web/src/agent/system-prompt.js";

// ---------------------------------------------------------------------------
// The BYOK live-chat transport (M-T8.3) — the OpenAI-`/chat/completions`
// adapter behind the transport-neutral agent loop.  Headless by construction:
// `fetchImpl` is injected, so we drive a full validate loop with a scripted
// provider and no network.
// ---------------------------------------------------------------------------

const CLEAN = `context Sales {
  aggregate Order { total: int }
}
`;

/** A canned OpenAI JSON response wrapped in a minimal Response-like object. */
function oaiResponse(message: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ choices: [{ message }] }),
    text: async () => JSON.stringify({ choices: [{ message }] }),
  } as unknown as Response;
}

describe("OpenAI-compatible message conversion", () => {
  it("carries tool_use → tool_calls and tool_result → role:tool", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "validating" },
          { type: "tool_use", id: "call_1", name: "loom_validate", input: { source: CLEAN } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call_1", content: '{"ok":true}' }],
      },
    ];
    const oai = toOpenAiMessages(messages, "SYSTEM");

    expect(oai[0]).toEqual({ role: "system", content: "SYSTEM" });
    expect(oai[1]).toEqual({ role: "user", content: "hi" });
    const assistant = oai[2];
    expect(assistant.role).toBe("assistant");
    expect(assistant.content).toBe("validating");
    expect(assistant.tool_calls?.[0]).toMatchObject({
      id: "call_1",
      type: "function",
      function: { name: "loom_validate" },
    });
    expect(JSON.parse(assistant.tool_calls?.[0].function.arguments ?? "{}")).toEqual({
      source: CLEAN,
    });
    expect(oai[3]).toEqual({ role: "tool", tool_call_id: "call_1", content: '{"ok":true}' });
  });

  it("omits an empty system prompt", () => {
    expect(toOpenAiMessages([], "")).toEqual([]);
    expect(toOpenAiMessages([], undefined)).toEqual([]);
  });

  it("maps catalog specs to OpenAI function tools", () => {
    const tools = toOpenAiTools([
      { name: "loom_validate", description: "validate a model", input_schema: { type: "object" } },
    ]);
    expect(tools[0]).toEqual({
      type: "function",
      function: {
        name: "loom_validate",
        description: "validate a model",
        parameters: { type: "object" },
      },
    });
  });

  it("parses a tool-call response, defaulting malformed arguments to {}", () => {
    const good = fromOpenAiMessage({
      role: "assistant",
      content: "sure",
      tool_calls: [
        {
          id: "c1",
          type: "function",
          function: { name: "loom_validate", arguments: '{"source":"x"}' },
        },
      ],
    });
    expect(good.stop_reason).toBe("tool_use");
    expect(good.content).toContainEqual({ type: "text", text: "sure" });
    expect(good.content).toContainEqual({
      type: "tool_use",
      id: "c1",
      name: "loom_validate",
      input: { source: "x" },
    });

    const malformed = fromOpenAiMessage({
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "c2", type: "function", function: { name: "loom_generate", arguments: "{bad" } },
      ],
    });
    expect(malformed.content).toEqual([
      { type: "tool_use", id: "c2", name: "loom_generate", input: {} },
    ]);

    const plain = fromOpenAiMessage({ role: "assistant", content: "all done" });
    expect(plain.stop_reason).toBe("end_turn");
    expect(plain.content).toEqual([{ type: "text", text: "all done" }]);
  });
});

describe("createOpenAiCompatibleComplete + runAgent", () => {
  it("drives a real loom_validate through the loop with a scripted provider", async () => {
    const seen: { url: string; body: Record<string, unknown> }[] = [];
    let turn = 0;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, body: JSON.parse(init.body as string) });
      turn++;
      if (turn === 1) {
        // First turn: model asks to validate the user's model.
        return oaiResponse({
          role: "assistant",
          content: "Let me validate that.",
          tool_calls: [
            {
              id: "call_v",
              type: "function",
              function: { name: "loom_validate", arguments: JSON.stringify({ source: CLEAN }) },
            },
          ],
        });
      }
      // Second turn: model has the tool result and concludes.
      return oaiResponse({ role: "assistant", content: "The model is valid." });
    }) as unknown as typeof fetch;

    const complete = createOpenAiCompatibleComplete({
      baseUrl: "https://openrouter.ai/api/v1/",
      apiKey: "sk-test",
      model: "anthropic/claude-sonnet-4",
      fetchImpl,
    });

    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "Is my Order model valid?" }] },
    ];
    const result = await runAgent({ complete, messages, system: buildSystemPrompt() });

    expect(result.stoppedBy).toBe("end_turn");
    // Two provider round-trips; trailing slash collapsed to one /chat/completions.
    expect(seen.length).toBe(2);
    expect(seen[0].url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(seen[0].body.model).toBe("anthropic/claude-sonnet-4");
    expect(Array.isArray(seen[0].body.tools)).toBe(true);
    // The REAL loom_validate ran: a tool_result turn is in the transcript, ok=true.
    const toolResult = result.messages
      .flatMap((m) => m.content)
      .find((b) => b.type === "tool_result");
    expect(toolResult).toBeDefined();
    if (toolResult && toolResult.type === "tool_result") {
      expect(JSON.parse(toolResult.content).ok).toBe(true);
    }
    // Concludes with the model's final text.
    expect(result.messages.at(-1)?.content.some((b) => b.type === "text")).toBe(true);
  });

  it("sends the BYOK key as a bearer header and surfaces provider errors", async () => {
    let authHeader: string | undefined;
    const okFetch = (async (_url: string, init: RequestInit) => {
      authHeader = (init.headers as Record<string, string>).Authorization;
      return oaiResponse({ role: "assistant", content: "hi" });
    }) as unknown as typeof fetch;
    const complete = createOpenAiCompatibleComplete({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-abc",
      model: "gpt-4o",
      fetchImpl: okFetch,
    });
    await complete({ messages: [], tools: [] });
    expect(authHeader).toBe("Bearer sk-abc");

    const failFetch = (async () => oaiResponse({}, 401)) as unknown as typeof fetch;
    const failing = createOpenAiCompatibleComplete({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "bad",
      model: "gpt-4o",
      fetchImpl: failFetch,
    });
    await expect(failing({ messages: [], tools: [] })).rejects.toThrow(/failed \(401\)/);
  });

  it("omits the Authorization header for a keyless (local) provider", async () => {
    let hasAuth = true;
    const localFetch = (async (_url: string, init: RequestInit) => {
      hasAuth = "Authorization" in (init.headers as Record<string, string>);
      return oaiResponse({ role: "assistant", content: "ok" });
    }) as unknown as typeof fetch;
    const complete = createOpenAiCompatibleComplete({
      baseUrl: "http://localhost:11434/v1",
      apiKey: "",
      model: "llama3.1",
      fetchImpl: localFetch,
    });
    await complete({ messages: [], tools: [] });
    expect(hasAuth).toBe(false);
  });
});

describe("provider presets + settings", () => {
  it("leads with OpenRouter and every preset is OpenAI-compatible", () => {
    expect(PROVIDER_PRESETS[0].id).toBe("openrouter");
    for (const p of PROVIDER_PRESETS) expect(p.kind).toBe("openai");
    // presetById falls back to the first entry.
    expect(presetById("nope").id).toBe("openrouter");
  });

  it("settingsReady gates on base URL + model + (unless keyless) key", () => {
    const base = defaultAgentSettings();
    expect(settingsReady(base)).toBe(false); // no key yet
    expect(settingsReady({ ...base, apiKey: "sk-x" })).toBe(true);
    // A keyless local provider is ready without a key.
    expect(
      settingsReady({
        providerId: "local",
        baseUrl: "http://localhost:11434/v1",
        model: "llama3.1",
        apiKey: "",
      }),
    ).toBe(true);
    // Missing model is never ready.
    expect(settingsReady({ ...base, apiKey: "sk-x", model: "" })).toBe(false);
  });

  it("loadAgentSettings returns defaults without localStorage", () => {
    // Node/vitest has no localStorage → defaults, never throws.
    const s = loadAgentSettings();
    expect(s.providerId).toBe("openrouter");
    expect(s.apiKey).toBe("");
  });
});

describe("system prompt", () => {
  it("names Loom and lists every callable tool", () => {
    const p = buildSystemPrompt();
    expect(p).toMatch(/Loom/);
    expect(p).toMatch(/loom_validate/);
    expect(p).toMatch(/loom_generate/);
    expect(p).toMatch(/loom_apply_patch/);
  });
});

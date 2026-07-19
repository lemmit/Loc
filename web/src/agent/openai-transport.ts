// ---------------------------------------------------------------------------
// The OpenAI-`/chat/completions`-compatible `Complete` transport — the one
// concrete LLM call behind the transport-neutral agent loop
// (`src/tools/agent-loop.ts`).  It converts the loop's Anthropic-shaped
// `Message`/`ToolSpec`/`Completion` vocabulary to/from the OpenAI wire shape,
// so a SINGLE adapter drives OpenRouter, OpenAI, Groq, a local llama.cpp, or
// any other compatible endpoint (see `provider.ts` for the preset menu).
//
// BYOK: the key is passed in, used for one `Authorization: Bearer` header, and
// never stored here.  `fetchImpl` is injected so the whole adapter is unit-
// testable with a scripted fetch — no network in tests.
// ---------------------------------------------------------------------------

import type {
  Complete,
  Completion,
  ContentBlock,
  Message,
  ToolSpec,
} from "../../../src/tools/index.js";

/** Everything the adapter needs to make a call.  `baseUrl` is the API root
 *  (no trailing `/chat/completions`); `headers` merges in provider extras
 *  (OpenRouter suggests `HTTP-Referer` + `X-Title` for attribution). */
export interface OpenAiTransportConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  headers?: Record<string, string>;
  temperature?: number;
  maxTokens?: number;
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

// --- OpenAI wire shapes (only the fields we read/write) --------------------

interface OaiFunctionCall {
  name: string;
  /** JSON-encoded arguments object (may be malformed — parsed defensively). */
  arguments: string;
}
interface OaiToolCall {
  id: string;
  type: "function";
  function: OaiFunctionCall;
}
interface OaiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OaiToolCall[];
  tool_call_id?: string;
}
interface OaiTool {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

// --- Conversions (exported so they're unit-testable in isolation) ----------

/** Loop messages (+ optional system prompt) → OpenAI `messages`.  The two
 *  shapes diverge on tool plumbing: Anthropic carries `tool_use`/`tool_result`
 *  as content blocks; OpenAI carries `tool_calls` on the assistant turn and one
 *  `role: "tool"` message per result. */
export function toOpenAiMessages(messages: Message[], system?: string): OaiMessage[] {
  const out: OaiMessage[] = [];
  if (system?.trim()) out.push({ role: "system", content: system });

  for (const m of messages) {
    if (m.role === "assistant") {
      const text = m.content
        .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("");
      const toolUses = m.content.filter(
        (b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use",
      );
      const msg: OaiMessage = { role: "assistant", content: text || null };
      if (toolUses.length > 0) {
        msg.tool_calls = toolUses.map((b) => ({
          id: b.id,
          type: "function",
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        }));
      }
      out.push(msg);
      continue;
    }

    // role: "user" — either the initial prompt (text) or a tool-result turn.
    const toolResults = m.content.filter(
      (b): b is Extract<ContentBlock, { type: "tool_result" }> => b.type === "tool_result",
    );
    for (const r of toolResults) {
      out.push({ role: "tool", tool_call_id: r.tool_use_id, content: r.content });
    }
    const texts = m.content.filter(
      (b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text",
    );
    for (const t of texts) out.push({ role: "user", content: t.text });
  }
  return out;
}

/** Catalog tool specs → OpenAI `tools`.  `input_schema` maps straight onto
 *  `function.parameters` (both are JSON Schema). */
export function toOpenAiTools(tools: ToolSpec[]): OaiTool[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

/** An OpenAI response `message` → the loop's `Completion`.  Tool calls become
 *  `tool_use` blocks (arguments JSON-parsed defensively — a malformed string
 *  degrades to `{}` rather than throwing).  `stop_reason` is `tool_use` iff the
 *  model requested any tool; the loop keys off tool-call presence regardless. */
export function fromOpenAiMessage(message: OaiMessage): Completion {
  const content: ContentBlock[] = [];
  if (message.content) content.push({ type: "text", text: message.content });
  for (const tc of message.tool_calls ?? []) {
    let input: Record<string, unknown> = {};
    try {
      input = tc.function.arguments ? (JSON.parse(tc.function.arguments) as Record<string, unknown>) : {};
    } catch {
      input = {};
    }
    content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
  }
  const stop_reason = (message.tool_calls?.length ?? 0) > 0 ? "tool_use" : "end_turn";
  return { content, stop_reason };
}

/** Build a `Complete` bound to one BYOK provider config.  The returned closure
 *  is exactly the injection point `runAgent` expects. */
export function createOpenAiCompatibleComplete(config: OpenAiTransportConfig): Complete {
  const f = config.fetchImpl ?? globalThis.fetch;
  const url = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;

  return async ({ messages, tools, system }) => {
    const body: Record<string, unknown> = {
      model: config.model,
      messages: toOpenAiMessages(messages, system),
      tools: toOpenAiTools(tools),
      tool_choice: "auto",
    };
    if (config.temperature !== undefined) body.temperature = config.temperature;
    if (config.maxTokens !== undefined) body.max_tokens = config.maxTokens;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...config.headers,
    };
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

    const res = await f(url, { method: "POST", headers, body: JSON.stringify(body) });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Provider request failed (${res.status})${detail ? `: ${detail}` : ""}`);
    }
    const data = (await res.json()) as { choices?: { message: OaiMessage }[] };
    const message = data.choices?.[0]?.message;
    if (!message) throw new Error("Provider returned no choices");
    return fromOpenAiMessage(message);
  };
}

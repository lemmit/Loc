// ---------------------------------------------------------------------------
// Live agent chat orchestration (M-T8.3) — the bridge between the transport-
// neutral loop (`runAgent` over an injected `Complete`) and the Agent dock
// tab's display.  Unlike the deterministic demo (`demo.ts`, a fixed
// transcript), this drives a REAL LLM through the same `loom_*` tools.
//
// The pure pieces live here so they're headless-testable with a scripted
// transport: folding the Anthropic-shaped `Message[]` transcript into the UI's
// `AgentMessage[]` bubbles, summarising a tool result to a one-liner, and
// recovering the latest `.ddd` source the agent has produced (so its edits land
// in the editor).  The React panel only calls `runLiveAgent`.
// ---------------------------------------------------------------------------

import {
  type Complete,
  type ContentBlock,
  type Message,
  runAgent,
} from "../../../src/tools/index.js";
import type { AgentMessage, AgentToolCall, ToolStatus } from "./demo.js";

let liveSeq = 0;
const nextLiveId = (): string => `l${++liveSeq}`;

/** Summarise a tool result to the short line shown on its card.  Keyed by tool
 *  so the common ones read well; everything else degrades to a truncated JSON
 *  snippet.  Never throws (a non-JSON result shows verbatim, truncated). */
export function summarizeToolResult(name: string, content: string, isError?: boolean): string {
  if (isError) return truncate(content.split("\n")[0], 80);
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    return truncate(content, 60);
  }
  const obj = (data ?? {}) as Record<string, unknown>;
  switch (name) {
    case "loom_validate": {
      if (obj.ok === true) return "0 errors";
      const errs = (obj.summary as { errors?: number } | undefined)?.errors;
      return typeof errs === "number" ? `${errs} error(s)` : "has errors";
    }
    case "loom_generate": {
      const deployables = obj.deployables as unknown[] | undefined;
      if (Array.isArray(deployables)) {
        return `${deployables.length} deployable${deployables.length === 1 ? "" : "s"}`;
      }
      return obj.ok === true ? "generated" : "failed";
    }
    case "loom_apply_patch":
      return obj.ok === true ? "patched" : "patch failed";
    case "loom_outline":
    case "loom_read_model":
    case "loom_list_primitives":
      return "ok";
    default:
      return truncate(JSON.stringify(obj), 60);
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** The latest `.ddd` source the agent has produced anywhere in the transcript,
 *  or null.  A `loom_apply_patch` RESULT (`.text`) is the newest state; a
 *  `loom_validate`/`loom_generate`/… CALL carries the source the agent is
 *  working on.  Both are scanned in order, so the last one seen wins. */
export function latestSourceFrom(messages: Message[]): string | null {
  let latest: string | null = null;
  for (const m of messages) {
    for (const block of m.content) {
      if (block.type === "tool_use") {
        const src = (block.input as { source?: unknown }).source;
        if (typeof src === "string" && src.trim()) latest = src;
      } else if (block.type === "tool_result" && !block.is_error) {
        try {
          const parsed = JSON.parse(block.content) as { text?: unknown };
          if (typeof parsed.text === "string" && parsed.text.trim()) latest = parsed.text;
        } catch {
          // not JSON / no text — ignore.
        }
      }
    }
  }
  return latest;
}

/** Fold the raw transcript into display bubbles.  Assistant turns become
 *  assistant bubbles (text + tool-call cards); the tool-result user turns don't
 *  render as bubbles — they fill in the matching card's status/result.  The
 *  seeding user prompt renders as a `you` bubble. */
export function foldTranscript(messages: Message[], running = false): AgentMessage[] {
  const out: AgentMessage[] = [];
  const cardById = new Map<string, AgentToolCall>();

  for (const m of messages) {
    if (m.role === "assistant") {
      const text = textOf(m.content);
      const toolCalls: AgentToolCall[] = [];
      for (const block of m.content) {
        if (block.type === "tool_use") {
          const card: AgentToolCall = {
            tool: block.name,
            label: block.name,
            status: "running",
          };
          cardById.set(block.id, card);
          toolCalls.push(card);
        }
      }
      out.push({
        id: nextLiveId(),
        role: "assistant",
        text,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      });
      continue;
    }

    // role: "user" — a tool-result turn fills cards; a plain-text turn is the
    // seeding prompt (or a follow-up) shown as a `you` bubble.
    const toolResults = m.content.filter(
      (b): b is Extract<ContentBlock, { type: "tool_result" }> => b.type === "tool_result",
    );
    if (toolResults.length > 0) {
      for (const r of toolResults) {
        const card = cardById.get(r.tool_use_id);
        if (card) {
          card.status = r.is_error ? "error" : "ok";
          card.result = summarizeToolResult(card.tool, r.content, r.is_error);
        }
      }
      continue;
    }
    const text = textOf(m.content);
    if (text) out.push({ id: nextLiveId(), role: "user", text });
  }

  // While the loop is in flight, the trailing assistant bubble is pending.
  if (running) {
    const last = out.at(-1);
    if (last && last.role === "assistant") last.pending = true;
  }
  return out;
}

function textOf(content: ContentBlock[]): string {
  return content
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/** Seed the first user turn with the current editor source as context, so the
 *  agent edits from where the user is rather than a blank slate.  Follow-up
 *  turns (a non-empty history) pass the prompt through unchanged. */
export function seedUserText(prompt: string, currentSource: string, isFirstTurn: boolean): string {
  if (!isFirstTurn || !currentSource.trim()) return prompt;
  return `Current model (main.ddd):\n\`\`\`\n${currentSource.trim()}\n\`\`\`\n\n${prompt}`;
}

export interface LiveAgentDeps {
  /** The transport built from the user's BYOK settings. */
  complete: Complete;
  /** The user's message this turn. */
  prompt: string;
  /** The live editor source, seeded as context on the first turn. */
  currentSource: string;
  /** The running raw transcript — appended to across turns.  Empty on the
   *  first send. */
  history: Message[];
  /** Optional system prompt (the context-pack seed). */
  system?: string;
  /** Re-render the display bubbles (called on every transcript change). */
  setMessages: (msgs: AgentMessage[]) => void;
  /** Reflect the agent's newest `.ddd` source into the editor + LSP. */
  applySource: (ddd: string) => void;
  /** Kick a real playground generate once the turn settles. */
  triggerGenerate: () => void;
  /** Cooperative cancellation. */
  signal?: { cancelled: boolean };
  /** Hard cap on tool round-trips per send (defends a runaway loop). */
  maxSteps?: number;
}

/** Run one live turn to completion: append the user message, drive `runAgent`,
 *  stream the folded transcript to the display, reflect source edits into the
 *  editor, and generate at the end.  Returns the updated raw transcript so the
 *  caller can persist it for the next turn. */
export async function runLiveAgent(deps: LiveAgentDeps): Promise<Message[]> {
  const {
    complete,
    prompt,
    currentSource,
    history,
    system,
    setMessages,
    applySource,
    triggerGenerate,
    signal,
  } = deps;

  const isFirstTurn = history.length === 0;
  const messages: Message[] = [
    ...history,
    {
      role: "user",
      content: [{ type: "text", text: seedUserText(prompt, currentSource, isFirstTurn) }],
    },
  ];

  // Render the raw transcript, swapping the seeded first user turn back to the
  // plain prompt (so context isn't shown in the bubble) and appending any
  // in-flight streamed text as a provisional assistant bubble.
  const render = (running: boolean, streamingText: string): void => {
    const display = messages.map((m, i) =>
      i === history.length && m.role === "user"
        ? { role: "user" as const, content: [{ type: "text" as const, text: prompt }] }
        : m,
    );
    const bubbles = foldTranscript(display, running);
    if (streamingText) {
      bubbles.push({ id: "streaming", role: "assistant", text: streamingText, pending: true });
    }
    setMessages(bubbles);
  };

  // Show the user's bubble immediately (before the model responds).
  render(true, "");

  let lastSource: string | null = latestSourceFrom(history);
  let streaming = "";

  await runAgent({
    complete,
    messages,
    system,
    maxSteps: deps.maxSteps ?? 12,
    onTextDelta: (t) => {
      streaming += t;
      render(true, streaming);
    },
    onMessage: () => {
      // The completed turn is now in `messages` — clear the provisional buffer
      // and re-render from the real transcript.
      streaming = "";
      render(true, "");

      // Reflect the newest source into the editor as soon as it appears.
      const src = latestSourceFrom(messages);
      if (src && src !== lastSource) {
        lastSource = src;
        applySource(src);
      }
    },
  });

  if (signal?.cancelled) return messages;

  // Settle: final render (not pending) + a real generate if the agent produced
  // a model.
  render(false, "");
  if (lastSource) triggerGenerate();

  return messages;
}

// ---------------------------------------------------------------------------
// The Loom agent loop (agent-tools-and-mcp.md §5) — the transport-neutral
// conversation orchestration that turns the tool catalog into an autonomous
// authoring agent.  This is the reference loop every IN-PROCESS host runs (the
// playground chat today; a future headless CLI tomorrow); an external MCP host
// runs its OWN loop, so this module is NOT used by the MCP server.
//
// The LLM call is INJECTED (`Complete`) — the loop knows nothing about
// Anthropic, a proxy, or a local model, so it is pure + browser-safe and
// unit-testable with a scripted fake.  The only Loom-specific piece is the tool
// dispatch: a `tool_use` block runs through the catalog's `callTool`, and the
// JSON result comes back as a `tool_result`.  One catalog, many transports
// (D-AGENT-TOOLS) — the loop is just the driver.
//
// Message / content-block shapes mirror the Anthropic Messages API so the
// playground's real client maps 1:1, but nothing here depends on that provider.
// ---------------------------------------------------------------------------

import { callTool, TOOLS } from "./catalog.js";

/** A text span in a message. */
export interface TextBlock {
  type: "text";
  text: string;
}

/** A model request to run a tool. */
export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** The result of running a tool, fed back to the model. */
export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface Message {
  role: "user" | "assistant";
  content: ContentBlock[];
}

/** A tool definition in the provider-neutral (Anthropic-shaped) form an LLM
 *  tool-use request expects. */
export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** One assistant turn from the model. */
export interface Completion {
  content: ContentBlock[];
  /** `"tool_use"` means the model wants tools run and the loop continues;
   *  anything else (`"end_turn"`, `"max_tokens"`, …) ends the loop. */
  stop_reason: string;
}

/** The injected LLM call — the ONLY transport-specific dependency.  Given the
 *  running conversation + the tool specs (+ optional system prompt), returns the
 *  next assistant turn.  The playground supplies an Anthropic/proxy-backed
 *  implementation; tests supply a scripted one.
 *
 *  `onTextDelta` is an OPTIONAL streaming hook: a transport that streams calls
 *  it with each text fragment as it arrives (the returned `Completion` is still
 *  the fully-accumulated turn, so a non-streaming consumer ignores it).  Tool
 *  calls are not streamed — they only appear in the resolved `Completion`. */
export type Complete = (req: {
  messages: Message[];
  tools: ToolSpec[];
  system?: string;
  onTextDelta?: (text: string) => void;
}) => Promise<Completion>;

/** The catalog as provider-neutral tool specs — the tool definitions an LLM
 *  tool-use request expects. */
export function toolSpecs(): ToolSpec[] {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
}

/** Run every `tool_use` block in an assistant turn through the catalog and
 *  return the matching `tool_result` blocks (in order).  A handler throw or an
 *  unknown tool becomes an `is_error` result the model can recover from —
 *  never a thrown exception that breaks the loop. */
export async function dispatchToolUses(blocks: ContentBlock[]): Promise<ToolResultBlock[]> {
  const results: ToolResultBlock[] = [];
  for (const block of blocks) {
    if (block.type !== "tool_use") continue;
    try {
      const result = await callTool(block.name, block.input ?? {});
      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: JSON.stringify(result),
      });
    } catch (err) {
      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: err instanceof Error ? err.message : String(err),
        is_error: true,
      });
    }
  }
  return results;
}

export interface RunAgentOptions {
  /** The injected LLM call. */
  complete: Complete;
  /** The conversation so far — seed with the user's first message.  Mutated in
   *  place (each turn appended) AND returned, so a UI can render live. */
  messages: Message[];
  /** Optional system prompt. */
  system?: string;
  /** Hard cap on assistant turns — defends against a tool-call ping-pong that
   *  never ends.  Default 12. */
  maxSteps?: number;
  /** Called after each appended message (assistant turn, then the tool-result
   *  user turn) — lets a UI stream the conversation. */
  onMessage?: (message: Message) => void;
  /** Forwarded to `complete` — a streaming transport calls it with each text
   *  fragment of the in-flight assistant turn (before `onMessage` lands the
   *  completed turn). */
  onTextDelta?: (text: string) => void;
}

export interface RunAgentResult {
  messages: Message[];
  steps: number;
  stoppedBy: "end_turn" | "max_steps";
}

/** Drive the catalog-backed agent loop to completion: ask the model, run any
 *  tools it requests, feed the results back, repeat until it stops (or the step
 *  cap is hit).  Transport-neutral — the `complete` call is the only injection
 *  point, so the same loop serves the playground, a CLI, or a test. */
export async function runAgent(opts: RunAgentOptions): Promise<RunAgentResult> {
  const { complete, messages, system, onMessage, onTextDelta } = opts;
  const maxSteps = opts.maxSteps ?? 12;
  const tools = toolSpecs();

  for (let step = 1; step <= maxSteps; step++) {
    const completion = await complete({ messages, tools, system, onTextDelta });
    const assistant: Message = { role: "assistant", content: completion.content };
    messages.push(assistant);
    onMessage?.(assistant);

    const toolResults = await dispatchToolUses(completion.content);
    if (toolResults.length === 0) {
      return { messages, steps: step, stoppedBy: "end_turn" };
    }
    const toolTurn: Message = { role: "user", content: toolResults };
    messages.push(toolTurn);
    onMessage?.(toolTurn);
  }

  return { messages, steps: maxSteps, stoppedBy: "max_steps" };
}

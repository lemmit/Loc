import { describe, expect, it } from "vitest";
import type { Complete, Completion, Message } from "../../src/tools/index.js";
import { dispatchToolUses, runAgent, toolSpecs } from "../../src/tools/index.js";

// ---------------------------------------------------------------------------
// The agent loop (agent-tools-and-mcp.md §5) — transport-neutral conversation
// orchestration over the tool catalog.  The LLM call is injected, so a scripted
// `Complete` drives the loop deterministically: we assert the tools actually
// run through the catalog and their results feed back to the model.
// ---------------------------------------------------------------------------

/** A `Complete` that replays a fixed script of assistant turns, recording the
 *  messages it was asked to complete (so we can assert the tool results were
 *  fed back). */
function scripted(turns: Completion[]): Complete & { seen: Message[][] } {
  let i = 0;
  const fn = (async (req) => {
    fn.seen.push(req.messages.map((m) => ({ ...m })));
    return turns[i++] ?? { content: [{ type: "text", text: "done" }], stop_reason: "end_turn" };
  }) as Complete & { seen: Message[][] };
  fn.seen = [];
  return fn;
}

const CLEAN = `context Sales {
  aggregate Order { total: int }
}
`;

describe("toolSpecs", () => {
  it("exposes every catalog tool as a provider-neutral spec", () => {
    const specs = toolSpecs();
    expect(specs.length).toBeGreaterThanOrEqual(10);
    for (const s of specs) {
      expect(s.name).toMatch(/^loom_/);
      expect(typeof s.description).toBe("string");
      expect((s.input_schema as { type?: string }).type).toBe("object");
    }
    expect(specs.map((s) => s.name)).toContain("loom_validate");
  });
});

describe("dispatchToolUses", () => {
  it("runs a tool_use through the catalog and returns its JSON result", async () => {
    const results = await dispatchToolUses([
      { type: "tool_use", id: "t1", name: "loom_validate", input: { source: CLEAN } },
    ]);
    expect(results).toHaveLength(1);
    expect(results[0]!.tool_use_id).toBe("t1");
    expect(results[0]!.is_error).toBeUndefined();
    expect(JSON.parse(results[0]!.content)).toMatchObject({ ok: true });
  });

  it("turns an unknown tool / handler throw into an is_error result", async () => {
    const results = await dispatchToolUses([
      { type: "tool_use", id: "t1", name: "loom_nope", input: {} },
    ]);
    expect(results[0]!.is_error).toBe(true);
    expect(results[0]!.content).toMatch(/unknown tool/);
  });

  it("ignores non-tool_use blocks", async () => {
    expect(await dispatchToolUses([{ type: "text", text: "hi" }])).toEqual([]);
  });
});

describe("runAgent", () => {
  it("stops immediately when the model emits no tool_use", async () => {
    const complete = scripted([
      { content: [{ type: "text", text: "hello" }], stop_reason: "end_turn" },
    ]);
    const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }];
    const result = await runAgent({ complete, messages });
    expect(result.stoppedBy).toBe("end_turn");
    expect(result.steps).toBe(1);
    // user seed + one assistant turn.
    expect(messages).toHaveLength(2);
  });

  it("runs a tool the model requests and feeds the result back before ending", async () => {
    const complete = scripted([
      {
        content: [{ type: "tool_use", id: "t1", name: "loom_validate", input: { source: CLEAN } }],
        stop_reason: "tool_use",
      },
      { content: [{ type: "text", text: "looks valid" }], stop_reason: "end_turn" },
    ]);
    const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "check this" }] }];
    const result = await runAgent({ complete, messages });

    expect(result.stoppedBy).toBe("end_turn");
    expect(result.steps).toBe(2);
    // seed + assistant(tool_use) + user(tool_result) + assistant(text).
    expect(messages).toHaveLength(4);
    const toolTurn = messages[2]!;
    expect(toolTurn.role).toBe("user");
    expect(toolTurn.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "t1" });
    // the SECOND completion call must have seen the tool result fed back.
    expect(complete.seen[1]!.some((m) => m.content.some((c) => c.type === "tool_result"))).toBe(
      true,
    );
  });

  it("composes the validate → apply_patch authoring loop through the catalog", async () => {
    // bare cross-aggregate ref — the fix is `Customer id`.
    const BARE = `context Sales {
  aggregate Order { customer: Customer }
  aggregate Customer { name: string }
}
`;
    const complete = scripted([
      {
        content: [
          {
            type: "tool_use",
            id: "fix",
            name: "loom_apply_patch",
            input: {
              source: BARE,
              patches: [
                {
                  op: "replace",
                  target: "aggregate Sales.Order.customer",
                  source: "customer: Customer id",
                },
              ],
            },
          },
        ],
        stop_reason: "tool_use",
      },
      { content: [{ type: "text", text: "fixed" }], stop_reason: "end_turn" },
    ]);
    const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "fix it" }] }];
    await runAgent({ complete, messages });
    const toolResult = messages[2]!.content[0];
    if (toolResult?.type !== "tool_result") throw new Error("expected tool_result");
    const patched = JSON.parse(toolResult.content) as { ok: boolean; text?: string };
    expect(patched.ok).toBe(true);
    expect(patched.text).toContain("customer: Customer id");
  });

  it("caps runaway tool ping-pong at maxSteps", async () => {
    // a model that ALWAYS asks for a tool would loop forever without the cap.
    const always: Complete = async () => ({
      content: [{ type: "tool_use", id: "x", name: "loom_validate", input: { source: CLEAN } }],
      stop_reason: "tool_use",
    });
    const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "go" }] }];
    const result = await runAgent({ complete: always, messages, maxSteps: 3 });
    expect(result.stoppedBy).toBe("max_steps");
    expect(result.steps).toBe(3);
  });

  it("streams each appended message through onMessage", async () => {
    const complete = scripted([
      {
        content: [{ type: "tool_use", id: "t1", name: "loom_validate", input: { source: CLEAN } }],
        stop_reason: "tool_use",
      },
      { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" },
    ]);
    const streamed: Message[] = [];
    const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }];
    await runAgent({ complete, messages, onMessage: (m) => streamed.push(m) });
    // assistant(tool_use) + user(tool_result) + assistant(text) = 3.
    expect(streamed).toHaveLength(3);
  });
});

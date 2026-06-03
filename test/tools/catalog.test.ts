import { describe, expect, it } from "vitest";
import type { GenerateReport, Outline, PatchResult, ValidateReport } from "../../src/api/index.js";
import { callTool, TOOLS, TOOLS_BY_NAME } from "../../src/tools/index.js";

// ---------------------------------------------------------------------------
// The agent-tool catalog (src/tools/, D-AGENT-TOOLS) — the one tool set every
// transport (MCP server, playground chat) shares.  Completeness + dispatch.
// ---------------------------------------------------------------------------

const CLEAN = `context Sales {
  aggregate Order { total: int }
}
`;

const BARE = `context Sales {
  aggregate Order { customer: Customer }
  aggregate Customer { name: string }
}
`;

describe("agent-tool catalog", () => {
  it("every tool is well-formed (loom_ name, description, object inputSchema, handler)", () => {
    expect(TOOLS.length).toBeGreaterThanOrEqual(4);
    for (const t of TOOLS) {
      expect(t.name).toMatch(/^loom_[a-z_]+$/);
      expect(t.description.length).toBeGreaterThan(20);
      expect((t.inputSchema as { type?: string }).type).toBe("object");
      expect(typeof t.handler).toBe("function");
    }
    // names are unique and indexed
    expect(Object.keys(TOOLS_BY_NAME).sort()).toEqual(TOOLS.map((t) => t.name).sort());
  });

  it("loom_validate dispatches to a ValidateReport", async () => {
    const ok = (await callTool("loom_validate", { source: CLEAN })) as ValidateReport;
    expect(ok.ok).toBe(true);
    const bad = (await callTool("loom_validate", { source: BARE })) as ValidateReport;
    expect(bad.ok).toBe(false);
    expect(bad.diagnostics.some((d) => d.code === "loom.bare-aggregate-in-type")).toBe(true);
  });

  it("loom_outline returns the address book", async () => {
    const out = (await callTool("loom_outline", { source: CLEAN })) as Outline;
    expect(out.contexts.find((c) => c.name === "Sales")).toBeDefined();
  });

  it("loom_generate reports validation (no system → empty manifest, still ok)", async () => {
    const r = (await callTool("loom_generate", { source: CLEAN })) as GenerateReport;
    expect(r.ok).toBe(true);
    expect(Array.isArray(r.deployables)).toBe(true);
  });

  it("loom_apply_patch applies a node-addressed edit", async () => {
    const r = (await callTool("loom_apply_patch", {
      source: CLEAN,
      patches: [{ op: "add", target: "aggregate Sales.Order", source: "note: string" }],
    })) as PatchResult;
    expect(r.ok).toBe(true);
    expect(r.text).toContain("note: string");
  });

  it("the loop composes through the catalog: validate → fix → validate", async () => {
    const before = (await callTool("loom_validate", { source: BARE })) as ValidateReport;
    const patches = before.diagnostics
      .map((d) => d.fixHint?.patch)
      .filter((p): p is NonNullable<typeof p> => p !== undefined);
    const applied = (await callTool("loom_apply_patch", {
      source: BARE,
      patches,
    })) as PatchResult;
    expect(applied.ok).toBe(true);
    const after = (await callTool("loom_validate", { source: applied.text })) as ValidateReport;
    expect(after.ok).toBe(true);
  });

  it("rejects unknown tools and bad args", async () => {
    await expect(callTool("loom_nope", {})).rejects.toThrow(/unknown tool/);
    await expect(callTool("loom_validate", {})).rejects.toThrow(/must be a string/);
  });
});

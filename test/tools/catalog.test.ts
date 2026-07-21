import { describe, expect, it } from "vitest";
import type {
  GenerateReport,
  ModelView,
  Outline,
  PatchResult,
  PrimitiveCatalog,
  ValidateReport,
} from "../../src/api/index.js";
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

  it("loom_read_model projects the resolved wire shape a loose context omits from the outline", async () => {
    const mv = (await callTool("loom_read_model", { source: CLEAN })) as ModelView;
    // CLEAN is a loose context (no `system`), so it lands under `contexts`.
    const sales = mv.contexts.find((c) => c.name === "Sales");
    expect(sales).toBeDefined();
    const order = sales?.aggregates.find((a) => a.name === "Order");
    expect(order?.context).toBe("Sales");
    // Wire shape leads with the id token, then the declared `total: int`.
    expect(order?.wire.some((f) => f.source === "id")).toBe(true);
    const total = order?.wire.find((f) => f.name === "total");
    expect(total?.type).toBe("int");
    expect(total?.source).toBe("property");
  });

  it("loom_read_model returns an empty view for a source that can't lower", async () => {
    const mv = (await callTool("loom_read_model", { source: "not a model" })) as ModelView;
    expect(mv).toEqual({ systems: [], contexts: [] });
  });

  it("loom_list_primitives lists the closed walker vocabulary (no args)", async () => {
    const cat = (await callTool("loom_list_primitives", {})) as PrimitiveCatalog;
    expect(cat.layout).toEqual([...cat.layout].sort()); // stable, sorted
    for (const name of ["Stack", "Heading", "Button", "Card", "Field", "Table"]) {
      expect(cat.layout).toContain(name);
    }
    expect(cat.sub).toContain("Tab");
    expect(cat.sub).toContain("Column");
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

  it("loom_apply_patch renames a declaration and its cross-references", async () => {
    const withRef = `context Sales {
  aggregate Order { customer: Customer id }
  aggregate Customer { name: string }
}
`;
    const r = (await callTool("loom_apply_patch", {
      source: withRef,
      patches: [{ op: "rename", target: "aggregate Sales.Customer", source: "Client" }],
    })) as PatchResult;
    expect(r.ok).toBe(true);
    expect(r.text).toContain("aggregate Client");
    expect(r.text).toContain("customer: Client id");
    expect(r.text).not.toContain("Customer");
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

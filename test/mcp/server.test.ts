import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import type { ValidateReport } from "../../src/api/index.js";
import { createServer, SERVER_INFO } from "../../src/mcp/server.js";

// ---------------------------------------------------------------------------
// MCP-server smoke test — drives the catalog-backed `Server` over the SDK's
// in-memory transport (no subprocess, no stdio), the same way an external host
// would over stdio.  Proves the transport surfaces the catalog (`tools/list`)
// and dispatches a real authoring-loop call (`tools/call loom_validate`).  The
// tool *logic* is covered by test/tools/catalog.test.ts; this guards the wiring.
// ---------------------------------------------------------------------------

const CLEAN = `context Sales {
  aggregate Order { total: int }
}
`;

// `customer:` is a bare cross-aggregate reference — must be `Customer id`.
const INVALID = `context Sales {
  aggregate Order { customer: Customer }
  aggregate Customer { name: string }
}
`;

/** Spin up the server + a linked in-memory client, both connected. */
async function connectClient(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-host", version: "0.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

/** The text payload of a tool result's first content block. */
function textOf(result: { content?: Array<{ type: string; text?: string }> }): string {
  const block = result.content?.find((c) => c.type === "text");
  if (!block?.text) throw new Error("no text content block in tool result");
  return block.text;
}

describe("ddd-mcp server", () => {
  it("lists the full agent-tool catalog with JSON-Schema inputs", async () => {
    const client = await connectClient();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "loom_apply_patch",
      "loom_find_symbol",
      "loom_generate",
      "loom_hover",
      "loom_list_primitives",
      "loom_outline",
      "loom_quickfix",
      "loom_read_model",
      "loom_references",
      "loom_rename",
      "loom_unfold_macro",
      "loom_validate",
    ]);
    for (const t of tools) {
      expect(t.description?.length).toBeGreaterThan(20);
      expect((t.inputSchema as { type?: string }).type).toBe("object");
    }
  });

  it("advertises the ddd-mcp server identity", async () => {
    const client = await connectClient();
    const info = client.getServerVersion();
    expect(info?.name).toBe(SERVER_INFO.name);
  });

  it("dispatches loom_validate and returns a clean report for valid source", async () => {
    const client = await connectClient();
    const result = await client.callTool({
      name: "loom_validate",
      arguments: { source: CLEAN },
    });
    expect(result.isError).toBeFalsy();
    const report = JSON.parse(textOf(result as never)) as ValidateReport;
    expect(report.ok).toBe(true);
    expect(report.diagnostics).toEqual([]);
    // The outline rides along so the host can address nodes for follow-up edits.
    expect(report.outline).toBeDefined();
  });

  it("surfaces coded diagnostics through loom_validate for invalid source", async () => {
    const client = await connectClient();
    const result = await client.callTool({
      name: "loom_validate",
      arguments: { source: INVALID },
    });
    expect(result.isError).toBeFalsy();
    const report = JSON.parse(textOf(result as never)) as ValidateReport;
    expect(report.ok).toBe(false);
    expect(report.diagnostics.some((d) => d.code === "loom.bare-aggregate-in-type")).toBe(true);
  });

  it("reports an unknown tool as an MCP tool error, not a protocol failure", async () => {
    const client = await connectClient();
    const result = await client.callTool({ name: "loom_nope", arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result as never)).toMatch(/unknown tool/);
  });
});

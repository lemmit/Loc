// The Loom agent-tool catalog — see docs/old/proposals/agent-tools-and-mcp.md and
// D-AGENT-TOOLS.  Transport-neutral: imported by the MCP server, the playground
// chat, and any future host.

export {
  type Complete,
  type Completion,
  type ContentBlock,
  dispatchToolUses,
  type Message,
  type RunAgentOptions,
  type RunAgentResult,
  runAgent,
  type TextBlock,
  type ToolResultBlock,
  type ToolSpec,
  type ToolUseBlock,
  toolSpecs,
} from "./agent-loop.js";
export { callTool, TOOLS, TOOLS_BY_NAME, type ToolDef } from "./catalog.js";

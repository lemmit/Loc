// ---------------------------------------------------------------------------
// The Loom agent-tool catalog (D-AGENT-TOOLS) — one transport-neutral set of
// tool definitions over the `src/api/` toolkit.  Every transport reuses it
// verbatim: the MCP stdio server (`packages/ddd-mcp`), the in-browser
// playground chat (direct dispatch), and any future HTTP host.
//
// Each entry pairs a JSON-Schema input with a handler that calls the toolkit
// and returns a contract wire shape.  Tools are PURE functions of their inputs
// (model `source` in → report / new-source out) — no server-side state, no
// filesystem side effect.  No MCP dependency, no Node-only imports → browser-safe.
//
// This module is the GENERATIVE family (the authoring loop).  The NAVIGATIONAL
// family (find_symbol / references / rename / quickfix over the LSP providers)
// joins the same catalog in a later slice — see
// docs/proposals/agent-tools-and-mcp.md §4b.
// ---------------------------------------------------------------------------

import { applyPatches, generate, outline, validate } from "../api/index.js";
import type { ModelPatch } from "../diagnostics/contract.js";

/** A single agent tool: a name, an LLM-facing description, a JSON-Schema input,
 *  and a handler that runs it against the toolkit. */
export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments (what MCP / function-calling needs). */
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

const SOURCE_SCHEMA = {
  type: "object",
  properties: { source: { type: "string", description: "The .ddd model source." } },
  required: ["source"],
  additionalProperties: false,
} as const;

function reqString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string") throw new Error(`'${key}' must be a string`);
  return v;
}

export const TOOLS: ToolDef[] = [
  {
    name: "loom_validate",
    description:
      "Validate a .ddd model source. Returns coded, located diagnostics (each with an optional fix-hint patch) plus the model outline. Use this as the repair loop's oracle.",
    inputSchema: SOURCE_SCHEMA,
    handler: (args) => validate(reqString(args, "source")),
  },
  {
    name: "loom_outline",
    description:
      "Return the model's outline — the address book of contexts, aggregates, and members. The addresses here are exactly the `target`s loom_apply_patch takes and the diagnostics point at.",
    inputSchema: SOURCE_SCHEMA,
    handler: (args) => outline(reqString(args, "source")),
  },
  {
    name: "loom_generate",
    description:
      "Validate a .ddd model and report the deployable manifest (name / platform / port). Writes no files.",
    inputSchema: SOURCE_SCHEMA,
    handler: (args) => generate(reqString(args, "source")),
  },
  {
    name: "loom_apply_patch",
    description:
      "Apply node-addressed model patches to a .ddd source. Each patch is { op: add|replace|remove|insert, target: <node address>, source?: <.ddd text>, position? }. add appends a member to a free-body container; replace/remove edit the targeted node; insert places source before/after a sibling or at header-end (before the target's opening '{', for header clauses). Atomic — if any patch fails to resolve, nothing is applied. Returns the patched source or per-patch errors.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "The .ddd model source." },
        patches: {
          type: "array",
          description: "Node-addressed edits, applied atomically.",
          items: {
            type: "object",
            properties: {
              op: { type: "string", enum: ["add", "replace", "remove", "insert"] },
              target: {
                type: "string",
                description:
                  "Canonical node address, e.g. 'aggregate Sales.Order.status' or 'context Sales' (an add target is the container).",
              },
              source: {
                type: "string",
                description:
                  ".ddd text for the new/replacement node (required for add/replace/insert).",
              },
              position: {
                type: "string",
                enum: ["before", "after", "header-end"],
                description:
                  "For op=insert only: place source before/after the target sibling, or at header-end (before its '{'). Default 'after'.",
              },
            },
            required: ["op", "target"],
            additionalProperties: false,
          },
        },
      },
      required: ["source", "patches"],
      additionalProperties: false,
    },
    handler: (args) => {
      const source = reqString(args, "source");
      if (!Array.isArray(args.patches)) throw new Error("'patches' must be an array");
      return applyPatches(source, args.patches as ModelPatch[]);
    },
  },
];

/** Catalog indexed by tool name. */
export const TOOLS_BY_NAME: Record<string, ToolDef> = Object.fromEntries(
  TOOLS.map((t) => [t.name, t]),
);

/** Dispatch a tool call by name — the one entry point every transport uses. */
export async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const tool = TOOLS_BY_NAME[name];
  if (!tool) throw new Error(`unknown tool '${name}'`);
  return tool.handler(args);
}

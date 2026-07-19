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
// This module hosts the GENERATIVE family (the authoring loop) AND the full
// NAVIGATIONAL family (§4b) over the LSP providers, addressed by symbol name:
// the read verbs (find_symbol / references / hover) and the rewrite verbs
// (rename / quickfix / unfold_macro) — the latter RETURN edits, never applying
// them (contract §3).  See docs/old/proposals/agent-tools-and-mcp.md §4b.
// ---------------------------------------------------------------------------

import {
  applyPatches,
  findSymbol,
  generate,
  hover,
  listPrimitives,
  outline,
  quickfix,
  readModel,
  references,
  rename,
  unfoldMacro,
  validate,
} from "../api/index.js";
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

/** No-argument tool schema (loom_list_primitives is a static catalog). */
const EMPTY_SCHEMA = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

function reqString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string") throw new Error(`'${key}' must be a string`);
  return v;
}

function optString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new Error(`'${key}' must be a string`);
  return v;
}

/** `{ source, symbol }` schema shared by the read-navigation tools. */
const SYMBOL_SCHEMA = {
  type: "object",
  properties: {
    source: { type: "string", description: "The .ddd model source." },
    symbol: {
      type: "string",
      description:
        "Dotted symbol path — short form 'Order.customerId' when unambiguous, fully qualified 'Sales.Order.customerId' otherwise. Same address space as loom_outline and the diagnostic node fields.",
    },
  },
  required: ["source", "symbol"],
  additionalProperties: false,
} as const;

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
    name: "loom_read_model",
    description:
      "Return the RESOLVED model — each system's deployables (name/platform/port) plus every aggregate's canonical wire shape (the ordered DTO fields id → properties → containments → derived, each with rendered type, optionality, and provenance). This is the semantic wire contract loom_outline (a name-only address book) omits — use it to see what a field's type actually is and what the backend will emit. Runs lowering + enrichment; empty when the source can't lower.",
    inputSchema: SOURCE_SCHEMA,
    handler: (args) => readModel(reqString(args, "source")),
  },
  {
    name: "loom_list_primitives",
    description:
      "List the closed page-body primitive vocabulary the UI walker admits (layout/display/input primitives — Stack, Group, Grid, Table, Field, Heading, Button, Card, CreateForm, … — plus the sub-primitives Tab/Column). These are the ONLY names valid as component types in a page/component body without declaring a domain type — consult this before authoring UI to avoid inventing primitives the validator rejects. Takes no arguments.",
    inputSchema: EMPTY_SCHEMA,
    handler: () => Promise.resolve(listPrimitives()),
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
  {
    name: "loom_find_symbol",
    description:
      "Locate a symbol by name. Returns its canonical address, kind, name-token range, and parent declaration. Optional 'kind' (e.g. 'aggregate', 'property', 'operation') disambiguates a name shared across kinds. An ambiguous or unknown symbol returns { error, candidates } — never a silent pick.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "The .ddd model source." },
        symbol: {
          type: "string",
          description:
            "Dotted symbol path — short form 'Order.customerId' when unambiguous, fully qualified otherwise.",
        },
        kind: {
          type: "string",
          description:
            "Optional kind filter — the node's own kind (aggregate / valueobject / property / containment / derived / operation / function / event / enum / value / repository / find / context / deployable / …).",
        },
      },
      required: ["source", "symbol"],
      additionalProperties: false,
    },
    handler: (args) =>
      findSymbol(reqString(args, "source"), reqString(args, "symbol"), optString(args, "kind")),
  },
  {
    name: "loom_references",
    description:
      "Find every usage site of a symbol (including its declaration) — member accesses and bare refs the cross-reference index can't see are included. Returns located ranges. Ambiguous/unknown symbol returns { error, candidates }.",
    inputSchema: SYMBOL_SCHEMA,
    handler: (args) => references(reqString(args, "source"), reqString(args, "symbol")),
  },
  {
    name: "loom_hover",
    description:
      "The hover bubble (markdown) for a symbol — its signature / type summary, exactly as the editor shows. Ambiguous/unknown symbol returns { error, candidates }.",
    inputSchema: SYMBOL_SCHEMA,
    handler: (args) => hover(reqString(args, "source"), reqString(args, "symbol")),
  },
  {
    name: "loom_rename",
    description:
      "Rename a symbol everywhere — returns the text edits (declaration + every use site, including member accesses the cross-reference index can't see), WITHOUT applying them. Apply the edits to your buffer. Ambiguous/unknown symbol returns { error, candidates }.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "The .ddd model source." },
        symbol: {
          type: "string",
          description: "Dotted symbol path of the declaration to rename.",
        },
        newName: { type: "string", description: "The new name." },
      },
      required: ["source", "symbol", "newName"],
      additionalProperties: false,
    },
    handler: (args) =>
      rename(reqString(args, "source"), reqString(args, "symbol"), reqString(args, "newName")),
  },
  {
    name: "loom_quickfix",
    description:
      "Return the fix-hint edits for a diagnostic code (from loom_validate), WITHOUT applying them. 'at' is the diagnostic's node address — required when several diagnostics share the code. Returns { edits, title } or { error } (not-found / ambiguous / no-fix).",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "The .ddd model source." },
        code: {
          type: "string",
          description: "The diagnostic code to fix, e.g. 'loom.bare-aggregate-in-type'.",
        },
        at: {
          type: "string",
          description:
            "Optional node address (the diagnostic's 'node' field) — disambiguates when several diagnostics share the code.",
        },
      },
      required: ["source", "code"],
      additionalProperties: false,
    },
    handler: (args) =>
      quickfix(reqString(args, "source"), reqString(args, "code"), optString(args, "at")),
  },
  {
    name: "loom_unfold_macro",
    description:
      "Unfold a 'with <macro>(...)' clause on a host into its expanded source — returns the refactor edits, WITHOUT applying them. 'on' is the host symbol (e.g. an aggregate). Returns { edits, title } or { error } (not-found with the macros it does carry / cannot-unfold).",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "The .ddd model source." },
        macro: { type: "string", description: "The macro name to unfold, e.g. 'crudish'." },
        on: {
          type: "string",
          description: "The host symbol the macro is applied to (e.g. 'Order').",
        },
      },
      required: ["source", "macro", "on"],
      additionalProperties: false,
    },
    handler: (args) =>
      unfoldMacro(reqString(args, "source"), reqString(args, "macro"), reqString(args, "on")),
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

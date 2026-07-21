import { AstUtils, type AstNode } from "langium";
import type { BoundedContext, Model, System } from "../../../../src/language/generated/ast.js";
import { applyEdits } from "../edit-engine";
import { parseDdd } from "../parse";
import type { NodeKind } from "./model";

// ---------------------------------------------------------------------------
// Adding constructs to a system from the Model builder. Domain constructs land
// in a bounded context (the user picks which when there's more than one);
// `api` references a subdomain (likewise pickable); infra constructs (storage / ui
// / deployable) live at system scope. Every add is parse-guarded — an edit that
// wouldn't parse is rejected (returns null) rather than written.
// ---------------------------------------------------------------------------

const CONSTRUCT_BASE: Partial<Record<NodeKind, string>> = {
  aggregate: "Aggregate",
  valueobject: "ValueObject",
  event: "Event",
  repository: "Repository",
  workflow: "Workflow",
  api: "Api",
  storage: "Storage",
  ui: "Ui",
  deployable: "Deployable",
};

// Infra constructs live at system scope; domain constructs live in a context.
const INFRA_KINDS = new Set<NodeKind>(["api", "storage", "ui", "deployable"]);

/** A fresh `<base><n>` name not already taken anywhere in the model. */
function freshName(ast: Model, base: string): string {
  const taken = new Set<string>();
  for (const n of AstUtils.streamAst(ast)) {
    const name = (n as { name?: unknown }).name;
    if (typeof name === "string") taken.add(name);
  }
  for (let i = 1; ; i++) {
    const candidate = `${base}${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Insert `text` just before the closing brace of `block` (i.e. as its last
 *  child). `block` must come from parsing the same source. */
function insertIntoBlock(source: string, block: AstNode, text: string): string {
  const cst = block.$cstNode;
  if (!cst) throw new Error("insertIntoBlock: node has no CST");
  const at = cst.end - 1; // before the trailing `}`
  return applyEdits(source, [{ offset: at, end: at, newText: text }]);
}

function contexts(ast: Model): BoundedContext[] {
  return [...AstUtils.streamAst(ast)].filter((n): n is BoundedContext => n.$type === "BoundedContext");
}

/** Bounded-context names, in document order (for the add target picker). */
export function listContextNames(ast: Model): string[] {
  return contexts(ast).map((c) => c.name);
}

/** Subdomain names, in document order (for the `api from <subdomain>` picker). */
export function listSubdomainNames(ast: Model): string[] {
  const out: string[] = [];
  for (const n of AstUtils.streamAst(ast)) {
    if (n.$type === "Subdomain") out.push((n as { name?: string }).name ?? "");
  }
  return out;
}

export function firstAggregateName(ast: Model): string | undefined {
  for (const n of AstUtils.streamAst(ast)) {
    if (n.$type === "Aggregate") return (n as { name?: string }).name;
  }
  return undefined;
}

function firstAggregateIn(ctx: BoundedContext): string | undefined {
  for (const m of ctx.members) {
    if (m.$type === "Aggregate") return (m as { name?: string }).name;
  }
  return undefined;
}

// Minimal-but-valid source for a freshly added construct. repository
// references an aggregate in its own context; `api` references a subdomain —
// returning null (so the add is skipped) when no such target exists.
function constructTemplate(
  kind: NodeKind,
  name: string,
  ast: Model,
  container: AstNode,
  opts: { subdomain?: string },
): string | null {
  switch (kind) {
    case "aggregate":
      return `\n    aggregate ${name} {\n    }\n`;
    case "valueobject":
      return `\n    valueobject ${name} {\n      value: string\n    }\n`;
    case "event":
      return `\n    event ${name} {\n    }\n`;
    case "workflow":
      return `\n    workflow ${name} {\n    }\n`;
    case "repository": {
      const agg = firstAggregateIn(container as BoundedContext);
      return agg ? `\n    repository ${name} for ${agg} {\n    }\n` : null;
    }
    case "storage":
      return `\n  storage ${name} {\n    type: postgres\n  }\n`;
    case "ui":
      return `\n  ui ${name} {\n  }\n`;
    case "deployable":
      return `\n  deployable ${name} {\n    platform: node\n  }\n`;
    case "api": {
      const sub = opts.subdomain ?? listSubdomainNames(ast)[0];
      return sub ? `\n  api ${name} from ${sub}\n` : null;
    }
    default:
      return null;
  }
}

/** Add a construct to `source`, returning the new source or null if it can't be
 *  placed / wouldn't parse. `opts.context` picks the target bounded context for
 *  domain kinds (defaults to the first); `opts.subdomain` picks the `api` source
 *  subdomain (defaults to the first). */
export function addConstructSource(
  source: string,
  kind: NodeKind,
  opts: { context?: string; subdomain?: string } = {},
): string | null {
  const ast = parseDdd(source).ast;
  let container: AstNode | undefined;
  if (INFRA_KINDS.has(kind)) {
    container = ast.members.find((m): m is System => m.$type === "System");
  } else {
    const ctxs = contexts(ast);
    container = (opts.context ? ctxs.find((c) => c.name === opts.context) : undefined) ?? ctxs[0];
  }
  if (!container) return null;
  const name = freshName(ast, CONSTRUCT_BASE[kind] ?? "Node");
  const text = constructTemplate(kind, name, ast, container, opts);
  if (!text) return null;
  const next = insertIntoBlock(source, container, text);
  return parseDdd(next).parserErrors.length === 0 ? next : null;
}

/** Add a subdomain (with a starter context) at system scope. */
export function addSubdomainSource(source: string): string | null {
  const ast = parseDdd(source).ast;
  const system = ast.members.find((m): m is System => m.$type === "System");
  if (!system) return null;
  const name = freshName(ast, "Subdomain");
  const text = `\n  subdomain ${name} {\n    context ${name}Ctx {\n    }\n  }\n`;
  const next = insertIntoBlock(source, system, text);
  return parseDdd(next).parserErrors.length === 0 ? next : null;
}

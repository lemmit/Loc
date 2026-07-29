// v2-only construct adders that v1's `add.ts` doesn't expose: inserting a new
// bounded context into an existing subdomain, and a new operation into an
// existing aggregate. Same shape as `addConstructSource` / `addSubdomainSource`:
// pure, parse-guarded splice; returns null on lookup failure / parse failure.

import { AstUtils, type AstNode } from "langium";
import type {
  Aggregate,
  BoundedContext,
  EventDecl,
  Model,
  Subdomain,
  System,
} from "../../../../src/language/generated/ast.js";
import { applyEdits } from "../edit-engine";
import { parseDdd } from "../parse";

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

function insertIntoBlock(source: string, block: AstNode, text: string): string {
  const cst = block.$cstNode;
  if (!cst) throw new Error("insertIntoBlock: node has no CST");
  const at = cst.end - 1; // just before the closing `}`
  return applyEdits(source, [{ offset: at, end: at, newText: text }]);
}

function ifParses(candidate: string): string | null {
  return parseDdd(candidate).parserErrors.length === 0 ? candidate : null;
}

/** Add a new (empty) bounded context to an existing subdomain, returning the new
 *  source or null when the subdomain isn't found / the result wouldn't parse. */
export function addContextSource(source: string, subdomainName: string): string | null {
  const ast = parseDdd(source).ast;
  let sub: Subdomain | undefined;
  for (const m of ast.members) {
    if (m.$type === "System") {
      for (const sm of (m as System).members) {
        if (sm.$type === "Subdomain" && (sm as Subdomain).name === subdomainName) sub = sm as Subdomain;
      }
    }
  }
  if (!sub) return null;
  const name = freshName(ast, "Context");
  const text = `\n    context ${name} {\n    }\n`;
  return ifParses(insertIntoBlock(source, sub, text));
}

/** Add a new no-arg operation to an existing aggregate. */
export function addOperationSource(source: string, aggregateName: string): string | null {
  const ast = parseDdd(source).ast;
  let agg: Aggregate | undefined;
  for (const n of AstUtils.streamAst(ast)) {
    if (n.$type === "Aggregate" && (n as Aggregate).name === aggregateName) {
      agg = n as Aggregate;
      break;
    }
  }
  if (!agg) return null;
  const name = freshName(ast, "op");
  const text = `\n      operation ${name}() {\n      }\n`;
  return ifParses(insertIntoBlock(source, agg, text));
}

// ---------------------------------------------------------------------------
// Context-scope construct kinds the v2 view now renders but aren't in v1's
// `NodeKind` union (`../system/model`), so — like `addContextSource` /
// `addOperationSource` above — they get their own function here rather than
// widening `add.ts`'s `addConstructSource` switch. `channel` carries a
// mandatory `carries:` event ref; the add targets the first event already
// declared in the SAME context and returns null when the context has none
// (repository/api's null-on-missing-target convention). The rest have no
// mandatory ref and always produce a template.
// ---------------------------------------------------------------------------

export type ContextExtraKind =
  | "projection"
  | "domainService"
  | "channel"
  | "criterion"
  | "retrieval"
  | "payload"
  | "enum"
  | "policy";

const CONTEXT_EXTRA_BASE: Record<ContextExtraKind, string> = {
  projection: "Projection",
  domainService: "DomainService",
  channel: "Channel",
  criterion: "Criterion",
  retrieval: "Retrieval",
  payload: "Payload",
  enum: "Enum",
  policy: "Policy",
};

function findContext(ast: Model, name: string): BoundedContext | undefined {
  for (const n of AstUtils.streamAst(ast)) {
    if (n.$type === "BoundedContext" && (n as BoundedContext).name === name) return n as BoundedContext;
  }
  return undefined;
}

function firstEventIn(ctx: BoundedContext): string | undefined {
  for (const m of ctx.members) {
    if (m.$type === "EventDecl") return (m as EventDecl).name;
  }
  return undefined;
}

function contextExtraTemplate(kind: ContextExtraKind, name: string, ctx: BoundedContext): string | null {
  switch (kind) {
    case "projection":
      return `\n    projection ${name} {\n    }\n`;
    case "domainService":
      return `\n    domainService ${name} {\n    }\n`;
    case "channel": {
      const event = firstEventIn(ctx);
      return event ? `\n    channel ${name} {\n      carries: ${event}\n    }\n` : null;
    }
    case "criterion":
      return `\n    criterion ${name} of bool = true\n`;
    case "retrieval":
      return `\n    retrieval ${name} of bool = true\n`;
    case "payload":
      return `\n    payload ${name} {\n    }\n`;
    case "enum":
      return `\n    enum ${name} {\n      A\n    }\n`;
    case "policy":
      return `\n    policy ${name}(): bool = true\n`;
    default:
      return null;
  }
}

/** Add a context-scope construct from the v2-only kind set to the named
 *  context. Returns null when the context isn't found, or when `channel`'s
 *  mandatory `carries:` target (an event declared in that same context) is
 *  absent. */
export function addContextExtraSource(
  source: string,
  contextName: string,
  kind: ContextExtraKind,
): string | null {
  const ast = parseDdd(source).ast;
  const ctx = findContext(ast, contextName);
  if (!ctx) return null;
  const name = freshName(ast, CONTEXT_EXTRA_BASE[kind]);
  const text = contextExtraTemplate(kind, name, ctx);
  if (!text) return null;
  return ifParses(insertIntoBlock(source, ctx, text));
}

/** Add a `permissions { <perm> }` block (with one fresh permission decl) to
 *  the named subdomain. Returns null when the subdomain isn't found. */
export function addPermissionsSource(source: string, subdomainName: string): string | null {
  const ast = parseDdd(source).ast;
  let sub: Subdomain | undefined;
  for (const m of ast.members) {
    if (m.$type === "System") {
      for (const sm of (m as System).members) {
        if (sm.$type === "Subdomain" && (sm as Subdomain).name === subdomainName) sub = sm as Subdomain;
      }
    }
  }
  if (!sub) return null;
  const permName = freshName(ast, "permission");
  const text = `\n    permissions {\n      ${permName}\n    }\n`;
  return ifParses(insertIntoBlock(source, sub, text));
}

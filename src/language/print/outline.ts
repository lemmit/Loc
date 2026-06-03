// ---------------------------------------------------------------------------
// Outline + node addressing for the structured-diagnostics contract
// (docs/proposals/ai-diagnostics-contract.md §5).
//
// `addressOf` turns an AST node into a canonical address
// `<keyword> <Context>.<Decl>[.<member>]`; `buildOutline` walks a parsed
// Model into the address book the AI authoring loop uses to resolve patch
// targets.  Both share one address space (the diagnostic `node` and the
// outline entries are produced by the same function), so a diagnostic always
// points at an address the outline also lists.
//
// Pure language-layer: depends only on the generated AST + langium AstUtils.
// No `ir/` value edge (the pipeline-layering invariant).
// ---------------------------------------------------------------------------

import { type AstNode, AstUtils } from "langium";
import type { Outline, OutlineContext } from "../../diagnostics/contract.js";
import {
  type Aggregate,
  type BoundedContext,
  isAggregate,
  isBoundedContext,
  isPage,
  isSubdomain,
  isSystem,
  isView,
  isWorkflow,
  type Model,
  type System,
} from "../generated/ast.js";

/** Declaration keyword for a node's `$type`.  Aggregate members without a
 *  keyword of their own (properties, containments, derived, invariants…) are
 *  addressed under the `aggregate` keyword, matching the contract example. */
const KEYWORD_BY_TYPE: Record<string, string> = {
  Model: "model",
  System: "system",
  BoundedContext: "context",
  Subdomain: "subdomain",
  Aggregate: "aggregate",
  ValueObject: "valueobject",
  EnumDecl: "enum",
  Workflow: "workflow",
  View: "view",
  Page: "page",
  Component: "component",
  Operation: "operation",
  FunctionDecl: "function",
  Create: "create",
  Destroy: "destroy",
  Apply: "apply",
};

function keywordOf(node: AstNode): string {
  return KEYWORD_BY_TYPE[node.$type] ?? "aggregate";
}

function nameOf(node: AstNode): string | undefined {
  const n = (node as { name?: unknown }).name;
  return typeof n === "string" && n.length > 0 ? n : undefined;
}

/**
 * Canonical address for an AST node, or `undefined` when it cannot be placed
 * (no enclosing named structure).  Best-effort: a node with no name of its own
 * (e.g. an invariant) resolves to its enclosing aggregate's address.
 */
export function addressOf(node: AstNode): string | undefined {
  const ctx = AstUtils.getContainerOfType(node, isBoundedContext);
  // getContainerOfType includes the node itself, so for an Aggregate node
  // `agg === node`.
  const agg = AstUtils.getContainerOfType(node, isAggregate);
  const name = nameOf(node);

  const segs: string[] = [];
  if (ctx) segs.push(ctx.name);
  if (agg && agg !== (node as unknown as Aggregate) && agg !== (ctx as unknown as Aggregate)) {
    segs.push(agg.name);
  }
  if (name && node !== (ctx as unknown as AstNode)) segs.push(name);

  if (segs.length === 0) return undefined;
  return `${keywordOf(node)} ${segs.join(".")}`;
}

/** Every BoundedContext under a system, flattening the optional subdomain
 *  layer (System → Subdomain → contexts, or System → context directly). */
function contextsOf(system: System): BoundedContext[] {
  const out: BoundedContext[] = [];
  for (const m of system.members) {
    if (isBoundedContext(m)) out.push(m);
    else if (isSubdomain(m)) out.push(...m.contexts);
  }
  return out;
}

function outlineContext(ctx: BoundedContext): OutlineContext {
  const aggregates: OutlineContext["aggregates"] = [];
  const workflows: string[] = [];
  const views: string[] = [];
  const pages: string[] = [];

  for (const m of ctx.members) {
    if (isAggregate(m)) {
      const node = addressOf(m);
      // Drop members that have no address of their own (unnamed invariants,
      // `implements`, …): they collapse to the aggregate's address and would
      // duplicate the `node` field.  Named members and the unnamed-but-keyworded
      // lifecycle ops (`create`/`destroy`) keep distinct addresses.
      const members = m.members
        .map((mem) => addressOf(mem))
        .filter((a): a is string => a !== undefined && a !== node);
      if (node) aggregates.push({ node, members });
    } else if (isWorkflow(m)) {
      const a = addressOf(m);
      if (a) workflows.push(a);
    } else if (isView(m)) {
      const a = addressOf(m);
      if (a) views.push(a);
    } else if (isPage(m)) {
      const a = addressOf(m);
      if (a) pages.push(a);
    }
  }

  return { name: ctx.name, aggregates, workflows, views, pages };
}

/**
 * Build the contract's `outline` address book from a parsed Model.  Always
 * returns a valid object; callers wrap in try/catch and fall back to the
 * empty outline on a recovered-but-broken AST (contract §6).
 */
export function buildOutline(model: Model): Outline {
  const systems: Outline["systems"] = [];
  const contexts: OutlineContext[] = [];

  for (const member of model.members) {
    if (isSystem(member)) {
      systems.push({
        name: member.name,
        contexts: contextsOf(member).map(outlineContext),
      });
    } else if (isBoundedContext(member)) {
      contexts.push(outlineContext(member));
    }
  }

  return { systems, contexts };
}

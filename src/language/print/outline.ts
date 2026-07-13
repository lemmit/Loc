// ---------------------------------------------------------------------------
// Outline + node addressing for the structured-diagnostics contract
// (docs/old/proposals/ai-diagnostics-contract.md §5).
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
import type { Outline, OutlineContext, OutlineDecl } from "../../diagnostics/contract.js";
import {
  type Aggregate,
  type BoundedContext,
  isAggregate,
  isBoundedContext,
  isEnumDecl,
  isEventDecl,
  isPage,
  isRepository,
  isSubdomain,
  isSystem,
  isValueObject,
  isView,
  isWorkflow,
  type Model,
  type System,
  type ValueObject,
} from "../generated/ast.js";

/** Declaration keyword for a node's `$type`. */
const KEYWORD_BY_TYPE: Record<string, string> = {
  Model: "model",
  System: "system",
  BoundedContext: "context",
  Subdomain: "subdomain",
  Aggregate: "aggregate",
  ValueObject: "valueobject",
  EnumDecl: "enum",
  EnumValue: "value",
  EventDecl: "event",
  Repository: "repository",
  FindDecl: "find",
  Deployable: "deployable",
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

/** The nearest entity-like container (aggregate or value object) of a node —
 *  the unit a member address is qualified by.  Includes the node itself. */
function entityContainer(node: AstNode): Aggregate | ValueObject | undefined {
  return (
    AstUtils.getContainerOfType(node, isAggregate) ??
    AstUtils.getContainerOfType(node, isValueObject)
  );
}

function nameOf(node: AstNode): string | undefined {
  const n = (node as { name?: unknown }).name;
  return typeof n === "string" && n.length > 0 ? n : undefined;
}

/**
 * Canonical address for an AST node, or `undefined` when it cannot be placed
 * (no enclosing named structure).  A member with its own keyword (operation /
 * function / create / …) is addressed under that keyword; a plain member
 * (property / containment / derived / invariant) is addressed under its
 * enclosing entity's keyword (`aggregate`/`valueobject`).  Best-effort: a node
 * with no name of its own resolves to its enclosing entity's address.
 */
export function addressOf(node: AstNode): string | undefined {
  const ctx = AstUtils.getContainerOfType(node, isBoundedContext);
  // getContainerOfType includes the node itself, so for an aggregate / value
  // object node `entity === node`.
  const entity = entityContainer(node);
  const name = nameOf(node);

  // Own keyword if mapped; otherwise (a plain member) the enclosing entity's.
  let keyword: string | undefined = KEYWORD_BY_TYPE[node.$type];
  if (!keyword && entity && entity !== node) keyword = KEYWORD_BY_TYPE[entity.$type];
  if (!keyword) keyword = "node";

  const segs: string[] = [];
  if (ctx) segs.push(ctx.name);
  if (entity && entity !== (node as unknown) && entity !== (ctx as unknown)) {
    segs.push(entity.name);
  }
  if (name && node !== (ctx as unknown as AstNode)) segs.push(name);

  if (segs.length === 0) return undefined;
  return `${keyword} ${segs.join(".")}`;
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

/** A declaration with addressable members (aggregate / value object); drops
 *  members that collapse to the declaration's own address (unnamed invariants,
 *  `implements`, …) so they don't duplicate the `node`. */
function outlineDecl(decl: Aggregate | ValueObject): OutlineDecl | undefined {
  const node = addressOf(decl);
  if (!node) return undefined;
  const members = decl.members
    .map((mem) => addressOf(mem))
    .filter((a): a is string => a !== undefined && a !== node);
  return { node, members };
}

function outlineContext(ctx: BoundedContext): OutlineContext {
  const aggregates: OutlineDecl[] = [];
  const valueObjects: OutlineDecl[] = [];
  const workflows: string[] = [];
  const views: string[] = [];
  const pages: string[] = [];
  const enums: string[] = [];
  const events: string[] = [];
  const repositories: string[] = [];

  const pushAddr = (m: AstNode, into: string[]) => {
    const a = addressOf(m);
    if (a) into.push(a);
  };

  for (const m of ctx.members) {
    if (isAggregate(m)) {
      const d = outlineDecl(m);
      if (d) aggregates.push(d);
    } else if (isValueObject(m)) {
      const d = outlineDecl(m);
      if (d) valueObjects.push(d);
    } else if (isWorkflow(m)) pushAddr(m, workflows);
    else if (isView(m)) pushAddr(m, views);
    else if (isPage(m)) pushAddr(m, pages);
    else if (isEnumDecl(m)) pushAddr(m, enums);
    else if (isEventDecl(m)) pushAddr(m, events);
    else if (isRepository(m)) pushAddr(m, repositories);
  }

  return {
    name: ctx.name,
    aggregates,
    valueObjects,
    workflows,
    views,
    pages,
    enums,
    events,
    repositories,
  };
}

/** Deployable addresses declared directly under a system. */
function deployablesOf(system: System): string[] {
  const out: string[] = [];
  for (const m of system.members) {
    if (m.$type === "Deployable") {
      const a = addressOf(m);
      if (a) out.push(a);
    }
  }
  return out;
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
        deployables: deployablesOf(member),
      });
    } else if (isBoundedContext(member)) {
      contexts.push(outlineContext(member));
    }
  }

  return { systems, contexts };
}

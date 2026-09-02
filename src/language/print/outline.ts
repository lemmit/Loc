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
  isApply,
  isArea,
  isBoundedContext,
  isComponent,
  isEnumDecl,
  isEventDecl,
  isPage,
  isRepository,
  isStore,
  isSubdomain,
  isSystem,
  isUi,
  isValueObject,
  isWorkflow,
  type Model,
  type System,
  type ValueObject,
} from "../generated/ast.js";

/** Declaration keyword for a node's `$type`.
 *
 *  Membership here means TWO things: the node gets this keyword, and — when it
 *  is named — it contributes a qualifying segment to the addresses of
 *  everything inside it.  That is why `Ui` / `Area` / `EntityPart` being absent
 *  was not a cosmetic gap: a page under `ui Admin { area Back { … } }` had
 *  NOTHING to qualify it, so two pages named alike in different `ui` blocks
 *  produced one address, and an entity part's fields collapsed onto the
 *  aggregate's own address. */
const KEYWORD_BY_TYPE: Record<string, string> = {
  Model: "model",
  System: "system",
  BoundedContext: "context",
  Subdomain: "subdomain",
  Aggregate: "aggregate",
  ValueObject: "valueobject",
  EntityPart: "entity",
  Capability: "capability",
  PayloadDecl: "payload",
  EnumDecl: "enum",
  EnumValue: "value",
  EventDecl: "event",
  Repository: "repository",
  FindDecl: "find",
  Deployable: "deployable",
  Workflow: "workflow",
  Projection: "projection",
  Ui: "ui",
  Area: "area",
  Page: "page",
  Component: "component",
  Store: "store",
  Operation: "operation",
  FunctionDecl: "function",
  Create: "create",
  Destroy: "destroy",
  Apply: "apply",
};

/** Leaf members that carry an address of their own but no keyword — they read
 *  under their enclosing declaration's keyword (`aggregate Sales.Order.total`),
 *  which is what makes a member address say what KIND of thing encloses it. */
const ADDRESSABLE_MEMBER_TYPES: ReadonlySet<string> = new Set([
  "Property",
  "DerivedProp",
  "StateField",
  "ActionDecl",
]);

/** The ambient scaffolding every address omits.  A `system` / `subdomain` is
 *  addressable in its own right but never qualifies what it contains — an
 *  address is read against a workspace, not a deployment. */
const NOT_A_QUALIFIER: ReadonlySet<string> = new Set(["Model", "System", "Subdomain"]);

/** True for a node that can be named as a patch target — a mapped declaration
 *  or one of the leaf members above.  A `Parameter` is deliberately NOT one:
 *  it lives under `params`, is not independently patchable, and would collide
 *  with the entity-part field of the same name. */
export function isAddressable(node: AstNode): boolean {
  return KEYWORD_BY_TYPE[node.$type] !== undefined || ADDRESSABLE_MEMBER_TYPES.has(node.$type);
}

/** The keyword a node reads under.
 *
 *  A payload declaration keeps the spelling its author used — `command Foo`,
 *  `query Foo`, `error Foo` are one AST type with a `kind`, and an address that
 *  said `payload` for all four would name something the source does not. */
function keywordOf(node: AstNode): string | undefined {
  if (node.$type === "PayloadDecl") {
    const kind = (node as { kind?: unknown }).kind;
    if (typeof kind === "string" && kind.length > 0) return kind;
  }
  return KEYWORD_BY_TYPE[node.$type];
}

/** The path segment a node contributes.
 *
 *  `apply` is the one declaration with no name of its own — it is identified by
 *  the event it folds (`apply(e: Opened)`), so THAT is its segment.  Without it
 *  two appliers on one aggregate share an address, which is how
 *  `apply Accounts.Account` came to name two different nodes. */
function segmentOf(node: AstNode): string | undefined {
  if (isApply(node)) return node.event?.ref?.name ?? node.event?.$refText ?? undefined;
  return nameOf(node);
}

function nameOf(node: AstNode): string | undefined {
  const n = (node as { name?: unknown }).name;
  return typeof n === "string" && n.length > 0 ? n : undefined;
}

/**
 * Canonical address for an AST node: `<keyword> <segment>.<segment>…`.
 *
 * The path is every enclosing NAMED DECLARATION from the bounded context (or
 * the `ui`) down to the node itself; the keyword names the innermost enclosing
 * declaration kind.  So a plain field reads `aggregate Sales.Order.total`, a
 * field of a nested entity part reads `entity Sales.Order.Line.qty`, and a page
 * under an area reads `page Admin.Back.Board`.
 *
 * The chain is WALKED rather than read from a fixed pair of slots (one
 * bounded-context, one aggregate/value-object).  A fixed pair silently
 * mis-addresses everything that does not fit it: the whole `ui` subtree (no
 * qualifier at all, so pages collide across `ui` blocks), entity-part fields
 * (the part name dropped), and event/payload fields (no keyword, so they read
 * `node Sales.at`).
 *
 * Returns `undefined` for a node with no addressable ancestry.
 */
export function addressOf(node: AstNode): string | undefined {
  const segments: string[] = [];

  // The node's own segment: a named declaration or leaf member contributes its
  // name; anything else (a statement, an expression) contributes nothing and is
  // addressed by whatever encloses it.
  if (isAddressable(node)) {
    const own = segmentOf(node);
    if (own) segments.push(own);
  }

  let keyword: string | undefined = keywordOf(node);
  for (let cur = node.$container; cur; cur = cur.$container) {
    const mapped = keywordOf(cur);
    if (!mapped || NOT_A_QUALIFIER.has(cur.$type)) continue;
    // The innermost mapped ancestor supplies the keyword for a leaf member.
    if (!keyword) keyword = mapped;
    const seg = segmentOf(cur);
    if (seg) segments.unshift(seg);
  }

  if (segments.length === 0) return undefined;
  return `${keyword ?? "node"} ${segments.join(".")}`;
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
    else if (isEnumDecl(m)) pushAddr(m, enums);
    else if (isEventDecl(m)) pushAddr(m, events);
    else if (isRepository(m)) pushAddr(m, repositories);
  }

  return {
    name: ctx.name,
    aggregates,
    valueObjects,
    workflows,
    enums,
    events,
    repositories,
  };
}

/** Every `ui` under a system, each with the surfaces it holds.
 *
 *  Pages nest through `area` blocks to any depth, so the members are collected
 *  by walking the ui subtree rather than reading one member list — the area
 *  path is already carried IN each address (`page Admin.Back.Board`), so the
 *  list stays flat without losing where a page lives. */
function uisOf(system: System): OutlineDecl[] {
  const out: OutlineDecl[] = [];
  for (const m of system.members) {
    if (!isUi(m)) continue;
    const node = addressOf(m);
    if (!node) continue;
    const members: string[] = [];
    for (const inner of AstUtils.streamAllContents(m)) {
      if (!isPage(inner) && !isComponent(inner) && !isStore(inner) && !isArea(inner)) continue;
      const a = addressOf(inner);
      if (a && a !== node) members.push(a);
    }
    out.push({ node, members });
  }
  return out;
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
        uis: uisOf(member),
        deployables: deployablesOf(member),
      });
    } else if (isBoundedContext(member)) {
      contexts.push(outlineContext(member));
    }
  }

  return { systems, contexts };
}

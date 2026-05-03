import {
  AstUtils,
  DefaultScopeProvider,
  EMPTY_SCOPE,
  type AstNode,
  type LangiumCoreServices,
  type ReferenceInfo,
  type Scope,
} from "langium";
import {
  isAggregate,
  isEntityPart,
  isContainment,
  isModel,
  type Aggregate,
  type EntityPart,
  type Model,
} from "./generated/ast.js";

/**
 * Custom scope provider that enforces aggregate-local visibility for
 * entity parts: a `Containment.partType` reference can only resolve to a
 * part declared in the same aggregate.  All other cross-references fall
 * back to the default global-scope behavior (which lets `Id<X>`,
 * repository.aggregate, named types, etc. resolve across the bounded
 * context).
 */
export class DddScopeProvider extends DefaultScopeProvider {
  constructor(services: LangiumCoreServices) {
    super(services);
  }

  override getScope(context: ReferenceInfo): Scope {
    if (context.container.$type === "Containment" && context.property === "partType") {
      const aggregate = enclosingAggregate(context.container);
      if (!aggregate) return EMPTY_SCOPE;
      return this.createScopeForNodes(localParts(aggregate));
    }
    return super.getScope(context);
  }
}

export function enclosingAggregate(node: AstNode | undefined): Aggregate | undefined {
  for (const a of AstUtils.streamAllContents({ $type: "", ...node } as never)) void a; // touch import
  let cur: AstNode | undefined = node;
  while (cur) {
    if (isAggregate(cur)) return cur;
    cur = cur.$container;
  }
  return undefined;
}

export function enclosingEntityPart(node: AstNode | undefined): EntityPart | undefined {
  let cur: AstNode | undefined = node;
  while (cur) {
    if (isEntityPart(cur)) return cur;
    cur = cur.$container;
  }
  return undefined;
}

function localParts(agg: Aggregate): EntityPart[] {
  const out: EntityPart[] = [];
  for (const m of agg.members) {
    if (isEntityPart(m)) out.push(m);
  }
  return out;
}

export function getModel(node: AstNode | undefined): Model | undefined {
  let cur: AstNode | undefined = node;
  while (cur) {
    if (isModel(cur)) return cur;
    cur = cur.$container;
  }
  return undefined;
}

export function isContainmentRef(node: AstNode | undefined): node is import("./generated/ast.js").Containment {
  return !!node && isContainment(node);
}

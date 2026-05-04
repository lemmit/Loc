import {
  AstUtils,
  Cancellation,
  DefaultScopeComputation,
  DefaultScopeProvider,
  EMPTY_SCOPE,
  type AstNode,
  type AstNodeDescription,
  type LangiumCoreServices,
  type LangiumDocument,
  type ReferenceInfo,
  type Scope,
} from "langium";
import {
  isAggregate,
  isEntityPart,
  isContainment,
  isEnumDecl,
  isModel,
  isValueObject,
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
 * context — and across modules / systems via the custom export below).
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

/**
 * Exports every named, top-level-ish declaration to the document's
 * global scope, no matter how deeply it sits inside system / module
 * / context wrappers.  Without this, `Id<Product>` inside one module
 * cannot reach an `aggregate Product` declared in another module —
 * Langium's default only exports direct children of the document root.
 *
 * The set of exportable types is intentionally narrow: aggregates,
 * entity parts, value objects, and enums.  `Module`, `Deployable`, and
 * `BoundedContext` themselves stay scoped to the document so a
 * cross-module reference must point at a *declaration*, not a wrapper.
 */
export class DddScopeComputation extends DefaultScopeComputation {
  override async computeExports(
    document: LangiumDocument,
    cancelToken?: Cancellation.CancellationToken,
  ): Promise<AstNodeDescription[]> {
    const exports: AstNodeDescription[] = [];
    for (const node of AstUtils.streamAllContents(document.parseResult.value)) {
      if (cancelToken && cancelToken.isCancellationRequested) break;
      if (
        isAggregate(node) ||
        isEntityPart(node) ||
        isValueObject(node) ||
        isEnumDecl(node)
      ) {
        const name = this.nameProvider.getName(node);
        if (name) {
          exports.push(this.descriptions.createDescription(node, name, document));
        }
      }
    }
    // Also include the default exports (Module, Deployable, etc.) so
    // local references like `repository ... for Order` keep working.
    const defaults = await super.computeExports(document, cancelToken);
    for (const d of defaults) {
      // Avoid duplicating the named-decl exports we just emitted.
      if (
        !exports.some(
          (e) => e.name === d.name && e.path === d.path,
        )
      ) {
        exports.push(d);
      }
    }
    return exports;
  }
}

export function enclosingAggregate(node: AstNode | undefined): Aggregate | undefined {
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

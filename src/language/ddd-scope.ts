import {
  type AstNode,
  type AstNodeDescription,
  AstUtils,
  type Cancellation,
  DefaultScopeComputation,
  DefaultScopeProvider,
  EMPTY_SCOPE,
  type LangiumCoreServices,
  type LangiumDocument,
  type ReferenceInfo,
  type Scope,
} from "langium";
import {
  type Aggregate,
  type EntityPart,
  isAggregate,
  isContainment,
  isEntityPart,
  isEnumDecl,
  isModel,
  isSystem,
  isTargetable,
  isValueObject,
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
      if (isAggregate(node) || isEntityPart(node) || isValueObject(node) || isEnumDecl(node)) {
        const name = this.nameProvider.getName(node);
        if (name) {
          exports.push(this.descriptions.createDescription(node, name, document));
        }
      }
      // Traceability code references: every `Targetable`
      // (module / context / aggregate / operation / value-object /
      // event / repository / workflow / view / deployable / api) is
      // exported under its qualified dotted name so a Solution's
      // `entitles [...]` / TestCase's `covers [...]` cross-references
      // resolve through Langium's standard machinery.  Most of these
      // (operations, workflows, deployables, …) are not exported by
      // the default computation at all, so there is no duplication;
      // aggregates / value-objects also keep their bare-name export
      // above for `Id<X>` / named-type resolution.
      if (isTargetable(node)) {
        const qn = qualifiedNameOf(node);
        if (qn) {
          exports.push(this.descriptions.createDescription(node, qn, document));
        }
      }
    }
    // Also include the default exports (Module, Deployable, etc.) so
    // local references like `repository ... for Order` keep working.
    const defaults = await super.computeExports(document, cancelToken);
    for (const d of defaults) {
      // Avoid duplicating the named-decl exports we just emitted.
      if (!exports.some((e) => e.name === d.name && e.path === d.path)) {
        exports.push(d);
      }
    }
    return exports;
  }
}

/**
 * Qualified dotted name for a `Targetable` code symbol — the path of
 * named structural ancestors from just below the enclosing `system`
 * down to the node itself, e.g. `Identity.Auth.LoginSession.start`
 * for `operation start` in `aggregate LoginSession` in `context Auth`
 * in `module Identity`.  The `system` wrapper is intentionally excluded
 * so references read the same regardless of which system ships the
 * symbol; deployables / apis (direct children of `system`) resolve to
 * their bare name.  Returns undefined if any path segment is unnamed.
 */
export function qualifiedNameOf(node: AstNode): string | undefined {
  const segments: string[] = [];
  let cur: AstNode | undefined = node;
  while (cur && !isSystem(cur) && !isModel(cur)) {
    const name = (cur as { name?: unknown }).name;
    if (typeof name === "string" && name.length > 0) {
      segments.unshift(name);
    }
    cur = cur.$container;
  }
  return segments.length > 0 ? segments.join(".") : undefined;
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

export function isContainmentRef(
  node: AstNode | undefined,
): node is import("./generated/ast.js").Containment {
  return !!node && isContainment(node);
}

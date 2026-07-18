import {
  type AstNode,
  type AstNodeDescription,
  AstUtils,
  type Cancellation,
  DefaultScopeComputation,
  DefaultScopeProvider,
  EMPTY_SCOPE,
  type LangiumDocument,
  type ReferenceInfo,
  type Scope,
} from "langium";
import {
  type Aggregate,
  type EntityPart,
  isAggregate,
  isArea,
  isBoundedContext,
  isChannel,
  isComponent,
  isContainment,
  isDomainService,
  isEntityPart,
  isEnumDecl,
  isEventDecl,
  isFunctionDecl,
  isModel,
  isPage,
  isPayloadDecl,
  isProjection,
  isSystem,
  isTargetable,
  isUi,
  isUiChannelParam,
  isUserBlock,
  isValueObject,
  isWorkflow,
  type Model,
  type PayloadDecl,
  type Ui,
  type UiApiParam,
  type UiChannelParam,
  type UiNotification,
} from "./generated/ast.js";

/**
 * Custom scope provider that enforces aggregate-local visibility for
 * entity parts: a `Containment.partType` reference can only resolve to a
 * part declared in the same aggregate.  All other cross-references fall
 * back to the default global-scope behavior (which lets `X id`,
 * repository.aggregate, named types, etc. resolve across the bounded
 * context — and across modules / systems via the custom export below).
 */
export class DddScopeProvider extends DefaultScopeProvider {
  override getScope(context: ReferenceInfo): Scope {
    if (context.container.$type === "Containment" && context.property === "partType") {
      const aggregate = enclosingAggregate(context.container);
      if (!aggregate) return EMPTY_SCOPE;
      return this.createScopeForNodes(localParts(aggregate));
    }
    // `NamedType.target` is the bare-name slot in a type position.  Cross-
    // aggregate links must spell `X id` (handled by IdType, which scopes
    // globally via the default scope provider).  Bare names may only resolve
    // to: enums + value-objects (always global), entity-parts of the same
    // enclosing aggregate, and aggregates (so the validator below can give
    // a friendly "use 'X id'" diagnostic instead of "could not resolve").
    if (context.container.$type === "NamedType" && context.property === "target") {
      const localScope = this.localTypeScope(context);
      // A `match await <api>.<Agg>.<op>() { … }` arm in a UI page/component
      // action names union-variant types.  The success variant (an aggregate)
      // resolves globally, but a context-local `error` variant does NOT — context
      // payloads stay context-scoped (they are not globally exported, so they
      // don't leak across contexts).  So when the arm sits in a UI union-variant
      // position, add the payload/error decls of the bounded contexts the
      // enclosing ui's `api X: Y` handles bind to — the page can only match errors
      // from contexts it actually talks to.  Additive over `localScope`, so the
      // `else` form and the success arm keep resolving exactly as before.
      if (inUnionVariant(context.container)) {
        const ui = AstUtils.getContainerOfType(context.container, isUi);
        if (ui) {
          const payloads = uiBoundContextPayloads(ui);
          if (payloads.length > 0) {
            const descs = payloads
              .map((p) => {
                const name = this.nameProvider.getName(p);
                return name ? this.descriptions.createDescription(p, name) : undefined;
              })
              .filter((d): d is AstNodeDescription => d !== undefined);
            return this.createScope(descs, localScope ?? super.getScope(context));
          }
        }
      }
      if (localScope) return localScope;
    }
    // `IdType.target` (`X id`) shares the `NamedDecl` cross-ref type, which now
    // admits events / payloads — but `PaymentReceived id` is meaningless, so
    // filter transport types back out of the `X id` slot.  Aggregates / parts /
    // enums / value objects still resolve via the default global scope.
    if (context.container.$type === "IdType" && context.property === "target") {
      return this.filterScope(super.getScope(context), (d) => !isTransportType(d.type));
    }
    // `channel Orders: Sales.Lifecycle` — the channel segment resolves only
    // within the named context (channels are context members, never exported
    // to the global scope).
    if (context.container.$type === "UiChannelParam" && context.property === "channel") {
      const param = context.container as UiChannelParam;
      const ctx = param.context?.ref;
      if (!ctx) return EMPTY_SCOPE;
      return this.createScopeForNodes(ctx.members.filter(isChannel));
    }
    // `on Orders.OrderShipped(e) { … }` — the param resolves to a channel
    // param of the containing ui; the event to one carried by that
    // param's channel (so an un-carried event is "could not resolve", not
    // a later semantic error).
    if (context.container.$type === "UiNotification" && context.property === "param") {
      const ui = AstUtils.getContainerOfType(context.container, isUi);
      if (!ui) return EMPTY_SCOPE;
      return this.createScopeForNodes(ui.members.filter(isUiChannelParam));
    }
    if (context.container.$type === "UiNotification" && context.property === "event") {
      const n = context.container as UiNotification;
      const ch = n.param?.ref?.channel?.ref;
      if (!ch) return EMPTY_SCOPE;
      const events = ch.carries.map((c) => c.ref).filter((e) => e !== undefined);
      return this.createScopeForNodes(events);
    }
    // `tenancy by user.<claim> of <Registry>` — the claim resolves against the
    // enclosing system's `user { … }` block fields, and ONLY in that position
    // (the same targeted-scoping trick that keeps EventDecl/PayloadDecl visible
    // only in workflow create/handle params): user fields are not globally
    // exported, so without this arm the cross-ref could never link — and with
    // it a user-field name stays out of scope everywhere else.  The `registry`
    // slot needs no arm: aggregates are exported to the global scope by bare
    // name (collectExportedSymbols below), so the default provider resolves it.
    if (context.container.$type === "TenancyDecl" && context.property === "claim") {
      const system = AstUtils.getContainerOfType(context.container, isSystem);
      const userBlock = system?.members.find(isUserBlock);
      if (!userBlock) return EMPTY_SCOPE;
      return this.createScopeForNodes(userBlock.fields);
    }
    // `timerSource sweep { for: SweepTick, … }` — the `for:` event resolves to
    // any event declared anywhere in the enclosing system.  Events are not
    // globally exported (the same reason the tenancy/workflow arms above exist),
    // so without this arm a system-scope timerSource could never link to a
    // context-nested tick event.  System-wide, because a timerSource is
    // infrastructure that may fire an event from any context it hosts.
    if (context.container.$type === "TimerSource" && context.property === "event") {
      const system = AstUtils.getContainerOfType(context.container, isSystem);
      if (!system) return EMPTY_SCOPE;
      return this.createScopeForNodes(AstUtils.streamAllContents(system).filter(isEventDecl));
    }
    // Reactor / projection-fold event subscriptions — `on(e: OrderPlaced)` in a
    // workflow or projection resolves system-wide, not context-local (M-T4.4
    // slice 1; channels.md cross-context choreography: a Shipping reactor
    // consumes Orders' OrderPlaced).  Same targeted-scope shape as the
    // timerSource arm above: events stay unexported globally, so the widening
    // applies ONLY in these two subscription positions.  Within one deployable
    // the in-process dispatcher already merges hosted contexts' channels ∪
    // workflows (`deriveEventSubscriptions`); across deployables delivery
    // needs a broker binding — gated by `loom.channel-consumer-unwired`.
    if (
      (context.container.$type === "OnDecl" || context.container.$type === "ProjectionOn") &&
      context.property === "event"
    ) {
      const system = AstUtils.getContainerOfType(context.container, isSystem);
      if (!system) return super.getScope(context); // context-local fallback outside a system
      return this.createScopeForNodes(AstUtils.streamAllContents(system).filter(isEventDecl));
    }
    // `menu { link Orders.List }` — a page link resolves within the enclosing
    // ui, by BOTH the page's bare name (`Home`, a unique top-level page) AND its
    // area-qualified dotted name (`Orders.List`, `Sales.Orders.List`).  The
    // qualifier is needed because the scaffold names every aggregate's pages by
    // ROLE (`List`/`New`/`Detail`), so the bare name collides across
    // aggregates.  Built here (not in `collectExportedSymbols`) because the
    // scaffold macro synthesises the area+page nodes AFTER global indexing —
    // they only exist on the tree at link time.
    if (context.container.$type === "MenuLink" && context.property === "page") {
      const ui = AstUtils.getContainerOfType(context.container, isUi);
      if (!ui) return super.getScope(context);
      const descs: AstNodeDescription[] = [];
      const collect = (members: readonly AstNode[], areaPath: readonly string[]): void => {
        for (const m of members) {
          if (isPage(m)) {
            // Bare name first so it wins on a duplicate (preserves the legacy
            // nearest-match behaviour for an unqualified `link List`).
            descs.push(this.descriptions.createDescription(m, m.name));
            if (areaPath.length > 0) {
              descs.push(this.descriptions.createDescription(m, `${areaPath.join(".")}.${m.name}`));
            }
          } else if (isArea(m)) {
            collect(m.members, [...areaPath, m.name]);
          }
        }
      };
      collect(ui.members, []);
      return this.createScope(descs);
    }
    return super.getScope(context);
  }

  private localTypeScope(context: ReferenceInfo): Scope | undefined {
    // Transport types (`event` / `command` / `query` / `response` / `error`)
    // are only offered as a type in a workflow `create`/`handle` parameter —
    // `create(e: PaymentReceived) by …`, `handle settle(c: SettleOrder)`.
    // Everywhere else they stay out of scope, so a stray event name in an
    // aggregate field / UI param position resolves to nothing (a clear error)
    // rather than silently typing as a transport record.
    const allowTransport =
      inWorkflowCommandParam(context.container) || inUnionVariant(context.container);
    const aggregate = enclosingAggregate(context.container);
    const defaultScope = super.getScope(context);
    if (!aggregate) {
      // Outside an aggregate (operation-param-on-page, event field, workflow
      // command param, etc.): restrict to enums + value-objects + aggregates
      // from the default scope.  Entity parts are not addressable from there.
      return this.filterScope(
        defaultScope,
        (d) =>
          d.type === "EnumDecl" ||
          d.type === "ValueObject" ||
          d.type === "Aggregate" ||
          (allowTransport && isTransportType(d.type)),
      );
    }
    // Inside an aggregate: filter out entity-parts owned by *other*
    // aggregates.  Same-aggregate parts and all enums/VOs/aggregates pass.
    return this.filterScope(defaultScope, (d) => {
      if (d.type === "EnumDecl" || d.type === "ValueObject" || d.type === "Aggregate") {
        return true;
      }
      if (allowTransport && isTransportType(d.type)) return true;
      if (d.type === "EntityPart") {
        const node = d.node;
        return !!node && AstUtils.getContainerOfType(node, isAggregate) === aggregate;
      }
      return false;
    });
  }

  private filterScope(scope: Scope, keep: (d: AstNodeDescription) => boolean): Scope {
    const elems = Array.from(scope.getAllElements());
    const kept = elems.filter(keep);
    return this.createScope(kept);
  }
}

/**
 * Exports every named, top-level-ish declaration to the document's
 * global scope, no matter how deeply it sits inside system / module
 * / context wrappers.  Without this, `Product id` inside one module
 * cannot reach an `aggregate Product` declared in another module —
 * Langium's default only exports direct children of the document root.
 *
 * The set of exportable types is intentionally narrow: aggregates,
 * entity parts, value objects, and enums.  `Module`, `Deployable`, and
 * `BoundedContext` themselves stay scoped to the document so a
 * cross-module reference must point at a *declaration*, not a wrapper.
 */
export class DddScopeComputation extends DefaultScopeComputation {
  override async collectExportedSymbols(
    document: LangiumDocument,
    cancelToken?: Cancellation.CancellationToken,
  ): Promise<AstNodeDescription[]> {
    const exports: AstNodeDescription[] = [];
    for (const node of AstUtils.streamAllContents(document.parseResult.value)) {
      if (cancelToken?.isCancellationRequested) break;
      if (isAggregate(node) || isEntityPart(node) || isValueObject(node) || isEnumDecl(node)) {
        const name = this.nameProvider.getName(node);
        if (name) {
          exports.push(this.descriptions.createDescription(node, name, document));
        }
      }
      // Workflows get a bare-name export too (in addition to the qualified
      // `Targetable` export below) so a `view X = <Workflow> where …` source
      // ref (`[ViewSource:ID]`) resolves by bare name, exactly as an aggregate
      // source does (workflow-instance-views.md).
      if (isWorkflow(node)) {
        const name = this.nameProvider.getName(node);
        if (name) {
          exports.push(this.descriptions.createDescription(node, name, document));
        }
      }
      // Projections get the same bare-name export as workflows so a
      // `view X = <Projection> where …` / `from <Projection>` source ref
      // (`[ViewSource:ID]`) resolves by bare name (projection.md v1.1).
      if (isProjection(node)) {
        const name = this.nameProvider.getName(node);
        if (name) {
          exports.push(this.descriptions.createDescription(node, name, document));
        }
      }
      // Domain services get a bare-name export too, the same way workflows do,
      // so a member call `Pricing.quote(...)` from an operation / workflow /
      // api body resolves its receiver to the `domainService` declaration
      // (lowered to a Call with `callKind: "domain-service"`).
      if (isDomainService(node)) {
        const name = this.nameProvider.getName(node);
        if (name) {
          exports.push(this.descriptions.createDescription(node, name, document));
        }
      }
      // Root-level payloads (`payload`/`error`/… declared at file scope, outside
      // any context — exception-less.md A1) are the ambient shared kernel for
      // transport types: exported globally so a `find`/operation `or`-union can
      // name an ambient `NotFound` from any context.  Context-local payloads
      // stay context-scoped (NOT exported here) so they don't leak across
      // contexts.
      if (isPayloadDecl(node) && isModel(node.$container)) {
        const name = this.nameProvider.getName(node);
        if (name) {
          exports.push(this.descriptions.createDescription(node, name, document));
        }
      }
      // D-STORAGE-SPLIT: bounded contexts are exported by bare name so
      // a `deployable.contexts: [Catalog]` cross-reference (declared as
      // `[BoundedContext:ID]`) resolves without forcing the source to
      // spell the qualified path.  The Targetable export below also
      // produces a qualified-name entry — that one stays for
      // traceability `covers`/`entitles` references.
      if (isBoundedContext(node)) {
        const name = this.nameProvider.getName(node);
        if (name) {
          exports.push(this.descriptions.createDescription(node, name, document));
        }
      }
      // Top-level components — declared as a `ModelMember` rather than
      // inside a `ui { … }` — are visible globally so any page in any ui
      // in any system in the workspace can invoke them by bare name.
      // Ui-scoped components stay local and intentionally shadow on
      // collision (resolved at the call site, not here).
      if (isComponent(node) && isModel(node.$container)) {
        const name = this.nameProvider.getName(node);
        if (name) {
          exports.push(this.descriptions.createDescription(node, name, document));
        }
      }
      // Top-level (ambient) helper `function`s (stdlib Phase B) — declared at
      // file root or directly inside a `system { }`, visible workspace-wide so
      // a call from any context/file resolves by bare name (they inline at
      // lowering).  Local aggregate/VO/workflow functions stay member-scoped
      // (NOT exported here) so they keep the emitted `this.<fn>` path.
      if (isFunctionDecl(node) && (isModel(node.$container) || isSystem(node.$container))) {
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
      // above for `X id` / named-type resolution.
      if (isTargetable(node)) {
        const qn = qualifiedNameOf(node);
        if (qn) {
          exports.push(this.descriptions.createDescription(node, qn, document));
        }
      }
    }
    // Also include the default exports (Module, Deployable, etc.) so
    // local references like `repository ... for Order` keep working.
    const defaults = await super.collectExportedSymbols(document, cancelToken);
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

/** A transport-type declaration kind — `event` (EventDecl) or a payload
 *  (`command`/`query`/`response`/`error`, all PayloadDecl).  These resolve as a
 *  type only in a workflow command-parameter position (see `localTypeScope`). */
function isTransportType(type: string): boolean {
  return type === "EventDecl" || type === "PayloadDecl";
}

/** True when `namedType` (a `NamedType` AST node) sits directly in a workflow
 *  `create` / `handle` parameter's type — `create(e: Event)` / `handle h(c:
 *  Command)`.  The container chain is NamedType → TypeRef → Parameter →
 *  WorkflowCreateDecl | HandleDecl; we match it positionally so a `NamedType`
 *  elsewhere inside the workflow (a `let x: T` annotation, say) does not also
 *  pull transport types into scope. */
function inWorkflowCommandParam(namedType: AstNode | undefined): boolean {
  const typeRef = namedType?.$container;
  const param = typeRef?.$container;
  if (param?.$type !== "Parameter") return false;
  const owner = param.$container?.$type;
  return owner === "WorkflowCreateDecl" || owner === "HandleDecl";
}

/** True when `namedType` sits in a discriminated-union variant position
 *  (payload-transport-layer.md, P4) — so a variant naming an `event` /
 *  `payload` (`payload OrderEvent = OrderPlaced | OrderCancelled`,
 *  `find f(): OrderId or NotFound`) resolves to that transport type rather
 *  than falling out of scope.  A `TypeAtom` only ever appears as a union
 *  variant (a `|` arm of a named union or an `or`-alternative); the head of an
 *  anonymous `A or B` is a `TypeRef` carrying `alternatives`. */
function inUnionVariant(namedType: AstNode | undefined): boolean {
  const c = namedType?.$container;
  if (!c) return false;
  if (c.$type === "TypeAtom") return true;
  return (
    c.$type === "TypeRef" && ((c as { alternatives?: unknown[] }).alternatives?.length ?? 0) > 0
  );
}

/** Every payload/error decl reachable through a UI's `api X: Y` handles — each
 *  `UiApiParam` resolves to its `Api`, whose `from <Subdomain>` source contains
 *  the bounded contexts whose context-local `error`/`payload` types a `match
 *  await` arm in this UI may name.  Used to widen the union-variant arm scope
 *  without exporting context payloads globally (they must not leak across
 *  contexts — see `collectExportedSymbols`). */
function uiBoundContextPayloads(ui: Ui): PayloadDecl[] {
  const out: PayloadDecl[] = [];
  for (const m of ui.members) {
    if (m.$type !== "UiApiParam") continue;
    const subdomain = (m as UiApiParam).apiRef?.ref?.source?.ref;
    if (!subdomain) continue;
    for (const node of AstUtils.streamAllContents(subdomain)) {
      if (isPayloadDecl(node)) out.push(node);
    }
  }
  return out;
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

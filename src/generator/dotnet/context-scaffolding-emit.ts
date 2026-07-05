import type { BoundedContextIR, EnrichedBoundedContextIR } from "../../ir/types/loom-ir.js";
import { isTpcBase, isTpcConcrete, isTphBase } from "../../ir/util/inheritance.js";
import { plural } from "../../util/naming.js";
import type { SourceMapRecorder } from "../_trace/sourcemap.js";
import {
  renderAuditableInterceptor,
  renderBaseReaderImpl,
  renderBaseReaderInterface,
  renderCommon,
  renderEnum,
  renderEvent,
  renderIDomainEvent,
  renderId,
  renderInProcessDispatcher,
  renderNoopDispatcher,
  renderValueObject,
} from "./emit.js";

// ---------------------------------------------------------------------------
// Shared / per-context emission helpers
// ---------------------------------------------------------------------------

/** Emit the SaveChangesInterceptor when at least one aggregate
 * contributes stamping rules.  The interceptor is registry-driven
 * — its body is a switch on `entry.Entity.GetType()` built from
 * every aggregate's `contextStamps`.  Adding a new stamping macro
 * (e.g. `lastModifiedBy`, `versionBump`) requires no compiler
 * changes: the new macro contributes more entries to one
 * aggregate's stamps, which become more assignments in that
 * aggregate's switch arm. */
export function emitStampingInterceptor(
  merged: BoundedContextIR,
  ns: string,
  out: Map<string, string>,
  /** System user-block id property (PascalCased) when the deployable carries
   *  auth — threaded so `currentUser` stamps render the principal id. */
  actorIdProp?: string,
): void {
  const anyStamping = merged.aggregates.some((a) => (a.contextStamps?.length ?? 0) > 0);
  if (!anyStamping) return;
  out.set(
    "Infrastructure/Persistence/AuditableInterceptor.cs",
    renderAuditableInterceptor(ns, merged.aggregates, actorIdProp),
  );
}

export function emitIds(ctx: BoundedContextIR, ns: string, out: Map<string, string>): void {
  for (const agg of ctx.aggregates) {
    // An abstract TPC base keeps no identity of its own (each concrete carries
    // its own strongly-typed `<Concrete>Id`), so it contributes no `<Base>Id`.
    // A TPH base, by contrast, OWNS the shared single-table key — emit its
    // `<Base>Id`, which the concretes inherit (they declare none of their own).
    if (agg.isAbstract && !isTphBase(agg, ctx.aggregates)) continue;
    out.set(`Domain/Ids/${agg.name}Id.cs`, renderId(agg.name, agg.idValueType, ns));
    for (const part of agg.parts) {
      out.set(`Domain/Ids/${part.name}Id.cs`, renderId(part.name, agg.idValueType, ns));
    }
  }
}

export function emitEnums(ctx: BoundedContextIR, ns: string, out: Map<string, string>): void {
  // Always emit a marker so `using <ns>.Domain.Enums;` resolves even
  // when the project has no enums in scope (deployables that include
  // only modules without enums would otherwise fail to compile).
  out.set(
    "Domain/Enums/_namespace.cs",
    `// Auto-generated namespace marker.\nnamespace ${ns}.Domain.Enums;\n`,
  );
  for (const e of ctx.enums) {
    out.set(`Domain/Enums/${e.name}.cs`, renderEnum(e, ns));
  }
}

export function emitValueObjects(
  ctx: BoundedContextIR,
  ns: string,
  out: Map<string, string>,
): void {
  out.set(
    "Domain/ValueObjects/_namespace.cs",
    `// Auto-generated namespace marker.\nnamespace ${ns}.Domain.ValueObjects;\n`,
  );
  for (const vo of ctx.valueObjects) {
    out.set(`Domain/ValueObjects/${vo.name}.cs`, renderValueObject(vo, ns));
  }
}

export function emitEvents(
  ctx: BoundedContextIR,
  ns: string,
  out: Map<string, string>,
  hasSubscriptions = false,
): void {
  out.set("Domain/Events/IDomainEvent.cs", renderIDomainEvent(ns, hasSubscriptions));
  for (const ev of ctx.events) {
    out.set(`Domain/Events/${ev.name}.cs`, renderEvent(ev, ns));
  }
}

export function emitCommon(ns: string, out: Map<string, string>): void {
  out.set("Domain/Common/DomainException.cs", renderCommon(ns));
}

export function emitDispatcher(
  ns: string,
  out: Map<string, string>,
  hasSubscriptions = false,
): void {
  out.set("Infrastructure/Events/NoopDomainEventDispatcher.cs", renderNoopDispatcher(ns));
  // In-process dispatch (channels.md): the Mediator-notification dispatcher
  // that routes emitted events to reactor / starter handlers.  Only emitted
  // when the deployable has channel-routed subscriptions; otherwise the
  // project keeps only the no-op (byte-identical).
  if (hasSubscriptions) {
    out.set(
      "Infrastructure/Events/InProcessDomainEventDispatcher.cs",
      renderInProcessDispatcher(ns),
    );
  }
}

/** Polymorphic read home for each abstract TPC (`ownTable`) base in the
 *  context: a read-only `I<Base>Repository` / `<Base>Repository` pair that
 *  delegates to the concrete repositories and concatenates (aggregate-
 *  inheritance.md, `find all <Base>`).  Emits nothing when the context has no
 *  TPC base. */
export function emitBaseReaders(
  ctx: EnrichedBoundedContextIR,
  ns: string,
  out: Map<string, string>,
  sourcemap?: SourceMapRecorder,
): void {
  for (const base of ctx.aggregates) {
    if (!isTpcBase(base, ctx.aggregates)) continue;
    const concretes = ctx.aggregates.filter(
      (a) => a.extendsAggregate === base.name && isTpcConcrete(a, ctx.aggregates),
    );
    if (concretes.length === 0) continue;
    const construct = `${ctx.name}.${base.name}`;
    const ifacePath = `Domain/${plural(base.name)}/I${base.name}Repository.cs`;
    const ifaceContent = renderBaseReaderInterface(base, ns);
    out.set(ifacePath, ifaceContent);
    sourcemap?.file(ifacePath, ifaceContent, base.origin, construct);
    const implPath = `Infrastructure/Repositories/${base.name}Repository.cs`;
    const implContent = renderBaseReaderImpl(base, concretes, ns);
    out.set(implPath, implContent);
    sourcemap?.file(implPath, implContent, base.origin, construct);
  }
}

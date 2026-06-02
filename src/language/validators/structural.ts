// Structural checks: cross-aggregate type references, containment
// sanity, aggregate / entity-part / value-object structural rules.

import { type AstNode, AstUtils, type ValidationAcceptor } from "langium";
import type {
  Aggregate,
  BoundedContext,
  Containment,
  Create,
  DerivedProp,
  Destroy,
  EntityPart,
  Model,
  ValueObject,
} from "../generated/ast.js";
import {
  isAggregate,
  isApply,
  isAssignOrCallStmt,
  isContainment,
  isCreate,
  isDerivedProp,
  isDestroy,
  isEmitStmt,
  isEntityPart,
  isFunctionDecl,
  isInvariant,
  isOperation,
  isPreconditionStmt,
  isPrimitiveType,
  isProperty,
  isValueObject,
} from "../generated/ast.js";
import { envForAggregate, envForPart, envForValueObject } from "./_shared.js";
import { checkCreate, checkDestroy, checkOperation } from "./statements.js";
import {
  checkDerived,
  checkFunction,
  checkInvariant,
  checkPropertyCheck,
  checkPropertyDefault,
} from "./types.js";

/** `slot` is a UI-only element-shaped param marker — meaningful only
 *  on a `component`'s parameter list (where the caller supplies JSX
 *  for the slot and the body renders it via a bare ref).  Anywhere
 *  else (aggregate field, value-object field, page param, operation
 *  param, …) the type has no runtime meaning and the backend
 *  emitters throw on it.  Flag the misuse at parse time with the
 *  same precision as `checkTypeReferences`. */
export function checkSlotTypePosition(model: Model, accept: ValidationAcceptor): void {
  for (const node of AstUtils.streamAllContents(model)) {
    if (node.$type !== "SlotType") continue;
    // SlotType lives inside a TypeRef which lives inside the
    // declaring node (Parameter / Property / etc.).  Walk one level
    // up to find the holder; `slot` is valid only when the holder is
    // a Parameter directly owned by a Component.
    const typeRef = node.$container;
    const holder = typeRef?.$container;
    const enclosing = holder?.$container;
    const ok = holder?.$type === "Parameter" && enclosing?.$type === "Component";
    if (ok) continue;
    const where = enclosing?.$type ?? holder?.$type ?? "<unknown>";
    accept("error", `'slot' is only valid on a component's parameter list; found on ${where}.`, {
      node,
      code: "loom.slot-out-of-position",
    });
  }
}

export function checkTypeReferences(model: Model, accept: ValidationAcceptor): void {
  for (const node of AstUtils.streamAllContents(model)) {
    if (node.$type !== "NamedType") continue;
    // Only fire on storage/wire-data positions — Property fields,
    // event/storage UserFields, and operation/function/page Parameters.
    // Find/Function return types and Derived/View/State projections may
    // legitimately reference an aggregate as a domain object.
    const typeRef = node.$container;
    const holder = typeRef?.$container;
    if (!holder) continue;
    // Storage / wire-data slots: aggregate Property fields, event
    // UserFields, and Operation/Function/Find/Workflow Parameters
    // (domain-side signatures).  UI Parameters (Page/Component) and
    // Find/Function return types may legitimately reference an
    // aggregate as a domain object reference.
    let isStoragePos: boolean;
    switch (holder.$type) {
      case "Property":
      case "UserField":
        isStoragePos = true;
        break;
      case "Parameter": {
        const owner = holder.$container?.$type;
        isStoragePos =
          owner === "Operation" ||
          owner === "FunctionDecl" ||
          owner === "Find" ||
          owner === "Workflow";
        break;
      }
      default:
        isStoragePos = false;
    }
    if (!isStoragePos) continue;
    const target = (node as { target?: { ref?: AstNode } }).target?.ref;
    if (!target) continue;
    // Bare aggregate name in type position: must be spelt `X id`.
    if (isAggregate(target)) {
      const aggName = target.name;
      accept(
        "error",
        `References across aggregate boundaries need an id link — write '${aggName} id' (or '${aggName} id[]' for many-to-many).`,
        { node, property: "target" },
      );
      continue;
    }
    // Entity-part from a different aggregate: must go through the root.
    if (isEntityPart(target)) {
      const enclosing = AstUtils.getContainerOfType(node, isAggregate);
      const owner = AstUtils.getContainerOfType(target, isAggregate);
      if (enclosing && owner && enclosing !== owner) {
        accept(
          "error",
          `Entity part '${target.name}' belongs to aggregate '${owner.name}'; cross-aggregate references must go through the root: use '${owner.name} id'.`,
          { node, property: "target" },
        );
      }
    }
  }
}

export function checkContext(ctx: BoundedContext, accept: ValidationAcceptor): void {
  for (const member of ctx.members) {
    if (isAggregate(member)) checkAggregate(member, accept);
    else if (isValueObject(member)) checkValueObject(member, accept);
  }
}

// Event-sourcing body discipline (D-DOCUMENT-AXIS, appliers Phase A1).
// `persistedAs(eventLog)` makes the event stream the source of truth, so
// command bodies decide and `emit`, and state transitions live in
// `apply(...)` folds.  This is the AST-level mirror of the IR validator
// `validateEventSourcedDiscipline`; keeping both means the contract is
// enforced both in the editor (LSP, AST) and at compile time (IR), with
// the diagnostics here attached to the precise offending node.
function checkEventSourcedDiscipline(agg: Aggregate, accept: ValidationAcceptor): void {
  const isEventSourced = agg.persistedAs === "eventLog";
  const appliers = agg.members.filter(isApply);

  // Rule 1 — appliers require an event-sourced aggregate.
  if (!isEventSourced) {
    for (const ap of appliers) {
      accept(
        "error",
        `Aggregate '${agg.name}' declares apply(...) but is not event-sourced. ` +
          `Appliers fold events into state; add 'persistedAs(eventLog)' to the aggregate header, or remove the applier.`,
        { node: ap, code: "loom.applier-on-non-event-sourced" },
      );
    }
    return;
  }

  // Rule 5 — one applier per event type.
  const eventName = (a: (typeof appliers)[number]): string => a.event.ref?.name ?? a.event.$refText;
  const seenApplier = new Map<string, number>();
  for (const ap of appliers)
    seenApplier.set(eventName(ap), (seenApplier.get(eventName(ap)) ?? 0) + 1);
  for (const ap of appliers) {
    if ((seenApplier.get(eventName(ap)) ?? 0) > 1) {
      accept(
        "error",
        `Aggregate '${agg.name}' declares more than one applier for event '${eventName(ap)}'. ` +
          `An event folds into state exactly one way — declare a single apply(${eventName(ap)}).`,
        { node: ap, property: "event", code: "loom.duplicate-applier" },
      );
    }
  }

  const appliedEvents = new Set(appliers.map(eventName));

  // Rules 2 + 3 — command bodies are emit-only; emitted events covered.
  const commands = agg.members.filter(
    (m) => isOperation(m) || isCreate(m) || isDestroy(m),
  ) as Array<{ body: AstNode[] }>;
  for (const cmd of commands) {
    for (const stmt of cmd.body) {
      if (isAssignOrCallStmt(stmt) && stmt.op) {
        accept(
          "error",
          `Aggregate '${agg.name}' is event-sourced — a command body must not mutate 'this' directly. ` +
            `Replace the assignment with an 'emit' and fold it in an apply(...) block.`,
          { node: stmt, code: "loom.event-sourced-command-mutation" },
        );
      } else if (isEmitStmt(stmt)) {
        const ev = stmt.event.ref?.name ?? stmt.event.$refText;
        if (!appliedEvents.has(ev)) {
          accept(
            "error",
            `Event '${ev}' is emitted but no applier folds it. ` +
              `Add an apply(${ev}: ${ev}) block to aggregate '${agg.name}', or the event is recorded but never reflected in state.`,
            { node: stmt, code: "loom.emitted-event-no-applier" },
          );
        }
      }
    }
  }

  // Rule 4 — applier bodies are pure, deterministic folds.
  for (const ap of appliers) {
    for (const stmt of ap.body) {
      if (isEmitStmt(stmt)) {
        accept(
          "error",
          `apply(${eventName(ap)}) must not emit — an applier reacts to an event by folding it into state. ` +
            `Move the 'emit' to the command body that decides it.`,
          { node: stmt, code: "loom.applier-impure" },
        );
      } else if (isAssignOrCallStmt(stmt) && !stmt.op) {
        accept(
          "error",
          `apply(${eventName(ap)}) must not call out — applier bodies are deterministic, replayable folds (assignments and 'let' only).`,
          { node: stmt, code: "loom.applier-impure" },
        );
      } else if (isPreconditionStmt(stmt)) {
        accept(
          "error",
          `apply(${eventName(ap)}) must not guard — by the time an event is applied the decision is already made; put the guard in the command.`,
          { node: stmt, code: "loom.applier-impure" },
        );
      }
    }
  }
}

// Constructibility is no longer a defaults-based AST warning (Stage 4):
// under the invariant gate an aggregate with required, undefaulted fields
// is constructible — those fields just become required create params (see
// `isConstructible`).  The remaining non-constructible case (an invariant
// referencing state outside the create input) is an IR-level concern; a
// dedicated diagnostic there is a follow-up.

export function checkAggregate(agg: Aggregate, accept: ValidationAcceptor): void {
  // Event-sourcing body discipline — the AST-level mirror of
  // `validateEventSourcedDiscipline` (ir/validate), so the contract shows
  // live in the editor as you type, not only at `generate` time.
  checkEventSourcedDiscipline(agg, accept);
  // Ensure unique part names within the aggregate
  const partNames = new Set<string>();
  let displayDerived: DerivedProp | undefined;
  let inspectDerived: DerivedProp | undefined;
  for (const m of agg.members) {
    if (isEntityPart(m)) {
      if (partNames.has(m.name)) {
        accept("error", `Duplicate entity part '${m.name}' in aggregate '${agg.name}'.`, {
          node: m,
          property: "name",
        });
      }
      partNames.add(m.name);
      checkEntityPart(m, agg, accept);
    }
    if (isContainment(m)) checkContainment(m, agg, accept);
    if (isInvariant(m)) checkInvariant(m, envForAggregate(agg), accept);
    if (isProperty(m) && m.check) checkPropertyCheck(m, envForAggregate(agg), accept);
    if (isProperty(m) && m.default) checkPropertyDefault(m, envForAggregate(agg), accept);
    if (isDerivedProp(m)) {
      checkDerived(m, envForAggregate(agg), accept);
      // Reserved-name derived fields — `display` (user-facing label) and
      // `inspect` (developer-facing debug form).  Both must be `string`;
      // at most one of each per aggregate.
      if (m.name === "display" || m.name === "inspect") {
        const slot = m.name === "display" ? displayDerived : inspectDerived;
        if (slot) {
          accept(
            "error",
            `Aggregate '${agg.name}' declares multiple 'derived ${m.name}' fields; at most one is allowed.`,
            { node: m, property: "name" },
          );
        } else if (m.name === "display") {
          displayDerived = m;
        } else {
          inspectDerived = m;
        }
        const typeText = m.type?.base;
        const isString = typeText && isPrimitiveType(typeText) && typeText.name === "string";
        if (!isString) {
          accept(
            "error",
            `Reserved 'derived ${m.name}' on aggregate '${agg.name}' must have type 'string'.`,
            { node: m, property: "type", code: `loom.derived-${m.name}-not-string` },
          );
        }
      }
    }
    if (isFunctionDecl(m)) checkFunction(m, agg, undefined, accept);
    if (isOperation(m)) checkOperation(m, agg, accept);
    if (isCreate(m)) checkCreate(m, agg, accept);
    if (isDestroy(m)) checkDestroy(m, agg, accept);
    if (isProperty(m) && m.access === "token" && m.type?.optional) {
      // A `token` field is echoed by the client on every update so the
      // server can identify the target / detect concurrency conflicts.
      // A nullable token cannot serve that role — the wire contract
      // would accept `null` and silently disable the check.
      accept(
        "error",
        `Token field '${m.name}' on aggregate '${agg.name}' cannot be nullable; \`token\` requires a non-optional type.`,
        { node: m, property: "access", code: "loom.token-nullable" },
      );
    }
    const hasExtern = agg.members.some((x) => isOperation(x) && x.extern);
    if (isProperty(m) && m.provenanced && !hasExtern && !fieldIsWritten(agg, m.name)) {
      // A provenanced field that no operation ever assigns produces no
      // trace records.  Warn (not error), and only when the aggregate has
      // no `extern` operation — an extern handler has no visible body and
      // may legitimately be the writer.
      accept(
        "warning",
        `Provenanced field '${m.name}' on aggregate '${agg.name}' is never written; no trace records will be produced.`,
        { node: m, property: "provenanced", code: "loom.provenanced-never-written" },
      );
    }
  }
  checkLifecycleConflicts(agg, accept);
}

/** Name-uniqueness rules for the lifecycle `create` / `destroy`
 * keywords: at most one canonical (unnamed) of each kind, and no two
 * named actions of the same kind sharing a name (lifecycle-operations.md
 * validator rules).  Create-vs-destroy names may coincide — they route
 * to different verbs/paths — so the two kinds are checked independently. */
function checkLifecycleConflicts(agg: Aggregate, accept: ValidationAcceptor): void {
  const creates = agg.members.filter(isCreate);
  const destroys = agg.members.filter(isDestroy);
  checkActionKindConflicts(creates, agg, "create", accept);
  checkActionKindConflicts(destroys, agg, "destroy", accept);
}

function checkActionKindConflicts(
  actions: readonly (Create | Destroy)[],
  agg: Aggregate,
  kind: "create" | "destroy",
  accept: ValidationAcceptor,
): void {
  const seenNames = new Set<string>();
  let canonicalSeen = false;
  for (const a of actions) {
    if (a.name == null) {
      if (canonicalSeen) {
        accept(
          "error",
          `Aggregate '${agg.name}' declares more than one canonical (unnamed) '${kind}'; at most one is allowed.`,
          { node: a, keyword: kind, code: `loom.canonical-${kind}-conflict` },
        );
      }
      canonicalSeen = true;
      continue;
    }
    if (seenNames.has(a.name)) {
      accept(
        "error",
        `Aggregate '${agg.name}' declares two '${kind} ${a.name}' actions; names must be unique within a kind.`,
        { node: a, property: "name", code: `loom.${kind}-name-conflict` },
      );
    }
    seenNames.add(a.name);
  }
}

/** True iff some `:=`/`+=`/`-=` in this aggregate targets `field`
 *  directly (matches the v1 instrumentation scope — direct fields). */
function fieldIsWritten(agg: Aggregate, field: string): boolean {
  for (const node of AstUtils.streamAllContents(agg)) {
    if (
      isAssignOrCallStmt(node) &&
      node.op &&
      node.target?.head === field &&
      (node.target.tail?.length ?? 0) === 0
    ) {
      return true;
    }
  }
  return false;
}

export function checkEntityPart(
  part: EntityPart,
  agg: Aggregate,
  accept: ValidationAcceptor,
): void {
  for (const m of part.members) {
    if (isContainment(m)) checkContainment(m, agg, accept);
    if (isInvariant(m)) checkInvariant(m, envForPart(agg, part), accept);
    if (isProperty(m) && m.check) checkPropertyCheck(m, envForPart(agg, part), accept);
    if (isProperty(m) && m.default) checkPropertyDefault(m, envForPart(agg, part), accept);
    if (isDerivedProp(m)) checkDerived(m, envForPart(agg, part), accept);
    if (isFunctionDecl(m)) checkFunction(m, agg, part, accept);
  }
}

export function checkValueObject(vo: ValueObject, accept: ValidationAcceptor): void {
  for (const m of vo.members) {
    if (isContainment(m)) {
      accept("error", `Value objects cannot contain entities.`, { node: m, property: "name" });
    }
    if (isInvariant(m)) checkInvariant(m, envForValueObject(vo), accept);
    if (isProperty(m) && m.check) checkPropertyCheck(m, envForValueObject(vo), accept);
    if (isDerivedProp(m)) {
      checkDerived(m, envForValueObject(vo), accept);
      if (m.name === "display" || m.name === "inspect") {
        // Reserved derived names are aggregate-only — VOs don't
        // participate in `string(x)` lowering or host-language
        // `ToString()`/`Inspect` emission.
        accept(
          "error",
          `Reserved 'derived ${m.name}' is only allowed on aggregates, not value objects.`,
          { node: m, property: "name", code: `loom.reserved-derived-on-vo` },
        );
      }
    }
  }
}

export function checkContainment(c: Containment, agg: Aggregate, accept: ValidationAcceptor): void {
  // An empty collection already encodes absence, so `[]?` is redundant
  // and almost certainly a mistake — reject it with a fixit pointer.
  if (c.collection && c.optional) {
    accept(
      "error",
      `Containment '${c.name}' is both a collection and optional — an empty collection already encodes absence; drop the '?'.`,
      { node: c, property: "optional" },
    );
  }
  const part = c.partType?.ref;
  if (!part) return;
  // Scope provider already restricts to local parts; this is a friendly
  // double-check in case of cross-aggregate ID-link errors.
  const owner = AstUtils.getContainerOfType(part, isAggregate);
  if (owner !== agg) {
    accept(
      "error",
      `Cannot 'contain' part '${part.name}' — it belongs to aggregate '${owner?.name ?? "?"}'. Use '${owner?.name ?? "?"} id' for a cross-aggregate link.`,
      { node: c, property: "partType" },
    );
  }
}

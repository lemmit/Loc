// Structural checks: cross-aggregate type references, containment
// sanity, aggregate / entity-part / value-object structural rules.

import { type AstNode, AstUtils, type ValidationAcceptor } from "langium";
import { isInferredContainment } from "../containment.js";
import type {
  Aggregate,
  BoundedContext,
  Containment,
  Create,
  DerivedProp,
  Destroy,
  EntityPart,
  Model,
  Property,
  Unique,
  ValueObject,
  Workflow,
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
  isHandleDecl,
  isIdType,
  isInvariant,
  isOnDecl,
  isOperation,
  isPreconditionStmt,
  isPrimitiveType,
  isProperty,
  isUnique,
  isValueObject,
  isWorkflow,
  isWorkflowCreateDecl,
} from "../generated/ast.js";
import { envForNode, typeOf, typeToString } from "../type-system.js";
import { envForAggregate, envForPart, envForValueObject } from "./_shared.js";
import { checkCreate, checkDestroy, checkOperation } from "./statements.js";
import {
  checkDerived,
  checkFunction,
  checkInvariant,
  checkParameterDefault,
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

/** `action` is the function-valued sibling of `slot`
 *  (extern-component-escape-hatch.md, Tier 2) — a behaviour the caller
 *  passes as a lambda, fired by the component.  Same position rule as
 *  `slot`: only meaningful on a `component`'s parameter list.  The
 *  callback's argument type (`action(Order)`) additionally may not
 *  itself be a `slot` / `action` (no higher-order nesting in v1). */
export function checkActionTypePosition(model: Model, accept: ValidationAcceptor): void {
  for (const node of AstUtils.streamAllContents(model)) {
    if (node.$type !== "ActionType") continue;
    const a = node as import("../generated/ast.js").ActionType;
    const typeRef = a.$container;
    const holder = typeRef?.$container;
    const enclosing = holder?.$container;
    const ok = holder?.$type === "Parameter" && enclosing?.$type === "Component";
    if (!ok) {
      const where = enclosing?.$type ?? holder?.$type ?? "<unknown>";
      accept(
        "error",
        `'action' is only valid on a component's parameter list; found on ${where}.`,
        { node: a, code: "loom.action-out-of-position" },
      );
      continue;
    }
    const argBase = a.arg?.base?.$type;
    if (argBase === "SlotType" || argBase === "ActionType") {
      accept(
        "error",
        `'action(${argBase === "SlotType" ? "slot" : "action"})' is not allowed — the callback argument must be a data type (primitive, aggregate, value object, …), not another UI marker.`,
        { node: a, property: "arg", code: "loom.action-nested-marker" },
      );
    }
  }
}

export function checkTypeReferences(model: Model, accept: ValidationAcceptor): void {
  for (const node of AstUtils.streamAllContents(model)) {
    if (node.$type !== "NamedType") continue;
    // Only fire on storage/wire-data positions — Property fields,
    // event/storage UserFields, and operation/function/page Parameters.
    // Find/Function return types and Derived/State projections may
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
          owner === "Workflow" ||
          // `create`/`destroy` action params are domain-side signatures too:
          // `create(c: Customer)` must spell the cross-aggregate link `Customer
          // id`, same as an operation param (C2).
          owner === "Create" ||
          owner === "Destroy";
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
        { node, property: "target", code: "loom.bare-aggregate-in-type" },
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
          { node, property: "target", code: "loom.cross-aggregate-entity-part" },
        );
      }
    }
  }
}

// Cross-aggregate entity-part reference ambiguity (full-review remediation
// §B8, audit finding under "Language & macros").
//
// `DddScopeComputation` exports every entity part to the document's GLOBAL
// scope by its bare name (ddd-scope.ts).  When two aggregates each declare an
// `entity Line`, an `X id` link written `l: Line id` resolves to whichever
// part the index happened to order first — silently, with no diagnostic — so
// the FK points at an arbitrary one of the two.
//
// This flags the ambiguity at the REFERENCE site (`IdType.target`), which is
// the one position that resolves entity parts through the un-scoped global
// map.  It cannot false-positive on same-aggregate references:
//   • `Containment.partType` is scoped to `localParts(aggregate)` (never
//     global), so a containment naming a local part is unambiguous.
//   • `NamedType.target` resolves entity parts only within the enclosing
//     aggregate (`localTypeScope`), so a bare-name field type is unambiguous.
// Only the `X id` form reaches the global scope, and we report only when the
// resolved target's bare name is shared by 2+ entity parts in the document —
// a single same-named part (even if it's a local one) is never flagged.
export function checkAmbiguousPartRefs(model: Model, accept: ValidationAcceptor): void {
  // Index every entity part by bare name → the aggregates that own one.
  const ownersByName = new Map<string, Set<string>>();
  for (const node of AstUtils.streamAllContents(model)) {
    if (!isEntityPart(node)) continue;
    const owner = AstUtils.getContainerOfType(node, isAggregate);
    const bucket = ownersByName.get(node.name) ?? new Set<string>();
    bucket.add(owner?.name ?? "<anonymous>");
    ownersByName.set(node.name, bucket);
  }

  for (const node of AstUtils.streamAllContents(model)) {
    if (!isIdType(node)) continue;
    const target = node.target?.ref;
    if (!target || !isEntityPart(target)) continue;
    const owners = ownersByName.get(target.name);
    // 2+ distinct owning aggregates → the bare `X id` link is ambiguous.
    if (!owners || owners.size < 2) continue;
    const names = [...owners].sort();
    const list =
      names.length === 2
        ? `aggregates '${names[0]}' and '${names[1]}'`
        : `aggregates ${names.map((n) => `'${n}'`).join(", ")}`;
    accept(
      "error",
      `Ambiguous entity-part reference '${target.name} id' — '${target.name}' is declared in ${list}. ` +
        `Entity parts are aggregate-local; reference the owning aggregate's root instead (e.g. '${names[0]} id'), ` +
        `or rename one of the parts so the link is unambiguous.`,
      { node, property: "target", code: "loom.ambiguous-part-ref" },
    );
  }
}

export function checkContext(ctx: BoundedContext, accept: ValidationAcceptor): void {
  for (const member of ctx.members) {
    if (isAggregate(member)) checkAggregate(member, accept);
    else if (isValueObject(member)) checkValueObject(member, accept);
    else if (isWorkflow(member)) checkWorkflow(member, accept);
  }
}

// `on(e: Event) [by <expr>] { … }` reactor discipline (workflow-and-applier.md
// Phase A2, surface slice).  Each inbound event routes to exactly one reactor,
// so two `on(...)` members for the same event type are almost certainly a
// mistake.  Until the `by` correlation clause is type-checked against the
// workflow's correlation field (a later slice), this is a warning rather than
// an error — intentional alternates distinguished only by `by` are still
// allowed.  Mirrors the applier "one applier per event type" rule above.
function checkWorkflow(wf: Workflow, accept: ValidationAcceptor): void {
  const reactors = wf.members.filter(isOnDecl);
  const eventName = (o: (typeof reactors)[number]): string => o.event.ref?.name ?? o.event.$refText;
  const counts = new Map<string, number>();
  for (const o of reactors) counts.set(eventName(o), (counts.get(eventName(o)) ?? 0) + 1);
  for (const o of reactors) {
    if ((counts.get(eventName(o)) ?? 0) > 1) {
      accept(
        "warning",
        `Workflow '${wf.name}' declares more than one on(...) reactor for event '${eventName(o)}'. ` +
          `Each inbound event routes to one reactor; if these are intentional alternates, distinguish them by their 'by' clause.`,
        { node: o, property: "event", code: "loom.on-duplicate-subscription" },
      );
    }
  }
  checkWorkflowEventSourcedDiscipline(wf, accept);

  // `requires Expr` authorization gate (authorization.md §11.3) on a workflow
  // `create` / `handle` trigger: a bool pre-check (403) over `currentUser` +
  // the trigger's command params (a saga starter/handler has no aggregate
  // `this`).  Types to bool exactly like the in-body `requires` it lowers to;
  // `envForNode` resolves the enclosing create/handle params.
  for (const m of wf.members) {
    if (!isWorkflowCreateDecl(m) && !isHandleDecl(m)) continue;
    if (!m.gate) continue;
    const gt = typeOf(m.gate, envForNode(m.gate));
    if (gt.kind !== "primitive" || gt.name !== "bool") {
      accept("error", `'requires' must be of type 'bool', got '${typeToString(gt)}'.`, {
        node: m,
        property: "gate",
      });
    }
  }

  // Workflow `function` members are the aggregate-parity pure helper — both the
  // expression form (`function f(...): T = expr`) and the pure block form
  // (`{ let … precondition … return … }`, domain-services.md rev. 4) are
  // allowed, exactly as on an aggregate.  Purity (no mutation / emit /
  // side-effecting call) is enforced at the IR layer (`loom.function-block-impure`),
  // and the no-`this` rule (a workflow helper is emitted at module/static scope)
  // by `loom.workflow-function-uses-state`.

  // Transactional legality (workflow-and-applier.md A2-S5e): `transactional`
  // is one DB transaction, so it is incompatible with continuation handlers —
  // an `on(...)` reactor or a `handle` command runs in its own later
  // transaction.  A multi-handler workflow is structurally multi-transaction.
  if (wf.transactional) {
    const continuations = wf.members.filter((m) => isOnDecl(m) || isHandleDecl(m));
    for (const c of continuations) {
      accept(
        "error",
        `Workflow '${wf.name}' is 'transactional' but declares a continuation handler. ` +
          `A reactor / handle runs in its own transaction — drop 'transactional', or remove the continuation.`,
        { node: c, code: "loom.transactional-with-continuations" },
      );
    }
  }
}

// Event-sourcing discipline for workflows (workflow-and-applier.md A2-S5b) —
// the AST-level mirror of the aggregate `checkEventSourcedDiscipline` below.
// An `eventSourced` workflow folds its emitted events into state via
// `apply(...)`; its handler bodies (`on(...)` + legacy statements) may only
// `emit`, and every emitted event needs an applier.
function checkWorkflowEventSourcedDiscipline(wf: Workflow, accept: ValidationAcceptor): void {
  const appliers = wf.members.filter(isApply);
  const eventOf = (a: (typeof appliers)[number]): string => a.event.ref?.name ?? a.event.$refText;

  // Rule 1 — appliers require an `eventSourced` workflow.
  if (!wf.eventSourced) {
    for (const ap of appliers) {
      accept(
        "error",
        `Workflow '${wf.name}' declares apply(...) but is not event-sourced. ` +
          `Add 'eventSourced' to the workflow header, or remove the applier.`,
        { node: ap, code: "loom.workflow-applier-on-non-event-sourced" },
      );
    }
    return;
  }

  // Rule 5 — one applier per event type.
  const counts = new Map<string, number>();
  for (const ap of appliers) counts.set(eventOf(ap), (counts.get(eventOf(ap)) ?? 0) + 1);
  for (const ap of appliers) {
    if ((counts.get(eventOf(ap)) ?? 0) > 1) {
      accept(
        "error",
        `Workflow '${wf.name}' declares more than one applier for event '${eventOf(ap)}'. ` +
          `An event folds into state exactly one way — declare a single apply(${eventOf(ap)}).`,
        { node: ap, property: "event", code: "loom.workflow-duplicate-applier" },
      );
    }
  }

  // Rules 2 + 3 — handler bodies are emit-only; emitted events must be folded.
  const appliedEvents = new Set(appliers.map(eventOf));
  const handlerBodies: AstNode[][] = [
    ...wf.members.filter(isOnDecl).map((o) => o.body),
    ...wf.members.filter(isHandleDecl).map((h) => h.body),
    wf.members.filter(isAssignOrCallStmt),
    wf.members.filter(isEmitStmt),
  ];
  for (const body of handlerBodies) {
    for (const stmt of body) {
      if (isAssignOrCallStmt(stmt) && stmt.op) {
        accept(
          "error",
          `Workflow '${wf.name}' is event-sourced — a handler body must not mutate 'this' directly. ` +
            `Replace the assignment with an 'emit' and fold it in an apply(...) block.`,
          { node: stmt, code: "loom.workflow-event-sourced-mutation" },
        );
      } else if (isEmitStmt(stmt)) {
        const ev = stmt.event.ref?.name ?? stmt.event.$refText;
        if (!appliedEvents.has(ev)) {
          accept(
            "error",
            `Event '${ev}' is emitted in workflow '${wf.name}' but no applier folds it. ` +
              `Add an apply(${ev}: ${ev}) block, or the event is recorded but never reflected in state.`,
            { node: stmt, code: "loom.workflow-emitted-event-no-applier" },
          );
        }
      }
    }
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

  // Rule 6 — a single canonical creator drives the `create(...)` factory +
  // POST route; more than one is ambiguous (zero is allowed — constructed
  // out-of-band, no create route).
  const creates = agg.members.filter(isCreate);
  if (creates.length > 1) {
    for (const c of creates.slice(1)) {
      accept(
        "error",
        `Aggregate '${agg.name}' is persistedAs(eventLog) and declares multiple 'create' actions. ` +
          `An event-sourced aggregate has a single canonical creator (v1) — keep one 'create(...)'.`,
        { node: c, code: "loom.event-sourced-multiple-creates" },
      );
    }
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
  // Loop-invariant: an extern operation has no visible body and may
  // legitimately write a provenanced field, so it suppresses the
  // never-written warning below.  Compute once, not per member.
  const hasExtern = agg.members.some((x) => isOperation(x) && x.extern);
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
    if (isUnique(m)) checkUnique(m, agg, accept);
    if (isProperty(m)) checkInferredContainment(m, accept);
    if (isProperty(m) && m.check) checkPropertyCheck(m, envForAggregate(agg), accept);
    if (isProperty(m) && m.default) checkPropertyDefault(m, envForAggregate(agg), accept);
    // Parameter defaults on aggregate actions (`operation cancel(reason = "x")`,
    // `create(...)`) get the same type-check as field defaults — `envForAggregate`
    // binds `this` so a this-relative default resolves.
    if (isOperation(m) || isCreate(m)) {
      for (const param of m.params) {
        if (param.default) checkParameterDefault(param, envForAggregate(agg), accept);
      }
    }
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

/** Validate a `unique (...)` uniqueness invariant (uniqueness-and-indexes.md).
 *  AST-level checks (fast editor feedback, no type resolution needed):
 *   - every listed column resolves to a declared property field
 *     (`loom.unique-unknown-field`, with the known field list);
 *   - a column named at most once per key (`loom.unique-duplicate-column`);
 *   - a collection (`[]`) field can't back a single-column unique key
 *     (`loom.unique-collection-field`);
 *   - uniqueness needs a single table to constrain, so it is gated off
 *     event-sourced / non-relational (`document` / `embedded`) aggregates
 *     (`loom.unique-on-event-sourced`) — the v1 deferral in §7.
 *  Value-object columns (multi-column, no single physical column) are
 *  rejected at IR level, where the resolved type is available. */
function checkUnique(u: Unique, agg: Aggregate, accept: ValidationAcceptor): void {
  const props = agg.members.filter(isProperty);
  const fieldNames = new Set(props.map((p) => p.name));

  if (agg.persistedAs === "eventLog" || agg.shape === "document" || agg.shape === "embedded") {
    const how = agg.persistedAs === "eventLog" ? "event-sourced" : `${agg.shape}-shaped`;
    accept(
      "error",
      `\`unique (...)\` on ${how} aggregate '${agg.name}' is not supported — uniqueness is enforced by a DB unique index, which needs a single relational table to constrain.`,
      { node: u, code: "loom.unique-on-event-sourced" },
    );
    return;
  }

  const seen = new Set<string>();
  u.columns.forEach((col, i) => {
    if (seen.has(col)) {
      accept("error", `\`unique\` on aggregate '${agg.name}' lists column '${col}' twice.`, {
        node: u,
        property: "columns",
        index: i,
        code: "loom.unique-duplicate-column",
      });
    }
    seen.add(col);
    if (!fieldNames.has(col)) {
      const known = [...fieldNames].join(", ") || "<none>";
      accept(
        "error",
        `\`unique\` on aggregate '${agg.name}' references unknown field '${col}'. Known fields: ${known}.`,
        { node: u, property: "columns", index: i, code: "loom.unique-unknown-field" },
      );
      return;
    }
    const prop = props.find((p) => p.name === col);
    if (prop?.type?.array) {
      accept(
        "error",
        `\`unique\` column '${col}' on aggregate '${agg.name}' is a collection; a uniqueness key must list single-valued fields.`,
        { node: u, property: "columns", index: i, code: "loom.unique-collection-field" },
      );
    }
  });
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
    if (isProperty(m)) checkInferredContainment(m, accept);
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

// A `contains`-less entity-typed field (`line: OrderLine`) is a containment, so
// it may carry only what `contains` carries — a name, `[]`, and `?`.  The value
// property modifiers (`provenanced` / access / `= default` / `sensitive(...)` /
// inline `check`) are meaningless on a child entity; reject them with a pointer
// to the explicit form rather than silently dropping them at lowering.  Also
// mirrors `contains`' own `[]?` rejection (an empty collection encodes absence).
export function checkInferredContainment(p: Property, accept: ValidationAcceptor): void {
  if (!isInferredContainment(p)) return;
  const part = p.type.base.$type === "NamedType" ? p.type.base.target?.ref?.name : undefined;
  const label = part ?? "the entity";
  const reject = (
    property: "provenanced" | "access" | "default" | "sensitivity" | "check",
    modifier: string,
  ) =>
    accept(
      "error",
      `Field '${p.name}' contains entity '${label}', so '${modifier}' does not apply — ` +
        `it is only valid on value properties. Drop it (write 'contains ${p.name}: ${label}${
          p.type.array ? "[]" : ""
        }' if you want the keyword explicit).`,
      { node: p, property, code: "loom.entity-field-modifier" },
    );
  if (p.provenanced) reject("provenanced", "provenanced");
  if (p.access) reject("access", p.access);
  if (p.default) reject("default", "= default");
  if (p.sensitivity) reject("sensitivity", "sensitive(...)");
  if (p.check) reject("check", "check");
  if (p.type.array && p.type.optional) {
    accept(
      "error",
      `Field '${p.name}' contains entity '${label}' as both a collection and optional — ` +
        `an empty collection already encodes absence; drop the '?'.`,
      { node: p, property: "type", code: "loom.entity-field-optional-collection" },
    );
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

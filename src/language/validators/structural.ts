// Structural checks: cross-aggregate type references, containment
// sanity, aggregate / entity-part / value-object structural rules.

import { type AstNode, AstUtils, type ValidationAcceptor } from "langium";
import type {
  Aggregate,
  BoundedContext,
  Containment,
  DerivedProp,
  EntityPart,
  Model,
  ValueObject,
} from "../generated/ast.js";
import {
  isAggregate,
  isAssignOrCallStmt,
  isContainment,
  isDerivedProp,
  isEntityPart,
  isFunctionDecl,
  isInvariant,
  isOperation,
  isPrimitiveType,
  isProperty,
  isValueObject,
} from "../generated/ast.js";
import {
  checkDerived,
  checkFunction,
  checkInvariant,
  checkPropertyCheck,
} from "./types.js";
import { checkOperation } from "./statements.js";
import { envForAggregate, envForPart, envForValueObject } from "./_shared.js";

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

export function checkAggregate(agg: Aggregate, accept: ValidationAcceptor): void {
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
    if (isDerivedProp(m)) {
      checkDerived(m, envForAggregate(agg), accept);
      // Reserved-name derived fields — `display` (user-facing label) and
      // `inspect` (developer-facing debug form).  Both must be `string`;
      // at most one of each per aggregate.  See plan
      // `/root/.claude/plans/i-think-we-have-glittery-lecun.md`.
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

export function checkContainment(
  c: Containment,
  agg: Aggregate,
  accept: ValidationAcceptor,
): void {
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

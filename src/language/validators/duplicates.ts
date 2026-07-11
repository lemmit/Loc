// Duplicate-name validator family (full-review remediation §B4, audit
// finding 10).
//
// The grammar admits sibling declarations that share a name; without a
// gate the last one silently wins and the earlier ones vanish:
//
//   • Two `aggregate Order` in one context → the first's fields are
//     dropped wholesale (a duplicate `aggregate Order` retains only the
//     second body).
//   • `total: money` + `total: string` on one aggregate → the field is
//     silently retyped.
//   • Duplicate operation params, event fields, value-object fields, and
//     enum values all pass validation and mangle the emitted DTO / signature.
//
// This module closes the class with four namespaces, each a themed
// `loom.duplicate-*` code:
//
//   1. loom.duplicate-context-type   — sibling aggregate / value-object /
//      event / enum *type* names must be unique within a bounded context
//      (they share the context's type-name namespace).  Root-level value
//      objects / enums / systems / contexts are covered separately by the
//      IR validator (`src/ir/validate/checks/structural-checks.ts`); this
//      is the context-scoped complement.  Payload name collisions are owned
//      by `validators/payload.ts` (`loom.payload-name-conflict`).
//   2. loom.duplicate-field          — property / derived / containment
//      *field* names must be unique within an aggregate / value object /
//      event (they all lower to one member of the wire shape).  Duplicate
//      entity-part *type* names and reserved `derived display`/`inspect`
//      collisions are owned by `validators/structural.ts`; payload fields by
//      `validators/payload.ts` (`loom.payload-duplicate-field`).
//   3. loom.duplicate-parameter      — operation / function / create /
//      destroy / commandHandler / queryHandler parameter names must be
//      distinct.
//   4. loom.duplicate-enum-value     — enum values must be distinct.
//   5. loom.duplicate-handler        — within a context, a `commandHandler` /
//      `queryHandler` name must not collide with another handler or with a
//      workflow `handle` in the same context (unfoldable-api-derivation.md,
//      Layer 3-4).  A `route -> Context.<name>` resolves the bare name against
//      the UNION of those three, so a collision silently deduplicates in the
//      resolver and a route would dispatch ambiguously.

import { type AstNode, AstUtils, type ValidationAcceptor } from "langium";
import type {
  Aggregate,
  BoundedContext,
  EnumDecl,
  EventDecl,
  Model,
  Parameter,
  ValueObject,
} from "../generated/ast.js";
import {
  isAggregate,
  isBoundedContext,
  isCommandHandler,
  isContainment,
  isCreate,
  isDerivedProp,
  isDestroy,
  isEnumDecl,
  isEventDecl,
  isFunctionDecl,
  isHandleDecl,
  isOperation,
  isProperty,
  isQueryHandler,
  isValueObject,
} from "../generated/ast.js";

/** A named member paired with the node the diagnostic should attach to. */
interface Named {
  readonly name: string;
  readonly node: AstNode;
}

/** Emit an error on every occurrence after the first for each repeated name.
 *  The first declaration is left un-flagged (it is the one that "wins"); the
 *  later shadowing declarations carry the diagnostic. */
function reportDuplicates(
  items: readonly Named[],
  code: string,
  message: (name: string) => string,
  accept: ValidationAcceptor,
): void {
  const seen = new Set<string>();
  for (const it of items) {
    if (seen.has(it.name)) {
      accept("error", message(it.name), { node: it.node, property: "name", code });
    } else {
      seen.add(it.name);
    }
  }
}

/** Sibling type names within a bounded context — aggregates, value objects,
 *  events, and enums share one type-name namespace. */
function checkContextTypeNames(ctx: BoundedContext, accept: ValidationAcceptor): void {
  const types: Named[] = [];
  for (const m of ctx.members) {
    if (isAggregate(m) || isValueObject(m) || isEventDecl(m) || isEnumDecl(m)) {
      types.push({ name: m.name, node: m });
    }
  }
  reportDuplicates(
    types,
    "loom.duplicate-context-type",
    (name) =>
      `Duplicate declaration '${name}' in context '${ctx.name}'; aggregate / value-object / ` +
      `event / enum names must be unique within a context (the later one silently replaces the first).`,
    accept,
  );
}

/** Application-layer handler names within a context — `commandHandler` /
 *  `queryHandler` context members and workflow `handle` declarations share one
 *  route-target namespace (`route -> Context.<name>`).  We report on the two
 *  new context-member kinds only: a command/query handler whose name is already
 *  taken by an earlier handler or a workflow `handle` in the same context.  We
 *  do NOT newly police workflow-`handle`-vs-`handle` collisions here (that is
 *  pre-existing behaviour owned elsewhere); this closes only the ambiguity the
 *  explicit handlers introduce. */
function checkHandlerNames(ctx: BoundedContext, accept: ValidationAcceptor): void {
  // Names already occupying the route-target space before we walk the explicit
  // handlers: every workflow `handle` in the context.
  const seen = new Set<string>();
  for (const node of AstUtils.streamAllContents(ctx)) {
    if (isHandleDecl(node)) seen.add(node.name);
  }
  // Walk the explicit handlers in document order; each collides if its name is
  // already taken (by a workflow handle or an earlier explicit handler).
  for (const m of ctx.members) {
    if (isCommandHandler(m) || isQueryHandler(m)) {
      const kind = isCommandHandler(m) ? "commandHandler" : "queryHandler";
      if (seen.has(m.name)) {
        accept(
          "error",
          `Duplicate handler '${m.name}' in context '${ctx.name}'; a ${kind} shares its name ` +
            `with another handler or a workflow 'handle'. A 'route -> ${ctx.name}.${m.name}' would ` +
            `be ambiguous — handler and workflow-handle names must be unique within a context.`,
          { node: m, property: "name", code: "loom.duplicate-handler" },
        );
      } else {
        seen.add(m.name);
      }
    }
  }
}

/** Field-position names on an aggregate — properties, derived fields, and
 *  containments all lower to a single wire-shape member, so they share one
 *  namespace.  (Entity-part *type* names are a separate namespace, gated in
 *  `structural.ts`.) */
function checkAggregateFieldNames(agg: Aggregate, accept: ValidationAcceptor): void {
  const fields: Named[] = [];
  for (const m of agg.members) {
    if (isProperty(m) || isDerivedProp(m) || isContainment(m)) {
      fields.push({ name: m.name, node: m });
    }
  }
  reportDuplicates(
    fields,
    "loom.duplicate-field",
    (name) =>
      `Duplicate field '${name}' in aggregate '${agg.name}'; property, derived, and containment ` +
      `names must be distinct (they map to one field of the wire shape).`,
    accept,
  );
}

/** Field-position names on a value object — properties and derived fields
 *  (value objects cannot contain entities). */
function checkValueObjectFieldNames(vo: ValueObject, accept: ValidationAcceptor): void {
  const fields: Named[] = [];
  for (const m of vo.members) {
    if (isProperty(m) || isDerivedProp(m)) fields.push({ name: m.name, node: m });
  }
  reportDuplicates(
    fields,
    "loom.duplicate-field",
    (name) => `Duplicate field '${name}' in value object '${vo.name}'.`,
    accept,
  );
}

/** Field names within an event record. */
function checkEventFieldNames(ev: EventDecl, accept: ValidationAcceptor): void {
  reportDuplicates(
    ev.fields.map((f) => ({ name: f.name, node: f })),
    "loom.duplicate-field",
    (name) => `Duplicate field '${name}' in event '${ev.name}'.`,
    accept,
  );
}

/** Values within an enum. */
function checkEnumValueNames(en: EnumDecl, accept: ValidationAcceptor): void {
  reportDuplicates(
    en.values.map((v) => ({ name: v.name, node: v })),
    "loom.duplicate-enum-value",
    (name) => `Duplicate value '${name}' in enum '${en.name}'.`,
    accept,
  );
}

/** Parameter names within a single signature (operation / function / create /
 *  destroy). */
function checkParamNames(
  params: readonly Parameter[],
  owner: string,
  accept: ValidationAcceptor,
): void {
  reportDuplicates(
    params.map((p) => ({ name: p.name, node: p })),
    "loom.duplicate-parameter",
    (name) => `Duplicate parameter '${name}' in ${owner}.`,
    accept,
  );
}

export function checkDuplicateNames(model: Model, accept: ValidationAcceptor): void {
  for (const node of AstUtils.streamAllContents(model)) {
    if (isBoundedContext(node)) {
      checkContextTypeNames(node, accept);
      checkHandlerNames(node, accept);
    } else if (isAggregate(node)) checkAggregateFieldNames(node, accept);
    else if (isValueObject(node)) checkValueObjectFieldNames(node, accept);
    else if (isEventDecl(node)) checkEventFieldNames(node, accept);
    else if (isEnumDecl(node)) checkEnumValueNames(node, accept);

    if (isOperation(node)) checkParamNames(node.params, `operation '${node.name}'`, accept);
    else if (isFunctionDecl(node)) checkParamNames(node.params, `function '${node.name}'`, accept);
    else if (isCreate(node))
      checkParamNames(node.params, `create${node.name ? ` '${node.name}'` : ""}`, accept);
    else if (isDestroy(node))
      checkParamNames(node.params, `destroy${node.name ? ` '${node.name}'` : ""}`, accept);
    else if (isCommandHandler(node))
      checkParamNames(node.params, `commandHandler '${node.name}'`, accept);
    else if (isQueryHandler(node))
      checkParamNames(node.params, `queryHandler '${node.name}'`, accept);
  }
}

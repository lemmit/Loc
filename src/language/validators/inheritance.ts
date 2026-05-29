// Aggregate-inheritance checks (aggregate-inheritance.md, phase I1).
//
// Model-level because every rule here crosses an aggregate boundary:
// resolving an `extends` target, spotting a repository pointed at an
// abstract base, and the D-ES-TPH base/concrete interaction all need to
// see more than the aggregate under inspection.  I1 is declaration +
// validation only — backends emit nothing for abstract aggregates and the
// storage strategies (`sharedTable` TPH / `ownTable` TPC) carry no emission
// semantics yet (that is I2/I3).  These rules keep the surface honest in
// the meantime.

import { AstUtils, type ValidationAcceptor } from "langium";
import type { Aggregate, IdType, Model, Repository } from "../generated/ast.js";
import {
  isAggregate,
  isCreate,
  isDestroy,
  isIdType,
  isOperation,
  isRepository,
} from "../generated/ast.js";

/** Default inheritance layout for a participant that omits the
 *  `inheritanceUsing(…)` modifier: TPH (`sharedTable`) — the simplest DSL
 *  surface and most performant default (aggregate-inheritance.md §"Decision
 *  guidance"). */
const DEFAULT_LAYOUT = "sharedTable" as const;

export function checkInheritance(model: Model, accept: ValidationAcceptor): void {
  const aggregates: Aggregate[] = [];
  const repositories: Repository[] = [];
  const idTypes: IdType[] = [];
  for (const node of AstUtils.streamAllContents(model)) {
    if (isAggregate(node)) aggregates.push(node);
    else if (isRepository(node)) repositories.push(node);
    else if (isIdType(node)) idTypes.push(node);
  }

  for (const agg of aggregates) {
    const base = agg.superType?.ref;

    // Rule 1 — `extends` may only target an `abstract` aggregate, and never
    // the aggregate itself.  (An unresolved `superType` is the linker's
    // error, not ours — `base` is undefined and we stay quiet.)
    if (agg.superType && base) {
      if (base === agg) {
        accept("error", `Aggregate '${agg.name}' cannot extend itself.`, {
          node: agg,
          property: "superType",
          code: "loom.extends-self",
        });
      } else if (!base.isAbstract) {
        accept(
          "error",
          `Aggregate '${agg.name}' extends '${base.name}', which is not abstract. ` +
            `Only an 'abstract aggregate' may be extended.`,
          { node: agg, property: "superType", code: "loom.extends-non-abstract" },
        );
      }
    }

    // Rule 2 — `inheritanceUsing(…)` is only meaningful on a participant in
    // an inheritance relationship (an `abstract` base or an `extends`
    // subtype).  Flag it on a plain aggregate.
    if (agg.inheritanceUsing && !agg.isAbstract && !agg.superType) {
      accept(
        "error",
        `'inheritanceUsing(${agg.inheritanceUsing})' is only valid on an 'abstract' base ` +
          `or an 'extends' subtype; '${agg.name}' is neither.`,
        { node: agg, property: "inheritanceUsing", code: "loom.inheritance-modifier-misplaced" },
      );
    }

    // Rule 3 — abstract aggregates declare no lifecycle actions in v1.
    // Bases are never instantiated (no `create`), never terminated
    // (no `destroy`), and polymorphic dispatch is explicitly deferred
    // (no `operation` on the base — declare it per concrete instead).
    if (agg.isAbstract) {
      for (const m of agg.members) {
        if (isCreate(m) || isDestroy(m) || isOperation(m)) {
          const kw = isCreate(m) ? "create" : isDestroy(m) ? "destroy" : "operation";
          accept(
            "error",
            `Abstract aggregate '${agg.name}' cannot declare a '${kw}' action — abstract ` +
              `bases are never instantiated and have no polymorphic dispatch in v1. ` +
              `Declare it on each concrete subtype.`,
            { node: m, code: "loom.abstract-aggregate-behavior" },
          );
        }
      }
    }

    // Rule 4 — D-ES-TPH: an event-sourced (`persistedAs(eventLog)`) or
    // document (`shape(document)`) concrete cannot share its base table, so
    // it cannot live under a `sharedTable` (TPH) base.  The validator raises
    // an error rather than silently coercing, so the author writes the
    // forced `inheritanceUsing(ownTable)` explicitly.
    if (base?.isAbstract) {
      const baseLayout = base.inheritanceUsing ?? DEFAULT_LAYOUT;
      const forcesOwn = agg.persistedAs === "eventLog" || agg.shape === "document";
      if (baseLayout === "sharedTable" && forcesOwn && agg.inheritanceUsing !== "ownTable") {
        const why = agg.persistedAs === "eventLog" ? "persistedAs(eventLog)" : "shape(document)";
        accept(
          "error",
          `'${agg.name}' is ${why} but extends the sharedTable (TPH) base '${base.name}'. ` +
            `An event-sourced / document concrete cannot share the base table — declare ` +
            `'inheritanceUsing(ownTable)' on '${agg.name}' (D-ES-TPH).`,
          {
            node: agg,
            property: agg.inheritanceUsing ? "inheritanceUsing" : "name",
            code: "loom.es-tph-forced-own-table",
          },
        );
      }
    }
  }

  // Rule 5 — an abstract aggregate has no repository of its own; repositories
  // belong to concrete subtypes.  (An unresolved target is the linker's
  // problem; we only flag a resolved-but-abstract one.)
  for (const repo of repositories) {
    const target = repo.aggregate?.ref;
    if (target?.isAbstract) {
      accept(
        "error",
        `'repository ${repo.name} for ${target.name}': '${target.name}' is an abstract ` +
          `aggregate and has no repository of its own. Repositories belong to concrete subtypes.`,
        { node: repo, property: "aggregate", code: "loom.abstract-repository" },
      );
    }
  }

  // Rule 6 — a polymorphic `Base id` reference to an abstract base is not
  // supported yet.  Under `ownTable` (TPC) the proposal forbids it outright
  // (the FK target is ambiguous across the per-concrete tables); under
  // `sharedTable` (TPH) it would target the single base table, but TPH
  // emission is not implemented yet (gated in IR-validate).  Until one of
  // those lands, reject the reference with a concrete fix rather than emitting
  // a dangling FK.  (A bare `Base` type ref is already steered to `Base id` by
  // `loom.bare-aggregate-in-type`; this catches the `id` form that survives.)
  for (const idType of idTypes) {
    const target = idType.target?.ref;
    if (isAggregate(target) && target.isAbstract) {
      accept(
        "error",
        `'${target.name} id' references the abstract base '${target.name}', which has no ` +
          `single table to key against. Polymorphic references to an abstract base are not ` +
          `supported yet — reference a concrete subtype's id (e.g. 'Customer id') instead.`,
        { node: idType, property: "target", code: "loom.polymorphic-id-ref-unsupported" },
      );
    }
  }
}

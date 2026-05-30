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

    // Rule 4b — a *voluntary* `ownTable` override of a `sharedTable` (TPH)
    // base (the per-concrete-override "mixed strategy", aggregate-inheritance.md
    // Pattern 3) is not supported in v1.  Such a concrete generates a working
    // standalone table today, but it sits OUTSIDE the shared table the base
    // reader scans, so `find all <Base>` and polymorphic `<Base> id` can't see
    // it (a UNION-ALL read over mixed strategies is deferred — the proposal
    // marks per-concrete override as an open question).  Rather than ship a
    // half-supported hierarchy that silently drops the override concrete from
    // every polymorphic query, reject the override until full mixed-strategy
    // emission lands.  The event-sourced / document case (Rule 4 `forcesOwn`)
    // is the one sanctioned `ownTable`-under-`sharedTable`: it's a forced
    // opt-out, not a free choice, and an ES/document concrete is never a
    // polymorphic read target — so it stays allowed.
    if (base?.isAbstract) {
      const baseLayout = base.inheritanceUsing ?? DEFAULT_LAYOUT;
      const forcesOwn = agg.persistedAs === "eventLog" || agg.shape === "document";
      if (baseLayout === "sharedTable" && agg.inheritanceUsing === "ownTable" && !forcesOwn) {
        accept(
          "error",
          `'${agg.name}' declares inheritanceUsing(ownTable) under the sharedTable (TPH) base ` +
            `'${base.name}' — a per-concrete storage override (mixed strategy) is not supported ` +
            `yet. The override concrete would live in its own table, outside the shared one, so ` +
            `'find all ${base.name}' and polymorphic '${base.name} id' references can't see it. ` +
            `Make '${agg.name}' sharedTable to keep the whole hierarchy in one table, or make ` +
            `the entire hierarchy ownTable (TPC).`,
          { node: agg, property: "inheritanceUsing", code: "loom.tph-own-override-unsupported" },
        );
      }
    }
    // (A `contains` part on a TPH concrete used to be gated here — Rule 4c,
    // `loom.tph-contains-unsupported`.  It is now supported: the part emits its
    // own table FK'd to the shared base table (Pattern 4, TPT-via-`contains`),
    // since a TPH concrete's id is the shared-table row id.  See
    // emit/schema.ts + migrations-builder.ts `tableForPart`.)
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

  // Rule 6 — a polymorphic `Base id` reference to an abstract base.  Whether
  // the FK target is unambiguous depends on the *effective* layout of every
  // concrete in the hierarchy (a concrete's own `inheritanceUsing` overrides
  // the base's — the per-concrete-override pattern, aggregate-inheritance.md):
  //
  //   - `ownTable` (TPC) base → no single table to key against; the FK target
  //     is ambiguous across the per-concrete tables.  Rejected outright
  //     (`loom.polymorphic-id-ref-unsupported`).
  //   - `sharedTable` (TPH) base whose concretes are *all* shared → one table,
  //     unambiguous FK; allowed (resolved by the Hono base reader).
  //   - `sharedTable` base with an `ownTable`-override concrete (mixed
  //     strategy) → the overridden concrete lives in its own table, outside
  //     the shared one the base reader scans, so a `Base id` would silently
  //     miss it.  Rejected (`loom.polymorphic-id-ref-mixed-strategy`), naming
  //     the offending sibling so the fix is obvious.
  //
  // (A bare `Base` type ref is already steered to `Base id` by
  // `loom.bare-aggregate-in-type`; this catches the `id` form.)
  for (const idType of idTypes) {
    const base = idType.target?.ref;
    if (!isAggregate(base) || !base.isAbstract) continue;
    const baseLayout = base.inheritanceUsing ?? DEFAULT_LAYOUT;
    if (baseLayout === "ownTable") {
      accept(
        "error",
        `'${base.name} id' references the abstract base '${base.name}', which uses ` +
          `inheritanceUsing(ownTable) (TPC) — there is no single table to key against, so the ` +
          `foreign-key target is ambiguous across the per-concrete tables. Reference a concrete ` +
          `subtype's id (e.g. 'Customer id'), or change '${base.name}' to ` +
          `inheritanceUsing(sharedTable) (TPH) to allow polymorphic references.`,
        { node: idType, property: "target", code: "loom.polymorphic-id-ref-unsupported" },
      );
      continue;
    }
    // sharedTable base: reject if any concrete overrides to `ownTable`.  The
    // effective layout of a concrete is its own modifier, else the base's.
    const ownSiblings = aggregates.filter(
      (a) =>
        a.superType?.ref === base &&
        (a.inheritanceUsing ?? base.inheritanceUsing ?? DEFAULT_LAYOUT) === "ownTable",
    );
    if (ownSiblings.length > 0) {
      const names = ownSiblings.map((a) => `'${a.name}'`).join(", ");
      accept(
        "error",
        `'${base.name} id' references the abstract base '${base.name}', but its hierarchy mixes ` +
          `storage strategies: ${names} override(s) to inheritanceUsing(ownTable) and live in a ` +
          `separate table, so a polymorphic '${base.name} id' would silently miss them. Reference ` +
          `a concrete subtype's id instead, or make every concrete sharedTable (TPH) so the ` +
          `whole hierarchy shares one table.`,
        { node: idType, property: "target", code: "loom.polymorphic-id-ref-mixed-strategy" },
      );
    }
  }
}

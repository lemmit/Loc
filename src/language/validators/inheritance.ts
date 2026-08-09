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
import { diagMessage } from "../../diagnostics/messages.js";
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
 *  `inheritanceUsing: …` modifier: TPH (`sharedTable`) — the simplest DSL
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
        accept("error", diagMessage("loom.extends-self", { name: agg.name }), {
          node: agg,
          property: "superType",
          code: "loom.extends-self",
        });
      } else if (!base.isAbstract) {
        accept(
          "error",
          diagMessage("loom.extends-non-abstract", { name: agg.name, baseName: base.name }),
          { node: agg, property: "superType", code: "loom.extends-non-abstract" },
        );
      }
    }

    // Rule 2 — `inheritanceUsing: …` is only meaningful on a participant in
    // an inheritance relationship (an `abstract` base or an `extends`
    // subtype).  Flag it on a plain aggregate.
    if (agg.inheritanceUsing && !agg.isAbstract && !agg.superType) {
      accept(
        "error",
        diagMessage("loom.inheritance-modifier-misplaced", {
          inheritanceUsing: agg.inheritanceUsing,
          name: agg.name,
        }),
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
          accept("error", diagMessage("loom.abstract-aggregate-behavior", { name: agg.name, kw }), {
            node: m,
            code: "loom.abstract-aggregate-behavior",
          });
        }
      }
    }

    // Rule 4 — D-ES-TPH: an event-sourced (`persistedAs: eventLog`) or
    // document (`shape: document`) concrete cannot share its base table, so
    // it cannot live under a `sharedTable` (TPH) base.  The validator raises
    // an error rather than silently coercing, so the author writes the
    // forced `inheritanceUsing: ownTable` explicitly.
    if (base?.isAbstract) {
      const baseLayout = base.inheritanceUsing ?? DEFAULT_LAYOUT;
      const forcesOwn = agg.persistedAs === "eventLog" || agg.shape === "document";
      if (baseLayout === "sharedTable" && forcesOwn && agg.inheritanceUsing !== "ownTable") {
        const why = agg.persistedAs === "eventLog" ? "persistedAs: eventLog" : "shape: document";
        accept(
          "error",
          diagMessage("loom.es-tph-forced-own-table", { name: agg.name, why, baseName: base.name }),
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
          diagMessage("loom.tph-own-override-unsupported", { name: agg.name, baseName: base.name }),
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

  // Rule 1b — `extends` CYCLES (full-review remediation §B7).  Rule 1 catches
  // only direct self-extension (`A extends A`).  A mutual or longer cycle
  // (`A extends B extends A`) validates clean today and silently truncates
  // inheritance — the enrichment merge (`enrichments.ts`) walks the chain with
  // a visited-set and simply stops when it loops back, so the fields beyond the
  // cycle are never merged and no diagnostic is raised.  Detect the cycle here
  // and report it once, naming every aggregate in the loop.
  const reportedCycles = new Set<string>();
  for (const start of aggregates) {
    const path: Aggregate[] = [];
    const onPath = new Set<Aggregate>();
    let cur: Aggregate | undefined = start;
    while (cur) {
      if (onPath.has(cur)) {
        // Re-entered a node already on the path → the tail from `cur` onward
        // is the cycle.  A length-1 cycle is self-extension (Rule 1's
        // `loom.extends-self`); leave that to Rule 1 and only report cycles of
        // two or more distinct aggregates here.
        const cycle = path.slice(path.indexOf(cur));
        if (cycle.length >= 2) {
          const key = cycle
            .map((a) => a.name)
            .sort()
            .join(" ");
          if (!reportedCycles.has(key)) {
            reportedCycles.add(key);
            const names = cycle.map((a) => a.name);
            accept(
              "error",
              diagMessage("loom.extends-cycle", {
                names: names[0],
                names2: [...names, names[0]].join(" → "),
              }),
              { node: cycle[0], property: "superType", code: "loom.extends-cycle" },
            );
          }
        }
        break;
      }
      onPath.add(cur);
      path.push(cur);
      cur = cur.superType?.ref;
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
        diagMessage("loom.abstract-repository", { name: repo.name, targetName: target.name }),
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
      accept("error", diagMessage("loom.polymorphic-id-ref-unsupported", { name: base.name }), {
        node: idType,
        property: "target",
        code: "loom.polymorphic-id-ref-unsupported",
      });
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
        diagMessage("loom.polymorphic-id-ref-mixed-strategy", { name: base.name, names }),
        { node: idType, property: "target", code: "loom.polymorphic-id-ref-mixed-strategy" },
      );
    }
  }
}

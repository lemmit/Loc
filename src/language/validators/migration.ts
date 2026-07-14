// Migration-block checks (M-T2.1, docs/new-plan/missions/
// M-T2.1-migration-surface-design.md).
//
// A top-level `migration "<name>" { rename Agg.old -> new }` block is a
// permanent, ledger-style record whose `rename` steps disambiguate the derived
// snapshot→model migration diff.  These checks are deliberately STRUCTURAL and
// snapshot-independent: a historical ledger block legitimately references field
// names that have since moved on (a column renamed a second time), so we must
// NOT require `to` to be a currently-live field — that would make an old,
// correct block fail forever.  We only reject the unambiguously-broken shapes:
//
//   - `loom.migration-duplicate-name`   — two blocks share a name.
//   - `loom.rename-to-self`             — `from` == `to` (a no-op rename), on a
//                                         COLUMN or a TABLE/aggregate rename.
//   - `loom.rename-duplicate-source`    — one aggregate column / one old table
//                                         renamed twice FROM (ambiguous origin).
//   - `loom.rename-duplicate-target`    — two renames collide ON one target
//                                         column / aggregate (ambiguous dest.).
//
// A column rename's `aggregate` and a table rename's `toAggregate` are real
// cross-references (`[Aggregate:ID]`), so an unknown live aggregate is already a
// Langium linking error — not re-checked here.  A table rename's `fromTable` is
// deliberately NOT a cross-reference (the old aggregate is gone), so it is only
// checked structurally.

import { AstUtils, type ValidationAcceptor } from "langium";
import type { Migration, Model } from "../generated/ast.js";
import { isMigration, isTableRename } from "../generated/ast.js";

export function checkMigrations(model: Model, accept: ValidationAcceptor): void {
  const seenNames = new Set<string>();
  // (aggregate, column) → seen once, across ALL blocks: a column may be a
  // rename source at most once and a rename target at most once.
  const seenSource = new Set<string>();
  const seenTarget = new Set<string>();
  for (const node of AstUtils.streamAllContents(model)) {
    if (!isMigration(node)) continue;
    checkMigration(node, seenNames, seenSource, seenTarget, accept);
  }
}

function checkMigration(
  m: Migration,
  seenNames: Set<string>,
  seenSource: Set<string>,
  seenTarget: Set<string>,
  accept: ValidationAcceptor,
): void {
  if (seenNames.has(m.name)) {
    accept("error", `Duplicate migration block name ${JSON.stringify(m.name)}.`, {
      node: m,
      property: "name",
      code: "loom.migration-duplicate-name",
    });
  } else {
    seenNames.add(m.name);
  }

  for (const step of m.renames) {
    if (isTableRename(step)) {
      // Table/aggregate rename (`OldName -> NewAggregate`).  Structural checks
      // only: `fromTable` is a bare name (the old aggregate is gone), so it
      // cannot be cross-referenced.
      const to = step.toAggregate.ref?.name ?? step.toAggregate.$refText;
      if (step.fromTable === to) {
        accept(
          "error",
          `Table rename '${step.fromTable} -> ${to}' names the same aggregate on both sides — a rename must change the name.`,
          { node: step, property: "toAggregate", code: "loom.rename-to-self" },
        );
        continue;
      }
      // A whole-table rename shares the source/target namespace with column
      // renames only trivially; key it on the aggregate name alone.
      if (seenSource.has(step.fromTable)) {
        accept(
          "error",
          `Table '${step.fromTable}' is renamed more than once — an aggregate can be renamed FROM only once (ambiguous origin).`,
          { node: step, property: "fromTable", code: "loom.rename-duplicate-source" },
        );
      } else {
        seenSource.add(step.fromTable);
      }
      if (seenTarget.has(to)) {
        accept(
          "error",
          `Two renames target aggregate '${to}' — an aggregate can be renamed TO only once (ambiguous destination).`,
          { node: step, property: "toAggregate", code: "loom.rename-duplicate-target" },
        );
      } else {
        seenTarget.add(to);
      }
      continue;
    }
    // A column rename is scoped to a specific aggregate; key collisions per aggregate.
    const agg = step.aggregate.ref?.name ?? step.aggregate.$refText;
    if (step.from === step.to) {
      accept(
        "error",
        `Rename of '${agg}.${step.from}' names the same field on both sides — a rename must change the name.`,
        { node: step, property: "to", code: "loom.rename-to-self" },
      );
      continue;
    }
    const sourceKey = `${agg}.${step.from}`;
    const targetKey = `${agg}.${step.to}`;
    if (seenSource.has(sourceKey)) {
      accept(
        "error",
        `Field '${sourceKey}' is renamed more than once — a column can be renamed FROM only once (ambiguous origin).`,
        { node: step, property: "from", code: "loom.rename-duplicate-source" },
      );
    } else {
      seenSource.add(sourceKey);
    }
    if (seenTarget.has(targetKey)) {
      accept(
        "error",
        `Two renames target '${targetKey}' — a column can be renamed TO only once (ambiguous destination).`,
        { node: step, property: "to", code: "loom.rename-duplicate-target" },
      );
    } else {
      seenTarget.add(targetKey);
    }
  }
}

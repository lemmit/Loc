// The Migrations tab's schema diagram: every table of the current schema,
// tinted by what the pending migration does to it (M-T8.22 slice 1 — the
// Prisma-Studio pattern over `MigrationsIR`, audit M8).
//
//   added     — a `createTable` step creates it            (green)
//   changed   — any other step touches it                  (amber)
//   removed   — a `dropTable` step drops it (it is no longer in the current
//               schema, so it is recovered from the step)  (red)
//   untouched — in the current schema, no step names it    (dimmed)
//
// Pure data → data (no React, no DOM) so the root vitest suite can drive it
// without `web/node_modules`, same convention as `layout/vocabulary.ts`.

import type { EvolutionResult, MigrationView, SchemaTableView } from "../build/protocol";

export type TableTint = "added" | "changed" | "removed" | "untouched";

export interface TintedTable {
  module: string;
  name: string;
  schema?: string;
  tint: TableTint;
  /** Columns of the current shape (empty for a removed table — its shape is
   *  gone with it). */
  columns: string[];
  /** Columns the migration adds / drops / renames / alters on this table —
   *  what the amber card highlights. */
  changedColumns: string[];
  /** Bare names of the tables this one's foreign keys point at. */
  refs: string[];
  /** The step ops that touched this table, in migration order. */
  ops: string[];
}

/** Ops whose target is a column of `table`; the column name is read from
 *  the rendered SQL because the step view carries only `{op, sql, table}`
 *  (keeping the worker DTO flat).  Best-effort: a miss leaves the table
 *  amber with no column highlighted, never a crash. */
const COLUMN_SQL: Record<string, RegExp> = {
  addColumn: /ADD COLUMN\s+"?([A-Za-z0-9_]+)"?/i,
  dropColumn: /DROP COLUMN\s+"?([A-Za-z0-9_]+)"?/i,
  renameColumn: /RENAME COLUMN\s+"?([A-Za-z0-9_]+)"?\s+TO\s+"?([A-Za-z0-9_]+)"?/i,
  alterColumnNullable: /ALTER COLUMN\s+"?([A-Za-z0-9_]+)"?/i,
  alterColumnType: /ALTER COLUMN\s+"?([A-Za-z0-9_]+)"?/i,
  backfillColumn: /SET\s+"?([A-Za-z0-9_]+)"?\s*=/i,
};

function columnsOf(step: { op: string; sql: string }): string[] {
  const re = COLUMN_SQL[step.op];
  if (!re) return [];
  const m = re.exec(step.sql);
  if (!m) return [];
  return m.slice(1).filter((s): s is string => typeof s === "string" && s.length > 0);
}

/** Tint the current schema by the pending migration.  Order: the current
 *  schema's tables in their derived order (per module), then any dropped
 *  tables appended — a stable order the diagram can lay out without a
 *  layout pass. */
export function tintTables(e: EvolutionResult | null): TintedTable[] {
  if (!e || !e.ok) return [];
  const byKey = new Map<string, TintedTable>();
  const key = (module: string, name: string): string => `${module}\0${name}`;
  for (const t of e.tables) byKey.set(key(t.module, t.name), untouched(t));
  for (const m of e.migrations) {
    for (const step of m.steps) {
      if (!step.table) continue;
      const k = key(m.module, step.table);
      let row = byKey.get(k);
      if (!row) {
        // A table the current schema no longer has — only `dropTable` can
        // legitimately name one.  Anything else naming an unknown table is
        // shown as changed so the step is not silently lost.
        row = {
          module: m.module,
          name: step.table,
          tint: step.op === "dropTable" ? "removed" : "changed",
          columns: [],
          changedColumns: [],
          refs: [],
          ops: [],
        };
        byKey.set(k, row);
      }
      row.ops.push(step.op);
      if (step.op === "createTable") {
        row.tint = "added";
      } else if (step.op === "dropTable") {
        row.tint = "removed";
      } else if (row.tint === "untouched") {
        row.tint = "changed";
      }
      for (const c of columnsOf(step)) {
        if (!row.changedColumns.includes(c)) row.changedColumns.push(c);
      }
    }
  }
  return [...byKey.values()];
}

/** Count per tint — the legend's numbers. */
export function tintCounts(tables: TintedTable[]): Record<TableTint, number> {
  const out: Record<TableTint, number> = { added: 0, changed: 0, removed: 0, untouched: 0 };
  for (const t of tables) out[t.tint]++;
  return out;
}

/** What a destructive migration would DROP — one line per table / column,
 *  for the gate copy ("the data it would drop").  Read from the steps the
 *  worker re-derived with the gate off, so it names exactly what
 *  `--allow-destructive` would let through. */
export function destructiveDrops(m: MigrationView): string[] {
  const out: string[] = [];
  for (const step of m.steps) {
    if (step.op === "dropTable" && step.table) {
      out.push(`table ${step.table} (every row)`);
    } else if (step.op === "dropColumn" && step.table) {
      const [col] = columnsOf(step);
      out.push(col ? `column ${step.table}.${col}` : `a column of ${step.table}`);
    } else if (step.op === "alterColumnType" && step.table) {
      const [col] = columnsOf(step);
      out.push(
        col
          ? `values of ${step.table}.${col} that do not fit the new type`
          : `values in ${step.table} that do not fit the new type`,
      );
    }
  }
  return out;
}

/** Bare `SchemaTableView` → tinted (untouched) row; exported for tests and
 *  for a diagram rendered with no migration at all. */
export function untouched(t: SchemaTableView): TintedTable {
  return {
    module: t.module,
    name: t.name,
    schema: t.schema,
    tint: "untouched",
    columns: [...t.columns],
    changedColumns: [],
    refs: [...t.refs],
    ops: [],
  };
}

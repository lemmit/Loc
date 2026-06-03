import type { DataSourceIR, DeployableIR, StorageIR, SystemIR } from "../ir/types/loom-ir.js";
import { platformOwnsBackend } from "../language/validators/data/platform-rules.js";
import { lines } from "../util/code-builder.js";
import { snake } from "../util/naming.js";
import { isRelational } from "../util/source-types.js";

// ---------------------------------------------------------------------------
// `.loom/datasources.md` — a derived markdown view of how `dataSource`
// declarations route domain contexts to physical storage.
//
// The Phase B / C / D validators (`src/ir/validate/validate.ts` +
// `src/language/validators/datasource.ts`) catch errors against this
// graph; this artifact catches *intent drift* — a reviewer skimming
// a PR diff can see "before" vs. "after" of the resolved routing
// without crawling individual deployable / dataSource declarations.
//
// Two sections per system:
//
//   1. Per backend deployable, the (context → kind → storage)
//      triples it wires up.  Frontend-only deployables (react,
//      static) are skipped — they own no database.
//
//   2. Per storage, the deployables consuming it.  Catches "primary"
//      becoming a single point of accidental shared state when a new
//      deployable starts routing through it.
//
// Like every other `.loom/` artifact (`mermaid.ts`, `likec4.ts`,
// `wire-spec.ts`, …), this is a derived view, not a contract.  No
// DSL keyword controls it.
// ---------------------------------------------------------------------------

export function renderDataSourcesMd(sys: SystemIR): string {
  const dsByName = new Map<string, DataSourceIR>();
  for (const ds of sys.dataSources) dsByName.set(ds.name, ds);
  const storageByName = new Map<string, StorageIR>();
  for (const st of sys.storages) storageByName.set(st.name, st);

  const out: string[] = [];
  out.push(`# ${sys.name} — resource routing`);
  out.push("");
  out.push(
    "Derived view of how `resource` declarations route domain contexts to physical storage.",
  );
  out.push(
    "Authoritative source is the `.ddd` model; the validators (`src/ir/validate/validate.ts` +",
  );
  out.push(
    "`src/language/validators/datasource.ts`) enforce the rules — this is the at-a-glance picture.",
  );
  out.push("");

  const backends = sys.deployables.filter((d) => platformOwnsBackend(d.platform));

  // ---- Per-deployable section ----
  out.push("## Per deployable");
  out.push("");
  if (backends.length === 0) {
    out.push("_No backend deployables in this system._");
    out.push("");
  } else {
    for (const dep of backends) {
      out.push(`### ${dep.name} — \`platform: ${dep.platform}\``);
      out.push("");
      const rows = collectRows(dep, dsByName, storageByName);
      if (rows.length === 0) {
        out.push("_No dataSource bindings._");
      } else {
        out.push("| Context | Kind | Resource | Storage | Storage type | Schema | TablePrefix |");
        out.push("| --- | --- | --- | --- | --- | --- | --- |");
        for (const r of rows) {
          out.push(
            `| ${r.context} | ${r.kind} | ${r.dataSource} | ${r.storage} | ${r.storageType} | ${r.schema} | ${r.tablePrefix} |`,
          );
        }
      }
      out.push("");
    }
  }

  // ---- Per-storage section ----
  out.push("## Per storage");
  out.push("");
  if (sys.storages.length === 0) {
    out.push("_No `storage` declarations in this system._");
    out.push("");
  } else {
    out.push("| Storage | Type | Used by |");
    out.push("| --- | --- | --- |");
    for (const st of sys.storages) {
      const usages = collectStorageUsages(st, sys, dsByName);
      const cell = usages.length === 0 ? "_unused_" : usages.join("; ");
      out.push(`| ${st.name} | ${st.type} | ${cell} |`);
    }
    out.push("");
  }

  // ---- Unused dataSources ----
  const referenced = new Set<string>();
  for (const dep of backends) for (const n of dep.dataSourceNames ?? []) referenced.add(n);
  const unused = sys.dataSources.filter((ds) => !referenced.has(ds.name));
  if (unused.length > 0) {
    out.push("## Unused dataSources");
    out.push("");
    out.push(
      "Declared at system scope but not listed on any deployable — generates no routing config:",
    );
    out.push("");
    for (const ds of unused) {
      out.push(
        `- \`${ds.name}\` (for: ${ds.contextName}, kind: ${ds.kind}, use: ${ds.storageName})`,
      );
    }
    out.push("");
  }

  return lines(...out);
}

interface RoutingRow {
  context: string;
  kind: string;
  dataSource: string;
  storage: string;
  storageType: string;
  schema: string;
  tablePrefix: string;
}

function collectRows(
  dep: DeployableIR,
  dsByName: Map<string, DataSourceIR>,
  storageByName: Map<string, StorageIR>,
): RoutingRow[] {
  const rows: RoutingRow[] = [];
  for (const dsName of dep.dataSourceNames ?? []) {
    const ds = dsByName.get(dsName);
    if (!ds) continue;
    const st = storageByName.get(ds.storageName);
    rows.push({
      context: ds.contextName,
      kind: ds.kind,
      dataSource: ds.name,
      storage: ds.storageName,
      storageType: st?.type ?? "_unresolved_",
      schema: effectiveSchema(ds, st),
      tablePrefix: ds.tablePrefix ?? "—",
    });
  }
  // Stable order: by context, then kind — matches how authors think
  // about the routing graph (per-context first, kinds as a secondary
  // axis).
  rows.sort((a, b) => a.context.localeCompare(b.context) || a.kind.localeCompare(b.kind));
  return rows;
}

/** Effective Postgres schema as the emitters see it.  Mirrors
 *  `resolveDataSourceConfig` in `src/ir/util/resolve-datasource.ts` —
 *  explicit DSL value wins; otherwise relational stores default to
 *  `snake(contextName)`; non-relational stores have no schema concept
 *  and render as `n/a`. */
function effectiveSchema(ds: DataSourceIR, st: StorageIR | undefined): string {
  if (ds.schema != null) return ds.schema;
  if (st && isRelational(st.type)) return `${snake(ds.contextName)} _(default)_`;
  return "n/a";
}

function collectStorageUsages(
  st: StorageIR,
  sys: SystemIR,
  dsByName: Map<string, DataSourceIR>,
): string[] {
  const out: string[] = [];
  for (const dep of sys.deployables) {
    if (!platformOwnsBackend(dep.platform)) continue;
    for (const dsName of dep.dataSourceNames ?? []) {
      const ds = dsByName.get(dsName);
      if (!ds) continue;
      if (ds.storageName !== st.name) continue;
      out.push(`${dep.name} → ${ds.contextName} (${ds.kind})`);
    }
  }
  return out;
}

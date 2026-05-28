// DataSource declaration checks — kind ↔ storage.type compatibility
// and config-knob ↔ (kind, storage.type) compatibility.  See the
// DataSourceIR fields documented in `src/ir/types/loom-ir.ts`.
//
// Layering note: these are AST-layer (Langium-resolved cross-refs)
// because the storage cross-reference is already wired by the
// scope provider; no IR-level lookup is needed.

import type { ValidationAcceptor } from "langium";
import type { DataSource, Storage } from "../generated/ast.js";

// Compatibility matrix.  Aligned with the runtime adapters that exist
// today: relational stores back `state` / `snapshot` / `replica`;
// kv-style stores back `cache`; append-stores back `eventLog`.
const RELATIONAL = new Set(["postgres", "mysql", "sqlite", "inMemory"]);
const CACHE_STORES = new Set(["redis", "inMemory"]);
const APPEND_STORES = new Set(["postgres", "mysql", "sqlite", "inMemory", "kafka"]);

const KIND_STORAGE: Record<string, Set<string>> = {
  state: RELATIONAL,
  snapshot: RELATIONAL,
  replica: new Set(["postgres", "mysql", "sqlite"]),
  cache: CACHE_STORES,
  eventLog: APPEND_STORES,
};

/** Validate one DataSource declaration in place.  Emits diagnostics
 *  against the dataSource node itself; mismatch on a referenced
 *  storage points at the `use:` property so the squiggle is local. */
export function checkDataSource(ds: DataSource, accept: ValidationAcceptor): void {
  const kind = ds.kind;
  const storage = ds.use?.ref as Storage | undefined;

  // (1) kind ↔ storage.type compatibility — only when both are
  // present.  Missing-required-field diagnostics live elsewhere
  // (a separate "every dataSource needs for/kind/use" pass would
  // be a sibling slice; for now we soft-skip).
  if (kind && storage?.type) {
    const allowed = KIND_STORAGE[kind];
    if (allowed && !allowed.has(storage.type)) {
      const sorted = [...allowed].sort();
      accept(
        "error",
        `dataSource '${ds.name}' kind '${kind}' is incompatible with storage '${storage.name}' of type '${storage.type}'.  ` +
          `kind '${kind}' requires a storage of type ${formatList(sorted)}.`,
        { node: ds, property: "use" },
      );
    }
  }

  // (2) kind ↔ knob compatibility.
  if (ds.ttl != null && kind && kind !== "cache") {
    accept(
      "error",
      `dataSource '${ds.name}': 'ttl' is only meaningful on kind: cache.  Got kind: ${kind}.`,
      { node: ds, property: "ttl" },
    );
  }
  if (ds.every != null && kind && kind !== "eventLog" && kind !== "snapshot") {
    accept(
      "error",
      `dataSource '${ds.name}': 'every' is a snapshot-policy knob; valid on kind: eventLog or kind: snapshot.  Got kind: ${kind}.`,
      { node: ds, property: "every" },
    );
  }
  if (ds.retain != null && kind && kind !== "eventLog" && kind !== "snapshot") {
    accept(
      "error",
      `dataSource '${ds.name}': 'retain' is a snapshot-policy knob; valid on kind: eventLog or kind: snapshot.  Got kind: ${kind}.`,
      { node: ds, property: "retain" },
    );
  }
  if (ds.isolationLevel && kind === "cache") {
    accept(
      "error",
      `dataSource '${ds.name}': 'isolationLevel' is not meaningful on kind: cache (no transactional semantics).`,
      { node: ds, property: "isolationLevel" },
    );
  }

  // (3) storage.type ↔ knob compatibility — only enforced when
  // storage resolves; otherwise the cross-ref error already points
  // the user there.
  if (storage?.type) {
    if (ds.schema != null && !RELATIONAL.has(storage.type)) {
      accept(
        "error",
        `dataSource '${ds.name}': 'schema' is only meaningful on a relational storage (postgres / mysql / sqlite / inMemory).  Got '${storage.type}'.`,
        { node: ds, property: "schema" },
      );
    }
    if (ds.tablePrefix != null && !RELATIONAL.has(storage.type)) {
      accept(
        "error",
        `dataSource '${ds.name}': 'tablePrefix' is only meaningful on a relational storage (postgres / mysql / sqlite / inMemory).  Got '${storage.type}'.`,
        { node: ds, property: "tablePrefix" },
      );
    }
    if (ds.keyPrefix != null && !CACHE_STORES.has(storage.type)) {
      accept(
        "error",
        `dataSource '${ds.name}': 'keyPrefix' is only meaningful on a key-value storage (redis / inMemory).  Got '${storage.type}'.`,
        { node: ds, property: "keyPrefix" },
      );
    }
    if (ds.isolationLevel && !RELATIONAL.has(storage.type)) {
      accept(
        "error",
        `dataSource '${ds.name}': 'isolationLevel' is only meaningful on a relational storage (postgres / mysql / sqlite / inMemory).  Got '${storage.type}'.`,
        { node: ds, property: "isolationLevel" },
      );
    }
  }
}

function formatList(xs: readonly string[]): string {
  if (xs.length === 0) return "<none>";
  if (xs.length === 1) return xs[0];
  if (xs.length === 2) return `${xs[0]} or ${xs[1]}`;
  return `${xs.slice(0, -1).join(", ")}, or ${xs[xs.length - 1]}`;
}

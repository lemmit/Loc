// DataSource declaration checks — kind ↔ storage.type compatibility
// and config-knob ↔ (kind, storage.type) compatibility.  See the
// DataSourceIR fields documented in `src/ir/types/loom-ir.ts`.
//
// Layering note: these are AST-layer (Langium-resolved cross-refs)
// because the storage cross-reference is already wired by the
// scope provider; no IR-level lookup is needed.

import type { ValidationAcceptor } from "langium";
import {
  isCacheStore,
  isRelational,
  sourceTypesForSurfaceKind,
  supportsSurfaceKind,
} from "../../ir/source-types.js";
import type { DataSourceKind } from "../../ir/types/loom-ir.js";
import type { Resource, Storage } from "../generated/ast.js";

// Kind↔storage-type and knob↔storage-type compatibility is sourced from
// the platform-internal sourceType registry (`src/ir/source-types.ts`),
// the single source of truth.  This validator keeps the check at the AST
// layer so mismatches surface as in-editor squiggles on the offending
// node/property; it merely consults the registry instead of hardcoding
// the matrix.

/** Validate one DataSource declaration in place.  Emits diagnostics
 *  against the dataSource node itself; mismatch on a referenced
 *  storage points at the `use:` property so the squiggle is local. */
export function checkDataSource(ds: Resource, accept: ValidationAcceptor): void {
  const kind = ds.kind;
  const storage = ds.use?.ref as Storage | undefined;

  // (1) kind ↔ storage.type compatibility — only when both are
  // present.  Missing-required-field diagnostics live elsewhere
  // (a separate "every dataSource needs for/kind/use" pass would
  // be a sibling slice; for now we soft-skip).
  if (kind && storage?.type) {
    if (!supportsSurfaceKind(storage.type, kind as DataSourceKind)) {
      accept(
        "error",
        `resource '${ds.name}' kind '${kind}' is incompatible with storage '${storage.name}' of type '${storage.type}'.  ` +
          `kind '${kind}' requires a storage of type ${formatList(sourceTypesForSurfaceKind(kind as DataSourceKind))}.`,
        { node: ds, property: "use" },
      );
    }
  }

  // (2) kind ↔ knob compatibility.
  if (ds.ttl != null && kind && kind !== "cache") {
    accept(
      "error",
      `resource '${ds.name}': 'ttl' is only meaningful on kind: cache.  Got kind: ${kind}.`,
      { node: ds, property: "ttl" },
    );
  }
  if (ds.every != null && kind && kind !== "eventLog" && kind !== "snapshot") {
    accept(
      "error",
      `resource '${ds.name}': 'every' is a snapshot-policy knob; valid on kind: eventLog or kind: snapshot.  Got kind: ${kind}.`,
      { node: ds, property: "every" },
    );
  }
  if (ds.retain != null && kind && kind !== "eventLog" && kind !== "snapshot") {
    accept(
      "error",
      `resource '${ds.name}': 'retain' is a snapshot-policy knob; valid on kind: eventLog or kind: snapshot.  Got kind: ${kind}.`,
      { node: ds, property: "retain" },
    );
  }
  if (ds.isolationLevel && kind === "cache") {
    accept(
      "error",
      `resource '${ds.name}': 'isolationLevel' is not meaningful on kind: cache (no transactional semantics).`,
      { node: ds, property: "isolationLevel" },
    );
  }

  // (3) storage.type ↔ knob compatibility — only enforced when
  // storage resolves; otherwise the cross-ref error already points
  // the user there.
  if (storage?.type) {
    if (ds.schema != null && !isRelational(storage.type)) {
      accept(
        "error",
        `resource '${ds.name}': 'schema' is only meaningful on a relational storage (postgres / mysql / sqlite / inMemory).  Got '${storage.type}'.`,
        { node: ds, property: "schema" },
      );
    }
    if (ds.tablePrefix != null && !isRelational(storage.type)) {
      accept(
        "error",
        `resource '${ds.name}': 'tablePrefix' is only meaningful on a relational storage (postgres / mysql / sqlite / inMemory).  Got '${storage.type}'.`,
        { node: ds, property: "tablePrefix" },
      );
    }
    if (ds.keyPrefix != null && !isCacheStore(storage.type)) {
      accept(
        "error",
        `resource '${ds.name}': 'keyPrefix' is only meaningful on a key-value storage (redis / inMemory).  Got '${storage.type}'.`,
        { node: ds, property: "keyPrefix" },
      );
    }
    if (ds.isolationLevel && !isRelational(storage.type)) {
      accept(
        "error",
        `resource '${ds.name}': 'isolationLevel' is only meaningful on a relational storage (postgres / mysql / sqlite / inMemory).  Got '${storage.type}'.`,
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

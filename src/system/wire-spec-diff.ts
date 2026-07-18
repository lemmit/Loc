import { lines } from "../util/code-builder.js";
import type { WireSpecDoc } from "./wire-spec.js";

// ---------------------------------------------------------------------------
// Semantic wire-contract diff.
//
// A pure, browser-safe classifier over two `WireSpecDoc`s (the
// `<system>/.loom/wire-spec.json` artifact built by `wire-spec.ts`).  Where
// `git diff .loom/wire-spec.json` shows *that* the contract moved, this shows
// *whether the move breaks a consumer* — each change is tagged
// breaking / non-breaking under consumer-compatibility semantics, so the
// playground (and later the CLI) can surface contract drift without a human
// eyeballing a JSON diff.
//
// No `node:*` / `Date` / Langium imports — mirrors the pure-derivation status
// of its sibling artifact emitters (`wire-spec.ts`, `traceability.ts`), so it
// runs unchanged in the browser playground.
//
// Compatibility model (a *consumer* is any party that already reads or writes
// the shape — an emitted client, an older service, a stored payload):
//   BREAKING     — an existing consumer can be wrong after the change:
//                  removed entity / removed property / type change /
//                  optional→required tightening / a newly-required property
//                  (older producers omit it) / additionalProperties true→false.
//   NON-BREAKING — every existing consumer stays valid:
//                  new entity / new OPTIONAL property /
//                  required→optional relaxation / additionalProperties
//                  false→true.
// Conservative bias: anything ambiguous is reported `breaking: true` — over-
// warning is cheaper than a missed break.
// ---------------------------------------------------------------------------

/** A JSON-schema object entry (aggregate / part / value object) inside a
 *  `WireSpecDoc`.  Derived by indexed access so this module never has to
 *  re-declare (or force the export of) `wire-spec.ts`'s internal shapes. */
type SchemaObject = WireSpecDoc["aggregates"][string];
/** A single property schema inside a {@link SchemaObject}. */
type SchemaProperty = SchemaObject["properties"][string];

/** Which of the three top-level buckets an entity lives in. */
export type WireBucket = "aggregates" | "parts" | "valueObjects";

/** The classification of one semantic change to the wire contract. */
export type WireContractChangeKind =
  | "entity-removed"
  | "entity-added"
  | "property-removed"
  | "property-added-required"
  | "property-added-optional"
  | "property-made-required"
  | "property-made-optional"
  | "property-type-changed"
  | "additional-properties-restricted"
  | "additional-properties-relaxed";

/** One classified change between two wire specs. */
export interface WireContractChange {
  readonly kind: WireContractChangeKind;
  /** Whether an existing consumer can break because of this change. */
  readonly breaking: boolean;
  /** Which bucket the affected entity lives in. */
  readonly bucket: WireBucket;
  /** The (possibly context-qualified) entity key, e.g. `Order` or `Sales.Order`. */
  readonly entity: string;
  /** The affected property, when the change is property-scoped. */
  readonly field?: string;
  /** Human-readable one-line description of the change. */
  readonly detail: string;
  /** Prior rendering (type tag / boolean), when the change replaces a value. */
  readonly from?: string;
  /** New rendering (type tag / boolean), when the change replaces a value. */
  readonly to?: string;
}

/** The full classified diff between two wire specs. */
export interface WireContractDiff {
  readonly changes: WireContractChange[];
  /** True iff any change is `breaking`. */
  readonly breaking: boolean;
}

const BUCKETS: readonly WireBucket[] = ["aggregates", "parts", "valueObjects"];

/** Singular label for a bucket, for human-readable `detail` strings. */
function singular(bucket: WireBucket): string {
  switch (bucket) {
    case "aggregates":
      return "aggregate";
    case "parts":
      return "part";
    case "valueObjects":
      return "value object";
  }
}

/** Compact, stable rendering of a property's wire type, for `from`/`to`. */
export function renderPropType(p: SchemaProperty): string {
  if ("$ref" in p) return p.$ref;
  if (p.type === "array") return `array<${renderPropType(p.items)}>`;
  if ("format" in p && p.format) return `${p.type}(${p.format})`;
  return p.type;
}

/** Whether two property schemas are structurally identical.  The generator
 *  emits every property schema with a fixed key order (`jsonPropertyForType`),
 *  so a canonical `JSON.stringify` is an exact structural compare — the same
 *  signature technique `wire-spec.ts` uses for collision detection. */
function sameType(a: SchemaProperty, b: SchemaProperty): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** `additionalProperties` read as a plain boolean (the schema type pins it to
 *  `false` today, but the classifier stays correct if that ever widens). */
function additionalAllowed(o: SchemaObject): boolean {
  return o.additionalProperties as boolean;
}

/** Sorted union of the keys of two records — deterministic change ordering. */
function unionKeys(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
}

/** Classify every breaking / non-breaking change from `prev` to `next`. */
export function diffWireSpec(prev: WireSpecDoc, next: WireSpecDoc): WireContractDiff {
  const changes: WireContractChange[] = [];

  for (const bucket of BUCKETS) {
    const prevEntities = prev[bucket];
    const nextEntities = next[bucket];
    for (const entity of unionKeys(prevEntities, nextEntities)) {
      const before = prevEntities[entity];
      const after = nextEntities[entity];
      const label = singular(bucket);

      if (before && !after) {
        changes.push({
          kind: "entity-removed",
          breaking: true,
          bucket,
          entity,
          detail: `${label} '${entity}' removed from the wire contract`,
        });
        continue;
      }
      if (!before && after) {
        changes.push({
          kind: "entity-added",
          breaking: false,
          bucket,
          entity,
          detail: `${label} '${entity}' added`,
        });
        continue;
      }
      if (!before || !after) continue; // unreachable, narrows for TS

      diffEntity(bucket, entity, before, after, changes);
    }
  }

  return { changes, breaking: changes.some((c) => c.breaking) };
}

/** Classify property-level + `additionalProperties` changes for one entity
 *  present in both specs. */
function diffEntity(
  bucket: WireBucket,
  entity: string,
  before: SchemaObject,
  after: SchemaObject,
  out: WireContractChange[],
): void {
  const requiredBefore = new Set(before.required);
  const requiredAfter = new Set(after.required);

  for (const field of unionKeys(before.properties, after.properties)) {
    const pBefore = before.properties[field];
    const pAfter = after.properties[field];

    if (pBefore && !pAfter) {
      out.push({
        kind: "property-removed",
        breaking: true,
        bucket,
        entity,
        field,
        detail: `property '${field}' removed from ${entity}`,
        from: renderPropType(pBefore),
      });
      continue;
    }
    if (!pBefore && pAfter) {
      const req = requiredAfter.has(field);
      out.push({
        kind: req ? "property-added-required" : "property-added-optional",
        // A newly-required property breaks existing producers (they omit it).
        // A new optional property is backward-compatible.
        breaking: req,
        bucket,
        entity,
        field,
        detail: `${req ? "required" : "optional"} property '${field}' added to ${entity}`,
        to: renderPropType(pAfter),
      });
      continue;
    }
    if (!pBefore || !pAfter) continue; // unreachable, narrows for TS

    // Present in both — type change is unconditionally breaking (no widening
    // is modelled in the wire vocabulary, so any inequality is a break).
    if (!sameType(pBefore, pAfter)) {
      out.push({
        kind: "property-type-changed",
        breaking: true,
        bucket,
        entity,
        field,
        detail: `property '${field}' on ${entity} changed type`,
        from: renderPropType(pBefore),
        to: renderPropType(pAfter),
      });
    }

    // Optionality shift, independent of the type check above.
    const wasRequired = requiredBefore.has(field);
    const nowRequired = requiredAfter.has(field);
    if (!wasRequired && nowRequired) {
      out.push({
        kind: "property-made-required",
        breaking: true,
        bucket,
        entity,
        field,
        detail: `property '${field}' on ${entity} tightened from optional to required`,
        from: "optional",
        to: "required",
      });
    } else if (wasRequired && !nowRequired) {
      out.push({
        kind: "property-made-optional",
        breaking: false,
        bucket,
        entity,
        field,
        detail: `property '${field}' on ${entity} relaxed from required to optional`,
        from: "required",
        to: "optional",
      });
    }
  }

  const allowedBefore = additionalAllowed(before);
  const allowedAfter = additionalAllowed(after);
  if (allowedBefore && !allowedAfter) {
    out.push({
      kind: "additional-properties-restricted",
      breaking: true,
      bucket,
      entity,
      detail: `${entity} stopped allowing additional properties`,
      from: "true",
      to: "false",
    });
  } else if (!allowedBefore && allowedAfter) {
    out.push({
      kind: "additional-properties-relaxed",
      breaking: false,
      bucket,
      entity,
      detail: `${entity} now allows additional properties`,
      from: "false",
      to: "true",
    });
  }
}

/** Human-readable one-screen summary of a diff, built procedurally via
 *  `lines(...)` (no template engine) — pure, browser-safe. */
export function renderWireContractDiff(diff: WireContractDiff): string {
  if (diff.changes.length === 0) return "No wire-contract changes.\n";
  const breaking = diff.changes.filter((c) => c.breaking);
  const safe = diff.changes.filter((c) => !c.breaking);
  const bullet = (c: WireContractChange) => `  - ${c.detail}`;
  return lines(
    diff.breaking
      ? `BREAKING wire-contract changes (${breaking.length}):`
      : `Wire-contract changes (${diff.changes.length}, none breaking):`,
    breaking.length > 0 ? "Breaking:" : undefined,
    ...breaking.map(bullet),
    safe.length > 0 ? "Non-breaking:" : undefined,
    ...safe.map(bullet),
    "",
  );
}

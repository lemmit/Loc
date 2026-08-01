// `mergeContexts` must account for EVERY field of `BoundedContextIR` — either
// by carrying it, or by naming it in the deliberate-drop list below.
//
// Why this gate exists, concretely.  `mergeContexts` builds its result
// field-by-field, so a field added to `BoundedContextIR` later is simply ABSENT
// from the merged context, and every emitter handed that context reads
// `undefined` for it.  There is no type error: the return type is satisfied
// because the dropped fields happen to be optional, and a `Record<string,
// number> | undefined` reads perfectly well as "no overrides declared".
//
// That is not hypothetical.  `structuralErrorStatuses` and
// `errorStatusOverrides` were dropped for as long as they have existed, so
// `resolveErrorStatus(name, undefined)` fell to the stdlib default and EVERY
// `httpStatus <Error> -> <Code>` override silently no-opped on the merged path —
// while the same override moved the per-context emitters in the same generated
// app.  One backend disagreeing with itself.
//
// No cross-backend gate can catch that class: `conformance-parity` compares
// backends to each other and the M-T9.11 wire golden compares each backend to an
// oracle.  Neither compares a backend's own emitters to each other.  A
// completeness ratchet is the cheap structural answer — the same shape as
// `walker-stdlib-completeness` and `print-completeness`.
//
// Source-text scanning (rather than type reflection) because TS interfaces do
// not survive to runtime.  It is the same technique
// `diagnostic-codes-completeness.test.ts` uses, and it fails CLOSED: a field it
// cannot parse shows up as missing, not as covered.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));

/** Fields `mergeContexts` deliberately does NOT carry, each with the reason.
 *  Adding a name here is a decision to be reviewed, which is the point — the
 *  failure mode being guarded is a field that gets dropped without anyone
 *  deciding anything. */
const DELIBERATELY_DROPPED: Readonly<Record<string, string>> = {
  // A merged context is synthetic — it is several source contexts fused for one
  // deployable — so it has no single `.ddd` span to point at.  Carrying any one
  // member's origin would mis-attribute every diagnostic raised against the
  // merge.
  origin: "synthetic context has no single source span",

  // The `policy { … }` ladders are CONSUMED BY ENRICHMENT (applyPolicyReadLevels
  // / applyPolicyWriteLevels) into per-aggregate filters, which the merge does
  // carry, and read by the validator off the PER-CONTEXT IR.  Nothing
  // downstream of the merge reads them today — verified by grep over
  // src/generator/** and src/platform/**.
  //
  // This is luck rather than design, so it is written down: an emitter that
  // starts reading `merged.policyReadLevels` gets `undefined` and silently
  // applies NO policy, which on an authorization feature is the worst possible
  // direction to fail.  If that day comes, carry them instead of extending this
  // note.
  policyReadLevels: "consumed by enrichment before the merge; no post-merge reader",
  policyWriteLevels: "consumed by enrichment before the merge; no post-merge reader",
  policyDenies: "consumed by enrichment before the merge; no post-merge reader",
};

/** Field names declared on `BoundedContextIR`, read out of the IR source. */
function declaredFields(): string[] {
  const src = readFileSync(`${root}src/ir/types/loom-ir.ts`, "utf8");
  const start = src.indexOf("export interface BoundedContextIR");
  expect(start, "BoundedContextIR was renamed — this gate needs updating").toBeGreaterThan(-1);
  const body = src.slice(start, src.indexOf("\n}", start));
  // Top-level members only (exactly two leading spaces), so nested object-type
  // members don't masquerade as context fields.
  return [...body.matchAll(/^ {2}([a-zA-Z][a-zA-Z0-9]*)\??:/gm)].map((m) => m[1]!);
}

/** Field names `mergeContexts` assigns in its returned object literal. */
function carriedFields(): string[] {
  const src = readFileSync(`${root}src/ir/util/merge-contexts.ts`, "utf8");
  const start = src.indexOf("export function mergeContexts");
  expect(start, "mergeContexts was renamed — this gate needs updating").toBeGreaterThan(-1);
  const body = src.slice(start, src.indexOf("\n}", start));
  return [...body.matchAll(/^ {4}([a-zA-Z][a-zA-Z0-9]*):/gm)].map((m) => m[1]!);
}

describe("mergeContexts accounts for every BoundedContextIR field", () => {
  it("carries, or deliberately drops, every declared field", () => {
    const declared = declaredFields();
    const carried = new Set(carriedFields());
    expect(declared.length, "parsed no fields — the scan regex has drifted").toBeGreaterThan(10);

    const unaccounted = declared.filter((f) => !carried.has(f) && !(f in DELIBERATELY_DROPPED));
    expect(
      unaccounted,
      "field(s) silently dropped by mergeContexts — every emitter handed a merged " +
        "context reads `undefined` for these. Carry them, or add them to " +
        "DELIBERATELY_DROPPED with the reason.",
    ).toEqual([]);
  });

  it("the deliberate-drop list has no stale entries", () => {
    // The ratchet's other half: a name that is now carried, or no longer exists,
    // must leave the list — otherwise the list slowly becomes a place where
    // decisions go to be forgotten.
    const declared = new Set(declaredFields());
    const carried = new Set(carriedFields());
    const stale = Object.keys(DELIBERATELY_DROPPED).filter(
      (f) => !declared.has(f) || carried.has(f),
    );
    expect(stale, "DELIBERATELY_DROPPED names a field that is gone or now carried").toEqual([]);
  });

  it("the two error-status maps are carried — the regression that motivated this", () => {
    const carried = new Set(carriedFields());
    expect(carried.has("structuralErrorStatuses")).toBe(true);
    expect(carried.has("errorStatusOverrides")).toBe(true);
  });
});

// The IR has TWO merge boundaries, and both rebuild their result field by
// field rather than spreading it. Each must account for EVERY field of the type
// it returns — either by carrying it, or by naming it in that boundary's
// deliberate-drop list.
//
//   `mergeContexts`    EnrichedBoundedContextIR — several source contexts fused
//                      for one deployable
//   `mergeLoomModels`  RawLoomModel — every `.ddd` file in an import graph fused
//                      into one model
//
// (Every OTHER reconstruction site in the IR spreads: `enrichContext` returns
// `{...ctx, …}`, `enrichAggregate` `{...resolved, …}`, `enrichPart` /
// `enrichValueObject` likewise. A spread is structurally immune to this bug,
// which is why only these two are ratcheted.)
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

// ---------------------------------------------------------------------------
// The second boundary: the multi-file import-graph merge.
// ---------------------------------------------------------------------------
//
// `mergeLoomModels` folds every `.ddd` file's lowered model into one, and it is
// the SAME field-by-field rebuild — with one property that makes it a worse
// trap than `mergeContexts`:
//
//     if (models.length === 1) return models[0]!;
//
// A single-file model never enters the rebuild. Nearly every test in this repo
// is single-file, so a field dropped here stays green across the entire suite
// and fails only on a real multi-file project — the shape users actually write
// and the shape CI fixtures mostly don't.
//
// It is complete TODAY, and the one field it doesn't carry is correct not to:
// `traceability` is populated by `enrichLoomModel`, which runs AFTER the merge,
// so on a `RawLoomModel` it is absent by definition. That is exactly the kind of
// reasoning that should be pinned rather than re-derived — the next field added
// to `LoomModel` may well be populated during LOWERING, and then dropping it is
// silent data loss on every multi-file project.

/** Fields `mergeLoomModels` deliberately does NOT carry, each with the reason. */
const MODEL_DELIBERATELY_DROPPED: Readonly<Record<string, string>> = {
  // Derived by `enrichLoomModel` (phase ⑥), which runs after this merge (phase
  // ⑤). Absent on every `RawLoomModel` by construction, so there is nothing to
  // carry. If lowering ever populates it, carry it instead of extending this.
  traceability: "derived in enrichment, after this merge runs — absent on RawLoomModel",
};

function modelDeclaredFields(): string[] {
  const src = readFileSync(`${root}src/ir/types/loom-ir.ts`, "utf8");
  const start = src.indexOf("export interface LoomModel {");
  expect(start, "LoomModel was renamed — this gate needs updating").toBeGreaterThan(-1);
  const body = src.slice(start, src.indexOf("\n}", start));
  return [...body.matchAll(/^ {2}([a-zA-Z][a-zA-Z0-9]*)\??:/gm)].map((m) => m[1]!);
}

function modelCarriedFields(): string[] {
  const src = readFileSync(`${root}src/ir/lower/lower.ts`, "utf8");
  const start = src.indexOf("export function mergeLoomModels");
  expect(start, "mergeLoomModels was renamed — this gate needs updating").toBeGreaterThan(-1);
  const body = src.slice(start, src.indexOf("\n}", start));
  return [...body.matchAll(/^ {4}([a-zA-Z][a-zA-Z0-9]*):/gm)].map((m) => m[1]!);
}

describe("mergeLoomModels accounts for every LoomModel field", () => {
  it("carries, or deliberately drops, every declared field", () => {
    const declared = modelDeclaredFields();
    const carried = new Set(modelCarriedFields());
    expect(declared.length, "parsed no fields — the scan regex has drifted").toBeGreaterThan(10);

    const unaccounted = declared.filter(
      (f) => !carried.has(f) && !(f in MODEL_DELIBERATELY_DROPPED),
    );
    expect(
      unaccounted,
      "field(s) silently dropped by mergeLoomModels — a MULTI-FILE project loses " +
        "these entirely, while every single-file test stays green because of the " +
        "`models.length === 1` early return. Carry them, or add them to " +
        "MODEL_DELIBERATELY_DROPPED with the reason.",
    ).toEqual([]);
  });

  it("the deliberate-drop list has no stale entries", () => {
    const declared = new Set(modelDeclaredFields());
    const carried = new Set(modelCarriedFields());
    const stale = Object.keys(MODEL_DELIBERATELY_DROPPED).filter(
      (f) => !declared.has(f) || carried.has(f),
    );
    expect(stale, "MODEL_DELIBERATELY_DROPPED names a field that is gone or now carried").toEqual(
      [],
    );
  });

  it("the migration-intent lists are carried — the ones a multi-file project needs most", () => {
    // `rename` / `backfill` / raw-SQL intents are declared next to the aggregate
    // they evolve, which in a real project means a different file from the
    // system block. Dropping them would produce a migration chain that silently
    // omits the rename and then DESTROYS the column instead of renaming it —
    // the exact failure `migration-evolution-e2e` exists to catch, but only on
    // the multi-file shape it does not currently exercise.
    const carried = new Set(modelCarriedFields());
    for (const f of ["renameIntents", "tableRenameIntents", "backfillIntents", "sqlMigrationSteps"])
      expect(carried.has(f), `mergeLoomModels drops ${f}`).toBe(true);
  });
});

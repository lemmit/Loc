// The `Provenanced<T>` wire carrier's MEMBER NAMES (M-T6.12).
//
// A `provenanced` field ships its value and the lineage of the write that
// produced it as ONE wire object — `{ value: T, lineage: ProvLineage | null }`
// (docs/provenance.md, `docs/old/proposals/provenanced-wire-pair.md`).
//
// These two strings are read at FOUR pipeline layers, so they live in `src/util/`
// — the layer every consumer can reach without an upward import (CLAUDE.md,
// "a shared helper consumed across layers belongs at the layer its consumers
// live at"):
//
//   ② macros    — the scaffold detail page renders `<record>.<field>.value`
//                 as the figure and `…​.lineage` in the "?" disclosure.
//   ⑥ enrich    — `GENERIC_SHAPES.provenanced` builds the carrier's field list
//                 from them (`src/ir/stdlib/generics.ts`), which is what lands
//                 in `wireShape`.
//   ⑧ generate  — every backend DTO emitter and frontend api-type emitter reads
//                 them through `src/generator/_payload/provenanced-wire.ts`.
//   ⑨ compose   — `.loom/wire-spec.json` publishes them as the carrier's
//                 JSON-Schema properties.
//
// Spelling them once here is what makes "all targets agree on the provenanced
// representation" a structural fact rather than a convention eleven emitters
// each have to remember.

/** The carrier member holding the field's actual value. */
export const PROVENANCE_VALUE_FIELD = "value";

/** The carrier member holding the write's lineage — nullable, because a field
 *  that has never been written has no lineage yet. */
export const PROVENANCE_LINEAGE_FIELD = "lineage";

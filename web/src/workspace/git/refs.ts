// ---------------------------------------------------------------------------
// Shared constants + encoding for the generated-tree baseline.
//
// A leaf module (no imports) so both the low-level store
// (`git-store.ts`, whose `restoreCommit` has to re-baseline the ref) and
// the merge policy (`generated-tree.ts`, which reads/advances it) agree
// on the ref name AND the blob format without either importing the
// other.
// ---------------------------------------------------------------------------

/** Root under which generated output is written.  Disjoint from the
 *  `.ddd` sources (`/workspace/*.ddd`) and custom packs
 *  (`/workspace/design/`), so generated paths never collide. */
export const GENERATED_PREFIX = "/workspace/generated/";

/** The ref the generated-tree merge stores the last generated output
 *  behind (as a JSON blob) — the base for the per-file 3-way merge in
 *  `generated-tree.ts`. */
export const GENERATED_BASE_REF = "refs/loom/generated-base";

/** Project-relative path → content, as the base blob stores it. */
export type GeneratedBaseMap = Record<string, string>;

export function encodeGeneratedBase(map: GeneratedBaseMap): string {
  return JSON.stringify(map);
}

export function decodeGeneratedBase(text: string): GeneratedBaseMap {
  return JSON.parse(text) as GeneratedBaseMap;
}

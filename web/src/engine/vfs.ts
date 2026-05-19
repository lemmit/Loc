// RestorableVfs lives with the Vfs contract it extends (vfs/types).
// Re-exported here so the engine barrel stays the single import
// surface for the seam types.  The tab-suspension fix (P4) uses it:
// on resume, replay the persisted snapshot instead of cold-booting.
export type { RestorableVfs } from "../vfs/types.js";

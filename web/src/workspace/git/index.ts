// ---------------------------------------------------------------------------
// Public surface of the git-backed store module.  Consumers (PR 2+)
// import from here, not from the individual files.
// ---------------------------------------------------------------------------

export { openGitFs, DEFAULT_GIT_DB, REPO_DIR, GITDIR, type GitFs } from "./git-fs.js";
export {
  GitStore,
  normalizePath,
  LOOM_AUTHOR,
  type GitAuthor,
  type ListOpts,
  type CommitInfo,
  type CommitFileChange,
} from "./git-store.js";
export { startAutoCommit, type AutoCommitOptions } from "./auto-commit.js";
export { commitOnSave, GENERATED_BASE_REF } from "./helpers.js";
export {
  applyGeneratedTree,
  readGeneratedTree,
  GENERATED_PREFIX,
  type GeneratedFile,
  type RegenerateResult,
} from "./generated-tree.js";

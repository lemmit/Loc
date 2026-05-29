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
  type FileDiff,
  type MergeOutcome,
  type CommitInfo,
} from "./git-store.js";
export {
  commitOnSave,
  regenerateMerge,
  diffForDisplay,
  GENERATED_BASE_REF,
} from "./helpers.js";

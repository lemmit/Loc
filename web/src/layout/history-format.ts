// ---------------------------------------------------------------------------
// Pure formatting helpers for the History view — extracted so they're
// unit-testable without rendering React.
// ---------------------------------------------------------------------------

/** Coarse classification of a workspace commit by its message.  The git
 *  store writes `autosave workspace` (debounced edits), `regenerate`
 *  (intentional generate), and `import legacy workspace` (first boot);
 *  everything that isn't an autosave is a user-meaningful "milestone". */
export type CommitKind = "milestone" | "autosave";

export function classifyCommit(message: string): CommitKind {
  return message.trim().toLowerCase().startsWith("autosave") ? "autosave" : "milestone";
}

/** Short, human relative time from a commit's epoch-**seconds** timestamp.
 *  `now` is injectable for testing. */
export function formatRelativeTime(epochSeconds: number, now: number = Date.now()): string {
  const delta = Math.max(0, Math.floor(now / 1000 - epochSeconds));
  if (delta < 5) return "just now";
  if (delta < 60) return `${delta}s ago`;
  const min = Math.floor(delta / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days < 7) return `${days}d ago`;
  return `${Math.floor(days / 7)}w ago`;
}

/** First 7 chars of a commit oid — the conventional short hash. */
export function shortOid(oid: string): string {
  return oid.slice(0, 7);
}

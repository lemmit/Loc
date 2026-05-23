// ---------------------------------------------------------------------------
// New-file-name validation for the SourceFileTabs UI.  Lives in a
// `.ts` file (not `.tsx`) so the root vitest can import it directly
// without dragging in React's JSX runtime.
// ---------------------------------------------------------------------------

const WORKSPACE_PREFIX = "/workspace/";

/** Normalise a user-typed basename into a full workspace path.
 *  Accepts `orders`, `orders.ddd`, `shared/money`, `shared/money.ddd`.
 *  Strips leading slashes; appends `.ddd` if missing. */
export function normaliseNewFilePath(basename: string): string {
  const trimmed = basename.trim().replace(/^\/+/, "");
  const withExt = trimmed.endsWith(".ddd") ? trimmed : `${trimmed}.ddd`;
  return `${WORKSPACE_PREFIX}${withExt}`;
}

/** Validate a user-typed basename.  Returns an error message when
 *  the input is rejected, otherwise undefined. */
export function validateNewFileBasename(
  basename: string,
  existing: ReadonlySet<string>,
): string | undefined {
  const trimmed = basename.trim();
  if (trimmed === "") return "Name is required.";
  // Allow letters, digits, dash, underscore, dot, and a single
  // forward slash (for one level of nesting).  Reject anything
  // else so users can't paste `../etc/passwd` or whitespace.
  if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)?$/.test(trimmed)) {
    return "Use letters, digits, dash, underscore, dot (one optional `/`).";
  }
  const fullPath = normaliseNewFilePath(trimmed);
  if (existing.has(fullPath)) return "A file with that name already exists.";
  return undefined;
}

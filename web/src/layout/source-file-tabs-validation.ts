// ---------------------------------------------------------------------------
// New-file / new-folder name validation for the SourceFileTabs and
// SourceFilesTree UIs.  Lives in a `.ts` file (not `.tsx`) so the
// root vitest can import it directly without dragging in React's
// JSX runtime.
//
// The VFS has no concept of an empty directory — folders exist only
// implicitly via path segments.  "Create folder" therefore means
// "create a file inside a new folder"; we seed an `untitled.ddd`
// placeholder so the folder shows up immediately and the user has
// something to start editing.  Disambiguation against existing
// paths (`untitled.ddd` → `untitled-2.ddd` → …) is handled here so
// both pickers share the same naming rule.
// ---------------------------------------------------------------------------

const WORKSPACE_PREFIX = "/workspace/";
const FOLDER_PLACEHOLDER = "untitled";

/** Normalise a user-typed basename into a full workspace path.
 *  Accepts `orders`, `orders.ddd`, `shared/money`, `shared/money.ddd`.
 *  Strips leading slashes; appends `.ddd` if missing. */
export function normaliseNewFilePath(basename: string): string {
  const trimmed = basename.trim().replace(/^\/+/, "");
  const withExt = trimmed.endsWith(".ddd") ? trimmed : `${trimmed}.ddd`;
  return `${WORKSPACE_PREFIX}${withExt}`;
}

/** Validate a user-typed file basename.  Returns an error message
 *  when the input is rejected, otherwise undefined. */
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

/** Validate a user-typed folder name.  Folders are a single path
 *  segment — no nesting in the create UI (a user that wants
 *  `a/b/c` can create the folders one level at a time). */
export function validateNewFolderName(
  name: string,
  existing: ReadonlySet<string>,
): string | undefined {
  const trimmed = name.trim().replace(/\/+$/, "");
  if (trimmed === "") return "Folder name is required.";
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) {
    return "Use letters, digits, dash, underscore, dot.  No slashes.";
  }
  // "Folder exists" check — any existing path whose first segment
  // matches `trimmed` means the folder is already there.  We allow
  // creating a new file inside an existing folder via the file
  // form; the folder form is for net-new folders.
  const existingFirstSegments = new Set<string>();
  for (const p of existing) {
    if (!p.startsWith(WORKSPACE_PREFIX)) continue;
    const rest = p.slice(WORKSPACE_PREFIX.length);
    const slash = rest.indexOf("/");
    if (slash > 0) existingFirstSegments.add(rest.slice(0, slash));
  }
  if (existingFirstSegments.has(trimmed)) {
    return `Folder "${trimmed}" already exists — add a file inside via "+ New file".`;
  }
  return undefined;
}

/** Build the full workspace path for the seed file dropped into a
 *  newly-created folder.  Defaults to `<folder>/untitled.ddd`;
 *  disambiguates against `existing` so two folder creations in a
 *  row don't collide (`untitled-2.ddd`, `untitled-3.ddd`, …).
 *  Returned path is always under `/workspace/<folder>/`. */
export function newFolderSeedPath(
  folderName: string,
  existing: ReadonlySet<string>,
): string {
  const folder = folderName.trim().replace(/\/+$/, "").replace(/^\/+/, "");
  const folderPrefix = `${WORKSPACE_PREFIX}${folder}/`;
  // Walk `untitled`, `untitled-2`, … until we find a name nobody
  // claims.  The first iteration almost always wins; the loop is a
  // safety net for the unlikely double-tap case.
  for (let n = 1; n < 1000; n++) {
    const suffix = n === 1 ? "" : `-${n}`;
    const candidate = `${folderPrefix}${FOLDER_PLACEHOLDER}${suffix}.ddd`;
    if (!existing.has(candidate)) return candidate;
  }
  // Pathological fallback — should never trigger at playground scale.
  return `${folderPrefix}${FOLDER_PLACEHOLDER}-${Date.now()}.ddd`;
}

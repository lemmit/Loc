// ---------------------------------------------------------------------------
// Pack-folder picker — framework-agnostic.
//
// Reads a user-chosen directory (a custom design pack) from the
// local disk and returns its files as a `name -> content` map ready
// to be written into the VFS at `/workspace/design/<name>/...`.
//
// Two code paths share the same return shape:
//   - File System Access API (`showDirectoryPicker`) — modern Chrome/
//     Edge.  Lets us walk the directory recursively via
//     `FileSystemDirectoryHandle.entries`.
//   - `<input type="file" webkitdirectory>` — broader compatibility
//     (Safari, Firefox).  The browser presents a directory chooser
//     and yields a flat `FileList` whose entries carry
//     `webkitRelativePath` like `<packname>/<file>`.
//
// Both flows produce the same `PickedPack` shape; the React picker
// component picks whichever path is available at runtime.
// ---------------------------------------------------------------------------

/** Sequence of `[relative-path, content]` pairs for a single
 *  picked pack.  Paths use POSIX `/` separators relative to the
 *  pack root (so `pack.json`, `page-list.hbs`, `cells/cell-id.hbs`).
 *  Content is text — Phase 4 packs are all `.json` and `.hbs`,
 *  both UTF-8.  Binary assets (images, fonts) come later. */
export interface PickedPack {
  /** Pack name — derived from the chosen directory's basename.
   *  Used to namespace files under `/workspace/design/<name>/...`
   *  in the VFS. */
  name: string;
  files: ReadonlyArray<readonly [string, string]>;
}

/** True iff the browser supports `window.showDirectoryPicker`. */
export function supportsDirectoryPicker(): boolean {
  return typeof window !== "undefined" && "showDirectoryPicker" in window;
}

/** Pick a directory using the File System Access API.  Returns null
 *  when the user cancels (the API throws `AbortError` for cancel,
 *  which we catch and surface as null). */
export async function pickPackViaFSAccess(): Promise<PickedPack | null> {
  type DirHandle = {
    name: string;
    entries(): AsyncIterable<[string, FileHandleAny]>;
  };
  type FileHandle = {
    kind: "file";
    getFile(): Promise<File>;
  };
  type DirEntry = { kind: "directory" } & DirHandle;
  type FileHandleAny = FileHandle | DirEntry;

  const w = window as unknown as {
    showDirectoryPicker?: () => Promise<DirHandle>;
  };
  if (!w.showDirectoryPicker) {
    throw new Error("showDirectoryPicker not available — use the fallback picker.");
  }
  let root: DirHandle;
  try {
    root = await w.showDirectoryPicker();
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") return null;
    throw err;
  }
  const files: Array<[string, string]> = [];
  await walkFsAccess(root, "", files);
  return { name: root.name, files };

  async function walkFsAccess(
    dir: DirHandle,
    prefix: string,
    out: Array<[string, string]>,
  ): Promise<void> {
    for await (const [name, handle] of dir.entries()) {
      const rel = prefix ? `${prefix}/${name}` : name;
      if (handle.kind === "file") {
        const file = await handle.getFile();
        out.push([rel, await file.text()]);
      } else {
        await walkFsAccess(handle, rel, out);
      }
    }
  }
}

/** Read a `FileList` produced by an `<input type=file webkitdirectory>`.
 *  Each `File` carries `webkitRelativePath` like `<root>/<rest>`;
 *  the pack name is the leading segment shared by every entry
 *  (browsers always include it).  Empty FileList → null (user
 *  cancelled the dialog). */
export async function pickPackFromFileList(
  list: FileList | null,
): Promise<PickedPack | null> {
  if (!list || list.length === 0) return null;
  const first = list[0] as File & { webkitRelativePath?: string };
  const firstPath = first.webkitRelativePath ?? "";
  const slash = firstPath.indexOf("/");
  if (slash < 0) {
    throw new Error(
      "pack-picker: file has no webkitRelativePath — the picker needs `webkitdirectory` support.",
    );
  }
  const name = firstPath.slice(0, slash);
  const files: Array<[string, string]> = [];
  for (let i = 0; i < list.length; i++) {
    const f = list[i] as File & { webkitRelativePath?: string };
    const fp = f.webkitRelativePath ?? "";
    if (!fp.startsWith(name + "/")) {
      throw new Error(
        `pack-picker: file outside chosen directory: "${fp}".  All files must live under "${name}/".`,
      );
    }
    const rel = fp.slice(name.length + 1);
    files.push([rel, await f.text()]);
  }
  return { name, files };
}

/** Validate that a picked directory looks like a Loom pack.
 *  Currently checks for the presence of `pack.json` at the root —
 *  the loader will surface every other manifest issue (missing
 *  `emits` map, undeclared template files, …) when generation
 *  runs.  Throws on failure so callers can surface a friendly
 *  error to the user. */
export function validatePickedPack(pack: PickedPack): void {
  if (pack.name.length === 0) {
    throw new Error("pack-picker: chosen directory has no name.");
  }
  // Reserved built-in names — `loader-vfs.resolvePackDir` resolves
  // them to /themes/<name> regardless of what's in /workspace, so
  // a user pack with a built-in name would silently never be used.
  if (pack.name === "mantine" || pack.name === "shadcn") {
    throw new Error(
      `pack-picker: "${pack.name}" is a built-in pack name; pick a different folder name.`,
    );
  }
  const hasManifest = pack.files.some(([p]) => p === "pack.json");
  if (!hasManifest) {
    throw new Error(
      `pack-picker: no pack.json in "${pack.name}".  A Loom design pack must contain a pack.json manifest at its root.`,
    );
  }
}

/** Translate a picked pack into VFS entries ready for `vfs.write`.
 *  Namespaces under `/workspace/design/<packname>/` so the loader's
 *  default reference dir (`/workspace`) resolves
 *  `design: "./design/<packname>"` correctly. */
export function packToVfsEntries(pack: PickedPack): Array<{ path: string; content: string }> {
  return pack.files.map(([rel, content]) => ({
    path: `/workspace/design/${pack.name}/${rel}`,
    content,
  }));
}

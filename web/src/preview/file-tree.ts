import type { VirtualFile } from "../build/protocol.js";

// A flat list of virtual files folded into a directory tree for
// rendering.  Path separators are always "/" — the generators emit
// forward-slashes, and the CLI's path normalisation is the only
// place that converts to platform separators.
export interface TreeFolder {
  kind: "folder";
  name: string;
  path: string;
  children: TreeNode[];
}

export interface TreeFile {
  kind: "file";
  name: string;
  path: string;
  size: number;
}

export type TreeNode = TreeFolder | TreeFile;

export function buildTree(files: VirtualFile[]): TreeFolder {
  const root: TreeFolder = { kind: "folder", name: "", path: "", children: [] };
  for (const f of files) {
    insert(root, f.path.split("/"), f, 0);
  }
  sortFolder(root);
  return root;
}

function insert(folder: TreeFolder, parts: string[], file: VirtualFile, depth: number): void {
  const name = parts[depth];
  const isLeaf = depth === parts.length - 1;
  if (isLeaf) {
    folder.children.push({
      kind: "file",
      name,
      path: file.path,
      size: file.size,
    });
    return;
  }
  let sub = folder.children.find((c): c is TreeFolder => c.kind === "folder" && c.name === name);
  if (!sub) {
    const childPath = folder.path ? `${folder.path}/${name}` : name;
    sub = { kind: "folder", name, path: childPath, children: [] };
    folder.children.push(sub);
  }
  insert(sub, parts, file, depth + 1);
}

function sortFolder(folder: TreeFolder): void {
  folder.children.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const c of folder.children) {
    if (c.kind === "folder") sortFolder(c);
  }
}

export function languageFromPath(path: string): string {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return "plaintext";
  const ext = path.slice(dot + 1).toLowerCase();
  switch (ext) {
    case "ts":
    case "tsx":
      return "typescript";
    case "js":
    case "jsx":
      return "javascript";
    case "json":
      return "json";
    case "yml":
    case "yaml":
      return "yaml";
    case "md":
      return "markdown";
    case "sql":
      return "sql";
    case "cs":
      return "csharp";
    case "html":
      return "html";
    case "css":
      return "css";
    default:
      return "plaintext";
  }
}

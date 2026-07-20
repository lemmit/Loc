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

// Map a generated file's path onto a Monaco/VS Code language id.  The ids must
// match a grammar registered in `loom-services.ts` (the codingame editor-api
// build has no built-in language modes), otherwise the file falls back to
// untokenized plaintext.  Some names are matched whole (`Dockerfile`,
// `.gitignore`) since they have no meaningful extension.
export function languageFromPath(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const lower = base.toLowerCase();
  // Extension-less / whole-name files.
  if (lower === "dockerfile" || lower.startsWith("dockerfile.")) return "dockerfile";
  if (lower === ".env" || lower.startsWith(".env.")) return "ini";
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return "plaintext";
  const ext = lower.slice(dot + 1);
  switch (ext) {
    case "ts":
    case "tsx":
    case "mts":
    case "cts":
      return "typescript";
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "javascript";
    case "json":
    case "jsonc":
      return "json";
    case "yml":
    case "yaml":
      return "yaml";
    case "md":
    case "markdown":
      return "markdown";
    case "sql":
      return "sql";
    case "cs":
      return "csharp";
    case "html":
    case "htm":
      return "html";
    case "css":
      return "css";
    case "scss":
      return "scss";
    case "less":
      return "less";
    case "py":
      return "python";
    case "java":
      return "java";
    case "fs":
    case "fsx":
      return "fsharp";
    case "dart":
      return "dart";
    case "xml":
    case "csproj":
    case "fsproj":
    case "props":
    case "targets":
      return "xml";
    case "gradle":
      return "groovy";
    case "sh":
    case "bash":
      return "shellscript";
    case "ini":
    case "toml":
    case "env":
    case "properties":
    case "conf":
      return "ini";
    default:
      return "plaintext";
  }
}

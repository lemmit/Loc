import { useEffect, useState } from "react";
import { buildTree, type TreeNode } from "../preview/file-tree";
import type { GitStore } from "./git/index.js";

const WORKSPACE_PREFIX = "/workspace/";

// "User code" tree — the editable contents of the workspace store
// (main.ddd plus any imported design packs under design/<pack>/...),
// projected into the same TreeNode shape the generated-output tree
// uses so the Explorer can render either with one component.
//
// Rebuilds on every store mutation under /workspace/ so autosaves and
// pack imports/deletes show up without a manual refresh.  Reads are
// async (git-backed), so the tree lands in state rather than being
// computed inline.
export function useWorkspaceFiles(store: GitStore | null): TreeNode[] {
  const [nodes, setNodes] = useState<TreeNode[]>([]);

  useEffect(() => {
    if (!store) {
      setNodes([]);
      return;
    }
    let cancelled = false;
    const rebuild = (): void => {
      void (async () => {
        const paths = await store.list(WORKSPACE_PREFIX);
        const files: Array<{ path: string; content: string; size: number }> = [];
        for (const full of paths) {
          const content = await store.readFile(full);
          if (content == null) continue;
          files.push({
            path: full.slice(WORKSPACE_PREFIX.length),
            content,
            size: content.length,
          });
        }
        if (!cancelled) setNodes(buildTree(files).children);
      })();
    };
    rebuild();
    const unsubscribe = store.subscribe(WORKSPACE_PREFIX, rebuild);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [store]);

  return nodes;
}

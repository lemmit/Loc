import { useEffect, useMemo, useState } from "react";
import { buildTree, type TreeNode } from "../preview/file-tree";
import type { IdbVfs } from "../vfs/idb-vfs.js";

const WORKSPACE_PREFIX = "/workspace/";

// "User code" tree — the editable contents of the workspace VFS
// (main.ddd plus any imported design packs under design/<pack>/...),
// projected into the same TreeNode shape the generated-output tree
// uses so the Explorer can render either with one component.
//
// Re-derives on every VFS mutation under /workspace/ so autosaves and
// pack imports/deletes show up without a manual refresh.
export function useWorkspaceFiles(vfs: IdbVfs | null): TreeNode[] {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!vfs) return;
    return vfs.subscribe(WORKSPACE_PREFIX, () => setTick((t) => t + 1));
  }, [vfs]);

  return useMemo(() => {
    if (!vfs) return [];
    const files = vfs.list(WORKSPACE_PREFIX).flatMap((full) => {
      const content = vfs.read(full);
      if (content == null) return [];
      return [{ path: full.slice(WORKSPACE_PREFIX.length), content, size: content.length }];
    });
    return buildTree(files).children;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vfs, tick]);
}

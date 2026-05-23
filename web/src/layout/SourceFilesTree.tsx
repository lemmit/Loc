// ---------------------------------------------------------------------------
// `SourceFilesTree` — accordion-style file picker for the mobile
// editor.  Mirrors the FilesPane mobile pattern (closed `<details>`
// summary above the editor) so the source-files picker and the
// generated-files picker feel like the same thing.  The tree itself
// reuses `preview/FileTree.tsx` — same chevrons, indents, touch
// targets, hover/pressed states — with delete buttons threaded in
// via the new `rowActions` slot.
//
// Visual model (collapsed):
//
//   ▸ Files (3)                                       [+]
//
// Visual model (expanded):
//
//   ▾ Files (3)                                       [+]
//   ─────────────────────────────────────────────────────
//   ▾ main.ddd                                          ·
//   ▾ shared/
//       ▸ money.ddd                                     ×
//       ▸ currency.ddd                                  ×
//
// Closed by default so the editor gets the screen real estate; the
// summary always shows the file count + Add button so the
// affordance is discoverable even when the tree is collapsed.
// ---------------------------------------------------------------------------

import { useCallback, useMemo, useRef, useState } from "react";
import { ActionIcon, Box, Button, Group, Stack, TextInput, Tooltip } from "@mantine/core";
import { buildTree, type TreeFolder } from "../preview/file-tree";
import { FileTree } from "../preview/FileTree";
import { DEFAULT_PATH } from "../workspace/workspace-sources";
import {
  normaliseNewFilePath,
  validateNewFileBasename,
} from "./source-file-tabs-validation";

const WORKSPACE_PREFIX = "/workspace/";

export interface SourceFilesTreeProps {
  /** Every `.ddd` source under `/workspace/`, from the workspace-
   *  sources controller. */
  files: ReadonlyMap<string, string>;
  /** The currently-active file's workspace path. */
  activePath: string;
  /** Switch which file the editor shows. */
  onSelect: (path: string) => void;
  /** Create a new `/workspace/<basename>.ddd`. */
  onCreate: (path: string) => void;
  /** Delete a file from the VFS.  Tree never calls this for
   *  `main.ddd` (the delete button isn't rendered there). */
  onDelete: (path: string) => void;
}

/** Build a tree of workspace-relative paths suitable for `FileTree`.
 *  Reuses `buildTree`; the path scheme is identical (POSIX, `/`-
 *  separated). */
function workspaceTree(
  files: ReadonlyMap<string, string>,
  activePath: string,
): TreeFolder {
  // Drop the `/workspace/` prefix so the top level reads `main.ddd`
  // / `shared/...` instead of a useless `workspace` root folder.
  // Synthesise the VirtualFile shape `buildTree` consumes; content /
  // size are unused by the tree renderer.
  const virtual = [...files.keys()].map((p) => ({
    path: p.startsWith(WORKSPACE_PREFIX) ? p.slice(WORKSPACE_PREFIX.length) : p,
    content: "",
    size: 0,
  }));
  // Ensure the active path always has a row even when it isn't in
  // the VFS yet (first edit of main.ddd before the VFS write lands)
  // — otherwise the user types into a "phantom" row.
  const activeRel = activePath.startsWith(WORKSPACE_PREFIX)
    ? activePath.slice(WORKSPACE_PREFIX.length)
    : activePath;
  if (!virtual.some((v) => v.path === activeRel)) {
    virtual.push({ path: activeRel, content: "", size: 0 });
  }
  return buildTree(virtual);
}

export function SourceFilesTree(props: SourceFilesTreeProps): JSX.Element {
  const root = useMemo(
    () => workspaceTree(props.files, props.activePath),
    [props.files, props.activePath],
  );
  const detailsRef = useRef<HTMLDetailsElement | null>(null);

  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState("");
  const existingPaths = new Set(props.files.keys());
  const draftError = creating ? validateNewFileBasename(draft, existingPaths) : undefined;

  const startCreate = useCallback(() => {
    setDraft("");
    setCreating(true);
    // Tapping "+" should also expand the accordion so the user can
    // see the new file appear at the right place in the tree.
    if (detailsRef.current) detailsRef.current.open = true;
  }, []);
  const cancelCreate = useCallback(() => {
    setCreating(false);
    setDraft("");
  }, []);
  const submitCreate = useCallback(() => {
    if (draftError || draft.trim() === "") return;
    props.onCreate(normaliseNewFilePath(draft));
    setCreating(false);
    setDraft("");
  }, [draft, draftError, props]);

  const activeRelPath = props.activePath.startsWith(WORKSPACE_PREFIX)
    ? props.activePath.slice(WORKSPACE_PREFIX.length)
    : props.activePath;

  // Per-row delete button injected via the FileTree's actions slot.
  // Hides for the workspace's default entry path (main.ddd) — the
  // generator's entry assumes it, so the tab strip and tree both
  // refuse to delete it.
  const rowActions = useCallback(
    (relPath: string) => {
      const fullPath = `${WORKSPACE_PREFIX}${relPath}`;
      if (fullPath === DEFAULT_PATH) return null;
      return (
        <Tooltip label="Delete file" withArrow openDelay={400}>
          <ActionIcon
            size="sm"
            variant="subtle"
            color="gray"
            aria-label={`Delete ${relPath}`}
            onClick={() => props.onDelete(fullPath)}
          >
            ×
          </ActionIcon>
        </Tooltip>
      );
    },
    [props.onDelete],
  );

  return (
    <Box
      component="details"
      ref={detailsRef as React.Ref<HTMLDetailsElement>}
      data-testid="source-files-tree"
      style={{
        borderBottom: "1px solid var(--mantine-color-dark-4)",
        background: "var(--mantine-color-dark-7)",
        flexShrink: 0,
      }}
    >
      <Box
        component="summary"
        px="sm"
        py={10}
        style={{
          cursor: "pointer",
          fontSize: 14,
          fontWeight: 600,
          color: "var(--mantine-color-dimmed)",
          userSelect: "none",
          minHeight: 44,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        {/* Native `<summary>` swallows arbitrary clicks as "toggle";
            wrap the label in a span so the "+" button (which calls
            preventDefault / stopPropagation) doesn't collapse the
            details when tapped.  File count mirrors the FilesPane
            summary so the two pickers read consistently. */}
        <span>Files ({props.files.size || 1})</span>
        <Tooltip label="Add a new .ddd file" withArrow openDelay={400}>
          <ActionIcon
            component="span"
            size="md"
            variant="subtle"
            color="gray"
            aria-label="Add a new .ddd file"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              startCreate();
            }}
          >
            +
          </ActionIcon>
        </Tooltip>
      </Box>
      <Box style={{ maxHeight: 240, overflow: "auto" }}>
        {creating && (
          <Box px="sm" py={6}>
            <Stack gap={4}>
              <TextInput
                size="sm"
                autoFocus
                placeholder="new-file or sub/dir/name"
                value={draft}
                error={draftError}
                onChange={(e) => setDraft(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitCreate();
                  else if (e.key === "Escape") cancelCreate();
                }}
              />
              <Group gap={6} wrap="nowrap">
                <Button
                  size="xs"
                  variant="default"
                  onClick={submitCreate}
                  disabled={!!draftError}
                >
                  Add
                </Button>
                <Button size="xs" variant="subtle" color="gray" onClick={cancelCreate}>
                  Cancel
                </Button>
              </Group>
            </Stack>
          </Box>
        )}
        <FileTree
          root={root}
          selectedPath={activeRelPath}
          onSelect={(rel) => {
            props.onSelect(`${WORKSPACE_PREFIX}${rel}`);
            // Auto-close after a pick so the editor reclaims the
            // viewport, matching the FilesPane mobile pattern.
            if (detailsRef.current) detailsRef.current.open = false;
          }}
          rowActions={rowActions}
        />
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// `SourceFilesTree` — vertical tree view of every `.ddd` file under
// `/workspace/`.  Mobile counterpart to `SourceFileTabs` — the
// horizontal tabs strip works well on a wide viewport but is hard
// to scan with a thumb when more than two files exist.  The tree is
// always-expanded for simplicity (nesting in `.ddd` source rarely
// runs more than one level deep — `shared/foo.ddd`).
//
// Visual model:
//   Files                                         [+]
//   ─────────────────────────────────────────────────
//   ▸ main.ddd                                      ×
//   ▸ shared/
//       money.ddd                                   ×
//       currency.ddd                                ×
//
// Click a file row to activate; the editor below remounts against
// the new model (matches the tabs strip's behaviour).  The `+`
// button opens an inline name input identical to the tabs strip
// (validation lives in `source-file-tabs-validation.ts`).
// `main.ddd` is non-deletable — the generator's entry path
// assumes it.
// ---------------------------------------------------------------------------

import { useCallback, useMemo, useState } from "react";
import { ActionIcon, Box, Button, Group, Stack, Text, TextInput, Tooltip } from "@mantine/core";
import { buildTree, type TreeFolder, type TreeNode } from "../preview/file-tree";
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

/** Build a tree of `/workspace/` paths suitable for the renderer.
 *  Reuses `buildTree` from the generated-output side; the path
 *  scheme is identical (POSIX, `/`-separated) so the produced
 *  `TreeNode` hierarchy renders the same way. */
function workspaceTree(files: ReadonlyMap<string, string>, activePath: string): TreeFolder {
  // Synthesise a `VirtualFile[]` shape with the `/workspace/`
  // prefix stripped so the tree's top level reads `main.ddd` /
  // `shared/...` instead of a useless `workspace` root folder.
  const virtual = [...files.keys()].map((p) => ({
    path: p.startsWith(WORKSPACE_PREFIX) ? p.slice(WORKSPACE_PREFIX.length) : p,
    content: "",
    size: 0,
  }));
  // Add the active path even if it isn't in the map yet (first
  // edit of main.ddd hasn't landed a VFS write, etc.) so the row
  // appears highlighted instead of being absent.
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

  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState("");
  const existingPaths = new Set(props.files.keys());
  const draftError = creating ? validateNewFileBasename(draft, existingPaths) : undefined;

  const startCreate = useCallback(() => {
    setDraft("");
    setCreating(true);
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

  return (
    <Box
      data-testid="source-files-tree"
      style={{
        display: "flex",
        flexDirection: "column",
        background: "var(--mantine-color-dark-6)",
        borderBottom: "1px solid var(--mantine-color-dark-4)",
        // Cap height so a workspace with many files doesn't eat the
        // whole viewport; the inner Stack scrolls when it overflows.
        maxHeight: 220,
        overflowY: "auto",
      }}
    >
      <Group
        justify="space-between"
        align="center"
        px="sm"
        py={6}
        style={{
          position: "sticky",
          top: 0,
          background: "var(--mantine-color-dark-6)",
          borderBottom: "1px solid var(--mantine-color-dark-5)",
          zIndex: 1,
        }}
      >
        <Text size="xs" c="dimmed" fw={600} tt="uppercase">
          Files
        </Text>
        <Tooltip label="Add a new .ddd file" withArrow openDelay={400}>
          <ActionIcon
            size="md"
            variant="subtle"
            color="gray"
            aria-label="Add a new .ddd file"
            onClick={startCreate}
          >
            +
          </ActionIcon>
        </Tooltip>
      </Group>
      <Stack gap={0} py={4}>
        {root.children.map((node) => (
          <TreeRow
            key={node.path}
            node={node}
            depth={0}
            activeRelPath={
              props.activePath.startsWith(WORKSPACE_PREFIX)
                ? props.activePath.slice(WORKSPACE_PREFIX.length)
                : props.activePath
            }
            onSelect={(rel) => props.onSelect(`${WORKSPACE_PREFIX}${rel}`)}
            onDelete={(rel) => props.onDelete(`${WORKSPACE_PREFIX}${rel}`)}
          />
        ))}
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
      </Stack>
    </Box>
  );
}

interface TreeRowProps {
  node: TreeNode;
  depth: number;
  activeRelPath: string;
  onSelect: (relPath: string) => void;
  onDelete: (relPath: string) => void;
}

function TreeRow({ node, depth, activeRelPath, onSelect, onDelete }: TreeRowProps): JSX.Element {
  // Indent each level by 12 px — keeps nested files visually grouped
  // with their parent folder without eating much horizontal space on
  // a phone.
  const indent = depth * 12;

  if (node.kind === "folder") {
    return (
      <Box>
        <Group
          gap={6}
          align="center"
          px="sm"
          py={4}
          style={{ paddingLeft: 12 + indent }}
        >
          <Text size="xs" c="dimmed" ff="monospace">
            {node.name}/
          </Text>
        </Group>
        {node.children.map((child) => (
          <TreeRow
            key={child.path}
            node={child}
            depth={depth + 1}
            activeRelPath={activeRelPath}
            onSelect={onSelect}
            onDelete={onDelete}
          />
        ))}
      </Box>
    );
  }

  const isActive = node.path === activeRelPath;
  // Deletable iff this isn't the default entry path — same rule the
  // tabs strip uses.
  const fullPath = `${WORKSPACE_PREFIX}${node.path}`;
  const isDeletable = fullPath !== DEFAULT_PATH;

  return (
    <Group
      gap={4}
      align="center"
      wrap="nowrap"
      px="sm"
      py={6}
      onClick={() => {
        if (!isActive) onSelect(node.path);
      }}
      style={{
        paddingLeft: 12 + indent,
        cursor: isActive ? "default" : "pointer",
        background: isActive ? "var(--mantine-color-dark-7)" : "transparent",
        borderLeft: isActive
          ? "2px solid var(--mantine-color-blue-5)"
          : "2px solid transparent",
      }}
      data-active={isActive ? "true" : undefined}
      data-path={fullPath}
    >
      <Text
        size="sm"
        ff="monospace"
        c={isActive ? undefined : "dimmed"}
        style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}
      >
        {node.name}
      </Text>
      {isDeletable && (
        <Tooltip label="Delete file" withArrow openDelay={400}>
          <ActionIcon
            size="sm"
            variant="subtle"
            color="gray"
            aria-label={`Delete ${node.name}`}
            onClick={(e) => {
              e.stopPropagation();
              onDelete(node.path);
            }}
          >
            ×
          </ActionIcon>
        </Tooltip>
      )}
    </Group>
  );
}

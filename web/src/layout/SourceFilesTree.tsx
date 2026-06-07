// ---------------------------------------------------------------------------
// `SourceFilesTree` — the workspace file explorer used by BOTH shells.
//
//   - `variant="sidebar"` (desktop): a persistent left column beside the
//     editor.  Replaces the old delete-on-× tab strip — the tree is the
//     file manager and the editor shows the selected file.
//   - `variant="accordion"` (mobile): a collapsible `<details>` panel
//     above the editor (closed by default to give the editor the screen).
//
// File management is **right-click → context menu** (the primary
// affordance the user asked for): on a file → Rename / Delete; on a
// folder → New file / New folder / Delete folder; on empty space →
// New file / New folder.  A header "+" menu is kept for discoverability
// and for touch, where a right-click isn't natural.  Deletes confirm
// first so a misclick can't silently destroy a file — the old tab "×"
// deleted with no confirmation.
//
// The tree itself reuses `preview/FileTree.tsx`; this module owns the
// workspace-relative projection, the create/rename inline form, and the
// context menu.
// ---------------------------------------------------------------------------

import { useCallback, useMemo, useRef, useState } from "react";
import { ActionIcon, Box, Button, Group, Menu, Stack, Text, TextInput, Tooltip } from "@mantine/core";
import { buildTree, type TreeFolder } from "../preview/file-tree";
import { FileTree } from "../preview/FileTree";
import { DEFAULT_PATH } from "../workspace/workspace-sources";
import {
  fileInFolderPath,
  parentRelOf,
  renameTargetPath,
  validateNewFileInFolder,
  validateNewFolderName,
  validateRename,
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
  /** Create a new `/workspace/...ddd` (full path). */
  onCreate: (path: string) => void;
  /** Delete a file from the VFS.  Never called for `main.ddd`. */
  onDelete: (path: string) => void;
  /** Workspace-relative folder paths that exist as empty folders. */
  emptyFolders?: ReadonlySet<string>;
  /** Create an empty folder via the VFS's `mkdir` (workspace-relative). */
  onCreateFolder?: (folder: string) => void;
  /** Delete a folder and everything under it (workspace-relative). */
  onDeleteFolder?: (folder: string) => void;
  /** Rename a file: write `newPath` with the old content, drop `oldPath`. */
  onRename?: (oldPath: string, newPath: string) => void;
  /** Layout: a persistent desktop sidebar or a collapsible mobile panel. */
  variant?: "sidebar" | "accordion";
}

const EMPTY_FOLDER_MARKER = ".empty-folder";

function isEmptyFolderMarker(relPath: string): boolean {
  return relPath.endsWith(`/${EMPTY_FOLDER_MARKER}`);
}

function workspaceTree(
  files: ReadonlyMap<string, string>,
  activePath: string,
  emptyFolders: ReadonlySet<string>,
): TreeFolder {
  const virtual = [...files.keys()].map((p) => ({
    path: p.startsWith(WORKSPACE_PREFIX) ? p.slice(WORKSPACE_PREFIX.length) : p,
    content: "",
    size: 0,
  }));
  const activeRel = activePath.startsWith(WORKSPACE_PREFIX)
    ? activePath.slice(WORKSPACE_PREFIX.length)
    : activePath;
  if (!virtual.some((v) => v.path === activeRel)) {
    virtual.push({ path: activeRel, content: "", size: 0 });
  }
  for (const folder of emptyFolders) {
    virtual.push({ path: `${folder}/${EMPTY_FOLDER_MARKER}`, content: "", size: 0 });
  }
  return buildTree(virtual);
}

/** Leaf of a workspace path with the `.ddd` extension stripped — the
 *  pre-fill for the rename form. */
function leafNoExt(fullPath: string): string {
  const rel = fullPath.startsWith(WORKSPACE_PREFIX)
    ? fullPath.slice(WORKSPACE_PREFIX.length)
    : fullPath;
  const leaf = rel.slice(rel.lastIndexOf("/") + 1);
  return leaf.endsWith(".ddd") ? leaf.slice(0, -4) : leaf;
}

// Inline form: create a file/folder under a known parent folder, or
// rename an existing file.  `parent` is workspace-relative ("" = root).
type FormState =
  | { kind: "create-file"; parent: string }
  | { kind: "create-folder"; parent: string }
  | { kind: "rename"; target: string }
  | null;

// Context menu anchored at the cursor.  `target` null = empty-area menu.
interface MenuState {
  x: number;
  y: number;
  target: { path: string; kind: "file" | "folder" } | null;
}

export function SourceFilesTree(props: SourceFilesTreeProps): JSX.Element {
  const variant = props.variant ?? "accordion";
  const emptyFolders = props.emptyFolders ?? new Set<string>();
  const root = useMemo(
    () => workspaceTree(props.files, props.activePath, emptyFolders),
    [props.files, props.activePath, emptyFolders],
  );
  const detailsRef = useRef<HTMLDetailsElement | null>(null);

  const [form, setForm] = useState<FormState>(null);
  const [draft, setDraft] = useState("");
  const [menu, setMenu] = useState<MenuState | null>(null);
  const existingPaths = useMemo(() => new Set(props.files.keys()), [props.files]);

  const draftError =
    form?.kind === "create-file"
      ? validateNewFileInFolder(draft, existingPaths, form.parent)
      : form?.kind === "create-folder"
        ? validateNewFolderName(draft, existingPaths)
        : form?.kind === "rename"
          ? validateRename(draft, existingPaths, form.target)
          : undefined;

  const formTitle =
    form?.kind === "create-file"
      ? form.parent
        ? `New file in ${form.parent}/`
        : "New file"
      : form?.kind === "create-folder"
        ? form.parent
          ? `New folder in ${form.parent}/`
          : "New folder"
        : form?.kind === "rename"
          ? "Rename file"
          : "";

  const openForm = useCallback((next: FormState, prefill = "") => {
    setMenu(null);
    setDraft(prefill);
    setForm(next);
    if (detailsRef.current) detailsRef.current.open = true;
  }, []);
  const cancelForm = useCallback(() => {
    setForm(null);
    setDraft("");
  }, []);
  const submitForm = useCallback(() => {
    if (!form || draftError || draft.trim() === "") return;
    if (form.kind === "create-file") {
      props.onCreate(fileInFolderPath(form.parent, draft));
    } else if (form.kind === "create-folder") {
      const name = draft.trim().replace(/^\/+/, "").replace(/\/+$/, "");
      const folder = form.parent ? `${form.parent}/${name}` : name;
      props.onCreateFolder?.(folder);
    } else if (form.kind === "rename") {
      const target = renameTargetPath(form.target, draft);
      if (target !== form.target) props.onRename?.(form.target, target);
    }
    cancelForm();
  }, [form, draft, draftError, props, cancelForm]);

  // ---- context-menu actions ------------------------------------------
  const onContextMenu = useCallback(
    (path: string, kind: "file" | "folder", e: React.MouseEvent) => {
      setMenu({ x: e.clientX, y: e.clientY, target: { path, kind } });
    },
    [],
  );
  const onEmptyContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, target: null });
  }, []);

  const confirmDeleteFile = useCallback(
    (fullPath: string) => {
      const rel = fullPath.slice(WORKSPACE_PREFIX.length);
      if (window.confirm(`Delete "${rel}"? This can't be undone.`)) props.onDelete(fullPath);
    },
    [props],
  );
  const confirmDeleteFolder = useCallback(
    (folderRel: string) => {
      if (window.confirm(`Delete folder "${folderRel}" and everything in it?`)) {
        props.onDeleteFolder?.(folderRel);
      }
    },
    [props],
  );

  // The action menu for a target row (`null` = empty-area / root).
  // Shared by the right-click context menu AND the per-row `⋮` kebab so
  // both surfaces offer the identical set — the kebab is what makes
  // rename + folder ops reachable on touch, where right-click isn't.
  // Tree row paths are workspace-relative; files re-prefix to the full
  // path the callbacks expect, folders use the rel path directly.
  const actionItems = useCallback(
    (target: { path: string; kind: "file" | "folder" } | null): JSX.Element => {
      if (target === null) {
        return (
          <>
            <Menu.Item onClick={() => openForm({ kind: "create-file", parent: "" })}>
              New file…
            </Menu.Item>
            <Menu.Item onClick={() => openForm({ kind: "create-folder", parent: "" })}>
              New folder…
            </Menu.Item>
          </>
        );
      }
      if (target.kind === "folder") {
        const folderRel = target.path;
        return (
          <>
            <Menu.Item onClick={() => openForm({ kind: "create-file", parent: folderRel })}>
              New file…
            </Menu.Item>
            <Menu.Item onClick={() => openForm({ kind: "create-folder", parent: folderRel })}>
              New folder…
            </Menu.Item>
            <Menu.Divider />
            <Menu.Item color="red" onClick={() => confirmDeleteFolder(folderRel)}>
              Delete folder
            </Menu.Item>
          </>
        );
      }
      const fullPath = `${WORKSPACE_PREFIX}${target.path}`;
      const isMain = fullPath === DEFAULT_PATH;
      return (
        <>
          <Menu.Item onClick={() => props.onSelect(fullPath)}>Open</Menu.Item>
          <Menu.Item
            disabled={isMain}
            onClick={() => openForm({ kind: "rename", target: fullPath }, leafNoExt(fullPath))}
          >
            Rename…
          </Menu.Item>
          <Menu.Divider />
          <Menu.Item color="red" disabled={isMain} onClick={() => confirmDeleteFile(fullPath)}>
            Delete file
          </Menu.Item>
        </>
      );
    },
    [openForm, confirmDeleteFile, confirmDeleteFolder, props],
  );

  const menuItems = menu ? actionItems(menu.target) : null;

  const activeRelPath = props.activePath.startsWith(WORKSPACE_PREFIX)
    ? props.activePath.slice(WORKSPACE_PREFIX.length)
    : props.activePath;

  // Per-row `⋮` kebab — a plain tap that opens the same action menu as
  // right-click.  This is the primary affordance on touch (long-press →
  // contextmenu is unreliable there, especially iOS Safari), and gives
  // folders an explicit action surface they otherwise lacked.
  const rowActions = useCallback(
    (relPath: string, kind: "file" | "folder") => (
      <Menu position="bottom-end" shadow="md" width={190} withinPortal>
        <Menu.Target>
          <Tooltip label="File actions" withArrow openDelay={400}>
            <ActionIcon
              component="span"
              size="sm"
              variant="subtle"
              color="gray"
              aria-label={`Actions for ${relPath}`}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
            >
              ⋮
            </ActionIcon>
          </Tooltip>
        </Menu.Target>
        <Menu.Dropdown
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          {actionItems({ path: relPath, kind })}
        </Menu.Dropdown>
      </Menu>
    ),
    [actionItems],
  );

  const addMenu = (
    <Menu position="bottom-end" shadow="sm" withinPortal>
      <Menu.Target>
        <Tooltip label="Add a new .ddd file or folder" withArrow openDelay={400}>
          <ActionIcon
            component="span"
            size={variant === "accordion" ? "md" : "sm"}
            variant="subtle"
            color="gray"
            aria-label="Add a new .ddd file or folder"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
          >
            +
          </ActionIcon>
        </Tooltip>
      </Menu.Target>
      <Menu.Dropdown
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        <Menu.Item onClick={() => openForm({ kind: "create-file", parent: "" })}>New file</Menu.Item>
        <Menu.Item onClick={() => openForm({ kind: "create-folder", parent: "" })}>New folder</Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );

  const inlineForm = form !== null && (
    <Box px="sm" py={6}>
      <Stack gap={4}>
        <Text size="xs" c="dimmed" fw={600} tt="uppercase">
          {formTitle}
        </Text>
        <TextInput
          size="sm"
          autoFocus
          placeholder={
            form.kind === "create-folder" ? "folder name" : "filename (.ddd optional)"
          }
          value={draft}
          error={draftError}
          onChange={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submitForm();
            else if (e.key === "Escape") cancelForm();
          }}
        />
        <Group gap={6} wrap="nowrap">
          <Button size="xs" variant="default" onClick={submitForm} disabled={!!draftError}>
            {form.kind === "rename" ? "Rename" : "Add"}
          </Button>
          <Button size="xs" variant="subtle" color="gray" onClick={cancelForm}>
            Cancel
          </Button>
        </Group>
      </Stack>
    </Box>
  );

  // The positioned context menu — a zero-size fixed target at the cursor
  // that Mantine's floating dropdown anchors to.
  const contextMenu = (
    <Menu
      opened={menu !== null}
      onClose={() => setMenu(null)}
      position="right-start"
      shadow="md"
      width={180}
      withinPortal
    >
      <Menu.Target>
        <div
          style={{
            position: "fixed",
            left: menu?.x ?? -9999,
            top: menu?.y ?? -9999,
            width: 1,
            height: 1,
            pointerEvents: "none",
          }}
        />
      </Menu.Target>
      <Menu.Dropdown>{menuItems}</Menu.Dropdown>
    </Menu>
  );

  const treeBody = (
    <Box
      onContextMenu={onEmptyContextMenu}
      style={
        variant === "sidebar"
          ? { flex: 1, minHeight: 0, overflow: "auto" }
          : { maxHeight: 240, overflow: "auto" }
      }
    >
      {inlineForm}
      <FileTree
        root={root}
        selectedPath={activeRelPath}
        onSelect={(rel) => {
          if (isEmptyFolderMarker(rel)) return;
          props.onSelect(`${WORKSPACE_PREFIX}${rel}`);
          if (variant === "accordion" && detailsRef.current) detailsRef.current.open = false;
        }}
        rowActions={rowActions}
        shouldRenderFile={(rel) => !isEmptyFolderMarker(rel)}
        onContextMenu={onContextMenu}
      />
      {contextMenu}
    </Box>
  );

  if (variant === "sidebar") {
    return (
      <Box
        data-testid="source-files-tree"
        style={{
          width: 220,
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
          borderRight: "1px solid var(--mantine-color-dark-4)",
          background: "var(--mantine-color-dark-7)",
        }}
      >
        <Group
          justify="space-between"
          wrap="nowrap"
          px="sm"
          py={6}
          style={{ borderBottom: "1px solid var(--mantine-color-dark-4)" }}
        >
          <Text size="xs" c="dimmed" fw={600} tt="uppercase">
            Files
          </Text>
          {addMenu}
        </Group>
        {treeBody}
      </Box>
    );
  }

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
        <span>Files ({props.files.size || 1})</span>
        {addMenu}
      </Box>
      {treeBody}
    </Box>
  );
}

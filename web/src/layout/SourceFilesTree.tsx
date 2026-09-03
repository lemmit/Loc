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
// and for touch, where a right-click isn't natural.  Deletes arm an inline
// confirm row first so a misclick can't silently destroy a file — the old
// tab "×" deleted with no confirmation.
//
// The tree itself reuses `preview/FileTree.tsx`; this module owns the
// workspace-relative projection, the create/rename inline form, and the
// context menu.
// ---------------------------------------------------------------------------

import { useCallback, useMemo, useRef, useState } from "react";
import {
  ActionIcon,
  Alert,
  Box,
  Button,
  Group,
  Menu,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core";
import { buildTree, type TreeFolder } from "../preview/file-tree";
import { FileTree } from "../preview/FileTree";
import { InlineConfirm, confirmSites } from "../util/confirm";
import {
  DEFAULT_PATH,
  readOnlyMessage,
  type WorkspaceReadOnlyReason,
  type WorkspaceSourcesError,
} from "../workspace/workspace-sources";
import {
  fileInFolderPath,
  joinRel,
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
  /** Whether file changes actually land.  False in ephemeral mode (no git
   *  store) AND while another tab owns the workspace's writer lock — every
   *  mutator is suppressed either way, so the create / rename / delete
   *  affordances are disabled and say why rather than letting the user add a
   *  file that silently evaporates. */
  writable?: boolean;
  /** Which read-only condition applies; picks the explanatory sentence.
   *  Defaults to `"ephemeral"` (the historical single reason). */
  readOnlyReason?: WorkspaceReadOnlyReason | null;
  /** Last failed mutation from the sources controller, rendered as a
   *  dismissible Alert above the tree. */
  error?: WorkspaceSourcesError | null;
  /** Dismiss `error`. */
  onDismissError?: () => void;
  /** Layout:
   *   - `sidebar`   — a standalone desktop column (own header + border).
   *   - `accordion` — a collapsible mobile panel.
   *   - `embedded`  — fills a host panel (no own header/border); used by
   *     the desktop left Explorer's "User code" view. */
  variant?: "sidebar" | "accordion" | "embedded";
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

/** Human-readable title for a failed mutation, by op. */
const ERROR_TITLE: Record<WorkspaceSourcesError["op"], string> = {
  write: "Save failed",
  create: "Could not create the file",
  "create-folder": "Could not create the folder",
  delete: "Delete failed",
  "delete-folder": "Could not delete the folder",
};

/** Shared empty-set identity for the optional `emptyFolders` prop. */
const NO_EMPTY_FOLDERS: ReadonlySet<string> = new Set<string>();

export function SourceFilesTree(props: SourceFilesTreeProps): JSX.Element {
  const variant = props.variant ?? "accordion";
  const writable = props.writable ?? true;
  const readOnlyNote = readOnlyMessage(props.readOnlyReason ?? "ephemeral");
  // Module-level fallback, not `new Set()` inline: an inline literal is a fresh
  // identity every render, which makes the `root` memo below miss every single
  // time (a full workspace-tree rebuild per render) for every caller that
  // doesn't pass `emptyFolders`.
  const emptyFolders = props.emptyFolders ?? NO_EMPTY_FOLDERS;
  const root = useMemo(
    () => workspaceTree(props.files, props.activePath, emptyFolders),
    [props.files, props.activePath, emptyFolders],
  );
  const detailsRef = useRef<HTMLDetailsElement | null>(null);

  const [form, setForm] = useState<FormState>(null);
  const [draft, setDraft] = useState("");
  const [menu, setMenu] = useState<MenuState | null>(null);
  // The header "+" menu is CONTROLLED — see `addMenu` below for why the
  // uncontrolled Mantine toggle can't survive this target sandwich.
  const [addOpened, setAddOpened] = useState(false);
  const existingPaths = useMemo(() => new Set(props.files.keys()), [props.files]);

  const draftError =
    form?.kind === "create-file"
      ? validateNewFileInFolder(draft, existingPaths, form.parent)
      : form?.kind === "create-folder"
        ? validateNewFolderName(draft, existingPaths, form.parent, emptyFolders)
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
      props.onCreateFolder?.(joinRel(form.parent, name));
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

  // Deletes arm an INLINE confirm row above the tree (the shared
  // `InlineConfirm`, M-T8.17) instead of a native dialog; the row names the
  // file — or the folder and how many files it holds — and Cancel keeps it.
  const [pendingDelete, setPendingDelete] = useState<
    { kind: "file"; fullPath: string } | { kind: "folder"; folderRel: string } | null
  >(null);
  const confirmDeleteFile = useCallback((fullPath: string) => {
    setMenu(null);
    setPendingDelete({ kind: "file", fullPath });
  }, []);
  const confirmDeleteFolder = useCallback((folderRel: string) => {
    setMenu(null);
    setPendingDelete({ kind: "folder", folderRel });
  }, []);
  const deleteSpec =
    pendingDelete === null
      ? null
      : pendingDelete.kind === "file"
        ? confirmSites.sourceFileDelete(pendingDelete.fullPath.slice(WORKSPACE_PREFIX.length))
        : confirmSites.sourceFolderDelete(
            pendingDelete.folderRel,
            [...props.files.keys()].filter((p) =>
              p.startsWith(`${WORKSPACE_PREFIX}${pendingDelete.folderRel}/`),
            ).length,
          );
  const runPendingDelete = (): void => {
    const target = pendingDelete;
    setPendingDelete(null);
    if (!target) return;
    if (target.kind === "file") props.onDelete(target.fullPath);
    else props.onDeleteFolder?.(target.folderRel);
  };

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
            <Menu.Item
              disabled={!writable}
              data-testid="source-files-new-file"
              onClick={() => openForm({ kind: "create-file", parent: "" })}
            >
              New file…
            </Menu.Item>
            <Menu.Item
              disabled={!writable}
              data-testid="source-files-new-folder"
              onClick={() => openForm({ kind: "create-folder", parent: "" })}
            >
              New folder…
            </Menu.Item>
          </>
        );
      }
      if (target.kind === "folder") {
        const folderRel = target.path;
        return (
          <>
            <Menu.Item
              disabled={!writable}
              onClick={() => openForm({ kind: "create-file", parent: folderRel })}
            >
              New file…
            </Menu.Item>
            <Menu.Item
              disabled={!writable}
              onClick={() => openForm({ kind: "create-folder", parent: folderRel })}
            >
              New folder…
            </Menu.Item>
            <Menu.Divider />
            <Menu.Item
              color="red"
              disabled={!writable}
              onClick={() => confirmDeleteFolder(folderRel)}
            >
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
            disabled={isMain || !writable}
            onClick={() => openForm({ kind: "rename", target: fullPath }, leafNoExt(fullPath))}
          >
            Rename…
          </Menu.Item>
          <Menu.Divider />
          <Menu.Item
            color="red"
            disabled={isMain || !writable}
            onClick={() => confirmDeleteFile(fullPath)}
          >
            Delete file
          </Menu.Item>
        </>
      );
    },
    [openForm, confirmDeleteFile, confirmDeleteFolder, writable, props],
  );

  const menuItems = menu ? actionItems(menu.target) : null;

  const activeRelPath = props.activePath.startsWith(WORKSPACE_PREFIX)
    ? props.activePath.slice(WORKSPACE_PREFIX.length)
    : props.activePath;

  // Per-row `⋮` kebab — a plain tap that opens the same action menu as
  // right-click.  This is the primary affordance on touch (long-press →
  // contextmenu is unreliable there, especially iOS Safari), and gives
  // folders an explicit action surface they otherwise lacked.
  //
  // CONTROLLED, for the same reason the header "+" menu is (see `addMenu`
  // below): `Menu.Target` injects its toggle as the child's `onClick`, but the
  // child is a `Tooltip`, which re-spreads the grandchild's own props AFTER
  // the injected ones — so the `ActionIcon`'s stop-propagation `onClick`
  // silently REPLACED the toggle and the kebab never opened (found by the
  // M-T8.17 destructive-actions spec, which drives the delete through it).
  const [openRowMenu, setOpenRowMenu] = useState<string | null>(null);
  const rowActions = useCallback(
    (relPath: string, kind: "file" | "folder") => (
      <Menu
        position="bottom-end"
        shadow="md"
        width={190}
        withinPortal
        opened={openRowMenu === relPath}
        onChange={(o) => setOpenRowMenu(o ? relPath : null)}
      >
        <Menu.Target>
          <Tooltip label="File actions" withArrow openDelay={400}>
            <ActionIcon
              component="span"
              size="sm"
              variant="subtle"
              color="gray"
              role="button"
              tabIndex={0}
              aria-label={`Actions for ${relPath}`}
              data-testid={`source-files-actions-${relPath}`}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setOpenRowMenu((cur) => (cur === relPath ? null : relPath));
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  setOpenRowMenu((cur) => (cur === relPath ? null : relPath));
                }
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
    [actionItems, openRowMenu],
  );

  // Opening the "+" menu is DRIVEN BY US, not by Mantine's uncontrolled
  // toggle.  Two forces collide on this one element:
  //
  //  1. In the accordion variant the button sits inside a `<summary>`, so a
  //     plain click would toggle the `<details>` open/closed underneath the
  //     menu.  That's what the `preventDefault()` is for.
  //  2. `Menu.Target` injects its toggle as the CHILD's `onClick` — but the
  //     child here is a `Tooltip`, and Tooltip re-spreads the grandchild's own
  //     props AFTER the ones it received (`{...tooltipProps, ..._childrenProps}`).
  //     So the `ActionIcon`'s local `onClick` silently REPLACED the toggle and
  //     the menu never opened at all (the "+" was a dead affordance).
  //
  // Controlling `opened` keeps both: cancel the summary toggle, then flip the
  // menu ourselves.  Mantine still closes it on item click / outside click via
  // `onChange`.
  const toggleAdd = (e: { preventDefault: () => void; stopPropagation: () => void }): void => {
    e.preventDefault();
    e.stopPropagation();
    setAddOpened((o) => !o);
  };

  const addMenu = (
    <Menu position="bottom-end" shadow="sm" withinPortal opened={addOpened} onChange={setAddOpened}>
      <Menu.Target>
        <Tooltip
          label={writable ? "Add a new .ddd file or folder" : readOnlyNote}
          withArrow
          multiline
          w={writable ? undefined : 260}
          openDelay={400}
        >
          <ActionIcon
            component="span"
            size={variant === "accordion" ? "md" : "sm"}
            variant="subtle"
            color="gray"
            data-testid="source-files-add"
            role="button"
            tabIndex={0}
            aria-label="Add a new .ddd file or folder"
            aria-disabled={!writable}
            data-disabled={writable ? undefined : true}
            onClick={toggleAdd}
            // `component="span"` (a `<button>` isn't valid inside `<summary>`)
            // means no built-in keyboard activation — wire it up explicitly so
            // the menu is reachable without a pointer.
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") toggleAdd(e);
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
        <Menu.Item
          disabled={!writable}
          data-testid="source-files-new-file"
          onClick={() => openForm({ kind: "create-file", parent: "" })}
        >
          New file
        </Menu.Item>
        <Menu.Item
          disabled={!writable}
          data-testid="source-files-new-folder"
          onClick={() => openForm({ kind: "create-folder", parent: "" })}
        >
          New folder
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );

  // Why nothing the user does here will stick.  Same condition (and the
  // same explanation) the History panel already shows for its own
  // unavailability — before this the file UI just silently no-op'd.
  const readOnlyNotice = !writable && (
    <Text size="xs" c="dimmed" px="sm" py={6} data-testid="source-files-readonly">
      {readOnlyNote}
    </Text>
  );

  const errorAlert = props.error && (
    <Alert
      color="red"
      variant="light"
      mx="sm"
      my={6}
      withCloseButton={!!props.onDismissError}
      onClose={props.onDismissError}
      title={ERROR_TITLE[props.error.op]}
      data-testid="source-files-error"
      style={{ flexShrink: 0 }}
    >
      <Text size="xs">{props.error.message}</Text>
    </Alert>
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
          data-testid="source-files-name"
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
          <Button
            size="xs"
            variant="default"
            data-testid="source-files-submit"
            onClick={submitForm}
            disabled={!!draftError}
          >
            {form.kind === "rename" ? "Rename" : "Add"}
          </Button>
          <Button size="xs" variant="subtle" color="gray" onClick={cancelForm}>
            Cancel
          </Button>
        </Group>
      </Stack>
    </Box>
  );

  const deleteConfirm = deleteSpec !== null && (
    <Box px="sm" py={6}>
      <InlineConfirm
        spec={deleteSpec}
        stacked
        onConfirm={runPendingDelete}
        onCancel={() => setPendingDelete(null)}
        testids={{ base: "source-files-delete" }}
      />
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
        variant === "accordion"
          ? { maxHeight: 240, overflow: "auto" }
          : { flex: 1, minHeight: 0, overflow: "auto" }
      }
    >
      {errorAlert}
      {readOnlyNotice}
      {inlineForm}
      {deleteConfirm}
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

  if (variant === "embedded") {
    // Fills a host panel (the desktop left Explorer): just a compact "+"
    // row + the tree.  The host owns the section header / chrome.
    return (
      <Box
        data-testid="source-files-tree"
        style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}
      >
        <Group justify="flex-end" wrap="nowrap" px="xs" py={2}>
          {addMenu}
        </Group>
        {treeBody}
      </Box>
    );
  }

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

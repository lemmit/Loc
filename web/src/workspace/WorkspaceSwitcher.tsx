import { useState } from "react";
import {
  ActionIcon,
  Button,
  Group,
  Menu,
  Popover,
  Select,
  Stack,
  TextInput,
} from "@mantine/core";
import { defaultExample, type LoomExample } from "../examples";
import type { WorkspaceState } from "../layout/ctx";
import { ConfirmModal, confirmSites } from "../util/confirm";
import { countSourceFiles } from "./workspace-sources";

interface Props {
  workspace: WorkspaceState;
  /** Example list for the "start from" picker in the create popover. */
  examples: LoomExample[];
  /** Create a new workspace seeded from the chosen example. */
  onCreateFromExample: (name: string, exampleId: string) => void;
  /** Mantine control size — `xs` on desktop, `sm` on the mobile header. */
  size?: "xs" | "sm";
}

// Multi-workspace switcher.  Each workspace is an isolated, autosaved
// git store; switching reopens its store (App reseats the editor + build
// worker around it).  Creating a workspace lets you pick the example it
// starts from (a popover form) — the non-destructive counterpart to the
// mobile drawer.  Rename is an inline TextInput in place of the Select (the
// mobile drawer's pattern); delete is the shared `ConfirmModal`, naming the
// file count and asking for the workspace name to be typed (M-T8.17, H8).
export function WorkspaceSwitcher({
  workspace,
  examples,
  onCreateFromExample,
  size = "xs",
}: Props): JSX.Element {
  const { workspaces, activeId, activeName, switchWorkspace, renameWorkspace, deleteWorkspace } =
    workspace;

  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [startExample, setStartExample] = useState<string>(defaultExample.id);

  const labelOf = (id: string): string => examples.find((e) => e.id === id)?.label ?? id;

  const submitCreate = (): void => {
    const id = startExample || defaultExample.id;
    onCreateFromExample(newName.trim() || labelOf(id), id);
    setNewName("");
    setStartExample(defaultExample.id);
    setCreateOpen(false);
  };
  // Inline rename: the Select gives way to a TextInput seeded with the
  // current name; Enter / Save commits, Escape / Cancel drops it.
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const beginRename = (): void => {
    setRenameDraft(activeName);
    setRenaming(true);
  };
  const commitRename = (): void => {
    const name = renameDraft.trim();
    if (name && name !== activeName) renameWorkspace(activeId, name);
    setRenaming(false);
  };
  // Delete: a modal naming the file count (one store list when the menu item
  // is clicked — the same walk the file tree does) and gated on typing the
  // workspace name.
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [fileCount, setFileCount] = useState<number | null>(null);
  const armDelete = (): void => {
    if (workspaces.length <= 1) return;
    setFileCount(null);
    setDeleteArmed(true);
    const store = workspace.store;
    if (store) void countSourceFiles(store).then(setFileCount, () => setFileCount(null));
  };
  const confirmDelete = (): void => {
    setDeleteArmed(false);
    deleteWorkspace(activeId);
  };

  return (
    <Group gap={4} wrap="nowrap">
      {renaming ? (
        <Group gap={4} wrap="nowrap">
          <TextInput
            size={size}
            autoFocus
            value={renameDraft}
            w={size === "sm" ? 150 : 170}
            aria-label="Workspace name"
            onChange={(e) => setRenameDraft(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              else if (e.key === "Escape") setRenaming(false);
            }}
            styles={size === "sm" ? { input: { fontSize: 16, minHeight: 36 } } : undefined}
            data-testid="workspace-rename-input"
          />
          <Button size={size} variant="default" onClick={commitRename} data-testid="workspace-rename-save">
            Save
          </Button>
          <Button size={size} variant="subtle" color="gray" onClick={() => setRenaming(false)}>
            Cancel
          </Button>
        </Group>
      ) : (
        <Select
          size={size}
          value={activeId}
          onChange={(v) => v && switchWorkspace(v)}
          data={workspaces.map((w) => ({ value: w.id, label: w.name }))}
          allowDeselect={false}
          w={size === "sm" ? 150 : 170}
          comboboxProps={{ withinPortal: true }}
          aria-label="Choose workspace"
          styles={size === "sm" ? { input: { fontSize: 16, minHeight: 36 } } : undefined}
          data-testid="workspace-select"
        />
      )}
      <Popover
        opened={createOpen}
        onChange={setCreateOpen}
        position="bottom-start"
        shadow="md"
        withinPortal
        width={300}
        trapFocus
        // The "Start from" Select renders its options in a separate portal, so
        // clicking one reads as a click *outside* this popover and would
        // auto-dismiss it mid-selection — the create button then vanishes
        // before it can be clicked (the dominant playground-e2e flake). Keep
        // the popover open until an explicit Create / Escape closes it.
        closeOnClickOutside={false}
      >
        <Popover.Target>
          <ActionIcon
            size={size === "sm" ? "lg" : "md"}
            variant="default"
            aria-label="New workspace"
            title="Create a new workspace from an example"
            onClick={() => setCreateOpen((o) => !o)}
            data-testid="workspace-new"
          >
            +
          </ActionIcon>
        </Popover.Target>
        <Popover.Dropdown>
          <Stack gap={8}>
            <Select
              size="xs"
              label="Start from"
              value={startExample}
              onChange={(v) => setStartExample(v ?? defaultExample.id)}
              data={examples.map((e) => ({ value: e.id, label: e.label }))}
              allowDeselect={false}
              comboboxProps={{ withinPortal: true }}
              // Same accessible name the e2e suite + SR users find the
              // example chooser by.
              aria-label="Choose example"
            />
            <TextInput
              size="xs"
              placeholder={`Name (defaults to “${labelOf(startExample)}”)`}
              value={newName}
              onChange={(e) => setNewName(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitCreate();
                else if (e.key === "Escape") setCreateOpen(false);
              }}
              data-testid="workspace-new-input"
            />
            <Button size="xs" variant="filled" onClick={submitCreate} data-testid="workspace-create">
              Create workspace
            </Button>
          </Stack>
        </Popover.Dropdown>
      </Popover>
      <Menu shadow="md" position="bottom-end" withinPortal>
        <Menu.Target>
          <ActionIcon
            size={size === "sm" ? "lg" : "md"}
            variant="default"
            aria-label="Workspace actions"
            data-testid="workspace-menu"
          >
            ⋮
          </ActionIcon>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item onClick={beginRename} data-testid="workspace-rename">
            Rename…
          </Menu.Item>
          <Menu.Item
            color="red"
            onClick={armDelete}
            disabled={workspaces.length <= 1}
            data-testid="workspace-delete"
          >
            Delete…
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
      <ConfirmModal
        opened={deleteArmed}
        spec={confirmSites.workspaceDelete(activeName, fileCount)}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteArmed(false)}
        testids={{ base: "workspace-delete" }}
      />
    </Group>
  );
}

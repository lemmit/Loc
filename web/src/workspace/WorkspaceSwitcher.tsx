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
// mobile drawer; rename/delete stay on the native prompt/confirm (one-
// line actions, no modal-form dependency).
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
  const onRename = (): void => {
    const name = window.prompt("Rename workspace", activeName)?.trim();
    if (name) renameWorkspace(activeId, name);
  };
  const onDelete = (): void => {
    if (workspaces.length <= 1) return;
    if (window.confirm(`Delete workspace "${activeName}"? Its files are removed.`)) {
      deleteWorkspace(activeId);
    }
  };

  return (
    <Group gap={4} wrap="nowrap">
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
          <Menu.Item onClick={onRename} data-testid="workspace-rename">
            Rename…
          </Menu.Item>
          <Menu.Item
            color="red"
            onClick={onDelete}
            disabled={workspaces.length <= 1}
            data-testid="workspace-delete"
          >
            Delete
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
    </Group>
  );
}

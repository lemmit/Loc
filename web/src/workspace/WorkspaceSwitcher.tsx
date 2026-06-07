import { ActionIcon, Group, Menu, Select } from "@mantine/core";
import type { WorkspaceState } from "../layout/ctx";

interface Props {
  workspace: WorkspaceState;
  /** Mantine control size — `xs` on desktop, `sm` on the mobile header. */
  size?: "xs" | "sm";
}

// Multi-workspace switcher.  Each workspace is an isolated, autosaved
// git store; switching reopens its store (App reseats the editor + build
// worker around it).  Create / rename / delete use native prompts to
// avoid pulling a modal-form dependency in for three one-line actions —
// the same minimal-deps stance as PackPicker's plain glyph buttons.
export function WorkspaceSwitcher({ workspace, size = "xs" }: Props): JSX.Element {
  const {
    workspaces,
    activeId,
    activeName,
    switchWorkspace,
    createWorkspace,
    renameWorkspace,
    deleteWorkspace,
  } = workspace;

  const onNew = (): void => {
    const name = window.prompt("New workspace name", "Workspace")?.trim();
    if (name) createWorkspace(name);
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
        // Stable accessible name for screen readers + e2e locators, in the
        // same spirit as the example picker's "Choose example".
        aria-label="Choose workspace"
        styles={size === "sm" ? { input: { fontSize: 16, minHeight: 36 } } : undefined}
        data-testid="workspace-select"
      />
      <ActionIcon
        size={size === "sm" ? "lg" : "md"}
        variant="default"
        aria-label="New workspace"
        title="Create a new workspace"
        onClick={onNew}
        data-testid="workspace-new"
      >
        +
      </ActionIcon>
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

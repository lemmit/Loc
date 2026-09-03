import { Kbd, Modal, Stack, Table, Text } from "@mantine/core";
import { SHORTCUT_ROWS } from "../util/hotkeys";
import { SHORTCUTS } from "./vocabulary";

// The `?` shortcut sheet (M-T8.18 slice 2, audit H5 / M14): every binding the
// app installs, from the one map the hotkeys module exports — so a new
// shortcut cannot ship unlisted (the unit test pins the rows against the
// action union) — plus the two editor-owned notes people ask about (Tab
// escape, undo from the panes).

interface Props {
  opened: boolean;
  onClose: () => void;
}

export function ShortcutSheet({ opened, onClose }: Props): JSX.Element {
  return (
    <Modal opened={opened} onClose={onClose} title={SHORTCUTS.title} centered size="md">
      {/* The test id sits on the CONTENT, not the Modal root: Mantine keeps
          the root div mounted with a zero-size box when the modal is closed,
          so a root-level id resolves to a permanently "hidden" element. */}
      <Stack gap="sm" data-testid="shortcut-sheet">
        <Table verticalSpacing={4} withRowBorders={false}>
          <Table.Tbody>
            {SHORTCUT_ROWS.map((r) => (
              <Table.Tr key={r.keys}>
                <Table.Td w={170}>
                  <Kbd size="xs">{r.keys}</Kbd>
                </Table.Td>
                <Table.Td>
                  <Text size="sm">{r.label}</Text>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
        <Text size="xs" c="dimmed">
          {SHORTCUTS.note}
        </Text>
        <Text size="xs" c="dimmed">
          {SHORTCUTS.undoNote}
        </Text>
      </Stack>
    </Modal>
  );
}

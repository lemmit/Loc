// ---------------------------------------------------------------------------
// `WorkspaceLockBanner` — the visible half of multi-tab write coordination
// (M-T8.12).
//
// Renders NOTHING in the overwhelmingly common case (one tab, writable).  When
// another tab holds this workspace's writer lock it says so in the header,
// where it is unmissable regardless of which explorer / dock tab is open, and
// offers the one action that resolves it: **Take over**.
//
// Deliberately not a modal: a read-only tab is still perfectly useful for
// reading, and a dialog would demand a decision the user did not ask to make.
// ---------------------------------------------------------------------------

import { Badge, Button, Group, Tooltip } from "@mantine/core";
import {
  OTHER_TAB_MESSAGE,
  type WorkspaceReadOnlyReason,
} from "../workspace/workspace-sources";

export interface WorkspaceLockBannerProps {
  /** Why the workspace is read-only, or `null` when it isn't.  Keyed on the
   *  REASON rather than a bare `!writable`, deliberately: the workspace is
   *  also un-writable for the moment between mount and the store opening, and
   *  flashing "open in another tab" on every boot would be a lie. */
  reason: WorkspaceReadOnlyReason | null;
  /** Take the writer lock from the tab that currently holds it. */
  onTakeOver: () => void;
  /** `xs` in the desktop header, `sm` on mobile's 48 px row. */
  size?: "xs" | "sm";
}

export function WorkspaceLockBanner({
  reason,
  onTakeOver,
  size = "xs",
}: WorkspaceLockBannerProps): JSX.Element | null {
  // Ephemeral mode has its own, longer-standing explanation in the file tree
  // and History panel; this banner is only about the multi-tab case.
  if (reason !== "other-tab") return null;
  return (
    <Group gap={6} wrap="nowrap" data-testid="workspace-readonly-banner">
      <Tooltip label={OTHER_TAB_MESSAGE} withArrow multiline w={280} openDelay={200}>
        <Badge color="orange" variant="light" size={size === "sm" ? "sm" : "xs"}>
          Read-only — open in another tab
        </Badge>
      </Tooltip>
      <Button
        size={size === "sm" ? "xs" : "compact-xs"}
        variant="light"
        color="orange"
        onClick={onTakeOver}
        data-testid="workspace-take-over"
        title="Make THIS tab the writer.  The other tab becomes read-only."
      >
        Take over
      </Button>
    </Group>
  );
}

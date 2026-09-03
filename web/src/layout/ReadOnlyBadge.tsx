// ---------------------------------------------------------------------------
// ReadOnlyBadge — the ONE way the playground says "you cannot edit here"
// (audit L1, M-T8.23).
//
// Read-only used to be explained in three places with three affordances and
// three phrasings: the header lock banner, the History panel's own note, and
// the file tree's note.  A user seeing two of them could not tell whether they
// were looking at one condition or two.  This is the single badge; the sentence
// comes from `readOnlyMessage` (already the one catalogue of reasons), and the
// only surface that adds an ACTION is the header, which owns *Take over*
// because there must be exactly one place to click.
// ---------------------------------------------------------------------------

import { Badge, Tooltip } from "@mantine/core";
import {
  readOnlyMessage,
  type WorkspaceReadOnlyReason,
} from "../workspace/workspace-sources";
import { READ_ONLY } from "./vocabulary";

interface Props {
  /** Why the workspace is read-only.  `null` renders nothing — the badge is
   *  keyed on the REASON, never on a bare `!writable`, so the moment between
   *  mount and the store opening does not flash a claim that is not yet true. */
  reason: WorkspaceReadOnlyReason | null;
  size?: "xs" | "sm";
}

export function ReadOnlyBadge({ reason, size = "xs" }: Props): JSX.Element | null {
  if (reason === null) return null;
  return (
    <Tooltip label={readOnlyMessage(reason)} withArrow multiline w={300} openDelay={200}>
      <Badge
        color={reason === "view" ? "gray" : "orange"}
        variant="light"
        size={size}
        data-testid="read-only-badge"
        data-reason={reason}
      >
        {READ_ONLY.badge[reason]}
      </Badge>
    </Tooltip>
  );
}

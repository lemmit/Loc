// ---------------------------------------------------------------------------
// ShareDialog (M-T8.23 slice 2).
//
// The playground's share affordance used to be a single "Copy share link"
// menu item that said nothing about what it copied.  A `.ddd` playground link
// carries the SOURCE, encoded in the URL hash — and nothing the browser made:
// no database rows, no generated files, no saved versions, no settings.  That
// asymmetry is exactly what a recipient needs to know, so the dialog states it
// instead of leaving them to discover an empty database.
//
// Three shapes of the same link:
//   • the plain link — opens the full playground on the shared source;
//   • the read-only link (`#view=1`) — no editing chrome, and the tab takes no
//     workspace writer lock, so following it cannot disturb a session;
//   • the embed link (`#embed=1`) — read-only and without the bottom dock.
//
// There is deliberately NO link shortener: the site is static, a shortener
// needs a server, and the program's §5 rules servers out.  The dialog says so
// rather than leaving a long URL looking like an oversight.
// ---------------------------------------------------------------------------

import { Button, Code, Group, Modal, Stack, Text, TextInput } from "@mantine/core";
import { useState } from "react";
import type { ViewFlags } from "../util/share";
import type { LayoutCtx } from "./ctx";
import { SHARE } from "./vocabulary";

type Ctx = Pick<LayoutCtx, "buildShareLink" | "copyShareLink">;

interface Props {
  ctx: Ctx;
  opened: boolean;
  onClose: () => void;
}

interface LinkShape {
  id: string;
  label: string;
  hint: string;
  flags: ViewFlags;
}

const SHAPES: LinkShape[] = [
  { id: "plain", label: SHARE.copy, hint: SHARE.carries, flags: { view: false, embed: false } },
  { id: "view", label: SHARE.viewOnly, hint: SHARE.viewOnlyHint, flags: { view: true, embed: false } },
  { id: "embed", label: SHARE.embed, hint: SHARE.embedHint, flags: { view: true, embed: true } },
];

export function ShareDialog({ ctx, opened, onClose }: Props): JSX.Element {
  const [copiedId, setCopiedId] = useState<string | null>(null);
  return (
    <Modal opened={opened} onClose={onClose} title={SHARE.title} size="lg">
      <Stack gap="md" data-testid="share-dialog">
        {/* What the link carries, and what it does not — the two sentences
            the old menu item never said. */}
        <Text size="sm" data-testid="share-carries">
          {SHARE.carries}
        </Text>
        <Text size="sm" c="dimmed" data-testid="share-omits">
          {SHARE.omits}
        </Text>
        {SHAPES.map((shape) => (
          <Stack key={shape.id} gap={4}>
            <Text size="xs" fw={600}>
              {shape.label}
            </Text>
            <Text size="xs" c="dimmed">
              {shape.hint}
            </Text>
            <Group gap="xs" wrap="nowrap" align="flex-start">
              <TextInput
                size="xs"
                readOnly
                value={opened ? ctx.buildShareLink(shape.flags) : ""}
                aria-label={shape.label}
                style={{ flex: 1, minWidth: 0 }}
                data-testid={`share-url-${shape.id}`}
              />
              <Button
                size="xs"
                variant="default"
                data-testid={`share-copy-${shape.id}`}
                onClick={() => {
                  ctx.copyShareLink(shape.flags);
                  setCopiedId(shape.id);
                  setTimeout(() => setCopiedId(null), 1500);
                }}
              >
                {copiedId === shape.id ? SHARE.copied : SHARE.copy}
              </Button>
            </Group>
          </Stack>
        ))}
        <Text size="xs" c="dimmed" data-testid="share-no-shortener">
          {SHARE.noShortener}
        </Text>
        <Text size="xs" c="dimmed">
          Hand-editing works too: append <Code>#view=1</Code> or <Code>#embed=1</Code> to any
          playground link.
        </Text>
      </Stack>
    </Modal>
  );
}

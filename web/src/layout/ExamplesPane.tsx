import { Box, Drawer, ScrollArea, Stack, Text, Tooltip, UnstyledButton } from "@mantine/core";
import { useCallback, useState } from "react";
import { CONCEPT_ORDER, conceptOf, type ExampleConcept, type LoomExample } from "../examples";
import type { LayoutCtx } from "./ctx";
import { EXAMPLES } from "./vocabulary";

// The Examples pane (M-T8.18 slice 3, audit H5): every sample system grouped
// by the concept it teaches, in syllabus order (CRUD → workflows → auth →
// persistence → multi-backend → frontends), with the TypeScript-playground
// read-tracking dot — a hollow dot until an example has been opened in this
// browser.  Each row opens the example in a NEW workspace through the
// existing create-from-example flow, so the current workspace is never
// overwritten.  Desktop mounts it in the Explorer switcher; mobile as a
// bottom sheet.

const READ_KEY = "loom.examples.read";

function loadRead(): Set<string> {
  try {
    const raw = window.localStorage.getItem(READ_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

function saveRead(read: Set<string>): void {
  try {
    window.localStorage.setItem(READ_KEY, JSON.stringify([...read]));
  } catch {
    // storage unavailable — the dot simply never fills
  }
}

interface Props {
  ctx: Pick<LayoutCtx, "augmentedExamplesList" | "createWorkspaceFromExample" | "exampleId">;
  /** Called after an example was opened (mobile closes its sheet). */
  onOpened?: () => void;
}

export function ExamplesPane({ ctx, onOpened }: Props): JSX.Element {
  const { augmentedExamplesList, createWorkspaceFromExample } = ctx;
  const [read, setRead] = useState<Set<string>>(() => loadRead());
  const open = useCallback(
    (ex: LoomExample): void => {
      setRead((prev) => {
        const next = new Set(prev);
        next.add(ex.id);
        saveRead(next);
        return next;
      });
      createWorkspaceFromExample(ex.label, ex.id);
      onOpened?.();
    },
    [createWorkspaceFromExample, onOpened],
  );
  const groups = new Map<ExampleConcept, LoomExample[]>();
  for (const ex of augmentedExamplesList) {
    const c = conceptOf(ex);
    groups.set(c, [...(groups.get(c) ?? []), ex]);
  }
  return (
    <ScrollArea style={{ flex: 1, minHeight: 0 }} data-testid="examples-pane">
      <Stack gap="xs" p="xs">
        <Text size="xs" c="dimmed">
          {EXAMPLES.hint}
        </Text>
        {CONCEPT_ORDER.filter((c) => groups.has(c)).map((c) => (
          <Box key={c}>
            <Text size="xs" fw={600} tt="uppercase" c="dimmed" mb={4} data-testid={`examples-concept-${c}`}>
              {EXAMPLES.concept[c]}
            </Text>
            <Stack gap={2}>
              {groups.get(c)?.map((ex) => (
                <ExampleRow key={ex.id} ex={ex} isRead={read.has(ex.id)} onOpen={() => open(ex)} />
              ))}
            </Stack>
          </Box>
        ))}
      </Stack>
    </ScrollArea>
  );
}

function ExampleRow({ ex, isRead, onOpen }: { ex: LoomExample; isRead: boolean; onOpen: () => void }): JSX.Element {
  return (
    <Tooltip label={ex.blurb ?? EXAMPLES.open} withArrow openDelay={600} multiline maw={360} position="right">
      <UnstyledButton
        onClick={onOpen}
        data-testid="example-row"
        data-example-id={ex.id}
        data-read={isRead || undefined}
        px={6}
        py={4}
        style={{ borderRadius: 4, display: "flex", gap: 8, alignItems: "center", width: "100%" }}
        aria-label={`${ex.label} — ${EXAMPLES.open}`}
      >
        <Box
          component="span"
          aria-label={isRead ? EXAMPLES.read : EXAMPLES.unread}
          role="img"
          data-testid="example-read-dot"
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            flexShrink: 0,
            border: "1px solid var(--mantine-color-blue-5)",
            background: isRead ? "var(--mantine-color-blue-5)" : "transparent",
          }}
        />
        <Text size="xs" truncate>
          {ex.label}
        </Text>
      </UnstyledButton>
    </Tooltip>
  );
}

/** Mobile: the same pane in a bottom sheet. */
export function ExamplesSheet({
  ctx,
  opened,
  onClose,
}: {
  ctx: Props["ctx"];
  opened: boolean;
  onClose: () => void;
}): JSX.Element {
  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      position="bottom"
      size="80%"
      title={EXAMPLES.pane}
      padding="sm"
      styles={{ content: { borderTopLeftRadius: 12, borderTopRightRadius: 12 }, body: { display: "flex", flexDirection: "column", height: "calc(100% - 60px)" } }}
      data-testid="examples-sheet"
    >
      <ExamplesPane ctx={ctx} onOpened={onClose} />
    </Drawer>
  );
}

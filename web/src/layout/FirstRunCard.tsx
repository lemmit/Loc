import { Button, Card, Group, Stack, Text, UnstyledButton } from "@mantine/core";
import type { LayoutCtx } from "./ctx";
import { FIRST_RUN } from "./vocabulary";

// The first-run card (M-T8.18 slice 3, audit H5): three doors on a workspace
// that has never been edited in this browser.  Desktop floats it over the
// editor (the editor stays mounted and live underneath); mobile stacks it
// above the textarea so nothing is covered on a 375 px screen.  Dismissal
// persists in `localStorage` (`loom.firstRun.dismissed`); Esc dismisses too
// (App's hotkeys).
//
//   • Describe a system — focuses the Agent composer; with no provider key
//     configured it plays the scripted demo instead, so the door always
//     opens onto something.
//   • Start from an example — the Examples pane / sheet.
//   • Write .ddd — dismiss and focus the editor.

interface Props {
  ctx: Pick<LayoutCtx, "isDesktop" | "dismissFirstRun" | "askAgent" | "openExamples" | "editorHandleRef">;
}

export function FirstRunCard({ ctx }: Props): JSX.Element {
  const { isDesktop, dismissFirstRun, askAgent, openExamples, editorHandleRef } = ctx;
  const describe = (): void => {
    dismissFirstRun();
    askAgent("");
  };
  const example = (): void => {
    dismissFirstRun();
    openExamples();
  };
  const write = (): void => {
    dismissFirstRun();
    editorHandleRef.current?.revealRange({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 1,
    });
  };
  const card = (
    <Card
      withBorder
      shadow="md"
      padding="md"
      radius="md"
      maw={isDesktop ? 520 : undefined}
      role="dialog"
      aria-labelledby="first-run-title"
      data-testid="first-run-card"
      style={{ background: "var(--mantine-color-body)" }}
    >
      <Stack gap="sm">
        <Text id="first-run-title" fw={700} size="md">
          {FIRST_RUN.title}
        </Text>
        <Text size="sm" c="dimmed">
          {FIRST_RUN.blurb}
        </Text>
        <Stack gap={6}>
          <Door title={FIRST_RUN.describe} hint={FIRST_RUN.describeHint} onClick={describe} testid="first-run-describe" />
          <Door title={FIRST_RUN.example} hint={FIRST_RUN.exampleHint} onClick={example} testid="first-run-example" />
          <Door title={FIRST_RUN.write} hint={FIRST_RUN.writeHint} onClick={write} testid="first-run-write" />
        </Stack>
        <Group justify="flex-end">
          <Button size="compact-xs" variant="subtle" color="gray" onClick={dismissFirstRun} data-testid="first-run-dismiss">
            {FIRST_RUN.dismiss}
          </Button>
        </Group>
      </Stack>
    </Card>
  );
  if (!isDesktop) return <div style={{ padding: 8, flexShrink: 0 }}>{card}</div>;
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        // Only the card catches the pointer — the editor beneath stays live.
        pointerEvents: "none",
        zIndex: 5,
      }}
    >
      <div style={{ pointerEvents: "auto", width: "100%", display: "flex", justifyContent: "center" }}>{card}</div>
    </div>
  );
}

function Door({ title, hint, onClick, testid }: { title: string; hint: string; onClick: () => void; testid: string }): JSX.Element {
  return (
    <UnstyledButton
      onClick={onClick}
      data-testid={testid}
      px="sm"
      py={8}
      style={{
        borderRadius: 8,
        border: "1px solid var(--mantine-color-default-border)",
        minHeight: 44,
      }}
    >
      <Text size="sm" fw={600}>
        {title}
      </Text>
      <Text size="xs" c="dimmed">
        {hint}
      </Text>
    </UnstyledButton>
  );
}

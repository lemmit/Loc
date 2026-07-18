import { Box, Group, Text, UnstyledButton } from "@mantine/core";
import { AuthConfigPanel, authStubDot } from "./AuthConfigPanel";
import { BackendBody, BackendHeader } from "./BackendPanel";
import { TestsBody } from "./TestsPanel";
import { HistoryBody } from "./HistoryPanel";
import { MigrationsBody, migrationsDot } from "./MigrationsPanel";
import { OutputPanel, outputAggregateDot } from "./OutputPanel";
import { type LayoutCtx } from "./ctx";

// Identifiers for the consolidated bottom dock.  The playground used
// to scatter status across the IDE — LSP diagnostics in one panel, the
// backend tester in another, bundle errors hidden at the foot of the
// Files pane, generator errors only counted in the footer, boot errors
// inside the Backend body.  The read-only diagnostic/log views now live
// behind a single Output tab (a stream Select); the interactive Backend
// tester and Tests runner keep their own tabs.  Each tab carries a
// status dot so the user sees where the red is without opening it.
export type DockTab = "output" | "backend" | "tests" | "migrations" | "history" | "auth";

interface Props {
  ctx: LayoutCtx;
  tab: DockTab;
  setTab: (t: DockTab) => void;
}

type DotColour = "red" | "yellow" | "green" | "gray" | null;

export function DevToolsDock({ ctx, tab, setTab }: Props): JSX.Element {
  const { ddl } = ctx;

  const backendDot: DotColour = ddl ? "green" : "gray";

  const tabs: { id: DockTab; label: string; dot: DotColour }[] = [
    { id: "output", label: "Output", dot: outputAggregateDot(ctx) },
    { id: "backend", label: "Runtime", dot: backendDot },
    { id: "tests", label: "Tests", dot: null },
    { id: "migrations", label: "Migrations", dot: migrationsDot(ctx) },
    { id: "history", label: "History", dot: null },
    { id: "auth", label: "Auth", dot: authStubDot(ctx) },
  ];

  return (
    <Box style={{ height: "100%", minHeight: 0, display: "flex", flexDirection: "column" }}>
      <Group
        px="sm"
        py={4}
        bg="dark.6"
        gap="xs"
        justify="space-between"
        wrap="nowrap"
        style={{ flexShrink: 0, borderBottom: "1px solid var(--mantine-color-dark-4)" }}
      >
        <Group gap={2} wrap="nowrap" data-testid="devtools-tabs">
          {tabs.map((t) => (
            <UnstyledButton
              key={t.id}
              onClick={() => setTab(t.id)}
              data-testid={`devtools-tab-${t.id}`}
              data-active={tab === t.id || undefined}
              px="xs"
              py={2}
              style={{
                borderRadius: 4,
                background:
                  tab === t.id ? "var(--mantine-color-dark-4)" : "transparent",
              }}
            >
              <Group gap={6} wrap="nowrap">
                <Text
                  size="xs"
                  fw={600}
                  tt="uppercase"
                  c={tab === t.id ? undefined : "dimmed"}
                >
                  {t.label}
                </Text>
                {t.dot && (
                  <Box
                    w={7}
                    h={7}
                    style={{
                      borderRadius: "50%",
                      background: `var(--mantine-color-${t.dot}-6)`,
                    }}
                  />
                )}
              </Group>
            </UnstyledButton>
          ))}
        </Group>
        {tab === "backend" && <BackendHeader ctx={ctx} />}
      </Group>

      <Box style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        {tab === "output" && (
          <OutputPanel ctx={ctx} stream={ctx.outputStream} setStream={ctx.setOutputStream} />
        )}
        {tab === "backend" && <BackendBody ctx={ctx} />}
        {tab === "tests" && <TestsBody ctx={ctx} />}
        {tab === "migrations" && <MigrationsBody ctx={ctx} />}
        {tab === "history" && <HistoryBody ctx={ctx} />}
        {tab === "auth" && <AuthConfigPanel ctx={ctx} />}
      </Box>
    </Box>
  );
}

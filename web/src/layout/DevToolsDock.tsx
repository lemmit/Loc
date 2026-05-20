import { Box, Group, ScrollArea, Stack, Text, UnstyledButton } from "@mantine/core";
import { ProblemsPanel } from "./ProblemsPanel";
import { BackendBody, BackendHeader } from "./BackendPanel";
import type { LayoutCtx } from "./ctx";

// Identifiers for the consolidated bottom dock.  Today's playground
// scatters status across the IDE — diagnostics in one panel, the
// backend tester in another, bundle errors hidden at the foot of the
// Files pane, boot errors inside the Backend body.  The dock gathers
// them into one tabbed surface; each tab carries a status dot so the
// user sees where the red is without opening every tab.
//
// Generator / Frontend-log / Tests tabs land in a later phase — the
// `data` array below is the single place to register a new one.
export type DockTab = "problems" | "bundler" | "backend";

interface Props {
  ctx: LayoutCtx;
  tab: DockTab;
  setTab: (t: DockTab) => void;
}

type DotColour = "red" | "yellow" | "green" | "gray" | null;

export function DevToolsDock({ ctx, tab, setTab }: Props): JSX.Element {
  const { diagnostics, errorCount, warningCount, honoBundleResult, reactBundleResult, ddl } = ctx;

  const bundleFailed =
    (honoBundleResult != null && !honoBundleResult.ok) ||
    (reactBundleResult != null && !reactBundleResult.ok);

  const problemsDot: DotColour =
    errorCount > 0 ? "red" : warningCount > 0 ? "yellow" : null;
  const bundlerDot: DotColour = bundleFailed ? "red" : null;
  const backendDot: DotColour = ddl ? "green" : "gray";

  const tabs: { id: DockTab; label: string; dot: DotColour }[] = [
    { id: "problems", label: "Problems", dot: problemsDot },
    { id: "bundler", label: "Bundler", dot: bundlerDot },
    { id: "backend", label: "Backend", dot: backendDot },
  ];

  return (
    <Box style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <Group
        px="sm"
        py={4}
        bg="dark.6"
        gap="xs"
        justify="space-between"
        wrap="nowrap"
        style={{ borderBottom: "1px solid var(--mantine-color-dark-4)" }}
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
        {tab === "problems" && (
          <ScrollArea style={{ flex: 1, minHeight: 0 }}>
            <ProblemsPanel items={diagnostics} />
          </ScrollArea>
        )}
        {tab === "bundler" && <BundlerBody ctx={ctx} />}
        {tab === "backend" && <BackendBody ctx={ctx} />}
      </Box>
    </Box>
  );
}

// Bundle diagnostics — moved out of the Files pane footer so a failed
// Hono/React bundle surfaces in the same place as every other build
// signal.  Renders a clean hint when nothing has failed.
function BundlerBody({ ctx }: { ctx: LayoutCtx }): JSX.Element {
  const { honoBundleResult, reactBundleResult } = ctx;
  const honoFailed = honoBundleResult != null && !honoBundleResult.ok;
  const reactFailed = reactBundleResult != null && !reactBundleResult.ok;

  if (!honoFailed && !reactFailed) {
    return (
      <Text c="dimmed" size="sm" p="sm">
        No bundle errors.
      </Text>
    );
  }

  return (
    <ScrollArea style={{ flex: 1, minHeight: 0 }}>
      <Box p="xs">
        {honoFailed && (
          <>
            <Text size="xs" fw={600} tt="uppercase" c="red" mb={4}>
              Hono bundle errors
            </Text>
            <Stack gap={2} mb={reactFailed ? "sm" : 0}>
              {honoBundleResult!.diagnostics.map((d, i) => (
                <Text key={i} size="xs" ff="monospace" style={{ whiteSpace: "pre-wrap" }}>
                  {d.file ? `${d.file}:${d.line ?? "?"}: ` : ""}
                  {d.message}
                </Text>
              ))}
            </Stack>
          </>
        )}
        {reactFailed && (
          <>
            <Text size="xs" fw={600} tt="uppercase" c="red" mb={4}>
              React bundle errors
            </Text>
            <Stack gap={2}>
              {reactBundleResult!.diagnostics.map((d, i) => (
                <Text key={i} size="xs" ff="monospace" style={{ whiteSpace: "pre-wrap" }}>
                  {d.file ? `${d.file}:${d.line ?? "?"}: ` : ""}
                  {d.message}
                </Text>
              ))}
            </Stack>
          </>
        )}
      </Box>
    </ScrollArea>
  );
}

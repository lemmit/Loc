import { Box, Group, ScrollArea, Stack, Text, UnstyledButton } from "@mantine/core";
import { ProblemsPanel } from "./ProblemsPanel";
import { BackendBody, BackendHeader } from "./BackendPanel";
import { TestsBody } from "./TestsPanel";
import { formatBytes, modeLabel, type LayoutCtx } from "./ctx";

// Identifiers for the consolidated bottom dock.  The playground used
// to scatter status across the IDE — LSP diagnostics in one panel, the
// backend tester in another, bundle errors hidden at the foot of the
// Files pane, generator errors only counted in the footer, boot errors
// inside the Backend body.  The dock gathers them into one tabbed
// surface; each tab carries a status dot so the user sees where the
// red is without opening every tab.
//
// A Frontend-log / Tests tab can join later — the `tabs` array below
// is the single place to register one.
export type DockTab = "problems" | "generator" | "bundler" | "backend" | "tests";

interface Props {
  ctx: LayoutCtx;
  tab: DockTab;
  setTab: (t: DockTab) => void;
}

type DotColour = "red" | "yellow" | "green" | "gray" | null;

export function DevToolsDock({ ctx, tab, setTab }: Props): JSX.Element {
  const { diagnostics, errorCount, warningCount, generateResult, honoBundleResult, reactBundleResult, ddl } = ctx;

  const bundleFailed =
    (honoBundleResult != null && !honoBundleResult.ok) ||
    (reactBundleResult != null && !reactBundleResult.ok);

  const problemsDot: DotColour =
    errorCount > 0 ? "red" : warningCount > 0 ? "yellow" : null;
  const generatorDot: DotColour = generateResult?.ok === false ? "red" : null;
  const bundlerDot: DotColour = bundleFailed ? "red" : null;
  const backendDot: DotColour = ddl ? "green" : "gray";

  const tabs: { id: DockTab; label: string; dot: DotColour }[] = [
    { id: "problems", label: "Problems", dot: problemsDot },
    { id: "generator", label: "Generator", dot: generatorDot },
    { id: "bundler", label: "Bundler", dot: bundlerDot },
    { id: "backend", label: "Backend", dot: backendDot },
    { id: "tests", label: "Tests", dot: null },
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
        {tab === "generator" && <GeneratorBody ctx={ctx} />}
        {tab === "bundler" && <BundlerBody ctx={ctx} />}
        {tab === "backend" && <BackendBody ctx={ctx} />}
        {tab === "tests" && <TestsBody ctx={ctx} />}
      </Box>
    </Box>
  );
}

// Generator status — the generate step's mode + file count on success,
// or its diagnostics on failure.  Build diagnostics used to be only
// *counted* in the footer ("generate: N error(s)") with no detailed
// view anywhere; this is that view.
function GeneratorBody({ ctx }: { ctx: LayoutCtx }): JSX.Element {
  const { generateResult } = ctx;

  if (generateResult == null) {
    return (
      <Text c="dimmed" size="sm" p="sm">
        Not generated yet.
      </Text>
    );
  }

  if (generateResult.ok) {
    const warnings = generateResult.diagnostics.filter((d) => d.severity === "warning");
    return (
      <ScrollArea style={{ flex: 1, minHeight: 0 }}>
        <Box p="xs">
          <Text size="sm">
            Generated {generateResult.files.length} file
            {generateResult.files.length === 1 ? "" : "s"} ({modeLabel(generateResult)}).
          </Text>
          {warnings.length > 0 && (
            <Stack gap={2} mt="xs">
              {warnings.map((d, i) => (
                <Text key={i} size="xs" ff="monospace" c="yellow" style={{ whiteSpace: "pre-wrap" }}>
                  {d.line != null ? `${d.line}${d.column != null ? `:${d.column}` : ""}: ` : ""}
                  {d.message}
                </Text>
              ))}
            </Stack>
          )}
        </Box>
      </ScrollArea>
    );
  }

  return (
    <ScrollArea style={{ flex: 1, minHeight: 0 }}>
      <Box p="xs">
        <Text size="xs" fw={600} tt="uppercase" c="red" mb={4}>
          Generation failed
        </Text>
        <Stack gap={2}>
          {generateResult.diagnostics.map((d, i) => (
            <Text
              key={i}
              size="xs"
              ff="monospace"
              c={d.severity === "error" ? "red" : "yellow"}
              style={{ whiteSpace: "pre-wrap" }}
            >
              {d.line != null ? `${d.line}${d.column != null ? `:${d.column}` : ""}: ` : ""}
              {d.message}
            </Text>
          ))}
        </Stack>
      </Box>
    </ScrollArea>
  );
}

// Bundle status — success summary (size / deps / duration), or the
// Hono/React diagnostics on failure.  Replaces the error drawer that
// used to hide at the foot of the Files pane.
function BundlerBody({ ctx }: { ctx: LayoutCtx }): JSX.Element {
  const { honoBundleResult, reactBundleResult } = ctx;
  const honoFailed = honoBundleResult != null && !honoBundleResult.ok;
  const reactFailed = reactBundleResult != null && !reactBundleResult.ok;

  if (honoBundleResult == null && reactBundleResult == null) {
    return (
      <Text c="dimmed" size="sm" p="sm">
        No bundle yet.
      </Text>
    );
  }

  if (!honoFailed && !reactFailed) {
    return (
      <ScrollArea style={{ flex: 1, minHeight: 0 }}>
        <Stack gap={2} p="xs">
          {honoBundleResult?.ok && (
            <Text size="sm">
              Hono: bundled {formatBytes(honoBundleResult.size)} in {honoBundleResult.durationMs} ms
              {" "}({honoBundleResult.fetchedUrls.length} dep
              {honoBundleResult.fetchedUrls.length === 1 ? "" : "s"} fetched).
            </Text>
          )}
          {reactBundleResult?.ok && (
            <Text size="sm">
              React: bundled {formatBytes(reactBundleResult.size)} in {reactBundleResult.durationMs} ms
              {" "}({reactBundleResult.fetchedUrls.length} dep
              {reactBundleResult.fetchedUrls.length === 1 ? "" : "s"} fetched).
            </Text>
          )}
        </Stack>
      </ScrollArea>
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

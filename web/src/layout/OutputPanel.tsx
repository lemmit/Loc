import { Badge, Box, Code, Group, ScrollArea, Select, Stack, Text } from "@mantine/core";
import { ProblemsPanel } from "./ProblemsPanel";
import { formatBytes, modeLabel, type LayoutCtx } from "./ctx";

// The playground used to scatter read-only status across three sibling
// dock tabs — LSP diagnostics, generator output, bundle errors — so a
// red dot could be hiding in any of them.  This panel gathers them
// behind a single stream Select (the VS Code "Output" idiom) and adds
// the test runner's captured console logs as a fourth stream, so the
// interactive Tests tab isn't the only place its output appears.
export type OutputStream = "problems" | "generator" | "bundler" | "tests";

type DotColour = "red" | "yellow" | "green" | "gray" | null;

const STREAMS: { value: OutputStream; label: string }[] = [
  { value: "problems", label: "Problems" },
  { value: "generator", label: "Generator" },
  { value: "bundler", label: "Bundler" },
  { value: "tests", label: "Tests" },
];

// Per-stream status dot.  Drives both the Select's option/trigger dots
// and (rolled up) the Output tab indicator in each shell.
export function streamDot(ctx: LayoutCtx, stream: OutputStream): DotColour {
  switch (stream) {
    case "problems":
      return ctx.errorCount > 0 ? "red" : ctx.warningCount > 0 ? "yellow" : null;
    case "generator":
      return ctx.generateResult?.ok === false ? "red" : null;
    case "bundler": {
      const failed =
        (ctx.honoBundleResult != null && !ctx.honoBundleResult.ok) ||
        (ctx.reactBundleResult != null && !ctx.reactBundleResult.ok);
      return failed ? "red" : null;
    }
    case "tests":
      return Object.values(ctx.testResults).some((r) => r.status === "fail")
        ? "red"
        : null;
  }
}

// Worst-of dot across every stream — the always-visible Output tab
// indicator, so a problem in a stream the user isn't viewing is still
// flagged without auto-switching them to it.
export function outputAggregateDot(ctx: LayoutCtx): DotColour {
  const dots = STREAMS.map((s) => streamDot(ctx, s.value));
  if (dots.includes("red")) return "red";
  if (dots.includes("yellow")) return "yellow";
  return null;
}

function Dot({ colour }: { colour: DotColour }): JSX.Element | null {
  if (!colour) return null;
  return (
    <Box
      w={7}
      h={7}
      style={{ borderRadius: "50%", background: `var(--mantine-color-${colour}-6)` }}
    />
  );
}

interface Props {
  ctx: LayoutCtx;
  stream: OutputStream;
  setStream: (s: OutputStream) => void;
}

export function OutputPanel({ ctx, stream, setStream }: Props): JSX.Element {
  return (
    <Box style={{ height: "100%", minHeight: 0, display: "flex", flexDirection: "column" }}>
      <Group
        px="sm"
        py={4}
        bg="dark.6"
        gap="xs"
        wrap="nowrap"
        style={{ flexShrink: 0, borderBottom: "1px solid var(--mantine-color-dark-4)" }}
      >
        <Select
          size="xs"
          w={150}
          allowDeselect={false}
          value={stream}
          onChange={(v) => v && setStream(v as OutputStream)}
          data={STREAMS}
          leftSection={<Dot colour={streamDot(ctx, stream)} />}
          data-testid="output-stream-select"
          comboboxProps={{ withinPortal: true }}
          renderOption={({ option }) => {
            const s = option.value as OutputStream;
            return (
              <Group gap={6} wrap="nowrap" justify="space-between" w="100%">
                <Text size="xs">{option.label}</Text>
                <Dot colour={streamDot(ctx, s)} />
              </Group>
            );
          }}
        />
      </Group>

      <Box style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        {stream === "problems" && (
          <ScrollArea style={{ flex: 1, minHeight: 0 }}>
            <ProblemsPanel items={ctx.diagnostics} />
          </ScrollArea>
        )}
        {stream === "generator" && <GeneratorBody ctx={ctx} />}
        {stream === "bundler" && <BundlerBody ctx={ctx} />}
        {stream === "tests" && <TestsLog ctx={ctx} />}
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

// Read-only roll-up of the test runner's results — status, error and
// captured console output per test.  Lives here (reading the lifted
// `ctx.testResults`) so the runner's logs surface in Output even while
// the interactive Tests tab is unmounted.
function TestsLog({ ctx }: { ctx: LayoutCtx }): JSX.Element {
  const results = Object.values(ctx.testResults);
  if (results.length === 0) {
    return (
      <Text c="dimmed" size="sm" p="sm">
        No test output yet — run tests from the Tests tab.
      </Text>
    );
  }
  const sorted = [...results].sort(
    (a, b) => a.suite.localeCompare(b.suite) || a.name.localeCompare(b.name),
  );
  return (
    <ScrollArea style={{ flex: 1, minHeight: 0 }}>
      <Stack gap={6} p="xs">
        {sorted.map((r) => (
          <Box key={`${r.suite}\0${r.name}`} data-testid="output-test-row">
            <Group gap={8} wrap="nowrap">
              <Badge size="xs" variant="light" color={r.status === "pass" ? "green" : "red"}>
                {r.status}
              </Badge>
              <Text size="sm" style={{ flex: 1 }}>
                {r.name}
              </Text>
              <Text size="xs" c="dimmed">
                {Math.round(r.durationMs)} ms
              </Text>
            </Group>
            {r.error && (
              <Code block c="red" mt={4} style={{ whiteSpace: "pre-wrap", fontSize: 11 }}>
                {r.error}
              </Code>
            )}
            {r.logs && r.logs.length > 0 && (
              <Code block mt={4} style={{ whiteSpace: "pre-wrap", fontSize: 11 }} data-testid="output-test-console">
                {r.logs
                  .map((l) => (l.level === "log" ? l.text : `[${l.level}] ${l.text}`))
                  .join("\n")}
              </Code>
            )}
          </Box>
        ))}
      </Stack>
    </ScrollArea>
  );
}

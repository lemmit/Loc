import { Badge, Box, Button, Chip, Code, Group, ScrollArea, Select, Stack, Text } from "@mantine/core";
import { useMemo, useState } from "react";
import { ProblemsPanel } from "./ProblemsPanel";
import { formatBytes, modeLabel, type LayoutCtx } from "./ctx";
import { LOG_LEVELS, type LogLine, type StructuredLogPayload } from "../util/log-line";
import { clearDiagnostics, readDiagnostics, type DiagSnapshot } from "../util/diagnostics";

// The playground used to scatter read-only status across sibling dock
// tabs — LSP diagnostics, generator output, bundle errors — so a red dot
// could be hiding in any of them.  This panel gathers them behind a
// single stream Select (the VS Code "Output" idiom), and adds the live
// log streams that previously only reached the browser DevTools console:
// the test runner's captured output, the backend (Hono runtime)
// console + stack traces, and the preview app's console + uncaught
// errors.
export type OutputStream =
  | "problems"
  | "generator"
  | "bundler"
  | "conflicts"
  | "backend"
  | "app"
  | "tests"
  | "diag";

type DotColour = "red" | "yellow" | "green" | "gray" | null;

const STREAMS: { value: OutputStream; label: string }[] = [
  { value: "problems", label: "Problems" },
  { value: "generator", label: "Generator" },
  { value: "bundler", label: "Bundler" },
  { value: "conflicts", label: "Conflicts" },
  { value: "backend", label: "Backend logs" },
  { value: "app", label: "App logs" },
  { value: "tests", label: "Tests" },
  { value: "diag", label: "Diagnostics" },
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
    case "conflicts":
      return ctx.generatedConflicts.length > 0 ? "red" : null;
    case "backend":
      return ctx.backendLog.some((l) => l.level === "error") ? "red" : null;
    case "app":
      return ctx.appLog.some((l) => l.level === "error") ? "red" : null;
    case "tests":
      return Object.values(ctx.testResults).some((r) => r.status === "fail")
        ? "red"
        : null;
    case "diag":
      // Inspection-only stream; reading localStorage on every aggregate-dot
      // pass would add a parse to the render hot path, so it never lights the
      // tab indicator. Pressure is surfaced inside the panel body instead.
      return null;
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
        {stream === "backend" && ctx.backendLog.length > 0 && (
          <Button size="compact-xs" variant="subtle" color="gray" onClick={ctx.clearBackendLog} data-testid="output-clear-backend">
            Clear
          </Button>
        )}
        {stream === "app" && ctx.appLog.length > 0 && (
          <Button size="compact-xs" variant="subtle" color="gray" onClick={ctx.clearAppLog} data-testid="output-clear-app">
            Clear
          </Button>
        )}
      </Group>

      <Box style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        {stream === "problems" && (
          <ScrollArea style={{ flex: 1, minHeight: 0 }}>
            <ProblemsPanel items={ctx.diagnostics} />
          </ScrollArea>
        )}
        {stream === "generator" && <GeneratorBody ctx={ctx} />}
        {stream === "bundler" && <BundlerBody ctx={ctx} />}
        {stream === "conflicts" && <ConflictsBody ctx={ctx} />}
        {stream === "backend" && (
          <FilterableLogView
            lines={ctx.backendLog}
            empty="No backend logs yet — boot the backend and hit an endpoint."
            testid="output-backend-log"
          />
        )}
        {stream === "app" && (
          <FilterableLogView
            lines={ctx.appLog}
            empty="No app logs yet — open the Preview and interact with the generated app."
            testid="output-app-log"
          />
        )}
        {stream === "tests" && <TestsLog ctx={ctx} />}
        {stream === "diag" && <DiagBody />}
      </Box>
    </Box>
  );
}

// Crash/pressure breadcrumbs (see util/diagnostics.ts) — JS heap + storage
// usage captured at tab-hide / pagehide / caught-error and persisted in
// localStorage so they survive the reload a crash causes.  Rendered newest-
// first so the snapshot just before a crash is at the top.  This is the
// no-tether way to read what `window.__loomDiag()` holds, straight on the
// device that crashed.
function DiagBody(): JSX.Element {
  const [snaps, setSnaps] = useState<DiagSnapshot[]>(() => readDiagnostics());
  const refresh = (): void => setSnaps(readDiagnostics());
  const clear = (): void => {
    clearDiagnostics();
    setSnaps([]);
  };
  const rows = [...snaps].reverse(); // newest-first

  return (
    <Box style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <Group
        gap="xs"
        px="sm"
        py={4}
        wrap="nowrap"
        style={{ flexShrink: 0, borderBottom: "1px solid var(--mantine-color-dark-4)" }}
      >
        <Text size="xs" c="dimmed" style={{ flex: 1 }}>
          {rows.length} snapshot{rows.length === 1 ? "" : "s"} · captured on tab
          hide / crash
        </Text>
        <Button size="compact-xs" variant="subtle" color="gray" onClick={refresh} data-testid="output-diag-refresh">
          Refresh
        </Button>
        {rows.length > 0 && (
          <Button size="compact-xs" variant="subtle" color="gray" onClick={clear} data-testid="output-diag-clear">
            Clear
          </Button>
        )}
      </Group>
      {rows.length === 0 ? (
        <Text c="dimmed" size="sm" p="sm">
          No diagnostics yet. A snapshot is recorded when the tab is backgrounded
          or a crash is caught; switch away and back, or hit Refresh.
        </Text>
      ) : (
        <ScrollArea style={{ flex: 1, minHeight: 0 }}>
          <Stack gap={6} p="xs" data-testid="output-diag-list">
            {rows.map((s, i) => (
              <DiagRow key={`${s.t}\0${i}`} snap={s} />
            ))}
          </Stack>
        </ScrollArea>
      )}
    </Box>
  );
}

/** Tint a storage-usage percentage by eviction risk. */
function pctColour(pct: number): "red" | "yellow" | undefined {
  if (pct >= 90) return "red";
  if (pct >= 75) return "yellow";
  return undefined;
}

function reasonColour(reason: string): "red" | "gray" {
  return reason === "hidden" || reason === "pagehide" ? "gray" : "red";
}

function DiagRow({ snap }: { snap: DiagSnapshot }): JSX.Element {
  const when = snap.t.replace("T", " ").replace(/\.\d+Z$/, "");
  return (
    <Box data-testid="output-diag-row">
      <Group gap={8} wrap="nowrap">
        <Badge size="xs" variant="light" color={reasonColour(snap.reason)}>
          {snap.reason}
        </Badge>
        <Text size="xs" c="dimmed" ff="monospace" style={{ flex: 1 }}>
          {when}
        </Text>
      </Group>
      <Group gap={12} wrap="wrap" mt={2} pl={2}>
        {snap.storage && (
          <Text size="xs" ff="monospace" c={pctColour(snap.storage.pct)}>
            storage {snap.storage.usageMB}/{snap.storage.quotaMB} MB ({snap.storage.pct}%)
          </Text>
        )}
        {snap.mem && (
          <Text
            size="xs"
            ff="monospace"
            c={pctColour(Math.round((snap.mem.usedMB / snap.mem.limitMB) * 100))}
          >
            heap {snap.mem.usedMB}/{snap.mem.limitMB} MB
          </Text>
        )}
        <Text size="xs" ff="monospace" c="dimmed">
          {snap.vw}×{snap.vh}
        </Text>
        {snap.hashLen > 0 && (
          <Text size="xs" ff="monospace" c="dimmed">
            hash {snap.hashLen}b
          </Text>
        )}
      </Group>
    </Box>
  );
}

// Live-console view with a per-level filter chip-row — used by BOTH the
// Backend (Hono runtime) and App (preview) streams so the two read
// consistently.  Backend lines are structured pino payloads tagged with
// the embedded catalog level (see log-line.ts + the runtime worker's
// console tee), so filtering matches the SEMANTIC stratum — hiding
// `trace` works even though pino in browser routes trace through
// console.debug.  App lines are plain `console.*` calls tinted by their
// method's level.  Defaults to "all visible" so every captured line
// shows unless the user explicitly narrows.
function FilterableLogView({
  lines,
  empty,
  testid,
}: {
  lines: LogLine[];
  empty: string;
  testid: string;
}): JSX.Element {
  const [selected, setSelected] = useState<Set<LogLine["level"]>>(() => new Set(LOG_LEVELS));
  // Always show every level chip — including levels the current stream
  // doesn't (yet) carry — so the filter UI is stable across boots and
  // the chip layout doesn't jump when a new level arrives.  Counts
  // surface what's actually present.
  const counts = useMemo(() => {
    const acc: Record<LogLine["level"], number> = {
      log: 0,
      trace: 0,
      debug: 0,
      info: 0,
      warn: 0,
      error: 0,
    };
    for (const l of lines) acc[l.level]++;
    return acc;
  }, [lines]);
  const filtered = useMemo(() => lines.filter((l) => selected.has(l.level)), [lines, selected]);
  const toggle = (level: LogLine["level"]): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(level)) next.delete(level);
      else next.add(level);
      return next;
    });
  };

  return (
    <Box style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <Group
        gap={6}
        px="sm"
        py={4}
        wrap="nowrap"
        style={{ flexShrink: 0, borderBottom: "1px solid var(--mantine-color-dark-4)" }}
        data-testid={`${testid}-filter`}
      >
        <Text size="xs" c="dimmed">
          Levels:
        </Text>
        {LOG_LEVELS.map((level) => (
          <Chip
            key={level}
            size="xs"
            checked={selected.has(level)}
            onChange={() => toggle(level)}
            color={levelColour(level) ?? "gray"}
            variant="light"
            data-testid={`${testid}-filter-${level}`}
          >
            {level} {counts[level] > 0 ? `(${counts[level]})` : ""}
          </Chip>
        ))}
      </Group>
      <LogView lines={filtered} empty={empty} testid={testid} />
    </Box>
  );
}

/** Per-level tint shared between the filter chips and the per-line text
 *  rendering, so a user reading a debug-tinted line and clicking the
 *  debug chip sees the same colour identity in both places. */
function levelColour(level: LogLine["level"]): "red" | "yellow" | "gray" | undefined {
  if (level === "error") return "red";
  if (level === "warn") return "yellow";
  if (level === "debug" || level === "trace") return "gray";
  return undefined;
}

/** Plain `console.*` lines — keep the existing `[level] text` form so
 *  user `console.log("foo")` calls render exactly as they used to.  info
 *  + log skip the `[level]` prefix (the default level is implicit). */
function renderUnstructuredLine(l: LogLine): string {
  return l.level === "log" || l.level === "info" ? l.text : `[${l.level}] ${l.text}`;
}

/** Structured pino lines parsed by the worker's captureConsole (see
 *  log-line.ts → asStructuredPayload) render as a compact, scannable
 *  shape instead of the raw JSON blob the unstructured fallback would
 *  show:
 *
 *      [debug] health_ok checks=["liveness"] req=7d8bedc1
 *      [info]  request_end method="GET" path="/health" status=200 duration_ms=4 req=7d8bedc1
 *
 *  The envelope keys (ts / level / event / request_id) are stripped
 *  from the body — `ts` is implicit in the log's ordering, `level`
 *  drives the tint, `event` becomes the head identifier, and
 *  `request_id` is shortened to a UUID prefix + dropped to the end so
 *  the eye lands on what's NEW first.  Per-event fields are JSON-
 *  formatted so a value like `["readiness","db"]` survives intact and
 *  doesn't get smashed to `[object Object]`. */
function renderStructuredLine(p: StructuredLogPayload): string {
  const head = `[${p.level}] ${p.event}`;
  const { ts: _ts, level: _level, event: _event, request_id, ...rest } = p;
  const parts: string[] = [head];
  for (const [k, v] of Object.entries(rest)) {
    parts.push(`${k}=${formatStructuredFieldValue(v)}`);
  }
  if (typeof request_id === "string" && request_id.length > 0) {
    // First UUID segment — enough to spot-correlate across lines
    // without consuming most of the row.
    parts.push(`req=${request_id.split("-")[0] ?? request_id.slice(0, 8)}`);
  }
  return parts.join(" ");
}

/** JSON-format a field value so arrays / objects survive intact and
 *  strings carry quotes (`path="/health"`).  Primitives skip JSON so
 *  numbers / booleans appear as themselves (`status=200`, not
 *  `status="200"`). */
function formatStructuredFieldValue(v: unknown): string {
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// Shared monospace log renderer for the live console streams (backend
// runtime + preview app).  One line per captured `console.*` call, tinted
// by level.  Structured pino lines render as a compact key=value shape
// (see `renderStructuredLine`); plain `console.*` calls keep the existing
// `[level] text` rendering with `pre-wrap` for multi-line errors / stacks.
function LogView({
  lines,
  empty,
  testid,
}: {
  lines: LogLine[];
  empty: string;
  testid: string;
}): JSX.Element {
  if (lines.length === 0) {
    return (
      <Text c="dimmed" size="sm" p="sm">
        {empty}
      </Text>
    );
  }
  return (
    <ScrollArea style={{ flex: 1, minHeight: 0 }}>
      <Stack gap={0} p="xs" data-testid={testid}>
        {lines.map((l, i) => (
          <Text
            key={i}
            size="xs"
            ff="monospace"
            c={
              l.level === "error"
                ? "red"
                : l.level === "warn"
                  ? "yellow"
                  : l.level === "debug" || l.level === "trace"
                    ? "dimmed"
                    : undefined
            }
            style={{ whiteSpace: "pre-wrap" }}
            data-testid={l.structured ? `${testid}-structured` : undefined}
          >
            {l.structured ? renderStructuredLine(l.structured) : renderUnstructuredLine(l)}
          </Text>
        ))}
      </Stack>
    </ScrollArea>
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

// Generated-code conflicts — the regenerate 3-way merge leaves git-style
// markers in a hand-edited generated file it couldn't auto-merge.  Such a
// file won't bundle until resolved, so list them here with the fix steps.
// Self-clears: `ctx.generatedConflicts` re-scans on every workspace change.
function ConflictsBody({ ctx }: { ctx: LayoutCtx }): JSX.Element {
  const { generatedConflicts } = ctx;
  if (generatedConflicts.length === 0) {
    return (
      <Text c="dimmed" size="sm" p="sm">
        No conflicts. When a regenerate can't merge a hand-edited generated
        file, the conflicting files appear here.
      </Text>
    );
  }
  return (
    <ScrollArea style={{ flex: 1, minHeight: 0 }}>
      <Box p="xs">
        <Text size="xs" fw={600} tt="uppercase" c="red" mb={4}>
          {generatedConflicts.length} generated file
          {generatedConflicts.length === 1 ? "" : "s"} with merge conflicts
        </Text>
        <Text size="xs" c="dimmed" mb="xs">
          A regenerate couldn't merge your edits with the new output. Open each
          file, pick the right side between the{" "}
          <Code>{"<<<<<<<"}</Code> / <Code>{"======="}</Code> /{" "}
          <Code>{">>>>>>>"}</Code> markers, and delete the markers. These files
          won't bundle until resolved.
        </Text>
        <Stack gap={2}>
          {generatedConflicts.map((path) => (
            <Group key={path} gap={6} wrap="nowrap" data-testid="output-conflict-row">
              <Badge size="xs" variant="light" color="red">
                conflict
              </Badge>
              <Text size="xs" ff="monospace" style={{ wordBreak: "break-all" }}>
                generated/{path}
              </Text>
            </Group>
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

import {
  Badge,
  Box,
  Button,
  Code,
  Divider,
  Group,
  Loader,
  ScrollArea,
  Stack,
  Text,
} from "@mantine/core";
import { useEffect } from "react";
import type { EvolutionOk, MigrationView } from "../build/protocol";
import type { LayoutCtx } from "./ctx";

// "Migrations" dock tab — the evolution lifecycle, made visible.
//
// The playground regenerates statelessly (keyed by a source hash) and holds
// no "previous version of my system", so schema migrations, wire-contract
// drift, and provenance are invisible side effects.  This tab restores the
// baseline: it diffs the LIVE edit against the last-committed source
// (`HEAD:/workspace/main.ddd`) and shows (a) the schema migration the change
// implies, (b) the wire-contract delta classified breaking vs additive, and
// (c) an on-demand provenance snapshot capture (`ddd snapshot`).  Every diff
// rides a shipped pure core in the build worker — the same ones the CLI runs.

/** Dot for the dock tab strip: red on any breaking change, yellow when there
 *  are non-breaking changes, else none. */
export function migrationsDot(ctx: LayoutCtx): "red" | "yellow" | null {
  const e = ctx.evolution;
  if (!e || !e.ok) return null;
  if (e.breaking) return "red";
  return e.migrations.length > 0 || e.wireChanges.length > 0 ? "yellow" : null;
}

export function MigrationsBody({
  ctx,
  active = true,
}: {
  ctx: LayoutCtx;
  active?: boolean;
}): JSX.Element {
  // Multi-file / import baselines aren't supported yet — the diff lowers a
  // single entry text on both sides (see M-T8.11).  Gate rather than emit a
  // confusing unresolved-import parse error.
  const multiFile = ctx.sourceFiles.size > 1;
  const canDiff = ctx.buildClient != null && !multiFile;

  // Auto-run once when the tab is opened with no result yet, so the panel
  // isn't a cold "click to compute" wall.  Re-run stays a manual button —
  // the diff re-lowers two whole sources, so we don't fire it on every keystroke.
  useEffect(() => {
    if (active && canDiff && ctx.evolution == null && !ctx.evolutionRunning) {
      ctx.runEvolutionDiff();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, canDiff]);

  const e = ctx.evolution;

  return (
    <Box style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <Group px="sm" py={4} justify="space-between" wrap="nowrap" style={{ flexShrink: 0 }}>
        <Group gap={8} wrap="nowrap">
          <Text size="xs" c="dimmed">
            live source vs last save
          </Text>
          {e?.ok && e.breaking && (
            <Badge size="xs" color="red" variant="filled" data-testid="evolution-breaking">
              breaking
            </Badge>
          )}
        </Group>
        <Button
          size="compact-xs"
          variant="light"
          loading={ctx.evolutionRunning}
          disabled={!canDiff}
          onClick={() => ctx.runEvolutionDiff()}
          data-testid="evolution-refresh"
        >
          Refresh diff
        </Button>
      </Group>
      <Divider />
      <ScrollArea style={{ flex: 1, minHeight: 0 }}>
        <Stack gap="md" p="sm" data-testid="migrations-panel">
          {multiFile ? (
            <Text c="dimmed" size="sm">
              The migration &amp; contract diff currently supports single-file
              workspaces. This workspace has {ctx.sourceFiles.size} source files —
              multi-file baselines are a follow-up (M-T8.11).
            </Text>
          ) : ctx.evolutionRunning && e == null ? (
            <Group gap="xs" py="sm">
              <Loader size="xs" />
              <Text size="sm" c="dimmed">
                Deriving migration &amp; contract diff…
              </Text>
            </Group>
          ) : e == null ? (
            <Text c="dimmed" size="sm">
              Click “Refresh diff” to derive the migration and wire-contract
              change your edits imply since the last save.
            </Text>
          ) : !e.ok ? (
            <Stack gap={4}>
              <Text size="sm" c="red" fw={600}>
                Diff failed — fix the source first.
              </Text>
              {e.diagnostics.map((d, i) => (
                <Text key={i} size="xs" c="dimmed" ff="monospace">
                  {d.message}
                </Text>
              ))}
            </Stack>
          ) : (
            <EvolutionReport e={e} />
          )}

          <Divider label="Provenance snapshots" labelPosition="left" />
          <SnapshotSection ctx={ctx} />
        </Stack>
      </ScrollArea>
    </Box>
  );
}

function EvolutionReport({ e }: { e: EvolutionOk }): JSX.Element {
  return (
    <>
      {/* -- schema migration -------------------------------------------- */}
      <Stack gap={6} data-testid="evolution-migrations">
        <Group gap={8}>
          <Text size="sm" fw={600}>
            Schema migration
          </Text>
          {!e.hasBaseline && (
            <Badge size="xs" variant="light" color="gray">
              no baseline — initial schema
            </Badge>
          )}
        </Group>
        {e.migrations.length === 0 ? (
          <Text size="sm" c="dimmed">
            {e.hasBaseline
              ? "No schema changes since the last save."
              : "No tables to create."}
          </Text>
        ) : (
          e.migrations.map((m) => <MigrationCard key={`${m.module}/${m.version}`} m={m} />)
        )}
      </Stack>

      <Divider />

      {/* -- wire contract ----------------------------------------------- */}
      <Stack gap={6} data-testid="evolution-wire">
        <Text size="sm" fw={600}>
          Wire contract
        </Text>
        {!e.hasBaseline ? (
          <Text size="sm" c="dimmed">
            Save the current source to establish a baseline — contract changes
            are shown against it.
          </Text>
        ) : e.wireChanges.length === 0 ? (
          <Text size="sm" c="dimmed">
            No wire-contract changes — every backend's DTO shape is unchanged.
          </Text>
        ) : (
          <Stack gap={2}>
            {e.wireChanges.map((c, i) => (
              <Group key={i} gap={8} wrap="nowrap" align="flex-start">
                <Badge
                  size="xs"
                  variant="light"
                  color={c.breaking ? "red" : "green"}
                  style={{ flexShrink: 0 }}
                >
                  {c.breaking ? "breaking" : "safe"}
                </Badge>
                <Text size="xs" c="dimmed">
                  <Text span c="bright">
                    {c.entity}
                    {c.field ? `.${c.field}` : ""}
                  </Text>{" "}
                  — {c.detail}
                </Text>
              </Group>
            ))}
          </Stack>
        )}
      </Stack>
    </>
  );
}

function MigrationCard({ m }: { m: MigrationView }): JSX.Element {
  return (
    <Box
      p={8}
      style={{
        border: "1px solid var(--mantine-color-dark-4)",
        borderRadius: 4,
        borderLeftColor: m.destructive
          ? "var(--mantine-color-red-6)"
          : "var(--mantine-color-dark-4)",
        borderLeftWidth: m.destructive ? 3 : 1,
      }}
      data-testid="migration-card"
    >
      <Group gap={8} mb={4} wrap="nowrap">
        <Badge size="xs" variant="light" color={m.destructive ? "red" : "blue"}>
          {m.name}
        </Badge>
        <Text size="xs" c="dimmed">
          {m.module} · v{m.version}
        </Text>
        {m.destructive && (
          <Badge size="xs" color="red" variant="filled">
            destructive
          </Badge>
        )}
      </Group>
      {m.destructive && m.destructiveMessage && (
        <Text size="xs" c="red" mb={4}>
          {m.destructiveMessage.split("\n")[0]} — shown below as the safe
          add-nullable / backfill / set-not-null sequence.
        </Text>
      )}
      <Code block style={{ fontSize: 11, whiteSpace: "pre-wrap" }}>
        {m.steps.map((s) => s.sql).join("\n")}
      </Code>
    </Box>
  );
}

function SnapshotSection({ ctx }: { ctx: LayoutCtx }): JSX.Element {
  const r = ctx.snapshotResult;
  return (
    <Stack gap={6} data-testid="snapshot-section">
      <Group justify="space-between" wrap="nowrap">
        <Text size="xs" c="dimmed">
          Capture immutable provenance rule snapshots — the playground’s{" "}
          <Code style={{ fontSize: 10 }}>ddd snapshot</Code>.
        </Text>
        <Button
          size="compact-xs"
          variant="light"
          loading={ctx.snapshotRunning}
          disabled={ctx.buildClient == null}
          onClick={() => ctx.runCaptureSnapshot()}
          data-testid="snapshot-capture"
        >
          Capture snapshot
        </Button>
      </Group>
      {r == null ? null : !r.ok ? (
        <Text size="xs" c="red">
          {r.diagnostics[0]?.message ?? "Snapshot failed."}
        </Text>
      ) : r.files.length === 0 ? (
        <Text size="xs" c="dimmed">
          No <Code style={{ fontSize: 10 }}>provenanced</Code> field is written in
          this source, so there is no provenance to snapshot.
        </Text>
      ) : (
        <Stack gap={1} data-testid="snapshot-files">
          {r.files.map((f) => (
            <Group key={f.path} gap={6} wrap="nowrap">
              <Badge size="xs" variant="light" color="grape">
                snap
              </Badge>
              <Text size="xs" c="dimmed" ff="monospace" truncate>
                {f.path.replace(/^\.loom\/snapshots\//, "")}
              </Text>
            </Group>
          ))}
        </Stack>
      )}
    </Stack>
  );
}

import {
  Badge,
  Box,
  Button,
  Code,
  Divider,
  Group,
  Loader,
  ScrollArea,
  Select,
  Stack,
  Text,
} from "@mantine/core";
import { useEffect, useMemo, useState } from "react";
import type { CommitInfo } from "../workspace/git";
import type { EvolutionOk, MigrationView } from "../build/protocol";
import { classifyCommit, formatRelativeTime, shortOid } from "./history-format";
import type { LayoutCtx } from "./ctx";
import { destructiveDrops, type TableTint, type TintedTable, tintCounts, tintTables } from "./migration-tint";
import { MIGRATIONS } from "./vocabulary";

// "Migrations" dock tab — the evolution lifecycle, made visible.
//
// The playground regenerates statelessly (keyed by a source hash) and holds
// no "previous version of my system", so schema migrations, wire-contract
// drift, and provenance are invisible side effects.  This tab restores the
// baseline: it diffs the LIVE edit against the last-committed source
// (`HEAD:/workspace/main.ddd`) and shows (a) the schema the change implies
// — as a table diagram tinted by the diff (added / changed / removed /
// untouched) beside the migration SQL, with a destructive change rendered
// as the gate `ddd generate system` would raise — (b) the wire-contract
// delta classified breaking vs additive, and (c) an on-demand provenance
// snapshot capture (`ddd snapshot`).  Every diff rides a shipped pure core
// in the build worker — the same ones the CLI runs.
//
// The comparison auto-runs when the tab opens (M-T8.22 slice 1, audit M8),
// so nothing here ever tells the user to click Refresh to see it.

export function MigrationsBody({
  ctx,
  active = true,
}: {
  ctx: LayoutCtx;
  active?: boolean;
}): JSX.Element {
  // Multi-file / import baselines are supported: the diff ships both whole
  // `.ddd` trees to the worker and lowers them through the project loader
  // (M-T8.11), so imports resolve the same as a generate.
  const canDiff = ctx.buildClient != null;

  // Baseline ref the diff runs against — `HEAD` (last save) by default, or any
  // commit pinned from the picker OR the History tab.  Lives on the ctx (not
  // panel-local) so History's "diff as baseline" can drive it; extends the
  // diff from "changes since I last saved" to "changes since <any milestone>".
  const baselineRef = ctx.evolutionBaselineRef;
  const [commits, setCommits] = useState<CommitInfo[]>([]);
  // The baseline list has a failure branch (audit M18): a git read that
  // fails shows an error row with Retry instead of silently offering only
  // "Last save".
  const [commitsError, setCommitsError] = useState<string | null>(null);
  const [commitsAttempt, setCommitsAttempt] = useState(0);
  const store = ctx.workspace.store;

  useEffect(() => {
    if (!active || !store) return;
    let cancelled = false;
    setCommitsError(null);
    void store
      .log(50)
      .then((c) => {
        if (!cancelled) setCommits(c);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setCommits([]);
          setCommitsError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [active, store, commitsAttempt]);

  // Auto-run once when the tab is opened with no result yet, so the panel
  // isn't a cold "click to compute" wall.  Re-run stays a manual button —
  // the diff re-lowers two whole sources, so we don't fire it on every keystroke.
  useEffect(() => {
    if (active && canDiff && ctx.evolution == null && !ctx.evolutionRunning) {
      ctx.runEvolutionDiff(baselineRef);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, canDiff]);

  const pickBaseline = (ref: string | null): void => {
    if (!ref) return;
    ctx.pinEvolutionBaseline(ref);
  };

  // `HEAD` (last save) plus the recent commits, newest first.  The newest
  // commit IS `HEAD`, so it's labelled as such and the rest offer earlier
  // milestones; autosaves are de-emphasised but still selectable.
  const baselineOptions = [
    { value: "HEAD", label: `${MIGRATIONS.lastSave} (HEAD)` },
    ...commits.slice(1).map((c) => ({
      value: c.oid,
      label: `${classifyCommit(c.message) === "autosave" ? "autosave" : "milestone"} · ${shortOid(
        c.oid,
      )} · ${formatRelativeTime(c.timestamp)}`,
    })),
  ];
  const baselineLabel =
    baselineRef === "HEAD"
      ? MIGRATIONS.lastSave
      : (baselineOptions.find((o) => o.value === baselineRef)?.label ?? shortOid(baselineRef));

  const e = ctx.evolution;

  return (
    <Box style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <Group px="sm" py={4} justify="space-between" wrap="nowrap" style={{ flexShrink: 0 }}>
        <Group gap={8} wrap="nowrap" style={{ minWidth: 0 }}>
          <Text
            size="xs"
            c="dimmed"
            style={{ flexShrink: 0 }}
            component="label"
            htmlFor="evolution-baseline-select"
            data-testid="evolution-baseline-label"
          >
            {MIGRATIONS.compareWith}
          </Text>
          <Select
            id="evolution-baseline-select"
            size="xs"
            value={baselineRef}
            onChange={pickBaseline}
            data={baselineOptions}
            disabled={!canDiff || store == null}
            allowDeselect={false}
            comboboxProps={{ withinPortal: true }}
            style={{ width: 210 }}
            data-testid="evolution-baseline"
          />
          {e?.ok && e.breaking && (
            <Badge size="xs" color="red" variant="filled" data-testid="evolution-breaking">
              breaking
            </Badge>
          )}
        </Group>
        {/* The label stays while the diff runs (a spinner-only button reads
            as "broken"): a small leading loader instead of Mantine's
            `loading` prop, which hides the text. */}
        <Button
          size="compact-xs"
          variant="light"
          disabled={!canDiff || ctx.evolutionRunning}
          leftSection={ctx.evolutionRunning ? <Loader size={10} /> : undefined}
          onClick={() => ctx.runEvolutionDiff(baselineRef)}
          data-testid="evolution-refresh"
          data-loading={ctx.evolutionRunning || undefined}
        >
          {MIGRATIONS.refresh}
        </Button>
      </Group>
      {commitsError && (
        <Group px="sm" pb={4} gap={8} wrap="nowrap" style={{ flexShrink: 0 }} data-testid="evolution-baseline-error">
          <Text size="xs" c="red" style={{ flex: 1 }}>
            Could not list earlier saves — {commitsError}
          </Text>
          <Button size="compact-xs" variant="subtle" onClick={() => setCommitsAttempt((n) => n + 1)} data-testid="evolution-baseline-retry">
            Retry
          </Button>
        </Group>
      )}
      <Divider />
      <ScrollArea style={{ flex: 1, minHeight: 0 }}>
        <Stack gap="md" p="sm" data-testid="migrations-panel">
          {ctx.evolutionRunning && e == null ? (
            <Group gap="xs" py="sm" data-testid="evolution-loading">
              <Loader size="xs" />
              <Text size="sm" c="dimmed">
                {MIGRATIONS.comparing(baselineLabel)}
              </Text>
            </Group>
          ) : e == null ? (
            <Text c="dimmed" size="sm" data-testid="evolution-empty">
              {canDiff ? MIGRATIONS.waitingForWorker : MIGRATIONS.noBuildWorker}
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
            <EvolutionReport e={e} isDesktop={ctx.isDesktop} />
          )}

          <Divider label="Provenance snapshots" labelPosition="left" />
          <SnapshotSection ctx={ctx} />
        </Stack>
      </ScrollArea>
    </Box>
  );
}

function EvolutionReport({ e, isDesktop }: { e: EvolutionOk; isDesktop: boolean }): JSX.Element {
  const tinted = useMemo(() => tintTables(e), [e]);
  return (
    <>
      {/* -- schema: diagram beside the SQL -------------------------------- */}
      <Stack gap={6} data-testid="evolution-migrations">
        <Group gap={8}>
          <Text size="sm" fw={600}>
            {MIGRATIONS.schemaHeading}
          </Text>
          {!e.hasBaseline && (
            <Badge size="xs" variant="light" color="gray">
              no baseline — initial schema
            </Badge>
          )}
          <TintLegend tables={tinted} />
        </Group>
        <Group
          gap="md"
          align="flex-start"
          wrap={isDesktop ? "nowrap" : "wrap"}
          style={{ width: "100%" }}
        >
          <Box style={{ flex: isDesktop ? "0 1 45%" : "1 1 100%", minWidth: 0 }}>
            <SchemaDiagram tables={tinted} />
          </Box>
          <Stack gap={6} style={{ flex: isDesktop ? "1 1 55%" : "1 1 100%", minWidth: 0 }}>
            {e.migrations.length === 0 ? (
              <Text size="sm" c="dimmed">
                {e.hasBaseline ? "No schema changes since the last save." : "No tables to create."}
              </Text>
            ) : (
              e.migrations.map((m) => <MigrationCard key={`${m.module}/${m.version}`} m={m} />)
            )}
          </Stack>
        </Group>
      </Stack>

      <Divider />

      {/* -- wire contract ----------------------------------------------- */}
      <Stack gap={6} data-testid="evolution-wire">
        <Text size="sm" fw={600}>
          {MIGRATIONS.wireHeading}
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

// ---------------------------------------------------------------------
// The tinted schema diagram.  One card per table (columns listed, changed
// ones highlighted, FK targets named), laid out as a wrapping grid — a
// layout pass would be over-engineering for the ~5–30 tables a playground
// system has.  Colour is never the only carrier: each card also names its
// tint in text (audit M11's rule, applied here too).
// ---------------------------------------------------------------------

const TINT_COLOUR: Record<TableTint, string> = {
  added: "green",
  changed: "yellow",
  removed: "red",
  untouched: "gray",
};

function TintLegend({ tables }: { tables: TintedTable[] }): JSX.Element | null {
  if (tables.length === 0) return null;
  const counts = tintCounts(tables);
  const order: TableTint[] = ["added", "changed", "removed", "untouched"];
  return (
    <Group gap={6} wrap="wrap" data-testid="evolution-tint-legend">
      {order
        .filter((t) => counts[t] > 0)
        .map((t) => (
          <Badge key={t} size="xs" variant="light" color={TINT_COLOUR[t]}>
            {counts[t]} {MIGRATIONS.tint[t]}
          </Badge>
        ))}
    </Group>
  );
}

function SchemaDiagram({ tables }: { tables: TintedTable[] }): JSX.Element {
  if (tables.length === 0) {
    return (
      <Text size="xs" c="dimmed" data-testid="evolution-diagram-empty">
        No tables — this source declares no persisted aggregate.
      </Text>
    );
  }
  return (
    <Box
      data-testid="evolution-diagram"
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))",
        gap: 8,
      }}
    >
      {tables.map((t) => (
        <TableCard key={`${t.module}\0${t.name}`} t={t} />
      ))}
    </Box>
  );
}

function TableCard({ t }: { t: TintedTable }): JSX.Element {
  const colour = TINT_COLOUR[t.tint];
  const dim = t.tint === "untouched";
  return (
    <Box
      p={6}
      data-testid="evolution-table"
      data-tint={t.tint}
      data-table={t.name}
      style={{
        border: `1px solid var(--mantine-color-${colour}-${dim ? 7 : 6})`,
        borderLeftWidth: 3,
        borderRadius: 4,
        opacity: dim ? 0.55 : 1,
        background: dim ? undefined : `color-mix(in srgb, var(--mantine-color-${colour}-6) 8%, transparent)`,
        minWidth: 0,
      }}
    >
      <Group gap={6} wrap="nowrap" mb={2}>
        <Text size="xs" fw={600} ff="monospace" truncate style={{ flex: 1 }} title={t.schema ? `${t.schema}.${t.name}` : t.name}>
          {t.name}
        </Text>
        <Badge size="xs" variant="light" color={colour} style={{ flexShrink: 0 }}>
          {MIGRATIONS.tint[t.tint]}
        </Badge>
      </Group>
      {t.columns.length > 0 && (
        <Stack gap={0}>
          {t.columns.map((c) => {
            const changed = t.changedColumns.includes(c);
            return (
              <Text
                key={c}
                size="xs"
                ff="monospace"
                c={changed ? `${colour}.4` : "dimmed"}
                fw={changed ? 600 : undefined}
                truncate
                data-changed={changed || undefined}
              >
                {c}
              </Text>
            );
          })}
          {/* A dropped column is no longer in the shape — list it struck. */}
          {t.changedColumns
            .filter((c) => !t.columns.includes(c))
            .map((c) => (
              <Text key={`${c}\0gone`} size="xs" ff="monospace" c="red.4" td="line-through" truncate>
                {c}
              </Text>
            ))}
        </Stack>
      )}
      {t.refs.length > 0 && (
        <Text size="xs" c="dimmed" mt={2} truncate title={`→ ${t.refs.join(", ")}`}>
          → {t.refs.join(", ")}
        </Text>
      )}
    </Box>
  );
}

// ---------------------------------------------------------------------
// One migration's SQL — and, when the non-destructive gate tripped, the gate
// itself: what `ddd generate system` refuses, the flag that lets it through,
// and the data that would go.
// ---------------------------------------------------------------------

function MigrationCard({ m }: { m: MigrationView }): JSX.Element {
  const drops = m.destructive ? destructiveDrops(m) : [];
  return (
    <Box
      p={8}
      style={{
        border: "1px solid var(--mantine-color-default-border)",
        borderRadius: 4,
        borderLeftColor: m.destructive ? "var(--mantine-color-red-6)" : "var(--mantine-color-default-border)",
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
      {m.destructive && (
        <Box
          p={6}
          mb={6}
          data-testid="migration-destructive-gate"
          style={{
            border: "1px solid var(--mantine-color-red-6)",
            borderRadius: 4,
            background: "color-mix(in srgb, var(--mantine-color-red-6) 8%, transparent)",
          }}
        >
          <Text size="xs" fw={600} c="red">
            {MIGRATIONS.destructiveTitle}
          </Text>
          {m.destructiveMessage && (
            <Text size="xs" c="dimmed" mt={2}>
              {m.destructiveMessage.split("\n")[0]}
            </Text>
          )}
          <Text size="xs" c="dimmed" mt={2}>
            {MIGRATIONS.destructiveBody}
          </Text>
          <Code style={{ fontSize: 10 }} mt={4}>
            ddd generate system main.ddd {MIGRATIONS.destructiveFlag}
          </Code>
          {drops.length > 0 && (
            <Box mt={4}>
              <Text size="xs" fw={600}>
                {MIGRATIONS.destructiveDropsHeading}
              </Text>
              <Stack gap={0}>
                {drops.map((d) => (
                  <Text key={d} size="xs" c="red.4" ff="monospace">
                    − {d}
                  </Text>
                ))}
              </Stack>
            </Box>
          )}
        </Box>
      )}
      <Text size="xs" c="dimmed" mb={2}>
        {MIGRATIONS.sqlHeading}
      </Text>
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

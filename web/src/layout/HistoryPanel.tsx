import {
  Badge,
  Box,
  Button,
  Code,
  Group,
  Loader,
  ScrollArea,
  Stack,
  Switch,
  Text,
  UnstyledButton,
} from "@mantine/core";
import { useEffect, useMemo, useState } from "react";
import { type CommitFileChange, type CommitInfo, commitOnSave } from "../workspace/git";
import type { LayoutCtx } from "./ctx";
import { classifyCommit, formatRelativeTime, shortOid } from "./history-format";

// "History" dock tab — a visible timeline of the git-backed workspace.
// Commits accrue from the debounced autosave ("autosave workspace"),
// intentional generates ("regenerate") and first boot ("import legacy
// workspace").  Read-only: lists commits and, on expand, the files each
// changed (via `store.commitChanges`).  No restore/checkout — that write
// path was deliberately removed.

const WORKSPACE_PREFIX = "/workspace/";
const STATUS_COLOR: Record<CommitFileChange["status"], string> = {
  added: "green",
  modified: "yellow",
  removed: "red",
};

export function HistoryBody({
  ctx,
  active = true,
}: {
  ctx: LayoutCtx;
  /** Whether this is the visible tab.  Mobile keeps panels mounted, so
   *  gate the (async git) reads on visibility; desktop only mounts the
   *  active tab, so the default suffices. */
  active?: boolean;
}): JSX.Element {
  const store = ctx.workspace.store;
  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [hideAutosaves, setHideAutosaves] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [changes, setChanges] = useState<Record<string, CommitFileChange[]>>({});
  // Inline "restore this version" confirm + in-flight state, keyed by oid.
  const [confirmOid, setConfirmOid] = useState<string | null>(null);
  const [restoringOid, setRestoringOid] = useState<string | null>(null);
  // Re-render periodically so relative timestamps stay fresh.
  const [, setNowTick] = useState(0);

  useEffect(() => {
    if (!active || !store) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = (): void => {
      void store
        .log(200)
        .then((c) => {
          if (!cancelled) {
            setCommits(c);
            setLoaded(true);
          }
        })
        .catch(() => {
          // Empty repo (no HEAD yet) → no history; not an error.
          if (!cancelled) {
            setCommits([]);
            setLoaded(true);
          }
        });
    };
    load();
    // Coalesce bursts of workspace events into one reload.
    const unsubscribe = store.subscribe(WORKSPACE_PREFIX, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(load, 400);
    });
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [active, store]);

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNowTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, [active]);

  const shown = useMemo(
    () => (hideAutosaves ? commits.filter((c) => classifyCommit(c.message) !== "autosave") : commits),
    [commits, hideAutosaves],
  );

  const toggle = (oid: string): void => {
    setExpanded((cur) => (cur === oid ? null : oid));
    if (!changes[oid] && store) {
      void store.commitChanges(oid).then((fc) => {
        setChanges((prev) => ({ ...prev, [oid]: fc }));
      });
    }
  };

  const restore = (oid: string): void => {
    if (!store) return;
    setRestoringOid(oid);
    void (async () => {
      try {
        await store.restoreCommit(oid);
        await commitOnSave(store, `restore to ${shortOid(oid)}`);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("restore failed:", err);
      } finally {
        setRestoringOid(null);
        setConfirmOid(null);
      }
    })();
  };

  // The newest commit is the current state — restoring to it is a no-op.
  const headOid = commits[0]?.oid;

  if (!store) {
    return (
      <Text c="dimmed" size="sm" p="sm">
        Workspace history is unavailable — persistent storage isn't accessible
        in this browser, so the playground is running in ephemeral mode.
      </Text>
    );
  }

  return (
    <Box style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <Group px="sm" py={4} justify="space-between" wrap="nowrap" style={{ flexShrink: 0 }}>
        <Text size="xs" c="dimmed">
          {shown.length} commit{shown.length === 1 ? "" : "s"}
        </Text>
        <Switch
          size="xs"
          checked={hideAutosaves}
          onChange={(e) => setHideAutosaves(e.currentTarget.checked)}
          label="Hide autosaves"
          data-testid="history-hide-autosaves"
        />
      </Group>
      <ScrollArea style={{ flex: 1, minHeight: 0 }}>
        <Stack gap={2} px="sm" pb="sm" data-testid="history-list">
          {loaded && shown.length === 0 && (
            <Text c="dimmed" size="sm" py="sm">
              No history yet — your edits and generates will appear here.
            </Text>
          )}
          {!loaded && (
            <Group gap="xs" py="sm">
              <Loader size="xs" />
              <Text size="sm" c="dimmed">
                Loading history…
              </Text>
            </Group>
          )}
          {shown.map((c) => {
            const kind = classifyCommit(c.message);
            const isOpen = expanded === c.oid;
            const fc = changes[c.oid];
            return (
              <Box key={c.oid} data-testid="history-row">
                <UnstyledButton
                  onClick={() => toggle(c.oid)}
                  style={{ width: "100%", borderRadius: 4 }}
                  px={6}
                  py={4}
                  data-active={isOpen || undefined}
                >
                  <Group gap={8} wrap="nowrap">
                    <Badge
                      size="xs"
                      variant="light"
                      color={kind === "autosave" ? "gray" : "blue"}
                    >
                      {kind === "autosave" ? "autosave" : "milestone"}
                    </Badge>
                    <Text size="sm" style={{ flex: 1 }} truncate>
                      {c.message}
                    </Text>
                    <Text size="xs" c="dimmed" title={c.author.name}>
                      {formatRelativeTime(c.timestamp)}
                    </Text>
                    <Code style={{ fontSize: 10 }}>{shortOid(c.oid)}</Code>
                  </Group>
                </UnstyledButton>
                {isOpen && (
                  <Box pl={28} pb={6} data-testid="history-changes">
                    {fc == null ? (
                      <Group gap="xs" py={2}>
                        <Loader size={10} />
                        <Text size="xs" c="dimmed">
                          Loading changes…
                        </Text>
                      </Group>
                    ) : fc.length === 0 ? (
                      <Text size="xs" c="dimmed">
                        No tracked file changes.
                      </Text>
                    ) : (
                      <Stack gap={1}>
                        {fc.map((f) => (
                          <Group key={f.path} gap={6} wrap="nowrap">
                            <Badge size="xs" variant="light" color={STATUS_COLOR[f.status]}>
                              {f.status[0]!.toUpperCase()}
                            </Badge>
                            <Text size="xs" c="dimmed" truncate>
                              {f.path.replace(WORKSPACE_PREFIX, "")}
                            </Text>
                          </Group>
                        ))}
                      </Stack>
                    )}
                    {/* One-click "diff against this milestone": pin this
                        commit as the evolution baseline and jump to the
                        Migrations tab.  Desktop-only — the Migrations tab
                        lives in the desktop dock. */}
                    {ctx.isDesktop && (
                      <Box mt={6}>
                        <Button
                          size="compact-xs"
                          variant="light"
                          onClick={() => ctx.pinEvolutionBaseline(c.oid)}
                          data-testid="history-diff-baseline"
                        >
                          Diff as baseline
                        </Button>
                      </Box>
                    )}
                    {c.oid !== headOid && (
                      <Box mt={6}>
                        {confirmOid === c.oid ? (
                          <Group gap={6} wrap="nowrap" data-testid="history-restore-confirm">
                            <Text size="xs" c="dimmed" style={{ flex: 1 }}>
                              Restore the workspace to this version?
                            </Text>
                            <Button
                              size="compact-xs"
                              color="orange"
                              loading={restoringOid === c.oid}
                              onClick={() => restore(c.oid)}
                              data-testid="history-restore-do"
                            >
                              Restore
                            </Button>
                            <Button
                              size="compact-xs"
                              variant="subtle"
                              disabled={restoringOid === c.oid}
                              onClick={() => setConfirmOid(null)}
                            >
                              Cancel
                            </Button>
                          </Group>
                        ) : (
                          <Button
                            size="compact-xs"
                            variant="light"
                            onClick={() => setConfirmOid(c.oid)}
                            data-testid="history-restore"
                          >
                            Restore this version
                          </Button>
                        )}
                      </Box>
                    )}
                  </Box>
                )}
              </Box>
            );
          })}
        </Stack>
      </ScrollArea>
    </Box>
  );
}

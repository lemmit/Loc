import {
  Alert,
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
import { readOnlyMessage } from "../workspace/workspace-sources";
import { InlineConfirm, confirmSites } from "../util/confirm";
import type { LayoutCtx } from "./ctx";
import {
  classifyCommit,
  COMMIT_KIND_COLOR,
  COMMIT_KIND_LABEL,
  formatRelativeTime,
  shortOid,
} from "./history-format";

// "History" dock tab — a visible timeline of the git-backed workspace.
// Commits accrue from the debounced autosave ("autosave workspace"),
// intentional generates ("regenerate") and first boot ("import legacy
// workspace").  Lists commits and, on expand, the files each changed
// (via `store.commitChanges`).
//
// The one write path is "Restore this version": `store.restoreCommit`
// rewrites the working tree (and re-baselines the generated-merge ref),
// which is committed as a NEW commit — history stays linear, nothing is
// rewritten.  The restore has to be VISIBLE, so it also schedules a
// regenerate; the editor follows through the sources controller's
// external-content epoch (see `workspace-sources.ts`).

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
  // "Restore this version" is a WRITE (it rewrites the working tree and
  // re-baselines the generated-merge ref), so it is suppressed — and says
  // why — while another tab owns the writer lock.
  const writable = ctx.workspace.writable;
  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [hideAutosaves, setHideAutosaves] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  // Per-commit file changes, with a FAILURE branch (audit M18): a git read
  // that rejects shows an error row + Retry instead of "Loading changes…"
  // forever.
  type ChangesSlot = { kind: "ok"; files: CommitFileChange[] } | { kind: "error"; message: string };
  const [changes, setChanges] = useState<Record<string, ChangesSlot>>({});
  // Inline "restore this version" confirm + in-flight state, keyed by oid.
  const [confirmOid, setConfirmOid] = useState<string | null>(null);
  const [restoringOid, setRestoringOid] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
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
    // File events alone leave the list stale: autosave commits land ~1.1 s
    // AFTER the debounce above has already reloaded.  Commits have their
    // own channel (reads only — it can't feed back into a commit).
    const unsubscribeCommits = store.subscribeCommits(load);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      unsubscribe();
      unsubscribeCommits();
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

  const loadChanges = (oid: string): void => {
    if (!store) return;
    setChanges((prev) => {
      const next = { ...prev };
      delete next[oid];
      return next;
    });
    void store
      .commitChanges(oid)
      .then((fc) => {
        setChanges((prev) => ({ ...prev, [oid]: { kind: "ok", files: fc } }));
      })
      .catch((err: unknown) => {
        setChanges((prev) => ({
          ...prev,
          [oid]: { kind: "error", message: err instanceof Error ? err.message : String(err) },
        }));
      });
  };

  const toggle = (oid: string): void => {
    setExpanded((cur) => (cur === oid ? null : oid));
    if (!changes[oid]) loadChanges(oid);
  };

  const restore = (oid: string): void => {
    if (!store || !writable) return;
    setRestoringOid(oid);
    setRestoreError(null);
    void (async () => {
      try {
        await store.restoreCommit(oid);
        await commitOnSave(store, `restore to ${shortOid(oid)}`);
        // The editor follows via the sources controller's external-content
        // epoch; the generated files + preview only follow if something
        // asks for them — a restore is exactly such a request.
        ctx.scheduleAutoGenerate(200);
        setConfirmOid(null);
      } catch (err) {
        setRestoreError(err instanceof Error ? err.message : String(err));
      } finally {
        setRestoringOid(null);
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
      {!writable && (
        <Group px="sm" py={6} gap={8} wrap="nowrap" style={{ flexShrink: 0 }}>
          <Text size="xs" c="dimmed" style={{ flex: 1 }} data-testid="history-readonly">
            {readOnlyMessage("other-tab")}
          </Text>
          {/* No "Take over" here on purpose — the header banner owns that one
              action, so there is exactly one place to click and exactly one
              `workspace-readonly-banner` in the DOM. */}
          <Button size="compact-xs" variant="light" color="orange" onClick={ctx.workspace.takeOver}>
            Take over
          </Button>
        </Group>
      )}
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
      {restoreError && (
        <Alert
          color="red"
          variant="light"
          mx="sm"
          mb={4}
          withCloseButton
          onClose={() => setRestoreError(null)}
          title="Restore failed"
          data-testid="history-restore-error"
          style={{ flexShrink: 0 }}
        >
          <Text size="xs">{restoreError}</Text>
        </Alert>
      )}
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
                      color={COMMIT_KIND_COLOR[kind]}
                      data-testid={`history-kind-${kind}`}
                    >
                      {COMMIT_KIND_LABEL[kind]}
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
                    ) : fc.kind === "error" ? (
                      <Group gap={8} py={2} wrap="wrap" data-testid="history-changes-error">
                        <Text size="xs" c="red" style={{ flex: 1, minWidth: 160 }}>
                          Could not read this commit's changes — {fc.message}
                        </Text>
                        <Button
                          size="compact-xs"
                          variant="subtle"
                          onClick={() => loadChanges(c.oid)}
                          data-testid="history-changes-retry"
                        >
                          Retry
                        </Button>
                      </Group>
                    ) : fc.files.length === 0 ? (
                      <Text size="xs" c="dimmed">
                        No tracked file changes.
                      </Text>
                    ) : (
                      <Stack gap={1}>
                        {fc.files.map((f) => (
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
                    {c.oid !== headOid && writable && (
                      <Box mt={6}>
                        {confirmOid === c.oid ? (
                          // The copy says BOTH halves of what restore does:
                          // the live edits are replaced, and the restore is
                          // recorded as a new commit (`commitOnSave` above),
                          // so it is itself restorable from this list.
                          <InlineConfirm
                            spec={confirmSites.historyRestore(shortOid(c.oid))}
                            stacked
                            size="compact-xs"
                            loading={restoringOid === c.oid}
                            onConfirm={() => restore(c.oid)}
                            onCancel={() => setConfirmOid(null)}
                            testids={{
                              base: "history-restore",
                              root: "history-restore-confirm",
                              yes: "history-restore-do",
                            }}
                          />
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

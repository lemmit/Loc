// ---------------------------------------------------------------------------
// WorkspaceTree — tiny inline list of imported design packs.
//
// Reads `/workspace/design/<pack>/...` from the IDB-backed
// workspace VFS and groups by pack name.  Each entry shows the
// pack's file count and a delete button that removes every file
// for that pack from both the workspace VFS (persistence) and the
// build worker's VFS (immediate effect).
//
// Built-in packs (`/designs/...`) are NOT shown here — they live in
// the worker bundle, not the workspace, and aren't user-managed.
// ---------------------------------------------------------------------------

import { ActionIcon, Badge, Group, Text, Tooltip } from "@mantine/core";
import { useEffect, useState } from "react";
import type { LoomBuildClient } from "../build/client.js";
import type { GitStore } from "./git/index.js";

interface Props {
  workspaceStore: GitStore | null;
  buildClient: LoomBuildClient | null;
}

interface PackSummary {
  name: string;
  paths: string[];
}

const DESIGN_PREFIX = "/workspace/design/";

async function summarisePacks(store: GitStore | null): Promise<PackSummary[]> {
  if (!store) return [];
  const grouped = new Map<string, string[]>();
  for (const path of await store.list(DESIGN_PREFIX)) {
    const rest = path.slice(DESIGN_PREFIX.length);
    const slash = rest.indexOf("/");
    const name = slash < 0 ? rest : rest.slice(0, slash);
    const arr = grouped.get(name) ?? [];
    arr.push(path);
    grouped.set(name, arr);
  }
  return Array.from(grouped, ([name, paths]) => ({ name, paths })).sort(
    (a, b) => a.name.localeCompare(b.name),
  );
}

export function WorkspaceTree({ workspaceStore, buildClient }: Props): JSX.Element | null {
  // Derive the pack list from the store.  Rebuild on every store
  // mutation under /workspace/design/ via the subscribe hook —
  // imports/deletes propagate without a manual refresh.  Reads are
  // async (git-backed), so the list lands in state.
  const [packs, setPacks] = useState<PackSummary[]>([]);
  useEffect(() => {
    if (!workspaceStore) {
      setPacks([]);
      return;
    }
    let cancelled = false;
    const rebuild = (): void => {
      void summarisePacks(workspaceStore).then((p) => {
        if (!cancelled) setPacks(p);
      });
    };
    rebuild();
    const unsubscribe = workspaceStore.subscribe(DESIGN_PREFIX, rebuild);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [workspaceStore]);

  if (packs.length === 0) return null;

  async function removePack(name: string, paths: string[]): Promise<void> {
    if (workspaceStore) {
      for (const p of paths) await workspaceStore.deleteFile(p);
    }
    if (buildClient) {
      await buildClient.vfsDelete(paths);
    }
  }

  return (
    <Group gap="xs" data-testid="workspace-packs">
      <Text size="xs" c="dimmed">
        Imported packs:
      </Text>
      {packs.map((p) => (
        <Badge
          key={p.name}
          size="sm"
          variant="light"
          data-testid={`workspace-pack-${p.name}`}
          rightSection={
            <Tooltip label={`Remove "${p.name}" pack`}>
              <ActionIcon
                size="xs"
                variant="transparent"
                onClick={() => void removePack(p.name, p.paths)}
                data-testid={`btn-remove-pack-${p.name}`}
                aria-label={`Remove ${p.name} pack`}
              >
                {/* Plain unicode glyph — avoids pulling in an icon
                    library for one button (the rest of the playground
                    has the same constraint, see Preview.tsx). */}
                ×
              </ActionIcon>
            </Tooltip>
          }
        >
          {p.name} ({p.paths.length})
        </Badge>
      ))}
    </Group>
  );
}

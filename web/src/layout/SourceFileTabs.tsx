// ---------------------------------------------------------------------------
// `SourceFileTabs` — horizontal tab strip above the Monaco editor
// showing every `.ddd` file in `/workspace/`.
//
// Phase 2b2 of the multi-file playground work.  The state model
// (controller + hook + ctx wiring) is in place from Phase 2a / 2b1
// — this is the visible UI that lets users switch between, create,
// and delete files.
//
// Design:
//   - One tab per `/workspace/*.ddd` file, sorted with `main.ddd`
//     first so it's a stable left anchor.
//   - Active tab gets the highlighted background.
//   - "+" button at the right opens an inline name prompt that
//     accepts an identifier-ish basename and creates
//     `/workspace/<basename>.ddd` with an empty body.
//   - "×" button per tab (except `main.ddd`) deletes the file from
//     the VFS.  No confirm dialog — the user can re-create from
//     the "+" button if they regret it.  `main.ddd` is non-
//     deletable because the generator's entry point assumes it.
// ---------------------------------------------------------------------------

import { useCallback, useState } from "react";
import { ActionIcon, Box, Button, Group, Text, TextInput, Tooltip } from "@mantine/core";
import { DEFAULT_PATH } from "../workspace/workspace-sources";
import {
  normaliseNewFilePath,
  validateNewFileBasename,
} from "./source-file-tabs-validation";

const WORKSPACE_PREFIX = "/workspace/";

// Re-export the validation helpers so consumers (and tests) can
// reach them without knowing the implementation lives in a sibling
// `.ts` file (extracted from the `.tsx` so vitest doesn't have to
// resolve the React JSX runtime).
export { normaliseNewFilePath, validateNewFileBasename };

export interface SourceFileTabsProps {
  /** Every `.ddd` source under `/workspace/`, from the workspace-
   *  sources controller. */
  files: ReadonlyMap<string, string>;
  /** The currently-active file's workspace path. */
  activePath: string;
  /** Switch which file the editor shows. */
  onSelect: (path: string) => void;
  /** Create a new `/workspace/<basename>.ddd`.  The strip surfaces
   *  validation (empty / duplicate / illegal characters); the
   *  callback always receives a path the strip believes to be valid
   *  and new. */
  onCreate: (path: string) => void;
  /** Delete a file from the VFS.  Strip never calls this for
   *  `main.ddd` (the delete button isn't rendered there). */
  onDelete: (path: string) => void;
  /** Bumps the strip's touch-target sizes (× / + actions) and font
   *  size so the tabs are thumb-friendly on the mobile shell.
   *  Default = false (desktop densities).  EditorPane wires this
   *  to `!ctx.isDesktop`. */
  compact?: boolean;
}

/** Sort filenames `main.ddd` first, then lexicographically.  Stable
 *  ordering so the active tab doesn't move when a file is added
 *  later in the alphabet. */
function orderTabs(paths: Iterable<string>): string[] {
  const xs = [...paths].sort();
  const i = xs.indexOf(DEFAULT_PATH);
  if (i > 0) {
    xs.splice(i, 1);
    xs.unshift(DEFAULT_PATH);
  }
  return xs;
}

/** Display name shown on the tab — strip the `/workspace/` prefix
 *  but keep any sub-folder so nested imports remain readable
 *  (`shared/money.ddd`). */
function displayName(path: string): string {
  return path.startsWith(WORKSPACE_PREFIX) ? path.slice(WORKSPACE_PREFIX.length) : path;
}

export function SourceFileTabs(props: SourceFileTabsProps): JSX.Element {
  const compact = props.compact ?? false;
  // Density knobs.  Mobile pads bigger touch targets (`sm` action
  // icons are ~26 px, "xs" are ~18 px) and bumps the font so file
  // names are scannable with a thumb without zooming.  Numbers
  // chosen to roughly match the existing mobile SegmentedControl
  // density elsewhere in the shell.
  const fontSize = compact ? 13 : 12;
  const tabPaddingV = compact ? 6 : 4;
  const tabPaddingH = compact ? 10 : 8;
  const actionIconSize: "xs" | "sm" = compact ? "sm" : "xs";

  const tabs = orderTabs(props.files.keys());
  // Ensure the active path always has a tab even when it doesn't
  // exist in the VFS yet (e.g. the first edit on main.ddd hasn't
  // landed a write).  Otherwise the user types into a "phantom"
  // tab with nothing highlighted.
  if (!tabs.includes(props.activePath)) {
    tabs.unshift(props.activePath);
  }

  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState("");
  const existingPaths = new Set(props.files.keys());
  const draftError = creating ? validateNewFileBasename(draft, existingPaths) : undefined;

  const startCreate = useCallback(() => {
    setDraft("");
    setCreating(true);
  }, []);
  const cancelCreate = useCallback(() => {
    setCreating(false);
    setDraft("");
  }, []);
  const submitCreate = useCallback(() => {
    if (draftError || draft.trim() === "") return;
    const fullPath = normaliseNewFilePath(draft);
    props.onCreate(fullPath);
    setCreating(false);
    setDraft("");
  }, [draft, draftError, props]);

  return (
    <Box
      data-testid="source-file-tabs"
      style={{
        display: "flex",
        alignItems: "stretch",
        gap: 0,
        padding: "2px 4px",
        background: "var(--mantine-color-dark-6)",
        borderBottom: "1px solid var(--mantine-color-dark-4)",
        overflowX: "auto",
        flex: "0 0 auto",
      }}
    >
      {tabs.map((path) => {
        const isActive = path === props.activePath;
        const isDeletable = path !== DEFAULT_PATH;
        return (
          <Box
            key={path}
            data-active={isActive ? "true" : undefined}
            data-path={path}
            onClick={() => {
              if (!isActive) props.onSelect(path);
            }}
            style={{
              display: "flex",
              alignItems: "center",
              padding: `${tabPaddingV}px ${tabPaddingH}px ${tabPaddingV}px ${tabPaddingH + 2}px`,
              marginRight: 2,
              gap: compact ? 6 : 4,
              cursor: isActive ? "default" : "pointer",
              background: isActive
                ? "var(--mantine-color-dark-7)"
                : "transparent",
              borderRadius: 4,
              border: "1px solid",
              borderColor: isActive
                ? "var(--mantine-color-dark-3)"
                : "transparent",
              fontFamily: "var(--mantine-font-family-monospace)",
              fontSize,
              whiteSpace: "nowrap",
            }}
          >
            <Text size={compact ? "sm" : "xs"} c={isActive ? undefined : "dimmed"}>
              {displayName(path)}
            </Text>
            {isDeletable && (
              <Tooltip label="Delete file" withArrow openDelay={400}>
                <ActionIcon
                  size={actionIconSize}
                  variant="subtle"
                  color="gray"
                  aria-label={`Delete ${displayName(path)}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    props.onDelete(path);
                  }}
                >
                  ×
                </ActionIcon>
              </Tooltip>
            )}
          </Box>
        );
      })}
      {creating ? (
        // Mobile: stack vertically so the TextInput gets full width
        // and the Add/Cancel buttons don't overflow off-screen.
        // Desktop: classic inline row.
        compact ? (
          <Box
            ml={4}
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 4,
              padding: "4px 0",
              minWidth: 240,
            }}
          >
            <TextInput
              size="sm"
              autoFocus
              placeholder="new-file or sub/dir/name"
              value={draft}
              error={draftError}
              onChange={(e) => setDraft(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitCreate();
                else if (e.key === "Escape") cancelCreate();
              }}
            />
            <Group gap={6} wrap="nowrap">
              <Button size="xs" variant="default" onClick={submitCreate} disabled={!!draftError}>
                Add
              </Button>
              <Button size="xs" variant="subtle" color="gray" onClick={cancelCreate}>
                Cancel
              </Button>
            </Group>
          </Box>
        ) : (
          <Group gap={4} ml={4} wrap="nowrap" align="center">
            <TextInput
              size="xs"
              autoFocus
              placeholder="new-file or sub/dir/name"
              value={draft}
              error={draftError}
              onChange={(e) => setDraft(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitCreate();
                else if (e.key === "Escape") cancelCreate();
              }}
              styles={{ input: { minWidth: 220 } }}
            />
            <Button size="xs" variant="default" onClick={submitCreate} disabled={!!draftError}>
              Add
            </Button>
            <Button size="xs" variant="subtle" color="gray" onClick={cancelCreate}>
              Cancel
            </Button>
          </Group>
        )
      ) : (
        <Tooltip label="Add a new .ddd file" withArrow openDelay={400}>
          <ActionIcon
            size={compact ? "md" : "sm"}
            variant="subtle"
            color="gray"
            aria-label="Add a new .ddd file"
            onClick={startCreate}
            ml={4}
          >
            +
          </ActionIcon>
        </Tooltip>
      )}
    </Box>
  );
}

import { Badge, Box, Group, ScrollArea, Text, UnstyledButton } from "@mantine/core";
import { useMemo } from "react";

import type { ApiOperationView, VirtualFile } from "../build/protocol";
import { diagramDocs, groupOperations, traceabilityDocs } from "../preview/loom-views";
import type { LoomDoc } from "../preview/loom-views";
import type { LayoutCtx } from "./ctx";
import { API_VIEW, DIAGRAMS, TRACEABILITY_VIEW } from "./vocabulary";

// The `.loom/` bundle as Explorer views (M-T8.20 slice 1).
//
// Three panes that sit where the file tree does and read ONLY what the build
// worker already produced: the mermaid diagrams and the traceability reports
// are files (a row opens them in the centre viewer, which already renders
// both formats — `preview/doc-viewers.tsx`), and the API surface is the
// worker's IR-derived operation list.  Nothing here re-derives a diagram, a
// report or a route; the files stay browsable under *Generated* exactly as
// before.

interface DocListProps {
  docs: LoomDoc[];
  activePath: string | null;
  onOpen: (doc: LoomDoc) => void;
  hint: string;
  empty: string;
  testid: string;
}

/** Shared list chrome for the two file-backed views. */
function DocList({ docs, activePath, onOpen, hint, empty, testid }: DocListProps): JSX.Element {
  if (docs.length === 0) {
    return (
      <Text size="sm" c="dimmed" p="sm" data-testid={`${testid}-empty`}>
        {empty}
      </Text>
    );
  }
  return (
    <Box style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <Text size="xs" c="dimmed" px="sm" py={6}>
        {hint}
      </Text>
      <ScrollArea style={{ flex: 1, minHeight: 0 }} data-testid={testid}>
        <Box px={4} pb="sm">
          {docs.map((doc) => (
            <UnstyledButton
              key={doc.path}
              onClick={() => onOpen(doc)}
              data-testid={`${testid}-row`}
              data-path={doc.path}
              data-active={activePath === doc.path || undefined}
              px={8}
              py={6}
              style={{
                display: "block",
                width: "100%",
                borderRadius: 4,
                background:
                  activePath === doc.path ? "var(--mantine-color-blue-9)" : "transparent",
              }}
            >
              <Text size="sm" fw={500} c={activePath === doc.path ? "white" : undefined}>
                {doc.label}
              </Text>
              {doc.blurb && (
                <Text size="xs" c={activePath === doc.path ? "gray.3" : "dimmed"}>
                  {doc.blurb}
                </Text>
              )}
            </UnstyledButton>
          ))}
        </Box>
      </ScrollArea>
    </Box>
  );
}

export function DiagramsPane({
  files,
  activePath,
  isDesktop,
  onOpen,
}: {
  files: VirtualFile[];
  activePath: string | null;
  isDesktop: boolean;
  onOpen: (doc: LoomDoc) => void;
}): JSX.Element {
  const docs = useMemo(() => diagramDocs(files), [files]);
  return (
    <DocList
      docs={docs}
      activePath={activePath}
      onOpen={onOpen}
      hint={DIAGRAMS.hint}
      empty={DIAGRAMS.empty(isDesktop)}
      testid="diagrams-view"
    />
  );
}

export function TraceabilityPane({
  files,
  activePath,
  isDesktop,
  onOpen,
}: {
  files: VirtualFile[];
  activePath: string | null;
  isDesktop: boolean;
  onOpen: (doc: LoomDoc) => void;
}): JSX.Element {
  const docs = useMemo(() => traceabilityDocs(files), [files]);
  return (
    <DocList
      docs={docs}
      activePath={activePath}
      onOpen={onOpen}
      hint={TRACEABILITY_VIEW.hint}
      empty={TRACEABILITY_VIEW.empty(isDesktop)}
      testid="traceability-view"
    />
  );
}

/** Method → colour, matching how every API console on the planet reads. */
const METHOD_COLOR: Record<string, string> = {
  GET: "blue",
  POST: "green",
  PUT: "yellow",
  PATCH: "yellow",
  DELETE: "red",
};

export function ApiPane({ ctx }: { ctx: LayoutCtx }): JSX.Element {
  const surface = ctx.apiSurface;
  const groups = useMemo(() => groupOperations(surface?.operations ?? []), [surface]);

  if (!surface || surface.operations.length === 0) {
    return (
      <Text size="sm" c="dimmed" p="sm" data-testid="api-view-empty">
        {API_VIEW.empty(ctx.isDesktop)}
      </Text>
    );
  }
  return (
    <Box style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <Text size="xs" c="dimmed" px="sm" py={6}>
        {API_VIEW.hint}
      </Text>
      <ScrollArea style={{ flex: 1, minHeight: 0 }} data-testid="api-view">
        <Box px={8} pb="sm">
          {groups.map((group) => (
            <Box key={group.key} mb="sm" data-testid="api-group" data-aggregate={group.aggregate}>
              <Group gap={6} wrap="nowrap" mb={2}>
                <Text size="xs" fw={700} tt="uppercase" c="dimmed" truncate>
                  {group.aggregate}
                </Text>
                <Text size="xs" c="dimmed" truncate>
                  {group.context}
                </Text>
              </Group>
              {group.operations.map((op) => (
                <OperationRow key={`${op.method} ${op.path}`} op={op} />
              ))}
            </Box>
          ))}
          <Text size="xs" fw={700} tt="uppercase" c="dimmed" mt="xs" mb={4}>
            {API_VIEW.channels}
          </Text>
          {surface.channels.length === 0 ? (
            <Text size="xs" c="dimmed" data-testid="api-no-channels">
              {API_VIEW.noChannels}
            </Text>
          ) : (
            surface.channels.map((ch) => (
              <Box key={`${ch.context}.${ch.name}`} mb={4} data-testid="api-channel">
                <Text size="xs" ff="monospace" truncate>
                  {ch.name}
                </Text>
                <Text size="xs" c="dimmed" truncate>
                  {ch.delivery} · {ch.retention} · {API_VIEW.carries(ch.carries.length)}
                </Text>
              </Box>
            ))
          )}
        </Box>
      </ScrollArea>
    </Box>
  );
}

function OperationRow({ op }: { op: ApiOperationView }): JSX.Element {
  return (
    <Group
      gap={6}
      wrap="nowrap"
      data-testid="api-operation"
      data-operation={op.id}
      title={`${op.method} ${op.path} — ${op.id}`}
    >
      <Badge
        size="xs"
        variant="light"
        color={METHOD_COLOR[op.method] ?? "gray"}
        style={{ flex: "0 0 auto", width: 52 }}
      >
        {op.method}
      </Badge>
      <Text size="xs" ff="monospace" truncate>
        {op.path}
      </Text>
    </Group>
  );
}

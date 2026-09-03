// ---------------------------------------------------------------------------
// TargetsDrawer (M-T8.23 slice 1, research §4 #21).
//
// The compiler playground's version selector, applied to the whole stack: a
// header control that lists the system's deployables with their platform,
// frontend framework and design pack as dropdowns, rewrites the chosen clause
// through the node-addressed patch surface (`applyPatches`), and regenerates.
//
// The drawer owns no model knowledge of its own — `targets-patch.ts` reads the
// deployables off the parsed AST and builds the patches; this file is the
// chrome plus the apply/refuse rail every builder pane uses (a change that
// resolves to no patch says so, rather than silently doing nothing —
// audit H11 / `builder/pane-write.ts`).
// ---------------------------------------------------------------------------

import { Alert, Badge, Button, Drawer, Group, Select, Stack, Text } from "@mantine/core";
import { useMemo, useState } from "react";
import { applyPatches } from "../../../src/language/model-patch.js";
import { parseDdd } from "../builder/parse.js";
import { isParseOk } from "../builder/pane-write.js";
import {
  designPackMenu,
  platformMenu,
  readTargets,
  type TargetAxis,
  type TargetDeployable,
  targetPatches,
} from "./targets-patch.js";
import type { LayoutCtx } from "./ctx";
import { unsupportedPlatformLabel, type UnsupportedPlatform } from "./ctx";
import { PARSE_ERROR, TARGETS } from "./vocabulary";

type Ctx = Pick<
  LayoutCtx,
  "getSource" | "onSourceChange" | "scheduleAutoGenerate" | "sourcesWritable" | "unsupportedDeployables"
>;

interface Props {
  ctx: Ctx;
  opened: boolean;
  onClose: () => void;
}

export function TargetsDrawer({ ctx, opened, onClose }: Props): JSX.Element {
  // Re-read on every open (and after every apply) — the source is the truth,
  // and the drawer is short-lived enough that memoising across opens would
  // just be a staleness bug.
  const [epoch, setEpoch] = useState(0);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const source = opened ? ctx.getSource() : "";
  const read = useMemo(() => {
    if (!opened) return { targets: [] as TargetDeployable[], parsed: true };
    const parse = parseDdd(source);
    // READ gate: a recovered AST's offsets do not describe the user's source.
    if (!isParseOk(parse)) return { targets: [] as TargetDeployable[], parsed: false };
    return { targets: readTargets(parse.ast, source), parsed: true };
    // `epoch` is the re-read trigger after an apply.
  }, [opened, source, epoch]);

  const unsupported = new Map(ctx.unsupportedDeployables.map((d) => [d.slug, d.platform]));

  async function apply(target: TargetDeployable, axis: TargetAxis, value: string): Promise<void> {
    if (busy) return;
    setRefusal(null);
    const patches = targetPatches(target, axis, value);
    if (patches.length === 0) {
      setRefusal(TARGETS.noop);
      return;
    }
    setBusy(true);
    try {
      const result = await applyPatches(source, patches);
      if (!result.ok) {
        setRefusal(TARGETS.failed(result.errors[0]?.message ?? "no patch applied"));
        return;
      }
      // Same sink the visual builders write through: Monaco's model + the LSP
      // are updated, then the pipeline re-runs.
      ctx.onSourceChange(result.text, "builder");
      // A target change is a deliberate "regenerate against this stack", so it
      // does not wait out the 5 s keystroke debounce `onSourceChange` sets —
      // just long enough for the workspace write + the LSP re-run to land.
      ctx.scheduleAutoGenerate(300);
      setEpoch((n) => n + 1);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      position="right"
      size="md"
      title={TARGETS.title}
      data-testid="targets-drawer"
    >
      <Stack gap="md">
        <Text size="xs" c="dimmed">
          {TARGETS.intro}
        </Text>
        {!ctx.sourcesWritable && (
          <Alert color="gray" variant="light" data-testid="targets-readonly">
            {TARGETS.readOnly}
          </Alert>
        )}
        {refusal && (
          <Alert color="yellow" variant="light" data-testid="targets-refusal">
            {refusal}
          </Alert>
        )}
        {!read.parsed && (
          <Alert color="yellow" variant="light" data-testid="targets-parse-error">
            {PARSE_ERROR.title}. {PARSE_ERROR.body("to change a target")}
          </Alert>
        )}
        {read.parsed && read.targets.length === 0 && (
          <Text size="sm" c="dimmed" data-testid="targets-empty">
            {TARGETS.none}
          </Text>
        )}
        {read.targets.map((target) => (
          <TargetRow
            key={target.name}
            target={target}
            disabled={busy || !ctx.sourcesWritable}
            unsupportedAs={unsupported.get(target.name) ?? null}
            onChange={(axis, value) => void apply(target, axis, value)}
          />
        ))}
      </Stack>
    </Drawer>
  );
}

interface RowProps {
  target: TargetDeployable;
  disabled: boolean;
  unsupportedAs: UnsupportedPlatform | null;
  onChange: (axis: TargetAxis, value: string) => void;
}

function TargetRow({ target, disabled, unsupportedAs, onChange }: RowProps): JSX.Element {
  const packs = designPackMenu(target);
  return (
    <Stack
      gap={6}
      p="sm"
      data-testid={`target-${target.name}`}
      style={{
        border: "1px solid var(--mantine-color-default-border)",
        borderRadius: "var(--mantine-radius-sm)",
      }}
    >
      <Group gap="xs" justify="space-between" wrap="nowrap">
        <Text size="sm" fw={600}>
          {target.name}
        </Text>
        <Badge size="xs" variant="light" color={target.isFrontend ? "grape" : "blue"}>
          {target.isFrontend ? "frontend" : "backend"}
        </Badge>
      </Group>
      <Select
        size="xs"
        label={target.isFrontend ? TARGETS.framework : TARGETS.platform}
        data={platformMenu(target)}
        value={target.platform}
        disabled={disabled}
        allowDeselect={false}
        comboboxProps={{ withinPortal: true }}
        data-testid={`target-platform-${target.name}`}
        onChange={(v) => v && onChange("platform", v)}
      />
      {packs.length > 0 && target.mountsUi && (
        <Select
          size="xs"
          label={TARGETS.design}
          data={packs}
          value={target.design ?? packs[0]}
          disabled={disabled}
          allowDeselect={false}
          comboboxProps={{ withinPortal: true }}
          data-testid={`target-design-${target.name}`}
          onChange={(v) => v && onChange("design", v)}
        />
      )}
      {unsupportedAs && (
        <Text size="xs" c="dimmed" data-testid={`target-unsupported-${target.name}`}>
          {unsupportedPlatformLabel(unsupportedAs)} — {TARGETS.unsupported}
        </Text>
      )}
    </Stack>
  );
}

import { Badge, Box, Button, Group, Switch, Text, Tooltip, VisuallyHidden } from "@mantine/core";
import type { LayoutCtx } from "./ctx";
import { deriveStages, nextStage, type StageState, type StageView } from "./pipeline-stages";
import { AUTO_RUN, AUTO_RUN_HINT, type StageId } from "./vocabulary";

// The pipeline strip (M-T8.16 slice 1, audit H1).
//
// Validate · Generate · Bundle · Boot as one widget: each segment shows its
// state (idle / running / ok / failed / blocked) and a count where one
// exists, a click runs that stage, and a blocked segment explains the
// blocker on hover.  Desktop renders it in the header in place of the old
// Generate / Bundle buttons and the Runtime tab's Boot; mobile keeps one
// **Run** button and renders the same states as four labelled dots.
//
// The `btn-generate` / `btn-bundle` / `btn-boot` test ids are a public
// contract (~35 Playwright specs); they live on the desktop segments.

interface Props {
  ctx: LayoutCtx;
}

const TESTID: Record<StageId, string> = {
  validate: "btn-validate",
  generate: "btn-generate",
  bundle: "btn-bundle",
  boot: "btn-boot",
};

/** Glyph per state — status is never colour alone (audit M11). */
const GLYPH: Record<StageState, string> = {
  idle: "○",
  running: "…",
  ok: "✓",
  failed: "✕",
  blocked: "–",
};

const COLOUR: Record<StageState, string> = {
  idle: "gray",
  running: "blue",
  ok: "green",
  failed: "red",
  blocked: "gray",
};

/** Human word per state for the visually-hidden status text. */
const STATE_WORD: Record<StageState, string> = {
  idle: "not run yet",
  running: "running",
  ok: "ok",
  failed: "failed",
  blocked: "blocked",
};

function runStage(ctx: LayoutCtx, id: StageId): void {
  switch (id) {
    case "validate":
      // Validation is live (the LSP) — the click opens the diagnostics.
      ctx.setOutputStream("problems");
      ctx.setDockTab("output");
      return;
    case "generate":
      ctx.runGenerate();
      return;
    case "bundle":
      ctx.runBundle();
      return;
    case "boot":
      ctx.runBoot();
      return;
  }
}

function Segment({
  stage,
  primary,
  onClick,
}: {
  stage: StageView;
  primary: boolean;
  onClick: () => void;
}): JSX.Element {
  const { state } = stage;
  const running = state === "running";
  const variant = primary ? "filled" : state === "ok" || state === "failed" ? "light" : "default";
  // A disabled button swallows pointer events, so the tooltip that explains
  // WHY it is disabled has to sit on a wrapper (audit H1's shipped half).
  return (
    <Tooltip label={stage.blocker ?? stage.hint} withArrow multiline maw={320}>
      <Box component="span" data-testid={`pipeline-segment-${stage.id}`}>
        <Button
          size="xs"
          variant={variant}
          color={primary ? undefined : COLOUR[state]}
          loading={running}
          disabled={!stage.enabled}
          onClick={onClick}
          data-testid={TESTID[stage.id]}
          data-stage={stage.id}
          data-state={state}
          leftSection={
            !running ? (
              <Text component="span" size="xs" aria-hidden>
                {GLYPH[state]}
              </Text>
            ) : undefined
          }
          rightSection={
            stage.count ? (
              <Badge
                size="xs"
                variant={state === "failed" ? "filled" : "light"}
                color={state === "failed" ? "red" : state === "ok" ? "green" : "gray"}
                data-testid={`pipeline-count-${stage.id}`}
              >
                {stage.count}
              </Badge>
            ) : undefined
          }
        >
          {stage.label}
          <VisuallyHidden>, {STATE_WORD[state]}</VisuallyHidden>
        </Button>
      </Box>
    </Tooltip>
  );
}

/** Desktop: four segments + the auto-run toggle. */
export function PipelineStrip({ ctx }: Props): JSX.Element {
  const stages = deriveStages(ctx);
  const next = nextStage(stages);
  return (
    <Group
      gap={4}
      wrap="nowrap"
      role="group"
      aria-label="Pipeline"
      data-testid="pipeline-strip"
      data-variant="segments"
    >
      {stages.map((s, i) => (
        <Group key={s.id} gap={4} wrap="nowrap">
          {i > 0 && (
            <Text size="xs" c="dimmed" aria-hidden>
              ›
            </Text>
          )}
          <Segment stage={s} primary={s.id === next} onClick={() => runStage(ctx, s.id)} />
        </Group>
      ))}
      <Tooltip label={AUTO_RUN_HINT} withArrow multiline maw={280}>
        <Box component="span" ml={6}>
          <Switch
            size="xs"
            checked={ctx.liveMode}
            onChange={(e) => ctx.setLiveMode(e.currentTarget.checked)}
            label={AUTO_RUN}
            data-testid="live-mode"
          />
        </Box>
      </Tooltip>
    </Group>
  );
}

/** Mobile: the same four states as labelled dots — read-only; **Run** in
 *  the header is the one control. */
export function PipelineDots({ ctx }: Props): JSX.Element {
  const stages = deriveStages(ctx);
  return (
    <Group
      gap="sm"
      wrap="nowrap"
      justify="center"
      role="list"
      aria-label="Pipeline"
      data-testid="pipeline-strip"
      data-variant="dots"
    >
      {stages.map((s) => (
        <Group
          key={s.id}
          gap={4}
          wrap="nowrap"
          role="listitem"
          data-testid={`pipeline-dot-${s.id}`}
          data-stage={s.id}
          data-state={s.state}
          title={s.blocker ?? s.hint}
        >
          <Box
            w={8}
            h={8}
            aria-hidden
            style={{
              borderRadius: "50%",
              background:
                s.state === "idle" || s.state === "blocked"
                  ? "transparent"
                  : `var(--mantine-color-${COLOUR[s.state]}-6)`,
              border: `1px solid var(--mantine-color-${COLOUR[s.state]}-6)`,
            }}
          />
          <Text size="xs" c={s.state === "idle" || s.state === "blocked" ? "dimmed" : undefined}>
            {s.label}
            {s.count ? ` · ${s.count}` : ""}
          </Text>
          <VisuallyHidden>, {STATE_WORD[s.state]}</VisuallyHidden>
        </Group>
      ))}
    </Group>
  );
}

import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Box,
  Button,
  Code,
  Group,
  Loader,
  PasswordInput,
  Popover,
  ScrollArea,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
  Textarea,
  Tooltip,
} from "@mantine/core";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { AgentMessage, AgentToolCall } from "../agent/demo";
import type { StuckSignal } from "../agent/loop-guard";
import type { PlanItem } from "../agent/plan";
import { planSummary } from "../agent/plan";
import { type AgentSettings, PROVIDER_PRESETS, presetById, settingsReady } from "../agent/provider";
import type { TurnReceipt } from "../agent/receipt";
import { fileDeltaIsEmpty } from "../agent/receipt";
import type { PlanCard as PlanCardData, TurnCheckpoint } from "../agent/turn";
import type { LayoutCtx } from "./ctx";
import { CHAT, CHECKPOINT, PLAN, RECEIPT, STUCK } from "./vocabulary";

// "Agent" dock tab — two modes over one shared transcript display:
//   • the deterministic M-T8.3 wedge demo (prose → `.ddd` → generate → green),
//     driven by a SCRIPTED agent running the REAL browser-safe `loom_*` tools;
//   • a LIVE chat against a BYOK provider (OpenRouter by default, or any
//     OpenAI-compatible endpoint) that drives the same tools through a real LLM.
// The composer + settings gear configure the live mode; the demo button stays
// for the reproducible, key-free walkthrough (and the Playwright e2e).

export function ChatBody({ ctx }: { ctx: LayoutCtx }): JSX.Element {
  const { agentMessages, agentRunning, runAgentDemo, agentSettings, sendAgentMessage, clearAgentChat } =
    ctx;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // A prompt handed over from elsewhere — a Problems row's *Ask the agent*,
  // the first-run card's *Describe a system* (M-T8.18).  Prefill (or, for an
  // empty request, just focus) and consume it so a re-render doesn't replay.
  const { agentPrompt, consumeAgentPrompt } = ctx;
  useEffect(() => {
    if (!agentPrompt) return;
    if (agentPrompt.text) setInput(agentPrompt.text);
    consumeAgentPrompt();
    // The tab may have just been switched to: focus after the panel paints.
    const id = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [agentPrompt, consumeAgentPrompt]);
  // A scripted transport (e2e/manual harness) counts as ready even without a
  // configured key — mirrors the App-side `__loomAgentComplete` seam.
  const injected =
    typeof window !== "undefined" &&
    !!(window as unknown as { __loomAgentComplete?: unknown }).__loomAgentComplete;
  const ready = injected || settingsReady(agentSettings);

  // Keep the newest turn in view as the transcript streams in.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [agentMessages.length, agentMessages.at(-1)?.text]);

  function submit(): void {
    const text = input.trim();
    if (!text || agentRunning || !ready) return;
    setInput("");
    sendAgentMessage(text);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <Box style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <Group px="sm" py={4} justify="space-between" wrap="nowrap" style={{ flexShrink: 0 }}>
        <Text size="xs" c="dimmed">
          Prose → <Code style={{ fontSize: 10 }}>.ddd</Code> → generate, via the{" "}
          <Code style={{ fontSize: 10 }}>loom_*</Code> tools
        </Text>
        <Group gap={6} wrap="nowrap">
          {agentMessages.length > 0 && (
            <Button
              size="compact-xs"
              variant="subtle"
              color="gray"
              onClick={() => clearAgentChat()}
              data-testid="agent-clear"
            >
              {CHAT.clear}
            </Button>
          )}
          <SettingsMenu ctx={ctx} />
          <Button
            size="compact-xs"
            variant="light"
            loading={agentRunning}
            onClick={() => runAgentDemo()}
            data-testid="agent-run-demo"
          >
            {agentMessages.length > 0 ? CHAT.replayDemo : CHAT.demo}
          </Button>
        </Group>
      </Group>
      <Box style={{ borderBottom: "1px solid var(--mantine-color-dark-4)" }} />

      <ScrollArea style={{ flex: 1, minHeight: 0 }} viewportRef={scrollRef}>
        <Stack gap="sm" p="sm" data-testid="agent-chat">
          {agentMessages.length === 0 ? (
            <Text c="dimmed" size="sm">
              {ready ? (
                <>
                  Ask for a system in plain English — the agent authors the{" "}
                  <Code style={{ fontSize: 10 }}>.ddd</Code>, validates and repairs it, then
                  generates the stack. Or click “Run demo” for the scripted walkthrough.
                </>
              ) : (
                <>
                  Add an API key in <b>Settings</b> to chat with a live model (BYOK — OpenRouter or
                  any OpenAI-compatible endpoint), or click “Run demo” for the scripted, key-free
                  walkthrough using the same <Code style={{ fontSize: 10 }}>loom_*</Code> tools.
                </>
              )}
            </Text>
          ) : (
            agentMessages.map((m) => <ChatMessage key={m.id} m={m} ctx={ctx} />)
          )}
        </Stack>
      </ScrollArea>

      {ctx.agentRestoreNote && (
        <Alert
          color="blue"
          variant="light"
          mx="sm"
          mb={4}
          withCloseButton
          onClose={() => ctx.dismissAgentRestoreNote()}
          data-testid="agent-restore-note"
          style={{ flexShrink: 0 }}
        >
          <Text size="xs">{ctx.agentRestoreNote}</Text>
        </Alert>
      )}
      <Box style={{ borderTop: "1px solid var(--mantine-color-dark-4)", flexShrink: 0 }} p="sm">
        <Group gap={8} align="flex-end" wrap="nowrap">
          <Textarea
            ref={inputRef}
            style={{ flex: 1 }}
            autosize
            minRows={1}
            maxRows={5}
            placeholder={ready ? "Describe what to build…" : "Configure a provider in Settings first"}
            value={input}
            disabled={agentRunning}
            onChange={(e) => setInput(e.currentTarget.value)}
            onKeyDown={onKeyDown}
            data-testid="agent-input"
          />
          <Button
            onClick={submit}
            loading={agentRunning}
            disabled={!ready || !input.trim() || ctx.agentStuck !== null}
            data-testid="agent-send"
          >
            {CHAT.send}
          </Button>
        </Group>
        <Group gap={10} mt={4} wrap="nowrap">
          <Tooltip label={PLAN.toggleHint} withArrow multiline w={280}>
            <Switch
              size="xs"
              checked={ctx.agentPlanMode}
              onChange={(e) => ctx.setAgentPlanMode(e.currentTarget.checked)}
              label={PLAN.toggle}
              data-testid="agent-plan-toggle"
            />
          </Tooltip>
          {ctx.agentStuck ? (
            <Text size="xs" c="red" data-testid="agent-stuck-hint">
              {STUCK.title} — {STUCK.body(ctx.agentStuck.code, ctx.agentStuck.node, ctx.agentStuck.turns)}
            </Text>
          ) : (
            !ready && (
              <Text size="xs" c="dimmed">
                Live chat needs a provider + API key.
              </Text>
            )
          )}
        </Group>
      </Box>
    </Box>
  );
}

/** The BYOK provider settings popover (gear).  Picking a preset resets base URL
 *  + model to its defaults; both stay editable (for Custom / local endpoints).
 *  The key lives only in this browser's localStorage. */
function SettingsMenu({ ctx }: { ctx: LayoutCtx }): JSX.Element {
  const { agentSettings, setAgentSettings } = ctx;
  const [opened, setOpened] = useState(false);
  const preset = presetById(agentSettings.providerId);
  const ready = settingsReady(agentSettings);

  function patch(p: Partial<AgentSettings>): void {
    setAgentSettings({ ...agentSettings, ...p });
  }

  function pickProvider(id: string): void {
    const next = presetById(id);
    // Reset URL/model to the picked preset's defaults; keep the key.
    setAgentSettings({
      providerId: id,
      baseUrl: next.baseUrl,
      model: next.defaultModel,
      apiKey: agentSettings.apiKey,
    });
  }

  return (
    <Popover opened={opened} onChange={setOpened} position="bottom-end" width={320} withArrow>
      <Popover.Target>
        <Tooltip label={ready ? "Model settings" : "Add an API key to chat live"} withArrow>
          <ActionIcon
            variant={ready ? "subtle" : "light"}
            color={ready ? "gray" : "yellow"}
            size="sm"
            onClick={() => setOpened((o) => !o)}
            data-testid="agent-settings-toggle"
            aria-label="Agent model settings"
          >
            {/* gear glyph — no icon dependency */}
            <Text size="sm">⚙</Text>
          </ActionIcon>
        </Tooltip>
      </Popover.Target>
      <Popover.Dropdown data-testid="agent-settings">
        <Stack gap="xs">
          <Text size="xs" fw={600}>
            Live model (BYOK)
          </Text>
          <Select
            size="xs"
            label="Provider"
            data={PROVIDER_PRESETS.map((p) => ({ value: p.id, label: p.label }))}
            value={agentSettings.providerId}
            onChange={(v) => v && pickProvider(v)}
            data-testid="agent-provider"
            comboboxProps={{ withinPortal: false }}
          />
          <TextInput
            size="xs"
            label="Base URL"
            value={agentSettings.baseUrl}
            onChange={(e) => patch({ baseUrl: e.currentTarget.value })}
            data-testid="agent-base-url"
          />
          <TextInput
            size="xs"
            label="Model"
            placeholder={preset.defaultModel || "model id"}
            value={agentSettings.model}
            onChange={(e) => patch({ model: e.currentTarget.value })}
            data-testid="agent-model"
          />
          {preset.needsKey && (
            <PasswordInput
              size="xs"
              label="API key"
              placeholder="sk-…"
              value={agentSettings.apiKey}
              onChange={(e) => patch({ apiKey: e.currentTarget.value })}
              data-testid="agent-api-key"
            />
          )}
          {preset.hint && (
            <Text size="xs" c="dimmed">
              {preset.hint}
            </Text>
          )}
          <Group justify="space-between">
            <Badge size="xs" variant="light" color={ready ? "green" : "yellow"}>
              {ready ? "ready" : "needs a key"}
            </Badge>
            <Anchor size="xs" c="dimmed" href="https://openrouter.ai/keys" target="_blank">
              get a key
            </Anchor>
          </Group>
          <Text size="xs" c="dimmed">
            The key stays in this browser and is sent only to the provider you pick.
          </Text>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}

function ChatMessage({ m, ctx }: { m: AgentMessage; ctx: LayoutCtx }): JSX.Element {
  const isUser = m.role === "user";
  return (
    <Box
      data-testid={`agent-msg-${m.role}`}
      style={{ alignSelf: isUser ? "flex-end" : "flex-start", maxWidth: "92%" }}
    >
      <Box
        p={8}
        style={{
          borderRadius: 8,
          background: isUser ? "var(--mantine-color-blue-9)" : "var(--mantine-color-dark-6)",
          border: "1px solid var(--mantine-color-dark-4)",
        }}
      >
        <Group gap={6} mb={m.text ? 4 : 0} wrap="nowrap">
          <Badge size="xs" variant="light" color={isUser ? "blue" : "grape"}>
            {isUser ? "you" : "agent"}
          </Badge>
          {m.pending && <Loader size={10} />}
        </Group>
        {m.text && (
          <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
            {m.text}
          </Text>
        )}
        {/* The receipt folds the turn's tool calls under itself (research
            §4 #4), so a turn that produced one does not also sprawl its cards
            up the bubble. */}
        {m.toolCalls && m.toolCalls.length > 0 && !m.extras?.receipt && (
          <Stack gap={4} mt={6}>
            {m.toolCalls.map((t, i) => (
              <ToolCallCard key={i} t={t} />
            ))}
          </Stack>
        )}
        {m.extras?.plan && <PlanCard card={m.extras.plan} ctx={ctx} />}
        {m.extras?.receipt && <ReceiptCard receipt={m.extras.receipt} />}
        {m.extras?.checkpoint && (
          <CheckpointRow cp={m.extras.checkpoint} ctx={ctx} />
        )}
        {m.extras?.stuck && <StuckCard signal={m.extras.stuck} ctx={ctx} />}
      </Box>
    </Box>
  );
}

/** The plan step's checklist (M-T8.19 slice 2).  Not prose the model wrote —
 *  a model-node delta from `loom_outline`, each line a real patch address, so
 *  striking one off is an operation the compiler can perform rather than a
 *  hint.  A `remove` line is all-or-nothing (reverting a deletion would need
 *  the base declaration's source text, which the outline does not carry), and
 *  the row says so instead of offering a control that would lie. */
function PlanCard({ card, ctx }: { card: PlanCardData; ctx: LayoutCtx }): JSX.Element {
  const [excluded, setExcluded] = useState<string[]>(card.excluded);
  const pending = card.state === "pending";
  const shown = pending ? excluded : card.excluded;
  const items = card.plan.items;

  const toggle = (node: string): void =>
    setExcluded((prev) => (prev.includes(node) ? prev.filter((n) => n !== node) : [...prev, node]));

  return (
    <Box
      mt={6}
      p={8}
      data-testid="agent-plan"
      data-plan-state={card.state}
      style={{
        borderRadius: 6,
        background: "var(--mantine-color-body)",
        border: "1px solid var(--mantine-color-default-border)",
      }}
    >
      <Group gap={6} wrap="nowrap" mb={4}>
        <Badge size="xs" variant="light" color="blue">
          {PLAN.title}
        </Badge>
        <Text size="xs" c="dimmed" data-testid="agent-plan-summary">
          {planSummary(items)}
        </Text>
      </Group>
      <Text size="xs" c="dimmed" mb={6}>
        {PLAN.subtitle}
      </Text>
      <Stack gap={2}>
        {items.map((item) => (
          <PlanRow
            key={item.node}
            item={item}
            excluded={shown.includes(item.node)}
            interactive={pending}
            onToggle={() => toggle(item.node)}
          />
        ))}
      </Stack>
      {pending ? (
        <Group gap={6} mt={8}>
          <Tooltip label={PLAN.approveHint} withArrow>
            <Button
              size="compact-xs"
              onClick={() => ctx.approveAgentPlan(excluded)}
              data-testid="agent-plan-approve"
            >
              {PLAN.approve}
            </Button>
          </Tooltip>
          <Tooltip label={PLAN.rejectHint} withArrow>
            <Button
              size="compact-xs"
              variant="subtle"
              color="gray"
              onClick={() => ctx.rejectAgentPlan(excluded)}
              data-testid="agent-plan-reject"
            >
              {PLAN.reject}
            </Button>
          </Tooltip>
        </Group>
      ) : (
        <Text size="xs" c="dimmed" mt={6} data-testid="agent-plan-verdict">
          {card.state === "rejected"
            ? PLAN.rejected
            : card.excluded.length > 0
              ? PLAN.partial(card.excluded.length)
              : ""}
        </Text>
      )}
    </Box>
  );
}

function PlanRow({
  item,
  excluded,
  interactive,
  onToggle,
}: {
  item: PlanItem;
  excluded: boolean;
  interactive: boolean;
  onToggle: () => void;
}): JSX.Element {
  const color = item.change === "add" ? "green" : item.change === "remove" ? "red" : "yellow";
  const canExclude = interactive && item.excludable;
  const label = excluded ? PLAN.include : item.excludable ? PLAN.exclude : PLAN.notExcludable;
  return (
    <Group
      gap={6}
      wrap="nowrap"
      data-testid="agent-plan-item"
      data-node={item.node}
      data-excluded={excluded || undefined}
      style={{ opacity: excluded ? 0.45 : 1 }}
    >
      <Tooltip label={label} withArrow>
        <ActionIcon
          size="xs"
          variant="subtle"
          color={excluded ? "gray" : color}
          disabled={!canExclude}
          onClick={onToggle}
          aria-label={`${label}: ${item.node}`}
          data-testid="agent-plan-exclude"
        >
          <Text size="xs">{excluded ? "+" : "×"}</Text>
        </ActionIcon>
      </Tooltip>
      <Badge size="xs" variant="light" color={color}>
        {PLAN.verb[item.change]}
      </Badge>
      <Code style={{ fontSize: 11, background: "transparent" }}>{item.node}</Code>
      {item.addedMembers.length + item.removedMembers.length > 0 && (
        <Text size="xs" c="dimmed" ml="auto" style={{ flexShrink: 0 }}>
          {item.addedMembers.length > 0 ? `+${item.addedMembers.length}` : ""}
          {item.addedMembers.length > 0 && item.removedMembers.length > 0 ? " " : ""}
          {item.removedMembers.length > 0 ? `−${item.removedMembers.length}` : ""}
        </Text>
      )}
    </Group>
  );
}

/** The circuit breaker (M-T8.19 slice 5; research §4 #13).
 *
 *  Three consecutive fix turns left the same `loom.*` code on the same node,
 *  so the loop stops rather than spending another turn on it — the failure
 *  every builder's users complain about.  A stop is only useful with an exit,
 *  so the card carries all three the literature asks for: go back to something
 *  that worked, shrink the request, or look at the problem yourself. */
function StuckCard({ signal, ctx }: { signal: StuckSignal; ctx: LayoutCtx }): JSX.Element {
  const green = ctx.agentLastGreen;
  return (
    <Box
      mt={6}
      p={8}
      data-testid="agent-stuck"
      style={{
        borderRadius: 6,
        background: "var(--mantine-color-body)",
        border: "1px solid var(--mantine-color-red-filled)",
      }}
    >
      <Group gap={6} mb={4} wrap="nowrap">
        <Badge size="xs" variant="light" color="red">
          {STUCK.title}
        </Badge>
        <Code style={{ fontSize: 11, background: "transparent" }}>{signal.code}</Code>
      </Group>
      <Text size="xs" mb={6}>
        {STUCK.body(signal.code, signal.node, signal.turns)}
      </Text>
      <Group gap={6} wrap="wrap">
        <Tooltip label={green ? STUCK.restoreGreenHint : STUCK.noGreen} withArrow>
          <Button
            size="compact-xs"
            variant="light"
            disabled={!green}
            onClick={() => {
              if (!green) return;
              ctx.dismissAgentStuck();
              ctx.restoreAgentCheckpoint(green.oid, green.point);
            }}
            data-testid="agent-stuck-restore-green"
          >
            {STUCK.restoreGreen}
          </Button>
        </Tooltip>
        <Tooltip label={STUCK.narrowHint} withArrow>
          <Button
            size="compact-xs"
            variant="light"
            color="gray"
            onClick={() => {
              ctx.dismissAgentStuck();
              ctx.askAgent(STUCK.narrowPrompt(signal.code, signal.node));
            }}
            data-testid="agent-stuck-narrow"
          >
            {STUCK.narrow}
          </Button>
        </Tooltip>
        <Tooltip label={STUCK.openProblemHint} withArrow>
          <Button
            size="compact-xs"
            variant="subtle"
            color="gray"
            onClick={() => {
              ctx.dismissAgentStuck();
              ctx.setOutputStream("problems");
              if (ctx.isDesktop) ctx.setDockTab("output");
              else ctx.setActiveTab("output");
              ctx.stepProblem(1);
            }}
            data-testid="agent-stuck-open-problem"
          >
            {STUCK.openProblem}
          </Button>
        </Tooltip>
      </Group>
    </Box>
  );
}

/** The turn's commit, and the one-click way back to it (M-T8.19 slice 4).
 *
 *  The copy names the POINT rather than the hash, and says the restore is
 *  itself recorded — the two things the Cursor checkpoint threads say users
 *  could not tell (research §2.4): whether they land at the start or the end
 *  of the turn, and whether they can get back. */
function CheckpointRow({
  cp,
  ctx,
}: {
  cp: TurnCheckpoint;
  ctx: LayoutCtx;
}): JSX.Element {
  return (
    <Group gap={8} mt={6} wrap="nowrap" data-testid="agent-checkpoint" data-oid={cp.oid}>
      <Code style={{ fontSize: 10 }}>{cp.oid.slice(0, 7)}</Code>
      <Text size="xs" c="dimmed" style={{ flex: 1 }} truncate>
        {cp.point}
      </Text>
      <Tooltip label={CHECKPOINT.restoreHint(cp.point)} withArrow multiline w={280}>
        <Button
          size="compact-xs"
          variant="light"
          onClick={() => ctx.restoreAgentCheckpoint(cp.oid, cp.point)}
          data-testid="agent-restore"
        >
          {CHECKPOINT.restore}
        </Button>
      </Tooltip>
    </Group>
  );
}

/** The per-turn receipt (M-T8.19 slice 3).  Every number on it is computed by
 *  the playground — the compiler's error counts either side of the write, the
 *  real unified `.ddd` diff, what moved in the generated tree, the provider's
 *  own token report.  None of it is the model's claim about itself, which is
 *  the whole point (NN/g on sycophancy; research §2.4). */
function ReceiptCard({ receipt }: { receipt: TurnReceipt }): JSX.Element {
  const [showDiff, setShowDiff] = useState(false);
  const [showPaths, setShowPaths] = useState(false);
  const [showTools, setShowTools] = useState(false);
  const files = receipt.files;
  const filesMoved = !fileDeltaIsEmpty(files);
  const paths = [...files.added, ...files.changed, ...files.removed];

  return (
    <Box
      mt={6}
      p={8}
      data-testid="agent-receipt"
      style={{
        borderRadius: 6,
        background: "var(--mantine-color-body)",
        border: "1px solid var(--mantine-color-default-border)",
      }}
    >
      <Group gap={8} wrap="wrap">
        <Badge size="xs" variant="light" color="gray">
          {RECEIPT.title}
        </Badge>
        <Badge
          size="xs"
          variant="light"
          color={receipt.validator.after === 0 ? "green" : "red"}
          data-testid="receipt-validator"
        >
          {RECEIPT.validatorDelta(receipt.validator.before, receipt.validator.after)}
        </Badge>
        {receipt.wrote ? (
          <Text size="xs" c="dimmed" data-testid="receipt-diffstat">
            {`+${receipt.added} −${receipt.removed}`}
          </Text>
        ) : (
          <Text size="xs" c="dimmed" data-testid="receipt-nodiff">
            {RECEIPT.noDiff}
          </Text>
        )}
        {receipt.usage && (
          <Text size="xs" c="dimmed" data-testid="receipt-tokens">
            {RECEIPT.tokens}: {RECEIPT.tokenLine(receipt.usage.input, receipt.usage.output)}
          </Text>
        )}
      </Group>

      <Group gap={8} mt={4} wrap="wrap">
        <Text size="xs" c="dimmed">
          {RECEIPT.files}:
        </Text>
        {filesMoved ? (
          <Code style={{ fontSize: 11 }} data-testid="receipt-filedelta">
            {RECEIPT.fileDelta(files.added.length, files.removed.length, files.changed.length)}
          </Code>
        ) : (
          <Text size="xs" c="dimmed" data-testid="receipt-filedelta">
            {RECEIPT.filesNone}
          </Text>
        )}
        {filesMoved && (
          <Button
            size="compact-xs"
            variant="subtle"
            color="gray"
            onClick={() => setShowPaths((v) => !v)}
            data-testid="receipt-toggle-paths"
          >
            {showPaths ? RECEIPT.hidePaths : RECEIPT.showPaths}
          </Button>
        )}
        {receipt.wrote && (
          <Button
            size="compact-xs"
            variant="subtle"
            color="gray"
            onClick={() => setShowDiff((v) => !v)}
            data-testid="receipt-toggle-diff"
          >
            {showDiff ? RECEIPT.hideDiff : RECEIPT.showDiff}
          </Button>
        )}
        {receipt.toolCalls.length > 0 && (
          <Button
            size="compact-xs"
            variant="subtle"
            color="gray"
            onClick={() => setShowTools((v) => !v)}
            data-testid="receipt-toggle-tools"
          >
            {RECEIPT.toolCalls} ({receipt.toolCalls.length})
          </Button>
        )}
      </Group>

      {showPaths && (
        <Stack gap={0} mt={4} data-testid="receipt-paths">
          {paths.map((p) => (
            <Text key={p} size="xs" c="dimmed" ff="monospace" truncate>
              {p}
            </Text>
          ))}
        </Stack>
      )}
      {showDiff && (
        <Box
          mt={4}
          p={6}
          data-testid="receipt-diff"
          style={{
            borderRadius: 4,
            overflowX: "auto",
            background: "var(--mantine-color-default-hover)",
          }}
        >
          <Text component="pre" size="xs" ff="monospace" style={{ margin: 0 }}>
            {receipt.diff}
          </Text>
        </Box>
      )}
      {showTools && (
        <Stack gap={4} mt={4} data-testid="receipt-tools">
          {receipt.toolCalls.map((t, i) => (
            <ToolCallCard key={i} t={t} />
          ))}
        </Stack>
      )}
    </Box>
  );
}

function ToolCallCard({ t }: { t: AgentToolCall }): JSX.Element {
  const color = t.status === "ok" ? "green" : t.status === "error" ? "red" : "gray";
  return (
    <Group
      gap={8}
      wrap="nowrap"
      align="center"
      px={8}
      py={4}
      data-testid="agent-tool-call"
      style={{
        borderRadius: 6,
        background: "var(--mantine-color-dark-7)",
        border: "1px solid var(--mantine-color-dark-4)",
      }}
    >
      {t.status === "running" ? (
        <Loader size={10} />
      ) : (
        <Box
          w={7}
          h={7}
          style={{ borderRadius: "50%", background: `var(--mantine-color-${color}-6)`, flexShrink: 0 }}
        />
      )}
      <Code style={{ fontSize: 11, background: "transparent" }}>{t.label}</Code>
      {t.result && (
        <Text size="xs" c="dimmed" ml="auto" style={{ flexShrink: 0 }}>
          {t.result}
        </Text>
      )}
    </Group>
  );
}

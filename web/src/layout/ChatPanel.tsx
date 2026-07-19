import {
  ActionIcon,
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
  Text,
  TextInput,
  Textarea,
  Tooltip,
} from "@mantine/core";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { AgentMessage, AgentToolCall } from "../agent/demo";
import { type AgentSettings, PROVIDER_PRESETS, presetById, settingsReady } from "../agent/provider";
import type { LayoutCtx } from "./ctx";

// "Agent" dock tab — two modes over one shared transcript display:
//   • the deterministic M-T8.3 wedge demo (prose → `.ddd` → generate → green),
//     driven by a SCRIPTED agent running the REAL browser-safe `loom_*` tools;
//   • a LIVE chat against a BYOK provider (OpenRouter by default, or any
//     OpenAI-compatible endpoint) that drives the same tools through a real LLM.
// The composer + settings gear configure the live mode; the demo button stays
// for the reproducible, key-free walkthrough (and the Playwright e2e).

/** Green once the demo/chat has run to a concluding turn. */
export function agentDot(ctx: LayoutCtx): "green" | null {
  const last = ctx.agentMessages.at(-1);
  return last && last.role === "assistant" && /Done|✅/.test(last.text) ? "green" : null;
}

export function ChatBody({ ctx }: { ctx: LayoutCtx }): JSX.Element {
  const { agentMessages, agentRunning, runAgentDemo, agentSettings, sendAgentMessage, clearAgentChat } =
    ctx;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [input, setInput] = useState("");
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
              Clear
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
            {agentMessages.length > 0 ? "Replay demo" : "Run demo"}
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
            agentMessages.map((m) => <ChatMessage key={m.id} m={m} />)
          )}
        </Stack>
      </ScrollArea>

      <Box style={{ borderTop: "1px solid var(--mantine-color-dark-4)", flexShrink: 0 }} p="sm">
        <Group gap={8} align="flex-end" wrap="nowrap">
          <Textarea
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
            disabled={!ready || !input.trim()}
            data-testid="agent-send"
          >
            Send
          </Button>
        </Group>
        {!ready && (
          <Text size="xs" c="dimmed" mt={4}>
            Live chat needs a provider + API key.
          </Text>
        )}
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

function ChatMessage({ m }: { m: AgentMessage }): JSX.Element {
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
        {m.toolCalls && m.toolCalls.length > 0 && (
          <Stack gap={4} mt={6}>
            {m.toolCalls.map((t, i) => (
              <ToolCallCard key={i} t={t} />
            ))}
          </Stack>
        )}
      </Box>
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

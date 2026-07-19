import { Badge, Box, Button, Code, Group, Loader, ScrollArea, Stack, Text } from "@mantine/core";
import { useEffect, useRef } from "react";
import type { AgentMessage, AgentToolCall } from "../agent/demo";
import type { LayoutCtx } from "./ctx";

// "Agent" dock tab — the deterministic M-T8.3 wedge demo (prose → `.ddd` →
// generate → green), driven by a SCRIPTED agent that runs the REAL browser-safe
// tools (`loom_validate` / `loom_generate`) against the authored source.  No
// live LLM: the transcript is fixed, so it's reproducible (and doubles as a
// Playwright e2e).  Watching it, you see the model appear in the editor, the
// validation come back clean, the deployable manifest derive, and the full
// project tree land in the Files pane.

/** Green once the demo has run to its concluding turn. */
export function agentDot(ctx: LayoutCtx): "green" | null {
  const last = ctx.agentMessages.at(-1);
  return last && last.role === "assistant" && /Done/.test(last.text) ? "green" : null;
}

export function ChatBody({ ctx }: { ctx: LayoutCtx }): JSX.Element {
  const { agentMessages, agentRunning, runAgentDemo } = ctx;
  const scrollRef = useRef<HTMLDivElement>(null);

  // Keep the newest turn in view as the transcript streams in.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [agentMessages.length]);

  return (
    <Box style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <Group px="sm" py={4} justify="space-between" wrap="nowrap" style={{ flexShrink: 0 }}>
        <Text size="xs" c="dimmed">
          Deterministic demo — prose → <Code style={{ fontSize: 10 }}>.ddd</Code> → generate → green
        </Text>
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
      <Box style={{ borderBottom: "1px solid var(--mantine-color-dark-4)" }} />
      <ScrollArea style={{ flex: 1, minHeight: 0 }} viewportRef={scrollRef}>
        <Stack gap="sm" p="sm" data-testid="agent-chat">
          {agentMessages.length === 0 ? (
            <Text c="dimmed" size="sm">
              Click “Run demo” to watch a scripted agent turn a plain-English request into a
              validated Loom model and a generated Node/Hono + React stack — using the same{" "}
              <Code style={{ fontSize: 10 }}>loom_*</Code> tools an MCP client calls.
            </Text>
          ) : (
            agentMessages.map((m) => <ChatMessage key={m.id} m={m} />)
          )}
        </Stack>
      </ScrollArea>
    </Box>
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

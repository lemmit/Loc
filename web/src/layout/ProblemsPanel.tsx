import { ActionIcon, Anchor, Badge, Button, Chip, Group, Stack, Text, Tooltip, UnstyledButton } from "@mantine/core";
import { useEffect, useMemo, useState } from "react";
import { codeDocsUrl } from "../../../src/diagnostics/code-docs.js";
import { loomQuickFixes, type LoomQuickFix } from "../editor/fix-hint-actions";
import { modelUriFor } from "../lsp/workspace-lsp-sync";
import type { Diagnostic } from "../lsp/protocol";
import type { LayoutCtx } from "./ctx";
import { inDocumentOrder, toEditorRange } from "./problem-nav";
import { PROBLEMS } from "./vocabulary";

// The Problems stream as a teaching surface (M-T8.18 slice 1, audit H7).
//
// Every `loom.*` row carries: the code as a chip; a docs link into the
// language reference when `codeDocsUrl` has an anchor for the code (a code
// without one renders no link rather than a 404); a **Fix** action when the
// fix-hint registry (`src/language/fix-hints.ts`) has a provider — resolved
// through the SAME `loomQuickFixes` path the editor's lightbulb uses, and
// applied through the editor handle as one undoable edit; and *Ask the
// agent*, which opens the Agent tab with the diagnostic in the composer.
// Clicking a row reveals it in Source.  Errors / Warnings chips filter the
// list; `F8` / `Shift+F8` (installed at App level) step through it.

interface Props {
  ctx: Pick<
    LayoutCtx,
    "diagnostics" | "getSource" | "activeSourcePath" | "editorHandleRef" | "revealSourceRange" | "askAgent"
  >;
}

export function ProblemsPanel({ ctx }: Props): JSX.Element {
  const { diagnostics, getSource, activeSourcePath, editorHandleRef, revealSourceRange, askAgent } = ctx;
  const [showErrors, setShowErrors] = useState(true);
  const [showWarnings, setShowWarnings] = useState(true);

  const ordered = useMemo(() => inDocumentOrder(diagnostics), [diagnostics]);
  const shown = ordered.filter((d) =>
    d.severity === "error" ? showErrors : d.severity === "warning" ? showWarnings : true,
  );

  // The fix-hint quick fixes for the CURRENT source — re-resolved when the
  // diagnostics move (they move on every validated keystroke, which is
  // exactly when the source changed).  `loomQuickFixes` memoises on the
  // source text, so this costs one validate per distinct source, shared
  // with the editor's own code-action provider.
  const [fixes, setFixes] = useState<LoomQuickFix[]>([]);
  useEffect(() => {
    let live = true;
    if (diagnostics.length === 0) {
      setFixes([]);
      return;
    }
    void loomQuickFixes(getSource(), modelUriFor(activeSourcePath)).then((f) => {
      if (live) setFixes(f);
    });
    return () => {
      live = false;
    };
  }, [diagnostics, getSource, activeSourcePath]);

  if (diagnostics.length === 0) {
    return (
      <Text c="dimmed" size="sm" p="sm" data-testid="problems-empty">
        {PROBLEMS.empty}
      </Text>
    );
  }

  const errorCount = ordered.filter((d) => d.severity === "error").length;
  const warningCount = ordered.filter((d) => d.severity === "warning").length;

  return (
    <Stack gap={4} p="xs" data-testid="problems-list">
      <Group gap={6}>
        <Chip
          size="xs"
          checked={showErrors}
          onChange={setShowErrors}
          color="red"
          variant="light"
          data-testid="problems-filter-errors"
        >
          {PROBLEMS.errors} · {errorCount}
        </Chip>
        <Chip
          size="xs"
          checked={showWarnings}
          onChange={setShowWarnings}
          color="yellow"
          variant="light"
          data-testid="problems-filter-warnings"
        >
          {PROBLEMS.warnings} · {warningCount}
        </Chip>
      </Group>
      {shown.length === 0 ? (
        <Text c="dimmed" size="sm" px={4}>
          {PROBLEMS.filteredOut}
        </Text>
      ) : (
        shown.map((d, i) => (
          <ProblemRow
            key={`${d.range.start.line}:${d.range.start.character}:${d.code ?? ""}:${i}`}
            d={d}
            fix={fixFor(d, fixes)}
            onReveal={() => revealSourceRange(toEditorRange(d))}
            onFix={(f) => editorHandleRef.current?.applyEdits(f.edits)}
            onAsk={() => askAgent(PROBLEMS.agentPrompt(d.range.start.line + 1, d.code, d.message))}
          />
        ))
      )}
    </Stack>
  );
}

/** The quick fix anchored on this diagnostic's line, if any.  Line
 *  granularity mirrors the lightbulb (`quickFixesAt`): a fix's anchor is
 *  the diagnostic's own range, so the first fix on the row's line is the
 *  row's fix.  A `choose`-kind hint fans out several; the row offers the
 *  preferred one, else the first. */
function fixFor(d: Diagnostic, fixes: readonly LoomQuickFix[]): LoomQuickFix | null {
  const line = d.range.start.line + 1;
  const onLine = fixes.filter((f) => f.anchor.startLineNumber <= line && line <= f.anchor.endLineNumber);
  return onLine.find((f) => f.preferred) ?? onLine[0] ?? null;
}

function ProblemRow({
  d,
  fix,
  onReveal,
  onFix,
  onAsk,
}: {
  d: Diagnostic;
  fix: LoomQuickFix | null;
  onReveal: () => void;
  onFix: (f: LoomQuickFix) => void;
  onAsk: () => void;
}): JSX.Element {
  const colour = d.severity === "error" ? "red" : d.severity === "warning" ? "yellow" : "blue";
  const docs = d.code ? codeDocsUrl(d.code) : undefined;
  const line = d.range.start.line + 1;
  return (
    <Group
      gap="xs"
      align="flex-start"
      wrap="nowrap"
      data-testid="problem-row"
      data-code={d.code}
      data-severity={d.severity}
      style={{
        borderRadius: 4,
        padding: "2px 4px",
      }}
    >
      <UnstyledButton
        onClick={onReveal}
        data-testid="problem-jump"
        aria-label={`Line ${line}: ${d.message}`}
        style={{ flex: 1, minWidth: 0, display: "flex", gap: 8, alignItems: "flex-start" }}
      >
        <Badge size="xs" color={colour} variant="light" mt={2} style={{ flexShrink: 0 }}>
          {d.severity}
        </Badge>
        <Text size="xs" ff="monospace" c="dimmed" mt={2} style={{ flexShrink: 0 }}>
          {line}:{d.range.start.character + 1}
        </Text>
        <Text size="sm" style={{ whiteSpace: "pre-wrap", flex: 1, minWidth: 0 }}>
          {d.message}
        </Text>
      </UnstyledButton>
      <Group gap={4} wrap="nowrap" style={{ flexShrink: 0 }}>
        {d.code && (
          <Badge size="xs" variant="outline" color="gray" ff="monospace" tt="none" data-testid="problem-code">
            {d.code}
          </Badge>
        )}
        {docs && (
          <Tooltip label={PROBLEMS.docsHint(d.code ?? "")} withArrow openDelay={400}>
            <Anchor
              href={docs}
              target="_blank"
              rel="noreferrer"
              size="xs"
              data-testid="problem-docs"
            >
              {PROBLEMS.docs}
            </Anchor>
          </Tooltip>
        )}
        {fix && (
          <Tooltip label={fix.title} withArrow openDelay={400}>
            <Button
              size="compact-xs"
              variant="light"
              onClick={() => onFix(fix)}
              data-testid="problem-fix"
              title={PROBLEMS.fixHint}
            >
              {PROBLEMS.fix}
            </Button>
          </Tooltip>
        )}
        <Tooltip label={PROBLEMS.askAgentHint} withArrow openDelay={400}>
          <ActionIcon
            size="sm"
            variant="subtle"
            color="gray"
            onClick={onAsk}
            aria-label={PROBLEMS.askAgent}
            data-testid="problem-ask-agent"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21 12a8 8 0 0 1-8 8H8l-5 3 1.5-4.5A8 8 0 1 1 21 12z" />
            </svg>
          </ActionIcon>
        </Tooltip>
      </Group>
    </Group>
  );
}

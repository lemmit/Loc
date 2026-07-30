// ---------------------------------------------------------------------------
// The two exits a static site can afford: the clipboard and a prefilled
// GitHub issue.  Rendered on BOTH crash fallbacks (root + pane), in the
// Output panel's Diagnostics stream, and on the "you crashed last session"
// notice — the same component everywhere, so a report filed from any of them
// has the identical shape.
//
// Nothing here transmits anything.  "Report on GitHub" is an ordinary link
// the user chooses to follow; the issue body is prefilled client-side.
// ---------------------------------------------------------------------------

import { Anchor, Button, Code, Group, Stack, Text } from "@mantine/core";
import { useCallback, useEffect, useState } from "react";
import { buildCrashReport, crashIssueUrl } from "./util/crash-report";
import { collectCrashReportInput, type LiveCrash } from "./util/crash-context";

interface Props {
  /** A crash caught right now, spliced into the report if the async ring
   *  write hasn't landed yet. */
  live?: LiveCrash;
  size?: "xs" | "sm";
}

export function CrashReportButtons({ live, size = "sm" }: Props): JSX.Element {
  const [issueHref, setIssueHref] = useState<string | null>(null);
  const [report, setReport] = useState<string | null>(null);
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");

  // The prefill URL needs the (async) workspace fingerprint, so it can't be
  // computed during render; it lands a tick later and enables the link.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const input = await collectCrashReportInput(live);
        if (alive) setIssueHref(crashIssueUrl(input));
      } catch {
        // leave the link disabled rather than rendering a broken href
      }
    })();
    return () => {
      alive = false;
    };
    // `live` is a fresh object each render on the fallbacks; key off its
    // identity-free contents so this runs once per distinct crash.
  }, [live?.reason, live?.detail?.message]);

  const copy = useCallback(async () => {
    let text = "";
    try {
      text = buildCrashReport(await collectCrashReportInput(live));
      setReport(text);
    } catch {
      setCopied("failed");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setCopied("copied");
    } catch {
      // Clipboard API is unavailable on insecure origins and blocked by some
      // permission policies — the rendered block below is then the copy path.
      setCopied("failed");
    }
  }, [live]);

  return (
    <Stack gap={6}>
      <Group gap="xs">
        <Button
          size={size === "xs" ? "compact-xs" : "xs"}
          variant="default"
          onClick={() => void copy()}
          data-testid="crash-report-copy"
        >
          {copied === "copied" ? "Copied" : "Copy crash report"}
        </Button>
        <Button
          size={size === "xs" ? "compact-xs" : "xs"}
          variant="default"
          component="a"
          href={issueHref ?? undefined}
          target="_blank"
          rel="noreferrer noopener"
          disabled={issueHref === null}
          data-testid="crash-report-github"
        >
          Report on GitHub
        </Button>
      </Group>
      {report && (
        <Stack gap={4}>
          <Text size="xs" c="dimmed">
            {copied === "failed"
              ? "Clipboard unavailable — select and copy the report below."
              : "This is exactly what was copied. No source text, credentials or API keys are included."}
          </Text>
          <Code
            block
            style={{ whiteSpace: "pre-wrap", maxHeight: 220, overflow: "auto", fontSize: 11 }}
            data-testid="crash-report-preview"
          >
            {report}
          </Code>
          <Text size="xs" c="dimmed">
            Paste it into{" "}
            <Anchor size="xs" href={issueHref ?? undefined} target="_blank" rel="noreferrer noopener">
              a new crash-report issue
            </Anchor>
            .
          </Text>
        </Stack>
      )}
    </Stack>
  );
}

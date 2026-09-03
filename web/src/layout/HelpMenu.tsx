import { ActionIcon, Menu } from "@mantine/core";
import { useEffect, useState } from "react";
import { collectCrashReportInput } from "../util/crash-context";
import { crashIssueUrl } from "../util/crash-report";
import type { LayoutCtx } from "./ctx";
import { HELP } from "./vocabulary";

// The `?` help menu (M-T8.18 slice 3, audit H5): Docs, Language reference,
// Keyboard shortcuts, Report a problem.  Desktop renders it as an ActionIcon
// beside the `⋯` overflow menu; mobile folds the same items into the header
// kebab (`HelpMenuItems`).  "Report a problem" is the existing crash-report
// prefill — the same URL `CrashReportButtons` builds — so a report filed from
// here has the identical shape.

interface Props {
  ctx: Pick<LayoutCtx, "setShortcutSheetOpen">;
}

export function HelpMenu({ ctx }: Props): JSX.Element {
  return (
    <Menu shadow="md" position="bottom-start" withinPortal>
      <Menu.Target>
        <ActionIcon size="sm" variant="default" aria-label={HELP.menu} data-testid="help-menu">
          ?
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        <HelpMenuItems ctx={ctx} />
      </Menu.Dropdown>
    </Menu>
  );
}

/** The four items, for embedding in another `Menu.Dropdown` (mobile). */
export function HelpMenuItems({ ctx }: Props): JSX.Element {
  const [issueHref, setIssueHref] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const input = await collectCrashReportInput();
        if (alive) setIssueHref(crashIssueUrl(input));
      } catch {
        // leave the link disabled rather than rendering a broken href
      }
    })();
    return () => {
      alive = false;
    };
  }, []);
  return (
    <>
      <Menu.Label>{HELP.menu}</Menu.Label>
      <Menu.Item component="a" href={HELP.docsUrl} target="_blank" rel="noreferrer" data-testid="help-docs">
        {HELP.docs}
      </Menu.Item>
      <Menu.Item component="a" href={HELP.referenceUrl} target="_blank" rel="noreferrer" data-testid="help-reference">
        {HELP.reference}
      </Menu.Item>
      <Menu.Item onClick={() => ctx.setShortcutSheetOpen(true)} data-testid="help-shortcuts">
        {HELP.shortcuts}
      </Menu.Item>
      <Menu.Item
        component="a"
        href={issueHref ?? undefined}
        target="_blank"
        rel="noreferrer"
        disabled={!issueHref}
        data-testid="help-report"
      >
        {HELP.report}
      </Menu.Item>
    </>
  );
}

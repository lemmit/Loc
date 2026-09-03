import { Badge, Box, VisuallyHidden } from "@mantine/core";
import type { LayoutCtx } from "./ctx";
import { countOf, PANE } from "./vocabulary";

// Status marks for tabs and stream options (M-T8.16 slice 3, audit M11):
// a count badge where a count exists ("2" with the accessible name
// "2 errors"), otherwise a dot with a visually-hidden label — never colour
// alone.  One component so the dock, the mobile tab bar and the Output
// stream Select all read the same.

export type MarkColour = "red" | "yellow" | "green" | "gray";

export interface Mark {
  colour: MarkColour;
  /** Rendered as the badge text when > 0; a dot otherwise. */
  count?: number;
  /** The accessible text — what the colour means. */
  label: string;
}

export function StatusMark({ mark, testid }: { mark: Mark | null; testid?: string }): JSX.Element | null {
  if (!mark) return null;
  if (mark.count != null && mark.count > 0) {
    return (
      <Badge
        size="xs"
        variant="filled"
        color={mark.colour}
        circle={mark.count < 10}
        title={mark.label}
        data-testid={testid}
        data-count={mark.count}
        style={{ flexShrink: 0 }}
      >
        <span aria-hidden>{mark.count}</span>
        <VisuallyHidden>{mark.label}</VisuallyHidden>
      </Badge>
    );
  }
  return (
    <Box component="span" title={mark.label} data-testid={testid} style={{ display: "inline-flex", alignItems: "center" }}>
      <Box
        component="span"
        w={7}
        h={7}
        aria-hidden
        style={{
          display: "inline-block",
          borderRadius: "50%",
          background: `var(--mantine-color-${mark.colour}-6)`,
        }}
      />
      <VisuallyHidden>{mark.label}</VisuallyHidden>
    </Box>
  );
}

// ---------------------------------------------------------------------
// Per-pane marks.  Each returns null when there is nothing to look at —
// a permanent grey dot reads as "something needs attention" (audit M4).
// ---------------------------------------------------------------------

/** Tests: the failed count. */
export function testsMark(ctx: LayoutCtx): Mark | null {
  const failed = Object.values(ctx.testResults).filter((r) => r.status === "fail").length;
  return failed > 0 ? { colour: "red", count: failed, label: countOf(failed, "failed test") } : null;
}

/** Migrations: destructive count (red), else breaking (red dot), else any
 *  schema / wire delta (yellow dot). */
export function migrationsMark(ctx: LayoutCtx): Mark | null {
  const e = ctx.evolution;
  if (!e || !e.ok) return null;
  const destructive = e.migrations.filter((m) => m.destructive).length;
  if (destructive > 0) {
    return { colour: "red", count: destructive, label: countOf(destructive, "destructive migration") };
  }
  if (e.breaking) return { colour: "red", label: "breaking wire change" };
  if (e.migrations.length > 0 || e.wireChanges.length > 0) {
    return { colour: "yellow", label: "schema or wire changes" };
  }
  return null;
}

/** Runtime: booted. */
export function runtimeMark(ctx: LayoutCtx): Mark | null {
  return ctx.ddl ? { colour: "green", label: "booted" } : null;
}

/** Agent: the last turn finished. */
export function agentMark(ctx: LayoutCtx): Mark | null {
  const last = ctx.agentMessages.at(-1);
  return last && last.role === "assistant" && /Done|✅/.test(last.text)
    ? { colour: "green", label: "done" }
    : null;
}

/** Auth: the dev identity is injected into requests. */
export function authMark(ctx: LayoutCtx, active: boolean): Mark | null {
  return active ? { colour: "green", label: `dev identity active` } : null;
}

/** The worst of several marks — a count wins over a dot, red over yellow
 *  over green.  Used by the mobile **More** tab to summarise the sheet. */
export function worstMark(marks: (Mark | null)[]): Mark | null {
  const rank = (m: Mark): number =>
    (m.count ? 10 : 0) + (m.colour === "red" ? 3 : m.colour === "yellow" ? 2 : m.colour === "green" ? 1 : 0);
  let best: Mark | null = null;
  for (const m of marks) {
    if (m && (!best || rank(m) > rank(best))) best = m;
  }
  return best;
}

export const MORE_SHEET_TITLE = PANE.more;

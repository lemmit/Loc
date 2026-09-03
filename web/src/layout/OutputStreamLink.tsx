import { Anchor } from "@mantine/core";
import type { LayoutCtx } from "./ctx";
import type { OutputStream } from "./OutputPanel";

// "See Output → <stream>" — the one link every interpretation line carries
// (M-T8.22, audit M19).  Switches the Output stream and reveals the Output
// surface on whichever shell is showing: the dock tab on desktop, the
// bottom tab on mobile.  A link, not a button: it navigates, it doesn't act.
export function OutputStreamLink({
  ctx,
  stream,
  label,
  testid,
}: {
  ctx: LayoutCtx;
  stream: OutputStream;
  label: string;
  testid?: string;
}): JSX.Element {
  return (
    <Anchor
      component="button"
      type="button"
      size="xs"
      onClick={() => {
        ctx.setOutputStream(stream);
        if (ctx.isDesktop) ctx.setDockTab("output");
        else ctx.setActiveTab("output");
      }}
      data-testid={testid ?? `see-stream-${stream}`}
    >
      {label} →
    </Anchor>
  );
}

// ---------------------------------------------------------------------------
// Deliberate crash triggers — the only way to test an error boundary end to
// end.
//
// `playwright.config.ts` runs `vite build && vite preview`, so specs execute a
// PRODUCTION bundle: an `import.meta.env.DEV`-gated trigger would be compiled
// out and the boundaries would stay untested (which is exactly why
// `builder-page.spec.ts` could only ever assert that the fallback *doesn't*
// appear).  The trigger is therefore unconditional, and reachable only by an
// explicit query parameter a user would have to type on purpose:
//
//   ?crash=app    — throw inside the ROOT boundary   (whole-page fallback)
//   ?crash=pane   — throw inside a PANE boundary     (contained fallback)
//
// It also doubles as a user-facing self-test: "does reporting work on my
// device" is answerable without waiting for a real crash.
// ---------------------------------------------------------------------------

import { PaneErrorBoundary } from "./PaneErrorBoundary";

/** The `crash` query parameter, or `null`.  Never throws (some embedding
 *  contexts make `location.search` inaccessible). */
export function crashParam(): string | null {
  try {
    return new URLSearchParams(window.location.search).get("crash");
  } catch {
    return null;
  }
}

function Thrower({ scope }: { scope: string }): null {
  throw new Error(
    `Forced crash (${scope}) — triggered by ?crash=${scope}, the diagnostics self-test.`,
  );
}

/** Mounted once in `main.tsx`, inside the root boundary and above `App`.
 *  Renders nothing at all unless the query parameter asks for a crash. */
export function CrashTestHooks(): JSX.Element | null {
  const scope = crashParam();
  if (scope === "app") return <Thrower scope="app" />;
  if (scope === "pane") {
    return (
      <PaneErrorBoundary name="Crash self-test">
        <Thrower scope="pane" />
      </PaneErrorBoundary>
    );
  }
  return null;
}

import { useEffect, useRef, useState } from "react";
import { ActionIcon, Box, Group, Text, Tooltip } from "@mantine/core";
import type { LoomRuntimeClient } from "../runtime/client";
import { makePreviewHtml } from "./iframe-html";
import { attachRuntimePort, pushBundle, sandboxUrl } from "./sw-host";
import { fnv1a32 } from "../util/hash";

interface PreviewProps {
  /** React bundle JS — output of `bundle.worker.ts` for kind: "react". */
  js: string;
  /** Combined CSS extracted from the bundle (Mantine + any user CSS). */
  css?: string;
  /** Pkg → semver map harvested from the generator's package.json.
   *  Drives the iframe's importmap so React/React-DOM resolve to
   *  the same esm.sh URL the bundle was compiled against. */
  versions?: Record<string, string>;
  /** Live runtime worker.  In-iframe fetches against the sandbox
   *  runtime path are forwarded through the SW to this client. */
  runtime: LoomRuntimeClient;
}

// Preview requires Service Worker support to serve the iframe
// from the sandbox URL.  Modern browsers all support SW over
// secure contexts (HTTPS, localhost); the playground's only hard
// requirement is therefore HTTPS or localhost.  When SW is
// unavailable we render an explanatory error instead of a broken
// iframe.
const SW_AVAILABLE =
  typeof navigator !== "undefined" &&
  "serviceWorker" in navigator &&
  typeof window !== "undefined" &&
  window.isSecureContext === true;

// Fullscreen target — wraps the iframe (not the header bar) so the
// generated app fills the actual screen edge-to-edge when expanded.
// Browser's Esc key exits fullscreen via the standard
// `fullscreenchange` event; our state listener flips the button
// affordance back to "expand" when that happens.
function MaximizeIcon({ size = 14 }: { size?: number }): JSX.Element {
  // Tabler IconArrowsMaximize, inlined so the playground doesn't
  // pick up @tabler/icons-react for a single button.
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M16 4h4v4" />
      <path d="M14 10l6 -6" />
      <path d="M8 20h-4v-4" />
      <path d="M4 20l6 -6" />
      <path d="M16 20h4v-4" />
      <path d="M14 14l6 6" />
      <path d="M8 4h-4v4" />
      <path d="M4 4l6 6" />
    </svg>
  );
}

function MinimizeIcon({ size = 14 }: { size?: number }): JSX.Element {
  // Tabler IconArrowsMinimize.
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 9h4v-4" />
      <path d="M3 3l6 6" />
      <path d="M5 15h4v4" />
      <path d="M3 21l6 -6" />
      <path d="M19 9h-4v-4" />
      <path d="M15 3l6 6" />
      <path d="M19 15h-4v4" />
      <path d="M15 21l6 -6" />
    </svg>
  );
}

export function Preview({ js, css, versions, runtime }: PreviewProps): JSX.Element {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const fullscreenTargetRef = useRef<HTMLDivElement | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Track fullscreen state so the toggle button reflects browser
  // truth — including Esc-to-exit and any future per-iframe fs
  // request from inside the bundle itself.
  useEffect(() => {
    const onChange = (): void => {
      setIsFullscreen(document.fullscreenElement !== null);
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleFullscreen = async (): Promise<void> => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else if (fullscreenTargetRef.current) {
        await fullscreenTargetRef.current.requestFullscreen();
      }
    } catch {
      // Fullscreen API rejects when permission is missing or the
      // user gesture wasn't propagated.  Swallow — the button just
      // becomes a no-op in those rare cases instead of throwing.
    }
  };

  // Wire the SW's runtime bridge to the in-process runtime worker.
  // The SW forwards `<sandbox>/runtime/*` fetches through the
  // MessageChannel; we translate each into a runtime.dispatch()
  // call and post back the response.  Re-attach when the runtime
  // client identity changes (App.tsx replaces the client on
  // re-mount); the cleanup closes the port so the SW falls back
  // to 502 until the next attach completes.
  const [runtimeAttached, setRuntimeAttached] = useState(false);
  useEffect(() => {
    if (!SW_AVAILABLE) return;
    let dispose: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      const reg = await navigator.serviceWorker.ready;
      if (cancelled) return;
      const detach = await attachRuntimePort(reg, async (req) => {
        const result = await runtime.dispatch({
          url: req.url,
          method: req.method,
          headers: req.headers,
          body: req.body,
        });
        if (result.ok) {
          return {
            ok: true,
            status: result.response.status,
            statusText: result.response.statusText,
            headers: result.response.headers,
            body: result.response.body,
          };
        }
        return { ok: false, message: result.message };
      });
      if (cancelled) {
        detach?.();
        return;
      }
      dispose = detach ?? undefined;
      setRuntimeAttached(true);
    })();
    return () => {
      cancelled = true;
      setRuntimeAttached(false);
      dispose?.();
    };
  }, [runtime]);

  // Build the document and push it to the SW.  Once both the
  // bundle is pushed AND the runtime port is attached we set
  // `pushedHash` so the iframe renders.  Gating on `runtimeAttached`
  // makes sure the bundle's first fetch can't outrun the runtime
  // bridge — otherwise the user would briefly see a 502 from the
  // SW.  `pushedHash` doubles as the iframe `key` so each new
  // bundle remounts the iframe (real navigation, not bfcache).
  const [pushedHash, setPushedHash] = useState<string | null>(null);
  useEffect(() => {
    if (!SW_AVAILABLE) return;
    if (!runtimeAttached) return;
    let cancelled = false;
    // Compute the basename the bundle's BrowserRouter should use.
    // The iframe loads at `<deploy>/__loom_sandbox__/`; routes
    // emitted by the generator are rooted at `/` (e.g. `/customers`),
    // so we tell react-router that the iframe URL pathname *is* the
    // base.  The injected `window.__LOOM_BASENAME__` is read by the
    // generated `main.tsx`.  Without this, BrowserRouter would
    // try to match `/loc/playground/__loom_sandbox__/` against
    // user routes (no match → "Not found"), and link clicks would
    // pushState to `/customers`, leaking out of SW scope and
    // breaking subsequent runtime fetches.
    const sandboxBase = new URL(sandboxUrl()).pathname.replace(/\/$/, "");
    const html = makePreviewHtml({ js, css, versions, sandboxBase });
    void (async () => {
      try {
        const reg = await navigator.serviceWorker.ready;
        if (cancelled) return;
        await pushBundle(reg, { html, js, css });
        if (cancelled) return;
        setPushedHash(fnv1a32(html));
      } catch {
        // SW push failed — `pushedHash` stays at the prior value
        // (or null on first failure).  The next bundle's effect
        // will retry.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [js, css, versions, runtimeAttached]);

  return (
    <Box style={{ height: "100%", width: "100%", display: "flex", flexDirection: "column" }}>
      <Box px="sm" py={4} bg="dark.6" style={{ borderBottom: "1px solid var(--mantine-color-dark-4)" }}>
        <Group justify="space-between" wrap="nowrap" gap="xs">
          <Text size="xs" fw={600} tt="uppercase" c="dimmed">
            Preview — generated React app, fetches routed to PGlite
          </Text>
          <Tooltip
            label={isFullscreen ? "Exit full screen (Esc)" : "Open full screen"}
            withArrow
            position="left"
            openDelay={300}
          >
            <ActionIcon
              size="sm"
              variant="subtle"
              color="gray"
              onClick={() => {
                void toggleFullscreen();
              }}
              aria-label={isFullscreen ? "Exit full screen" : "Open full screen"}
              data-testid="preview-fullscreen-toggle"
            >
              {isFullscreen ? <MinimizeIcon /> : <MaximizeIcon />}
            </ActionIcon>
          </Tooltip>
        </Group>
      </Box>
      <Box
        ref={fullscreenTargetRef}
        style={{ flex: 1, minHeight: 0, background: "white" }}
      >
        {!SW_AVAILABLE ? (
          // No SW available — the preview iframe needs the SW to
          // serve the bundle and bridge runtime fetches.  Surface
          // a clear message instead of a broken iframe.  In
          // practice this only happens on insecure-context dev
          // setups (HTTP, file://) since modern browsers ship SW
          // over HTTPS / localhost.
          <Box p="md">
            <Text size="sm" c="dimmed">
              Preview requires Service Worker support over a secure context
              (HTTPS or localhost).
            </Text>
          </Box>
        ) : (
          // `key` remounts on each new bundle so the browser
          // re-navigates rather than serving the same URL from
          // bfcache.  Render only after `pushedHash` is set;
          // before that the SW would answer with its 503 "bundle
          // first" placeholder.  No `sandbox` attribute: the SW
          // response runs in our origin and we want it to share
          // postMessage + history with the parent unencumbered.
          pushedHash !== null && (
            <iframe
              key={pushedHash}
              ref={iframeRef}
              src={sandboxUrl()}
              style={{ width: "100%", height: "100%", border: "none" }}
              title="Loom-generated app"
              data-testid="preview-iframe"
            />
          )
        )}
      </Box>
    </Box>
  );
}

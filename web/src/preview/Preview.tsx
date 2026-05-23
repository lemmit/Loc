import { useEffect, useMemo, useRef, useState } from "react";
import { ActionIcon, Box, Group, Text, Tooltip } from "@mantine/core";
import type { RuntimeDispatcher } from "../engine";
import { SandboxBridge } from "./bridge/parent-bridge";
import {
  SANDBOX_ORIGIN,
  SANDBOX_SAME_ORIGIN,
  sandboxBasename,
  sandboxStubUrl,
} from "./sandbox-origin";
import { makePreviewHtml } from "./iframe-html";
import { setActiveDriverPort } from "./active-driver-port";
import { fnv1a32 } from "../util/hash";
import type { LogLine } from "../util/log-line";

interface PreviewProps {
  /** React bundle JS — output of `bundle.worker.ts` for kind: "react". */
  js: string;
  /** Combined CSS extracted from the bundle (Mantine + any user CSS). */
  css?: string;
  /** Pkg → semver map harvested from the generator's package.json.
   *  Drives the iframe's importmap so React/React-DOM resolve to
   *  the same version the bundle was compiled against. */
  versions?: Record<string, string>;
  /** C2: when the bundle externalised a prebuilt design-pack vendor,
   *  the iframe importmap (bare spec → origin-absolute url) + optional
   *  vendor.css url.  Absent → self-contained bundle (no vendor map). */
  vendorImportmap?: Record<string, string>;
  vendorCssUrl?: string;
  /** Live runtime dispatcher (the RuntimeEngine).  The preview's
   *  in-iframe `fetch` shim forwards API requests over the sandbox
   *  bridge to this. */
  runtime: RuntimeDispatcher;
  /** Sink for the preview app's `console.*` + uncaught errors,
   *  forwarded over the sandbox bridge — feeds the "App" log stream. */
  onAppLog?: (line: LogLine) => void;
}

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

export function Preview({
  js,
  css,
  versions,
  vendorImportmap,
  vendorCssUrl,
  runtime,
  onAppLog,
}: PreviewProps): JSX.Element {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  // Held in a ref so a changing callback identity never re-triggers the
  // bridge handshake effect (its deps are deliberately narrow).
  const onAppLogRef = useRef(onAppLog);
  onAppLogRef.current = onAppLog;
  const fullscreenTargetRef = useRef<HTMLDivElement | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  // CSS-based fallback for platforms where `Element.requestFullscreen`
  // is unsupported or rejects.  iOS Safari (and every iOS browser,
  // since they all use WebKit) doesn't implement the standard API
  // for arbitrary elements — only `<video>` via the WebKit-prefixed
  // `webkitEnterFullscreen`.  Without this fallback the Maximize
  // button is a no-op on mobile.  We track the two modes separately
  // (native vs pseudo) but expose a single "is maximised" boolean
  // to the UI so the button icon stays in sync regardless of path.
  const [pseudoFullscreen, setPseudoFullscreen] = useState(false);
  const isMaximized = isFullscreen || pseudoFullscreen;

  // Track native fullscreen state so the toggle button reflects
  // browser truth — including Esc-to-exit and any future per-iframe
  // fs request from inside the bundle itself.
  useEffect(() => {
    const onChange = (): void => {
      setIsFullscreen(document.fullscreenElement !== null);
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  // Esc-to-exit for the CSS fallback.  Native fullscreen exits on
  // Esc automatically; the pseudo overlay needs its own handler
  // because it's just a position:fixed box.
  useEffect(() => {
    if (!pseudoFullscreen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setPseudoFullscreen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [pseudoFullscreen]);

  const toggleFullscreen = async (): Promise<void> => {
    // Exit whichever mode is active.
    if (pseudoFullscreen) {
      setPseudoFullscreen(false);
      return;
    }
    if (document.fullscreenElement) {
      try {
        await document.exitFullscreen();
      } catch {
        /* nothing else to do */
      }
      return;
    }
    // Enter native fullscreen when the API is genuinely available.
    // `document.fullscreenEnabled` returns false on iOS Safari and
    // any embedded WebView that opts out, which is the case we need
    // the CSS fallback for.  Wrap the call in try/catch anyway —
    // Permissions-Policy frame-ancestors can reject the request at
    // runtime even when the API is exposed.
    const target = fullscreenTargetRef.current;
    if (document.fullscreenEnabled && target?.requestFullscreen) {
      try {
        await target.requestFullscreen();
        return;
      } catch {
        // Fall through to the CSS overlay below.
      }
    }
    setPseudoFullscreen(true);
  };

  // Static stub URL on SANDBOX_ORIGIN (computed once).
  const stubUrl = useMemo(() => sandboxStubUrl(), []);
  // The sandbox UI-test driver module, served alongside the stub (so it is
  // same-origin as the sandbox document in both same- and cross-origin modes).
  const driverUrl = useMemo(
    () => new URL("driver.js", stubUrl).toString(),
    [stubUrl],
  );

  // Bundle identity is split in two so ordinary edits refresh the
  // preview in place instead of remounting the iframe:
  //  - docKey: the page-shell inputs (importmap / vendor css / pkg
  //    versions).  A change means the synthesised document itself
  //    differs, so the iframe must remount and re-handshake.  Rare —
  //    only when deps or the design-pack vendor change.
  //  - codeKey: the app bundle (js + css), which is what changes after
  //    a normal `.ddd` edit.  Pushed into the LIVE iframe as an
  //    in-place reload (route + shell survive, no white flash).
  const docKey = fnv1a32(
    JSON.stringify(versions ?? {}) + "\0" + JSON.stringify(vendorImportmap ?? {}) + "\0" + (vendorCssUrl ?? ""),
  );
  const codeKey = fnv1a32((js ?? "") + "\0" + (css ?? ""));

  // Latest preview material, read by the start effect at mount time
  // without being a dependency — we must NOT re-handshake on every code
  // edit (that's the reload effect's job).
  const materialRef = useRef({ js, css, versions, vendorImportmap, vendorCssUrl });
  materialRef.current = { js, css, versions, vendorImportmap, vendorCssUrl };

  const bridgeRef = useRef<SandboxBridge | null>(null);
  // codeKey baked into the document the bridge last (re)started with, so
  // the reload effect skips the bundle that's already mounted.
  const startedCodeKeyRef = useRef<string | null>(null);

  // Create + start the bridge for the current iframe.  Re-runs only
  // when the iframe element identity changes (docKey remounts it) or
  // runtime/stub changes — never on an ordinary code edit.  The bridge
  // attaches a `loom-stub-ready` listener immediately; when the mounted
  // stub announces itself it gets the document + one MessagePort, and
  // forwarded runtime requests are dispatched to the engine.
  useEffect(() => {
    const el = iframeRef.current;
    if (!el) return;
    const m = materialRef.current;
    const html = makePreviewHtml({
      js: m.js,
      css: m.css,
      versions: m.versions,
      vendorImportmap: m.vendorImportmap,
      vendorCssUrl: m.vendorCssUrl,
      sandboxBase: sandboxBasename(stubUrl),
      driverUrl,
    });
    const bridge = new SandboxBridge(
      el,
      SANDBOX_ORIGIN,
      (req) => runtime.dispatch(req),
      setActiveDriverPort,
      (line) => onAppLogRef.current?.(line),
    );
    bridgeRef.current = bridge;
    startedCodeKeyRef.current = codeKey;
    bridge.start(html);
    return () => {
      bridge.dispose();
      bridgeRef.current = null;
      startedCodeKeyRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey, runtime, stubUrl]);

  // Code-only rebuilds: hot-swap the bundle into the live preview in
  // place.  Skips the bundle already baked into the freshly-started
  // document (startedCodeKeyRef), so the first render after a remount
  // doesn't double-mount.
  useEffect(() => {
    const bridge = bridgeRef.current;
    if (!bridge) return;
    if (startedCodeKeyRef.current === codeKey) return;
    const m = materialRef.current;
    bridge.pushReload({ js: m.js, css: m.css });
    startedCodeKeyRef.current = codeKey;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [codeKey]);

  return (
    // The whole Preview is the fullscreen target so the toolbar (and
    // therefore the Minimise button) stays accessible — important
    // for the CSS fallback path, since pseudo-fullscreen has no Esc
    // affordance on a touch device.  In native fullscreen Esc still
    // works; the visible toolbar is just a bonus.
    <Box
      ref={fullscreenTargetRef}
      style={{
        height: "100%",
        width: "100%",
        display: "flex",
        flexDirection: "column",
        // Pseudo-fullscreen overlay.  `position: fixed` lifts the
        // Preview out of the playground's column flex and pins it to
        // the viewport edges; `100dvh` follows iOS's dynamic
        // viewport so the iframe doesn't sit under the bottom URL
        // bar.  zIndex picks any value above Mantine's defaults.
        ...(pseudoFullscreen
          ? {
              position: "fixed" as const,
              inset: 0,
              height: "100dvh",
              width: "100dvw",
              zIndex: 9999,
              background: "white",
            }
          : {}),
      }}
    >
      <Box
        px="sm"
        py={4}
        bg="dark.6"
        style={{ borderBottom: "1px solid var(--mantine-color-dark-4)" }}
      >
        <Group justify="space-between" wrap="nowrap" gap="xs">
          <Text size="xs" fw={600} tt="uppercase" c="dimmed">
            Preview — generated React app, fetches routed to PGlite
          </Text>
          <Tooltip
            label={isMaximized ? "Exit full screen (Esc)" : "Open full screen"}
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
              aria-label={isMaximized ? "Exit full screen" : "Open full screen"}
              data-testid="preview-fullscreen-toggle"
            >
              {isMaximized ? <MinimizeIcon /> : <MaximizeIcon />}
            </ActionIcon>
          </Tooltip>
        </Group>
      </Box>
      <Box style={{ flex: 1, minHeight: 0, background: "white" }}>
        {/* Iframe served from SANDBOX_ORIGIN.  Isolation comes from the
            ORIGIN, not the sandbox attribute: while same-origin (staging)
            there is no boundary, so we omit `sandbox` entirely — a
            `sandbox` with both `allow-scripts` and `allow-same-origin`
            would only emit the browser's "can escape its sandboxing"
            warning while providing nothing (escaping lands on the parent
            origin, which is where we already are).  Once SANDBOX_ORIGIN is
            a distinct origin the attribute is applied as defence-in-depth
            (blocks top-navigation / popups); its "can escape" caveat is
            then benign — escape means the sandbox's OWN origin, already
            isolated from the parent.  `key` remounts on each new bundle so
            the stub reloads. */}
        <iframe
          key={docKey}
          ref={(el) => {
            iframeRef.current = el;
          }}
          src={stubUrl}
          sandbox={
            SANDBOX_SAME_ORIGIN
              ? undefined
              : "allow-scripts allow-same-origin allow-forms"
          }
          style={{ width: "100%", height: "100%", border: "none" }}
          title="Loom-generated app"
          data-testid="preview-iframe"
        />
      </Box>
    </Box>
  );
}

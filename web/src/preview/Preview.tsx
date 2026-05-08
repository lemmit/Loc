import { useEffect, useMemo, useRef } from "react";
import { Box, Text } from "@mantine/core";
import type { LoomRuntimeClient } from "../runtime/client";
import { makePreviewHtml } from "./iframe-html";
import { pushBundle } from "./sw-host";

interface PreviewProps {
  /** React bundle JS — output of `bundle.worker.ts` for kind: "react". */
  js: string;
  /** Combined CSS extracted from the bundle (Mantine + any user CSS). */
  css?: string;
  /** Pkg → semver map harvested from the generator's package.json.
   *  Drives the iframe's importmap so React/React-DOM resolve to
   *  the same esm.sh URL the bundle was compiled against. */
  versions?: Record<string, string>;
  /** Live runtime worker — every fetch the iframe makes against
   *  `http://localhost:*` is forwarded here. */
  runtime: LoomRuntimeClient;
}

interface FetchRequestMsg {
  type: "loom-fetch";
  id: number;
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

interface FetchResponseMsg {
  type: "loom-fetch-response";
  id: number;
  ok: true;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
}

interface FetchErrorMsg {
  type: "loom-fetch-response";
  id: number;
  ok: false;
  message: string;
}

export function Preview({ js, css, versions, runtime }: PreviewProps): JSX.Element {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  // Build the document once per JS/CSS/versions tuple.  Switching
  // examples or re-bundling produces a new srcdoc → iframe re-renders
  // cleanly.
  const html = useMemo(
    () => makePreviewHtml({ js, css, versions }),
    [js, css, versions],
  );

  // Push the latest bundle to the preview Service Worker so it can
  // serve the synthesized HTML when the iframe-rewire PR lands.
  // No-op today against the user-facing preview (which still uses
  // srcDoc), but lets you navigate directly to `<base>/__loom_sandbox__/`
  // in a new tab to validate the SW serving path.  Bundle pushes are
  // cheap (string postMessage) and the SW only stores the latest.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
        return;
      }
      try {
        const reg = await navigator.serviceWorker.ready;
        if (cancelled) return;
        pushBundle(reg, { html, js, css });
      } catch {
        // Registration failed earlier in App.tsx; nothing to push.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [html, js, css]);

  useEffect(() => {
    const handler = async (ev: MessageEvent) => {
      const data = ev.data as FetchRequestMsg | undefined;
      if (!data || data.type !== "loom-fetch") return;
      // Only respond to our own iframe.
      const iframe = iframeRef.current;
      if (!iframe || ev.source !== iframe.contentWindow) return;

      const result = await runtime.dispatch({
        url: data.url,
        method: data.method,
        headers: data.headers,
        body: data.body,
      });
      let reply: FetchResponseMsg | FetchErrorMsg;
      if (result.ok) {
        reply = {
          type: "loom-fetch-response",
          id: data.id,
          ok: true,
          status: result.response.status,
          statusText: result.response.statusText,
          headers: result.response.headers,
          body: result.response.body,
        };
      } else {
        reply = {
          type: "loom-fetch-response",
          id: data.id,
          ok: false,
          message: result.message,
        };
      }
      iframe.contentWindow?.postMessage(reply, "*");
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [runtime]);

  return (
    <Box style={{ height: "100%", width: "100%", display: "flex", flexDirection: "column" }}>
      <Box px="sm" py={4} bg="dark.6" style={{ borderBottom: "1px solid var(--mantine-color-dark-4)" }}>
        <Text size="xs" fw={600} tt="uppercase" c="dimmed">
          Preview — generated React app, fetches routed to PGlite
        </Text>
      </Box>
      <Box style={{ flex: 1, minHeight: 0, background: "white" }}>
        <iframe
          ref={iframeRef}
          srcDoc={html}
          // sandbox flags: the iframe needs `allow-scripts` to run
          // the bundle and `allow-same-origin` so React's
          // BrowserRouter can read window.location.  We don't
          // surface forms/popups beyond what the generated app
          // already does.
          sandbox="allow-scripts allow-same-origin allow-forms"
          style={{ width: "100%", height: "100%", border: "none" }}
          title="Loom-generated app"
          data-testid="preview-iframe"
        />
      </Box>
    </Box>
  );
}

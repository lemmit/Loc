import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text } from "@mantine/core";
import type { LoomRuntimeClient } from "../runtime/client";
import { makePreviewHtml } from "./iframe-html";
import { pushBundle, sandboxUrl } from "./sw-host";
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

// SW availability is decided once at module load: secure context +
// `serviceWorker` in `navigator`.  When false, the preview falls
// back to the legacy srcDoc path so dev/test environments without
// HTTPS or with SW disabled still work.
const SW_AVAILABLE =
  typeof navigator !== "undefined" &&
  "serviceWorker" in navigator &&
  typeof window !== "undefined" &&
  window.isSecureContext === true;

export function Preview({ js, css, versions, runtime }: PreviewProps): JSX.Element {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const html = useMemo(
    () => makePreviewHtml({ js, css, versions }),
    [js, css, versions],
  );

  // SW path: push the bundle, then flip `pushedHash` so the iframe
  // renders with `src={sandboxUrl()}`.  Until the push round-trip
  // completes the iframe stays unmounted to avoid a 503 flash from
  // the SW's "bundle first" placeholder.  `pushedHash` doubles as
  // the iframe React `key`, so each new bundle remounts the iframe
  // cleanly (forces a real navigation rather than a same-URL no-op).
  const [pushedHash, setPushedHash] = useState<string | null>(null);
  useEffect(() => {
    if (!SW_AVAILABLE) return;
    let cancelled = false;
    void (async () => {
      try {
        const reg = await navigator.serviceWorker.ready;
        if (cancelled) return;
        await pushBundle(reg, { html, js, css });
        if (cancelled) return;
        setPushedHash(fnv1a32(html));
      } catch {
        // SW failed at runtime — leave `pushedHash` null and the
        // srcDoc fallback below renders instead.
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
        {SW_AVAILABLE ? (
          // SW path — real-origin iframe.  `key` remounts on each
          // new bundle so the browser re-navigates rather than
          // serving the same URL from its bfcache.  Render only
          // after `pushedHash` is set; before that the SW would
          // answer with its 503 "bundle first" placeholder, which
          // would flash for the user and double-load on push.  No
          // `sandbox` attribute: the SW response runs in our
          // origin and we want it to share postMessage + history
          // with the parent unencumbered (BrowserRouter's
          // pushState in particular).
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
        ) : (
          // Legacy fallback — srcDoc with the URL/Routing/fetch
          // shims baked in by `makePreviewHtml`.  Used only when
          // SW isn't available (insecure context, file://, browser
          // without SW support).
          <iframe
            ref={iframeRef}
            srcDoc={html}
            sandbox="allow-scripts allow-same-origin allow-forms"
            style={{ width: "100%", height: "100%", border: "none" }}
            title="Loom-generated app"
            data-testid="preview-iframe"
          />
        )}
      </Box>
    </Box>
  );
}

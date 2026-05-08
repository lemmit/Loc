import { useEffect, useRef, useState } from "react";
import { Box, Text } from "@mantine/core";
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

export function Preview({ js, css, versions, runtime }: PreviewProps): JSX.Element {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

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
    const html = makePreviewHtml({ js, css, versions });
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
        <Text size="xs" fw={600} tt="uppercase" c="dimmed">
          Preview — generated React app, fetches routed to PGlite
        </Text>
      </Box>
      <Box style={{ flex: 1, minHeight: 0, background: "white" }}>
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

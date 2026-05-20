// SANDBOX_ORIGIN — the origin the preview iframe is served from.
//
// Staged rollout (see docs/playground-sandbox-redesign.md): defaults
// to the playground's OWN origin, which ships on GitHub Pages today
// but gives no isolation yet.  Setting `VITE_SANDBOX_ORIGIN` to a
// distinct origin (a free second `*.github.io` site or a custom
// domain) turns the same iframe `sandbox` attribute into a real
// cross-site boundary — a config change, no code change.
//
// The preview iframe always loads a single static stub from this
// origin; the generated bundle is handed to it over `postMessage`,
// so the stub is fixed and the same mechanism works in both modes
// (a cross-origin host can't be handed files any other way).

const CONFIGURED =
  (import.meta.env.VITE_SANDBOX_ORIGIN as string | undefined)?.replace(
    /\/+$/,
    "",
  ) || null;

export const SANDBOX_ORIGIN: string =
  CONFIGURED ?? (typeof location !== "undefined" ? location.origin : "");

/** True while the sandbox shares the playground origin (staging mode
 *  — NO isolation).  Flips to false once `SANDBOX_ORIGIN` points at a
 *  distinct origin; the untrusted-user-code feature is gated on this
 *  being false. */
export const SANDBOX_SAME_ORIGIN: boolean =
  typeof location === "undefined" || SANDBOX_ORIGIN === location.origin;

/** URL of the static stub the iframe loads.
 *   - same-origin: a sibling of the playground page (`<base>/sandbox/`),
 *     so it inherits the deploy sub-path on GitHub Pages;
 *   - cross-origin: the sandbox site's `/sandbox/index.html`. */
export function sandboxStubUrl(): string {
  if (SANDBOX_SAME_ORIGIN) {
    return new URL("sandbox/index.html", location.href).toString();
  }
  return new URL("/sandbox/index.html", SANDBOX_ORIGIN).toString();
}

/** BrowserRouter basename for the app rendered inside the stub: the
 *  stub's directory, with the `index.html` / trailing slash stripped.
 *  The stub does `history.replaceState` to `basename + "/"` before the
 *  app mounts, so route matching starts at `/` regardless of the
 *  stub's filename. */
export function sandboxBasename(stubUrl: string): string {
  return new URL(stubUrl).pathname
    .replace(/\/index\.html$/, "")
    .replace(/\/+$/, "");
}

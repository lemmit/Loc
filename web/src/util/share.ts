// Share-via-URL helpers.
//
// We stash the editor's current `.ddd` source in `window.location.hash`
// so any deploy URL is shareable: paste it into chat / Slack / GitHub,
// the recipient lands on the playground with that exact source loaded.
// The hash key is `s` and the value is base64url-encoded UTF-8.
//
// Why the hash and not a query param: hashes never round-trip to
// the server (GitHub Pages is purely static) and don't need a new
// HTTP request to update — we use `history.replaceState` so editing
// doesn't pollute browser history.
//
// Why base64url + UTF-8 (not LZ-compressed): adds zero bundle
// dependencies; the playground's example sources are 1–5 KB plain
// text, encoded fits comfortably under every browser's URL length
// cap.  Compression would shave ~30–40 % but not enough to be worth
// the dep / complexity at current sizes.

const HASH_KEY = "s";

export function encodeSource(text: string): string {
  const bytes = new TextEncoder().encode(text);
  // String.fromCharCode chunked because spread can blow up the call
  // stack on large strings.
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function decodeSource(b64url: string): string | null {
  try {
    let b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4 !== 0) b64 += "=";
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/** Read the source out of the current URL hash, if any.  Returns
 *  null when the hash is empty, missing the `s=` key, or fails to
 *  decode.  The decode is lenient — broken hashes degrade silently
 *  to "no shared source" rather than throwing on page load. */
export function readHashSource(): string | null {
  if (typeof window === "undefined") return null;
  const hash = window.location.hash;
  if (!hash || hash.length < 2) return null;
  // Strip leading `#` and parse `key=value&key=value` style.
  const params = new URLSearchParams(hash.slice(1));
  const raw = params.get(HASH_KEY);
  return raw ? decodeSource(raw) : null;
}

/** Write the source into the URL hash via `replaceState` — no new
 *  history entry, no server round-trip.  No-op when the encoded
 *  payload is identical to what's already there (avoids hashchange
 *  floods on every keystroke debounce). */
export function writeHashSource(text: string): void {
  if (typeof window === "undefined") return;
  const encoded = encodeSource(text);
  const desired = `#${HASH_KEY}=${encoded}`;
  if (window.location.hash === desired) return;
  const url = new URL(window.location.href);
  url.hash = desired;
  window.history.replaceState(null, "", url.toString());
}

/** Build a full shareable URL for the given source — used by the
 *  "copy link" button so the user gets a clean link in their
 *  clipboard regardless of where the cursor is on the page. */
export function buildShareUrl(text: string): string {
  if (typeof window === "undefined") return "";
  const url = new URL(window.location.href);
  url.hash = `${HASH_KEY}=${encodeSource(text)}`;
  return url.toString();
}

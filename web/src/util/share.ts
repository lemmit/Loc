// Share-via-URL helpers.
//
// We stash the playground's editor state in `window.location.hash`
// so any deploy URL is shareable: paste it into chat / Slack /
// GitHub, the recipient lands on the playground with that exact
// state loaded.  Two hash keys today:
//
//   #s=<base64url>   single-file (legacy) — main.ddd content only.
//   #p=<base64url>   multi-file project — base64url(JSON({ files,
//                    active })) for the whole workspace.
//
// On read we prefer `p=` when present and fall back to `s=`, so
// every shared link ever generated still loads.  On write we pick
// the smallest form that fits the project: a workspace that
// contains only `/workspace/main.ddd` round-trips as `s=` (same
// hash bytes as before Stage 3); anything more uses `p=`.
//
// Why the hash and not a query param: hashes never round-trip to
// the server (GitHub Pages is purely static) and don't need a new
// HTTP request to update — we use `history.replaceState` so editing
// doesn't pollute browser history.
//
// Why base64url + UTF-8 (not LZ-compressed): adds zero bundle
// dependencies; the playground's example sources are 1–5 KB plain
// text, encoded fits comfortably under every browser's URL length
// cap.  Compression would shave ~30–40 % but not enough to be
// worth the dep / complexity at current sizes — easy to add later
// if multi-file projects routinely push past ~30 KB.

const HASH_KEY_SINGLE = "s";
const HASH_KEY_PROJECT = "p";
const MAIN_PATH = "/workspace/main.ddd";

export function encodeSource(text: string): string {
  return base64urlEncode(new TextEncoder().encode(text));
}

export function decodeSource(b64url: string): string | null {
  const bytes = base64urlDecode(b64url);
  if (!bytes) return null;
  try {
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

function base64urlEncode(bytes: Uint8Array): string {
  // String.fromCharCode chunked because spread can blow up the call
  // stack on large strings.
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(b64url: string): Uint8Array | null {
  try {
    let b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4 !== 0) b64 += "=";
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/** Multi-file project payload — the JSON shape encoded inside the
 *  `p=` hash.  Kept tiny and explicit so a hand-crafted hash from
 *  another tool is easy to verify. */
export interface SharedProject {
  /** Path → content for every `.ddd` file in the workspace.  Paths
   *  are workspace-absolute (start with `/workspace/`).  Empty
   *  files / placeholder bodies are encoded verbatim. */
  files: Record<string, string>;
  /** Path that should be active when the recipient opens the link.
   *  Always one of `files`' keys when set; consumers fall back to
   *  `/workspace/main.ddd` if the encoded active path went missing
   *  somehow. */
  active: string;
}

export function encodeProject(project: SharedProject): string {
  const json = JSON.stringify(project);
  return base64urlEncode(new TextEncoder().encode(json));
}

export function decodeProject(b64url: string): SharedProject | null {
  const bytes = base64urlDecode(b64url);
  if (!bytes) return null;
  try {
    const json = new TextDecoder().decode(bytes);
    const obj = JSON.parse(json) as unknown;
    if (!isSharedProject(obj)) return null;
    return obj;
  } catch {
    return null;
  }
}

function isSharedProject(obj: unknown): obj is SharedProject {
  if (!obj || typeof obj !== "object") return false;
  const o = obj as { files?: unknown; active?: unknown };
  if (typeof o.active !== "string") return false;
  if (!o.files || typeof o.files !== "object") return false;
  for (const [k, v] of Object.entries(o.files as Record<string, unknown>)) {
    if (typeof k !== "string" || typeof v !== "string") return false;
  }
  return true;
}

/** Discriminated result of reading the hash.  `null` = no shareable
 *  payload (empty hash, missing key, broken encoding).  `single` is
 *  the legacy `s=` form (treat as `main.ddd`'s body).  `project` is
 *  the multi-file `p=` form. */
export type HashLoad =
  | { kind: "single"; text: string }
  | { kind: "project"; project: SharedProject };

export function readHash(): HashLoad | null {
  if (typeof window === "undefined") return null;
  const hash = window.location.hash;
  if (!hash || hash.length < 2) return null;
  const params = new URLSearchParams(hash.slice(1));
  const rawP = params.get(HASH_KEY_PROJECT);
  if (rawP) {
    const project = decodeProject(rawP);
    if (project) return { kind: "project", project };
  }
  const rawS = params.get(HASH_KEY_SINGLE);
  if (rawS) {
    const text = decodeSource(rawS);
    if (text !== null) return { kind: "single", text };
  }
  return null;
}

/** Legacy single-file accessor — preserved so callers that only
 *  need the main.ddd body keep working.  Multi-file payloads
 *  collapse to their main.ddd content; callers that care about the
 *  full project state use `readHash` instead. */
export function readHashSource(): string | null {
  const load = readHash();
  if (!load) return null;
  if (load.kind === "single") return load.text;
  return load.project.files[load.project.active] ?? load.project.files[MAIN_PATH] ?? null;
}

/** Write the playground state into the URL hash.  Picks the
 *  smallest legal form: a workspace whose only file is
 *  `/workspace/main.ddd` round-trips as the legacy `s=` form (same
 *  bytes existing shared links produce), anything more uses the
 *  multi-file `p=` form.  No-op when the encoded payload matches
 *  what's already in the hash. */
export function writeHashProject(project: SharedProject): void {
  if (typeof window === "undefined") return;
  const desired = `#${hashKeyValueFor(project)}`;
  if (window.location.hash === desired) return;
  const url = new URL(window.location.href);
  url.hash = desired;
  window.history.replaceState(null, "", url.toString());
}

/** Legacy single-file write — equivalent to writing a workspace
 *  whose only file is `/workspace/main.ddd`.  Preserved so single-
 *  file callers (the URL-hash sync on every keystroke, the legacy
 *  share-link builder) don't have to construct a `SharedProject`. */
export function writeHashSource(text: string): void {
  writeHashProject({ files: { [MAIN_PATH]: text }, active: MAIN_PATH });
}

function hashKeyValueFor(project: SharedProject): string {
  const paths = Object.keys(project.files);
  // Single-file shortcut: workspace contains only main.ddd, no
  // active-path quirk.  Emit `s=<main-content>` so URLs stay
  // backward-compatible with everything generated before Stage 3.
  if (
    paths.length === 1 &&
    paths[0] === MAIN_PATH &&
    project.active === MAIN_PATH
  ) {
    return `${HASH_KEY_SINGLE}=${encodeSource(project.files[MAIN_PATH] ?? "")}`;
  }
  return `${HASH_KEY_PROJECT}=${encodeProject(project)}`;
}

/** Build a full shareable URL for the given project — used by the
 *  "copy link" button so the user gets a clean link in their
 *  clipboard regardless of where the cursor is on the page. */
export function buildShareUrl(textOrProject: string | SharedProject): string {
  if (typeof window === "undefined") return "";
  const project: SharedProject =
    typeof textOrProject === "string"
      ? { files: { [MAIN_PATH]: textOrProject }, active: MAIN_PATH }
      : textOrProject;
  const url = new URL(window.location.href);
  url.hash = hashKeyValueFor(project);
  return url.toString();
}

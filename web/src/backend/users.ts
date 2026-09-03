// The Users strip (M-T8.22 slice 3): which identities requests to the booted
// backend carry.  Two sources, both already in the playground:
//
//   1. the generated dev-stub verifier's BUILT-IN identity — the `base`
//      literal in `auth/dev-stub.ts` (one value per field the system's
//      `user { … }` block declares; `renderDevStubVerifier` in the Hono
//      backend), read straight out of the generated file;
//   2. the Auth tab's OVERRIDE — the claims JSON injected as
//      `x-loom-dev-claims` when the stub is enabled.
//
// A system with an `auth { oidc }` block has a real verifier instead, and a
// system with no `user` block carries no identity at all; both are reported
// as such rather than as an empty list.
//
// Pure: file list + config in, identities out.

import type { AuthStubConfig } from "../layout/ctx";

export interface DevIdentity {
  /** "Built-in dev identity" / "Override (Auth tab)" — the caller labels. */
  kind: "builtIn" | "override";
  claims: Record<string, string>;
}

export type UsersState =
  | { kind: "none" }
  | { kind: "oidc" }
  | { kind: "stub"; identities: DevIdentity[] };

interface FileLike {
  path: string;
  content: string;
}

const DEV_STUB_FILE = /(^|\/)auth\/dev-stub\.ts$/;
const OIDC_FILE = /(^|\/)auth\/oidc[^/]*\.ts$/;

/** Parse the `const base = { … };` literal of the generated dev stub into
 *  `field → rendered value`.  The literal is one `key: value,` per line
 *  (see `renderStubUserLiteral`), so a line-wise read is exact for the
 *  shapes the emitter produces; a line it cannot read is skipped, never
 *  thrown on. */
export function parseDevStubIdentity(source: string): Record<string, string> | null {
  const m = /const base = \{([\s\S]*?)\n\s*\};/.exec(source);
  if (!m) return null;
  const out: Record<string, string> = {};
  for (const raw of m[1]!.split("\n")) {
    const line = raw.trim().replace(/,$/, "");
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const k = line.slice(0, colon).trim();
    const v = line.slice(colon + 1).trim();
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k)) continue;
    out[k] = renderClaimValue(v);
  }
  return out;
}

/** `"admin"` → `admin`; `new Date(0)` / `[]` / `null` stay as written. */
function renderClaimValue(v: string): string {
  const str = /^"(.*)"$/.exec(v) ?? /^'(.*)'$/.exec(v);
  return str ? str[1]! : v;
}

/** The Auth tab's override claims, or `null` when the stub is off or the
 *  JSON does not parse to an object — the same rule `devClaimsHeader`
 *  applies, so the strip shows exactly what the header carries. */
export function overrideIdentity(cfg: AuthStubConfig): Record<string, string> | null {
  if (!cfg.enabled) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(cfg.claimsJson);
  } catch {
    return null;
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    out[k] = typeof v === "string" ? v : JSON.stringify(v);
  }
  return out;
}

export function usersState(files: readonly FileLike[], cfg: AuthStubConfig): UsersState {
  const stub = files.find((f) => DEV_STUB_FILE.test(f.path));
  if (!stub) {
    return files.some((f) => OIDC_FILE.test(f.path)) ? { kind: "oidc" } : { kind: "none" };
  }
  const identities: DevIdentity[] = [];
  const builtIn = parseDevStubIdentity(stub.content);
  if (builtIn) identities.push({ kind: "builtIn", claims: builtIn });
  const over = overrideIdentity(cfg);
  if (over) identities.push({ kind: "override", claims: over });
  return { kind: "stub", identities };
}

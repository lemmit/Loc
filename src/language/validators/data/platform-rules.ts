// Table-driven deployable-platform rules.  Lifted from the inline
// helpers that used to live alongside `checkDeployablePlatform` /
// `checkDeployableDesignPack` in `ddd-validator.ts` so future
// platform additions touch one data table instead of multiple
// switches scattered through validator methods.
//
// What stays out of the table: the *backend version registry*
// (`parseBuiltinPlatformRef`, `backendVersionsForFamily` etc. from
// `src/platform/registry.ts`) and the *design-pack version
// registry* (`BUILTIN_PACK_LATEST` etc. from
// `src/generator/_packs/builtin-formats.ts`).  Those are dynamic
// registries that already exist; this table only encodes the
// *grammar-level* platform-family classification — what kind of
// thing each platform is.

import {
  BUILTIN_PACK_LATEST,
  packFormatForBuiltin,
} from "../../../generator/_packs/builtin-formats.js";
import type { Platform } from "../../../ir/types/loom-ir.js";
import { parseBuiltinPlatformRef, platformFor } from "../../../platform/registry.js";

/** Frontend keyword platforms — those that are valid as bareword
 *  `platform:` values without being registered as a backend family. */
export const FRONTEND_KEYWORDS: ReadonlySet<string> = new Set(["react", "static"]);

/** True iff this platform mounts a UI (admits a `ui:` binding).
 *  Consults the runtime PlatformSurface registry so adding a new
 *  platform requires extending exactly the `mountsUi` flag plus the
 *  `Platform` grammar enum + the `Framework` enum. */
export function platformMountsUi(platform: string | undefined): boolean {
  if (platform == null) return false;
  // The registry's `mountsUi` is the single source of truth.  Cast
  // is safe because the grammar enum and the registry stay in
  // lockstep (registry barfs at boot if a platform is missing).
  try {
    return platformFor(platform as Platform).mountsUi;
  } catch {
    return false;
  }
}

/** The bareword family of a `platform:` value — strips a
 *  `@version` pin so the predicate helpers + framework checks work
 *  on `platform: "hono@v4"` exactly as on `platform: hono`.
 *  Frontend / unknown names pass through unchanged
 *  (`parseBuiltinPlatformRef` returns null for them). */
export function platformFamily(platform: string | undefined): string | undefined {
  if (platform == null) return undefined;
  return parseBuiltinPlatformRef(platform)?.family ?? platform;
}

/** True iff this platform owns a backend (serves an api surface).
 *  The backend families are exactly the keys
 *  `parseBuiltinPlatformRef` recognises (BUILTIN_PLATFORM_LATEST),
 *  so a non-null parse — bareword or `family@version` pin — *is*
 *  the backend predicate. */
export function platformOwnsBackend(platform: string | undefined): boolean {
  return platform != null && parseBuiltinPlatformRef(platform) !== null;
}

/** Framework a deployable will render against, given its platform
 *  and whether it actually declares a `ui:` mount.  `hasUi` matters
 *  for platforms that are dual-mode: `dotnet` is backend-only without
 *  `ui:` and serves an embedded React SPA when `ui:` is set.  For
 *  always-frontend platforms (`react`/`static`) and always-fullstack
 *  platforms (`phoenixLiveView`) the answer is independent of
 *  `hasUi`. */
export function expectedFrameworkFor(
  platform: string | undefined,
  hasUi: boolean,
): string | undefined {
  // Normalise a `family@version` pin to its family first so a pinned
  // backend (`"phoenixLiveView@v1"`, `"dotnet@v8"`) maps to the same
  // framework as its bareword.
  const fam = platformFamily(platform);
  if (fam === "react" || fam === "static") return "react";
  if (fam === "phoenixLiveView") return "phoenixLiveView";
  if (fam === "dotnet" && hasUi) return "react";
  return undefined;
}

/** Format a given framework's design pack must declare.  Mirrors
 *  `expectedFrameworkFor`; used by Rule 14 to cross-check the
 *  deployable's `design:` against its framework. */
export function expectedPackFormatFor(framework: string | undefined): "tsx" | "heex" | undefined {
  if (framework === "react") return "tsx";
  if (framework === "phoenixLiveView") return "heex";
  return undefined;
}

/** Comma-joined list of built-in pack family names whose default
 *  version produces the given format — used to make Rule 14's
 *  diagnostic suggest valid replacements ("Use one of: mantine,
 *  shadcn, mui, chakra.").  Reads `BUILTIN_PACK_LATEST` so the
 *  suggestion follows the bareword resolution rule: each family
 *  shows up once, no `@version` noise. */
export function builtinPackNamesForFormat(format: "tsx" | "heex"): string {
  return (Object.keys(BUILTIN_PACK_LATEST) as Array<keyof typeof BUILTIN_PACK_LATEST>)
    .filter((family) => {
      const f = packFormatForBuiltin(family);
      return f === format;
    })
    .join(", ");
}

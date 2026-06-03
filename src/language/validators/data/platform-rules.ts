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
// `src/util/builtin-formats.ts`).  Those are dynamic
// registries that already exist; this table only encodes the
// *grammar-level* platform-family classification — what kind of
// thing each platform is.

import {
  applicationAdapterToDsl,
  applicationDslToAdapter,
  PLATFORM_SAVING_SHAPES,
  type Platform,
  type SavingShape,
} from "../../../ir/types/loom-ir.js";
import { parseBuiltinPlatformRef, platformFor } from "../../../platform/registry.js";
import {
  allAdapterNames,
  availableAdapterNames,
  hasAdapters,
} from "../../../platform/resolve-adapters.js";
import { BUILTIN_PACK_LATEST, packFormatForBuiltin } from "../../../util/builtin-formats.js";

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

/** Canonicalise a D-PHOENIX-SURFACE framework alias to the IR's stable
 *  value.  `liveview` → `phoenixLiveView`; everything else passes
 *  through.  Mirrors the lowering-side `canonicalFramework` so the
 *  validator compares the same canonical value the registry's
 *  `hostableFrameworks` set holds. */
export function canonicalFramework(framework: string | undefined): string | undefined {
  return framework === "liveview" ? "phoenixLiveView" : framework;
}

/** The set of `ui { framework: … }` values this platform can host —
 *  `PlatformSurface.hostableFrameworks` (D-PHOENIX-SURFACE).  Empty set
 *  for unknown / typo'd platforms (the unknown-platform diagnostic
 *  surfaces those separately).  Consulted by the deployable validator's
 *  ui-framework host-compatibility check. */
export function hostableFrameworksFor(platform: string | undefined): ReadonlySet<string> {
  if (platform == null) return new Set();
  try {
    return platformFor(platform as Platform).hostableFrameworks;
  } catch {
    return new Set();
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

/** Saving shapes (D-DOCUMENT-AXIS `shape(…)`) the given platform can
 *  emit today — the capability tier of the supportedShapes validator.
 *  Resolves a `family@version` pin to its family first.  `undefined` for
 *  frontend / unknown platforms (they own no persistence). */
export function platformSavingShapes(
  platform: string | undefined,
): readonly SavingShape[] | undefined {
  const fam = platformFamily(platform);
  return fam ? PLATFORM_SAVING_SHAPES[fam as Platform] : undefined;
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
  if (fam === "phoenix") return "phoenixLiveView";
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

// ---------------------------------------------------------------------------
// D-REALIZATION-AXES — the six deployable realization axes.
//
// Three axes (`persistence` / `application` / `directoryLayout`) ride the
// live D-ADAPTER-HOME adapter menus; their DSL menu is the REAL (non-stub)
// adapters off the surface, in DSL spelling.  Three (`foundation` /
// `transport` / `runtime`) are greenfield — no adapter infra yet, so a
// single current value each.  Frontends carry no axes (empty menu →
// validator rejects any axis written on them).
// ---------------------------------------------------------------------------

export type RealizationAxis =
  | "foundation"
  | "application"
  | "persistence"
  | "directoryLayout"
  | "transport"
  | "runtime";

// `applicationDslToAdapter` / `applicationAdapterToDsl` live in
// `loom-ir.ts` (shared with lowering) — imported above.

/** Adapter kind backing each axis, or undefined for the greenfield axes. */
const ADAPTER_KIND_BY_AXIS: Partial<Record<RealizationAxis, "persistence" | "style" | "layout">> = {
  persistence: "persistence",
  application: "style",
  directoryLayout: "layout",
};

function adapterKindForAxis(axis: RealizationAxis): "persistence" | "style" | "layout" | undefined {
  return ADAPTER_KIND_BY_AXIS[axis];
}

/** Single current value for a greenfield axis on a backend family. */
function greenfieldMenu(family: Platform, axis: "foundation" | "transport" | "runtime"): string[] {
  if (axis === "runtime") return ["transactional"];
  if (axis === "foundation") return [family === "phoenix" ? "ash" : "vanilla"];
  // transport — the platform's only current HTTP surface.
  return [family === "dotnet" ? "minimalApi" : family === "phoenix" ? "phoenixRouter" : "hono"];
}

/** The DSL-legal values for one realization axis on a platform family.
 *  Adapter-backed axes → the REAL adapters (stubs excluded) in DSL
 *  spelling; greenfield axes → the size-1 menu.  `[]` for frontends /
 *  unknown platforms (no adapter menu) — any axis there is rejected. */
export function realizationAxisMenu(family: Platform, axis: RealizationAxis): string[] {
  if (!hasAdapters(family)) return [];
  switch (axis) {
    case "persistence":
      return availableAdapterNames(family, "persistence");
    case "directoryLayout":
      return availableAdapterNames(family, "layout");
    case "application":
      return availableAdapterNames(family, "style").map(applicationAdapterToDsl);
    default:
      return greenfieldMenu(family, axis);
  }
}

/** True when an out-of-menu value is a REGISTERED STUB (the platform
 *  reserves the name but hasn't implemented it) rather than an unknown
 *  value — lets the diagnostic say "reserved but not yet implemented". */
export function isReservedStub(family: Platform, axis: RealizationAxis, dslValue: string): boolean {
  const kind = adapterKindForAxis(axis);
  if (kind === undefined) return false; // greenfield axes have no stubs
  const key = axis === "application" ? applicationDslToAdapter(dslValue) : dslValue;
  return (
    allAdapterNames(family, kind).includes(key) &&
    !availableAdapterNames(family, kind).includes(key)
  );
}

/** Which realization axes each `foundation:` value OWNS (supplies itself)
 *  — setting an owned axis alongside the foundation is an error (R4).
 *  `vanilla` owns nothing; a rung-3/4 framework owns the application +
 *  HTTP surface.  Data-driven: growing the foundation menu activates the
 *  rule with no code change.  (`ash` does NOT own `persistence:` in v1 —
 *  `ashPostgres`/`ashSqlite` stay selectable; menu-narrowing deferred.) */
export const FOUNDATION_OWNED_AXES: Record<string, readonly RealizationAxis[]> = {
  vanilla: [],
  ash: ["application", "transport"],
  abp: ["application", "transport"],
  nestjs: ["application", "transport"],
};

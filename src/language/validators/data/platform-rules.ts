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

import type { Platform, SavingShape } from "../../../ir/types/loom-ir.js";
import {
  allAdapterNames,
  availableAdapterNames,
  defaultsFor,
  hasAdapters,
  styleSupportedLayouts,
} from "../../../platform/adapter-metadata.js";
import { descriptorFor, parseBuiltinPlatformRef } from "../../../platform/metadata.js";
import {
  BUILTIN_PACK_LATEST,
  type PackFormat,
  packFormatForBuiltin,
} from "../../../util/builtin-formats.js";
import { PLATFORM_SAVING_SHAPES } from "../../../util/platform-axes.js";

/** Frontend keyword platforms — those that are valid as bareword
 *  `platform:` values without being registered as a backend family. */
export const FRONTEND_KEYWORDS: ReadonlySet<string> = new Set([
  "react",
  "svelte",
  "vue",
  "angular",
  "feliz",
  "static",
]);

/** True iff this platform mounts a UI (admits a `ui:` binding).
 *  Consults the runtime PlatformSurface registry so adding a new
 *  platform requires extending exactly the `mountsUi` flag plus the
 *  `Platform` grammar enum + the `Framework` enum. */
export function platformMountsUi(platform: string | undefined): boolean {
  if (platform == null) return false;
  // The descriptor's `mountsUi` is the single source of truth.  Cast
  // is safe because the grammar enum and the descriptor table stay in
  // lockstep (descriptor-consistency.test.ts pins them).
  try {
    return descriptorFor(platform as Platform).mountsUi;
  } catch {
    return false;
  }
}

/** The set of `ui { framework: … }` values this platform can host —
 *  `PlatformSurface.hostableFrameworks` (D-PHOENIX-SURFACE).  Empty set
 *  for unknown / typo'd platforms (the unknown-platform diagnostic
 *  surfaces those separately).  Consulted by the deployable validator's
 *  ui-framework host-compatibility check. */
export function hostableFrameworksFor(platform: string | undefined): ReadonlySet<string> {
  if (platform == null) return new Set();
  try {
    return descriptorFor(platform as Platform).hostableFrameworks;
  } catch {
    return new Set();
  }
}

/** The bareword family of a `platform:` value — strips a
 *  `@version` pin so the predicate helpers + framework checks work
 *  on `platform: "node@v4"` exactly as on `platform: node`.
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
  // backend (`"phoenixLiveView@v1"`, `"dotnet@v10"`) maps to the same
  // framework as its bareword.
  const fam = platformFamily(platform);
  if (fam === "react" || fam === "static") return "react";
  if (fam === "svelte") return "svelte";
  if (fam === "vue") return "vue";
  if (fam === "angular") return "angular";
  if (fam === "feliz") return "feliz";
  if (fam === "elixir") return "phoenixLiveView";
  // dotnet and java are dual-mode: backend-only without `ui:`, embedded
  // React SPA host with it.
  if ((fam === "dotnet" || fam === "java") && hasUi) return "react";
  return undefined;
}

/** Format a given framework's design pack must declare.  Mirrors
 *  `expectedFrameworkFor`; used by Rule 14 to cross-check the
 *  deployable's `design:` against its framework. */
export function expectedPackFormatFor(framework: string | undefined): PackFormat | undefined {
  if (framework === "react") return "tsx";
  if (framework === "svelte") return "svelte";
  if (framework === "vue") return "vue";
  if (framework === "angular") return "angular";
  if (framework === "phoenixLiveView") return "heex";
  return undefined;
}

/** Comma-joined list of built-in pack family names whose default
 *  version produces the given format — used to make Rule 14's
 *  diagnostic suggest valid replacements ("Use one of: mantine,
 *  shadcn, mui, chakra.").  Reads `BUILTIN_PACK_LATEST` so the
 *  suggestion follows the bareword resolution rule: each family
 *  shows up once, no `@version` noise. */
export function builtinPackNamesForFormat(format: PackFormat): string {
  return (Object.keys(BUILTIN_PACK_LATEST) as Array<keyof typeof BUILTIN_PACK_LATEST>)
    .filter((family) => {
      const f = packFormatForBuiltin(family);
      return f === format;
    })
    .join(", ");
}

// ---------------------------------------------------------------------------
// D-REALIZATION-AXES — the two deployable realization axes.
//
// Both (`persistence` / `directoryLayout`) ride the live D-ADAPTER-HOME adapter
// menus; their DSL menu is the REAL (non-stub) adapters off the surface.  Both
// carry real per-backend choice.  Frontends carry no axes (empty menu →
// validator rejects any axis written on them).  (The application/style axis was
// removed — each backend has a single fixed emission style, not a user knob.)
// ---------------------------------------------------------------------------

export type RealizationAxis = "persistence" | "directoryLayout";

/** Adapter kind backing each realization axis. */
const ADAPTER_KIND_BY_AXIS: Record<RealizationAxis, "persistence" | "layout"> = {
  persistence: "persistence",
  directoryLayout: "layout",
};

function adapterKindForAxis(axis: RealizationAxis): "persistence" | "layout" {
  return ADAPTER_KIND_BY_AXIS[axis];
}

/** The DSL-legal values for one realization axis on a platform family — the
 *  REAL adapters (stubs excluded) in DSL spelling.  `[]` for frontends /
 *  unknown platforms (no adapter menu) — any axis there is rejected. */
export function realizationAxisMenu(family: Platform, axis: RealizationAxis): string[] {
  if (!hasAdapters(family)) return [];
  switch (axis) {
    case "persistence":
      return availableAdapterNames(family, "persistence");
    case "directoryLayout":
      return availableAdapterNames(family, "layout");
  }
}

/** True when an out-of-menu value is a REGISTERED STUB (the platform
 *  reserves the name but hasn't implemented it) rather than an unknown
 *  value.  No stubs are registered today, so this is always false; kept as
 *  the seam for a future reserved-but-unimplemented adapter. */
export function isReservedStub(family: Platform, axis: RealizationAxis, dslValue: string): boolean {
  const kind = adapterKindForAxis(axis);
  return (
    allAdapterNames(family, kind).includes(dslValue) &&
    !availableAdapterNames(family, kind).includes(dslValue)
  );
}

/** R3 support — does the backend's fixed emission *style* accept the resolved
 *  `directoryLayout`?  A `StyleAdapter` declares `supportedLayouts`; the
 *  validator pairs the platform's default style with the chosen layout to
 *  reject combinations the style can't fit (e.g. elixir's `layered` only
 *  supports `byFeature`).
 *
 *  `layout` may be undefined (knob omitted) → the platform default applies.
 *  Returns `undefined` when the check doesn't apply: a frontend / unknown
 *  family, or a layout that isn't a REAL adapter (an unknown value already
 *  errored under R1 — R3 stays quiet to avoid a double diagnostic). */
export function resolveStyleLayoutCompat(
  family: Platform,
  layout: string | undefined,
): { style: string; layout: string; supported: readonly string[]; ok: boolean } | undefined {
  // Guard the unresolved-platform case FIRST.  A name that isn't a known
  // backend family (a typo'd quoted `platform:`) has no adapter metadata, so
  // stay quiet: an unknown platform already draws its own diagnostic from
  // `checkDeployablePlatform` (deployable.ts), and a frontend legitimately has
  // no layout axis to check.  Reads pure adapter FACTS from
  // `adapter-metadata.ts` (no live surface / generator import), so the
  // validator no longer drags the backend generators into a client bundle.
  if (parseBuiltinPlatformRef(family) == null) return undefined;
  const defaults = defaultsFor(family);
  if (!defaults) return undefined;
  const styleKey = defaults.style;
  const supported = styleSupportedLayouts(family, styleKey);
  if (!supported || !availableAdapterNames(family, "style").includes(styleKey)) return undefined;
  const resolvedLayout = layout ?? defaults.layout;
  if (!availableAdapterNames(family, "layout").includes(resolvedLayout)) return undefined;
  return {
    style: styleKey,
    layout: resolvedLayout,
    supported,
    ok: supported.includes(resolvedLayout),
  };
}

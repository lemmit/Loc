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
import {
  applicationAdapterToDsl,
  applicationDslToAdapter,
  PLATFORM_SAVING_SHAPES,
} from "../../../util/platform-axes.js";

/** Frontend keyword platforms — those that are valid as bareword
 *  `platform:` values without being registered as a backend family. */
export const FRONTEND_KEYWORDS: ReadonlySet<string> = new Set([
  "react",
  "svelte",
  "vue",
  "angular",
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
// `util/platform-axes.ts` (shared with lowering) — imported above.

/** Adapter kind backing each axis, or undefined for the one remaining
 *  greenfield axis (`foundation`).  `transport` + `runtime` joined the
 *  adapter-backed set when they were promoted from greenfield
 *  (realization-axes-alignment.md). */
const ADAPTER_KIND_BY_AXIS: Partial<
  Record<RealizationAxis, "persistence" | "style" | "layout" | "transport" | "runtime">
> = {
  persistence: "persistence",
  application: "style",
  directoryLayout: "layout",
  transport: "transport",
  runtime: "runtime",
};

function adapterKindForAxis(
  axis: RealizationAxis,
): "persistence" | "style" | "layout" | "transport" | "runtime" | undefined {
  return ADAPTER_KIND_BY_AXIS[axis];
}

/** Menu for the one remaining greenfield axis, `foundation`.  `transport` and
 *  `runtime` are now adapter-backed (realization-axes-alignment.md), resolved
 *  via `availableAdapterNames(family, …)` in `realizationAxisMenu`.  Every
 *  backend — elixir included — is `vanilla` only (the Ash foundation was
 *  removed; `foundation: ash` is now rejected as an out-of-menu value).  The
 *  FIRST entry is the platform default (`defaultFoundationFor`). */
function greenfieldMenu(family: Platform, axis: "foundation"): string[] {
  void axis;
  void family;
  return ["vanilla"];
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
    case "transport":
      return availableAdapterNames(family, "transport");
    case "runtime":
      return availableAdapterNames(family, "runtime");
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
 *  rule with no code change.  (`abp` / `nestjs` are reserved future
 *  foundations, not yet on any platform menu.) */
export const FOUNDATION_OWNED_AXES: Record<string, readonly RealizationAxis[]> = {
  vanilla: [],
  abp: ["application", "transport"],
  nestjs: ["application", "transport"],
};

/** Adapters BOUND to a specific opinionated foundation framework — its data
 *  layer (`persistence`) and architectural style (`application`, in DSL
 *  spelling).  A *named* foundation admits ONLY its own family on these axes;
 *  `vanilla` admits the rest (the non-framework libraries).  Drives R6
 *  (foundation↔axis compatibility) + the foundation-narrowed menu.
 *
 *  Empty today — the Ash foundation was removed.  `abp` / `nestjs` gain
 *  entries when those foundations are wired. */
export const FOUNDATION_FAMILY_ADAPTERS: Record<
  string,
  { readonly persistence?: readonly string[]; readonly application?: readonly string[] }
> = {};

/** The platform's DEFAULT foundation — the primary (first) entry of its
 *  foundation menu (every backend → `vanilla` post D-VANILLA-DEFAULT).
 *  Used by R6 to resolve the effective foundation when the knob is omitted.
 *  (Mirror of the `foundation` default in `greenfieldAxisDefaults`, kept here
 *  in the language layer so the validator need not reach into lowering.) */
export function defaultFoundationFor(family: Platform): string | undefined {
  return greenfieldMenu(family, "foundation")[0];
}

/** R3 support — does the resolved application *style* accept the resolved
 *  `directoryLayout`?  A `StyleAdapter` declares `supportedLayouts`; the
 *  validator pairs it with the chosen layout to reject combinations the style
 *  can't fit (e.g. node's `layered` only supports `byLayer`, so `byFeature`
 *  is rejected).
 *
 *  `applicationDsl` / `layout` may be undefined (knob omitted) → the platform
 *  default applies.  Returns `undefined` when the check doesn't apply: a
 *  frontend / unknown family, or a style / layout that isn't a REAL adapter
 *  (a stub or unknown value already errored under R1 — R3 stays quiet to
 *  avoid a double diagnostic). */
export function resolveStyleLayoutCompat(
  family: Platform,
  applicationDsl: string | undefined,
  layout: string | undefined,
): { style: string; layout: string; supported: readonly string[]; ok: boolean } | undefined {
  // Guard the unresolved-platform case FIRST.  A name that isn't a known
  // backend family (a typo'd quoted `platform:`) has no adapter metadata, so
  // stay quiet: an unknown platform already draws its own diagnostic from
  // `checkDeployablePlatform` (deployable.ts), and a frontend legitimately has
  // no style/layout axes to check.  Reads pure adapter FACTS from
  // `adapter-metadata.ts` (no live surface / generator import), so the
  // validator no longer drags the backend generators into a client bundle.
  if (parseBuiltinPlatformRef(family) == null) return undefined;
  const defaults = defaultsFor(family);
  if (!defaults) return undefined;
  const styleKey = applicationDsl ? applicationDslToAdapter(applicationDsl) : defaults.style;
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

/** The values legal for `persistence:` / `application:` under a foundation on
 *  a platform (R6).  Named foundation → its framework family ∩ the platform
 *  menu.  `vanilla` (or any non-framework foundation) → the platform menu
 *  minus every framework family (the non-framework libraries).  Returns the
 *  axis values in DSL spelling, matching `realizationAxisMenu`. */
export function foundationCompatibleMenu(
  family: Platform,
  foundation: string,
  axis: "persistence" | "application",
): string[] {
  const full = realizationAxisMenu(family, axis);
  const own = FOUNDATION_FAMILY_ADAPTERS[foundation]?.[axis];
  if (own !== undefined) {
    // Named foundation: only its own family that the platform actually ships.
    return full.filter((v) => own.includes(v));
  }
  // vanilla / non-framework: everything that is NOT bound to a framework.
  const frameworkBound = new Set<string>();
  for (const fam of Object.values(FOUNDATION_FAMILY_ADAPTERS)) {
    for (const v of fam[axis] ?? []) frameworkBound.add(v);
  }
  return full.filter((v) => !frameworkBound.has(v));
}

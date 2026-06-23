// -------------------------------------------------------------------------
// Platform / design qualification — boundary helpers that desugar legacy
// platform & framework aliases and resolve bareword built-in design/platform
// refs to `family@version`.  Pure string/registry manipulation (no Env, no
// expression lowering); consumed by the deployable + ui structural lowerers
// in ./lower.ts.
// -------------------------------------------------------------------------

import { parseBuiltinPlatformRef } from "../../platform/metadata.js";
import { type BuiltinPackFamily, parseBuiltinDesignRef } from "../../util/builtin-formats.js";
import type { Platform } from "../types/loom-ir.js";

/** Fold a bareword built-in family or pinned `family@version`
 *  reference (or `undefined`) into the fully-qualified form the rest
 *  of the toolchain stores.  Lowering resolves the toolchain default
 *  for bareword built-ins so that
 *  every downstream consumer (generator dispatch, build matrix,
 *  snapshot tests) sees an unambiguous `family@version` string and
 *  doesn't need its own copy of the resolution logic.  Custom paths
 *  pass through verbatim; nothing to qualify there. */
export function qualifyDesign(raw: string | undefined, fallback: BuiltinPackFamily): string {
  const value = raw ?? fallback;
  const parsed = parseBuiltinDesignRef(value);
  // Built-in family: return the parsed `family@version` (handles both
  // bareword input -> latest-version-resolved, and pinned input -> as-is).
  // Anything else (custom path, unknown family) flows through verbatim;
  // the loader's reference-dir resolution handles the rest.
  return parsed ? parsed.qualified : value;
}

/** Default values for the three greenfield realization axes
 *  (D-REALIZATION-AXES) — the axes with no adapter infra yet, so each has
 *  a single current value per platform.  Only `foundation` remains greenfield;
 *  `application`/`persistence`/`directoryLayout`/`transport`/`runtime` source
 *  their defaults from the live adapter menu (`defaultsFor`) — `transport` and
 *  `runtime` joined them when promoted to adapter axes
 *  (realization-axes-alignment.md).  Only ever called for backends (frontends
 *  carry no realization axes). */
export function greenfieldAxisDefaults(platform: Platform): {
  foundation: string;
} {
  void platform;
  return {
    // Every backend — elixir included — defaults to `vanilla` (no
    // framework).  The elixir flip from `ash` to `vanilla` landed per
    // D-VANILLA-DEFAULT: `platform: elixir` with no explicit `foundation:`
    // now generates plain Phoenix LiveView on Ecto.  An explicit
    // `foundation: ash` opts back into the Ash data layer + action surface.
    foundation: "vanilla",
  };
}

/** Split a `platform:` value into the family (the closed `Platform`
 *  union every consumer branches on) and the fully-qualified ref
 *  (`family@version`, mirrors `qualifyDesign`).  Bareword backend →
 *  family + `family@latest`.  Backend pin (`node@v4`) → family + the
 *  pin verbatim.  Frontend / unknown (`react`, `static`) → value for
 *  both (no version axis here).  Byte-identical for every existing
 *  source: `family` equals the bareword, so all `platform === "…"`
 *  logic is unchanged; `platformRef` is additive (dispatch keys
 *  on `platform`). */

/** Per-foundation overrides of the adapter-axis defaults
 *  (D-REALIZATION-AXES; docs/plans/realization-axes-alignment.md).
 *
 *  Elixir's `adapterDefaults()` encode the ASH data layer + style
 *  (`ashPostgres` / `ash`), but post D-VANILLA-DEFAULT the default foundation
 *  is `vanilla`, which implies its own data layer + application style even
 *  though `vanilla` *owns* no axis (FOUNDATION_OWNED_AXES) — so the
 *  omitted-knob (and explicit-`vanilla`) path overrides them: `elixir` +
 *  `vanilla` ⇒ plain Ecto + the `layered` style (DSL `serviceLayer`: plain
 *  Phoenix's controller → context → repository pipeline).  An explicit
 *  `foundation: ash` returns `{}` and resolves the base `ash` defaults. */
export function foundationAdapterOverride(
  platform: Platform,
  foundation: string | undefined,
): { style?: string; persistence?: string } {
  if (platform === "elixir" && foundation === "vanilla") {
    return { style: "layered", persistence: "ecto" };
  }
  return {};
}

export function qualifyPlatform(raw: string | undefined): {
  family: Platform;
  ref: string;
} {
  // `node` is the bareword default.  No alias desugaring — every legacy
  // platform alias (`hono` → `node`, `phoenix` / `phoenixLiveView` →
  // `elixir`, `fastapi` → `python`) was retired, so the spelling IS the
  // canonical family.  (The Phoenix web framework surfaces as the
  // `transport: phoenix` value; the LiveView framework keeps
  // `phoenixLiveView` — both decoupled from the platform name.)
  const value = raw ?? "node";
  const parsed = parseBuiltinPlatformRef(value);
  return parsed
    ? { family: parsed.family as Platform, ref: parsed.qualified }
    : { family: value as Platform, ref: value };
}

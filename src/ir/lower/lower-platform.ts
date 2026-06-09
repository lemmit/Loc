// -------------------------------------------------------------------------
// Platform / design qualification — boundary helpers that desugar legacy
// platform & framework aliases and resolve bareword built-in design/platform
// refs to `family@version`.  Pure string/registry manipulation (no Env, no
// expression lowering); consumed by the deployable + ui structural lowerers
// in ./lower.ts.
// -------------------------------------------------------------------------

import { parseBuiltinPlatformRef } from "../../platform/registry.js";
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
 *  a single current value per platform.  `application`/`persistence`/
 *  `directoryLayout` are NOT here: they source their defaults from the
 *  live adapter menu (`defaultsFor`).  Only ever called for backends
 *  (frontends carry no realization axes). */
export function greenfieldAxisDefaults(platform: Platform): {
  foundation: string;
  transport: string;
  runtime: string;
} {
  return {
    // Elixir's domain framework defaults to Ash (matches today's
    // `phoenixLiveView` behaviour after desugar — D-PHOENIX-SURFACE
    // open-item 2, renamed to elixir by D-ELIXIR-PLATFORM); every other
    // backend is `vanilla` (no framework).
    foundation: platform === "elixir" ? "ash" : "vanilla",
    // The platform's only current HTTP surface (D-PHOENIX-TRANSPORT:
    // Phoenix is the Elixir web framework's transport value).
    transport: platform === "dotnet" ? "minimalApi" : platform === "elixir" ? "phoenix" : "hono",
    // Repository-loaded, DB-transaction consistency — the only runtime
    // shipped today (actor runtimes land per-backend later).
    runtime: "transactional",
  };
}

/** Split a `platform:` value into the family (the closed `Platform`
 *  union every consumer branches on) and the fully-qualified ref
 *  (`family@version`, mirrors `qualifyDesign`).  Bareword backend →
 *  family + `family@latest`.  Backend pin (`hono@v4`) → family + the
 *  pin verbatim.  Frontend / unknown (`react`, `static`) → value for
 *  both (no version axis here).  Byte-identical for every existing
 *  source: `family` equals the bareword, so all `platform === "…"`
 *  logic is unchanged; `platformRef` is additive (dispatch keys
 *  on `platform`). */

/** Per-foundation overrides of the adapter-axis defaults
 *  (D-REALIZATION-AXES; docs/plans/realization-axes-alignment.md).
 *
 *  A platform's `adapterDefaults()` describe its DEFAULT foundation's axes —
 *  for elixir that is `ash` (→ `ashPostgres` / `ash`).  A non-default
 *  foundation still implies its own data layer + application style even though
 *  `vanilla` *owns* no axis (FOUNDATION_OWNED_AXES), so the omitted-knob
 *  default must follow the foundation, not the platform.  `elixir` +
 *  `vanilla` ⇒ plain Ecto + plain-Phoenix style.  Everything else uses the
 *  platform `adapterDefaults` unchanged (returns `{}`). */
export function foundationAdapterOverride(
  platform: Platform,
  foundation: string | undefined,
): { style?: string; persistence?: string } {
  if (platform === "elixir" && foundation === "vanilla") {
    return { style: "vanilla", persistence: "ecto" };
  }
  return {};
}

export function qualifyPlatform(raw: string | undefined): {
  family: Platform;
  ref: string;
} {
  // D-ELIXIR-PLATFORM: `elixir` is the canonical language-ecosystem
  // platform name.  Legacy *platform* spellings (`phoenix`,
  // `phoenixLiveView`, `hono`) are desugared here at the boundary so
  // every downstream consumer sees only the canonical family
  // (`elixir`, `node`).
  const value = canonicalPlatform(raw ?? "node");
  const parsed = parseBuiltinPlatformRef(value);
  return parsed
    ? { family: parsed.family as Platform, ref: parsed.qualified }
    : { family: value as Platform, ref: value };
}

/** Canonicalise a legacy *platform* alias to its canonical family
 *  (`phoenixLiveView` → `phoenix` → `elixir`, `hono` → `node`); everything
 *  else passes through.  Boundary-only: the alias never reaches the IR or
 *  any generator.  (The Hono *web framework* keeps the `hono` spelling as
 *  the `transport:` value; the LiveView *framework* keeps `phoenixLiveView`
 *  — see `canonicalFramework`.  D-ELIXIR-PLATFORM renamed the language-
 *  ecosystem platform `phoenix` → `elixir`; D-PHOENIX-TRANSPORT renamed
 *  the Phoenix web framework `phoenixRouter` → `phoenix` (see
 *  `canonicalTransport`).) */
export function canonicalPlatform(value: string): string {
  // Chain: phoenixLiveView → phoenix → elixir.  Order matters so the
  // legacy `phoenixLiveView` lands at the canonical `elixir` in one pass.
  if (value === "phoenixLiveView") return "elixir";
  if (value === "phoenix") return "elixir";
  if (value === "hono") return "node";
  return value;
}

/** Canonicalise a legacy *transport* alias to its canonical value.
 *  D-PHOENIX-TRANSPORT: the Phoenix web framework is the `transport:`
 *  value on `platform: elixir`; legacy `transport: phoenixRouter`
 *  desugars to `transport: phoenix`.  Other transports pass through. */
export function canonicalTransport(value: string | undefined): string | undefined {
  return value === "phoenixRouter" ? "phoenix" : value;
}

/** Canonicalise a D-PHOENIX-SURFACE framework alias.  `liveview` →
 *  `phoenixLiveView`; everything else passes through. */
export function canonicalFramework(value: string | undefined): string | undefined {
  return value === "liveview" ? "phoenixLiveView" : value;
}

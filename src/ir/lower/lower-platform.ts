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

/** Split a `platform:` value into the family (the closed `Platform`
 *  union every consumer branches on) and the fully-qualified ref
 *  (`family@version`, mirrors `qualifyDesign`).  Bareword backend →
 *  family + `family@latest`.  Backend pin (`node@v4`) → family + the
 *  pin verbatim.  Frontend / unknown (`react`, `static`) → value for
 *  both (no version axis here).  Byte-identical for every existing
 *  source: `family` equals the bareword, so all `platform === "…"`
 *  logic is unchanged; `platformRef` is additive (dispatch keys
 *  on `platform`). */

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

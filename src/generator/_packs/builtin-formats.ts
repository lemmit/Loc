// ---------------------------------------------------------------------------
// Single source of truth for the built-in design packs that ship under
// `<repo>/designs/<family>/<version>/`.  Phase 0 of the pack-versioning
// rollout: every built-in pack is identified by a `family@version` pair
// (e.g. "mantine@v7"), with the `family` half corresponding to a
// directory under `designs/` and the `version` half corresponding to
// a subdirectory inside it.
//
// Two consumers read this map:
//   1. The Node + browser pack loaders (`loader-fs.ts`, `loader-vfs.ts`)
//      decide whether a `design:` value resolves under the bundled
//      designs/ directory (built-in) or as a path relative to the .ddd
//      file (custom) via `parseBuiltinDesignRef`.
//   2. The Langium validator (`ddd-validator.ts`) uses the format value
//      to reject a `design:` whose format doesn't match the deployable's
//      framework (e.g. `platform: react, design: ashPhoenix` would
//      render a HEEx pack through the TSX renderer).
//
// Adding a new built-in pack version: drop the pack directory under
// `designs/<family>/<vNN>/`, add an entry to `BUILTIN_PACK_FORMATS`,
// and optionally bump `BUILTIN_PACK_LATEST[family]` once the new
// version is the recommended default.  Both consumers pick it up
// automatically; no other code edits required.
// ---------------------------------------------------------------------------

export const BUILTIN_PACK_FORMATS = {
  "mantine@v7":    "tsx",
  "mantine@v9":    "tsx",
  "chakra@v2":     "tsx",
  "chakra@v3":     "tsx",
  "mui@v5":        "tsx",
  "shadcn@v3":     "tsx",
  "ashPhoenix@v3": "heex",
} as const satisfies Record<string, "tsx" | "heex">;

/** What bareword `design: mantine` (no `@version`) resolves to in
 *  this toolchain build.  When we ship a new major version of a pack,
 *  flip the entry here and every bareword consumer rolls forward
 *  automatically — explicit pins (`design: "mantine@v7"`) are the
 *  opt-out for projects that want determinism across toolchain
 *  upgrades.  Phase 0 keeps every default pointing at today's
 *  behaviour so the existing examples generate byte-identical
 *  output. */
export const BUILTIN_PACK_LATEST = {
  // mantine promoted to v9 (Mantine 9 / React 19, stack v2) once the
  // pinned v9 pack proved out live in the playground.  Bareword
  // `design: mantine` now resolves to mantine@v9; the v7 pack stays
  // loadable via the explicit pin `design: "mantine@v7"` for projects
  // that want React 18.  This flip was paired with refreshing
  // `test/fixtures/baseline-output/` (acme.ddd uses the bareword).
  mantine:    "v9",
  chakra:     "v2",
  mui:        "v5",
  shadcn:     "v3",
  ashPhoenix: "v3",
} as const satisfies Record<string, string>;

export type BuiltinPackFamily = keyof typeof BUILTIN_PACK_LATEST;
/** Legacy alias kept for callers that don't care about versions —
 *  semantically `BuiltinPackName` always referred to a family. */
export type BuiltinPackName = BuiltinPackFamily;

/** Resolved view of a `design:` slot value when it points at a
 *  built-in pack.  Returned by `parseBuiltinDesignRef`; carries the
 *  family + version + the canonical `family@version` form that the
 *  format map + IR field both store. */
export interface ParsedBuiltinDesignRef {
  family: BuiltinPackFamily;
  version: string;
  /** `${family}@${version}` — the canonical key into
   *  `BUILTIN_PACK_FORMATS` and the value stored in IR after
   *  lowering qualifies the bareword form. */
  qualified: string;
}

/** Parse a `design:` slot value.  Returns `null` for custom paths
 *  (anything starting with `.` or `/`) or for names that aren't a
 *  registered built-in family — both callers (loader + validator)
 *  fall through to their custom-pack / unknown-pack codepaths in
 *  those cases.
 *
 *  Accepted forms:
 *    "mantine"        → { family: "mantine", version: "v7",  qualified: "mantine@v7" }   // bareword, version from BUILTIN_PACK_LATEST
 *    "mantine@v7"     → { family: "mantine", version: "v7",  qualified: "mantine@v7" }   // explicit pin
 *    "mantine@v9"     → { family: "mantine", version: "v9",  qualified: "mantine@v9" }   // explicit pin (may not exist yet — caller checks via packFormatForBuiltin)
 *    "./design/foo"   → null                                                              // custom pack
 *    "frobnicator"    → null                                                              // unknown family
 */
export function parseBuiltinDesignRef(
  s: string,
): ParsedBuiltinDesignRef | null {
  // Custom path — leave to the loader's reference-dir resolution.
  if (s.startsWith(".") || s.startsWith("/")) return null;
  const at = s.indexOf("@");
  const family = (at === -1 ? s : s.slice(0, at)) as BuiltinPackFamily;
  if (!(family in BUILTIN_PACK_LATEST)) return null;
  const version =
    at === -1 ? BUILTIN_PACK_LATEST[family] : s.slice(at + 1);
  return { family, version, qualified: `${family}@${version}` };
}

/** Format the named built-in pack produces, or `undefined` if `name`
 *  is not a built-in or names a built-in family at an unknown
 *  version.  Used by the validator to cross-check a deployable's
 *  `design:` against its framework's expected pack format, and to
 *  emit "no such version" errors. */
export function packFormatForBuiltin(
  name: string,
): "tsx" | "heex" | undefined {
  const parsed = parseBuiltinDesignRef(name);
  if (!parsed) return undefined;
  return (BUILTIN_PACK_FORMATS as Record<string, "tsx" | "heex">)[
    parsed.qualified
  ];
}

/** Every version registered for a given built-in family.  Used by
 *  the validator's "unknown version" error to list the available
 *  pins for a family the user typo'd a version of. */
export function builtinVersionsForFamily(
  family: BuiltinPackFamily,
): string[] {
  const prefix = `${family}@`;
  return Object.keys(BUILTIN_PACK_FORMATS)
    .filter((k) => k.startsWith(prefix))
    .map((k) => k.slice(prefix.length))
    .sort();
}

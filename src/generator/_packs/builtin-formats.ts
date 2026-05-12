// ---------------------------------------------------------------------------
// Single source of truth for the built-in design packs that ship under
// `<repo>/designs/<name>/` and the output format each one produces.
//
// Two consumers read this map:
//   1. The Node pack loader (`loader-fs.ts`) — uses the key set to decide
//      whether a `design:` value resolves under the bundled designs/ dir
//      (built-in) or as a path relative to the .ddd file (custom).
//   2. The Langium validator (`ddd-validator.ts`) — uses the value side to
//      reject a `design:` whose format doesn't match the deployable's
//      framework (e.g. `platform: react, design: ashPhoenix` would render
//      a HEEx pack through the TSX renderer and explode at template
//      lookup time).  Validators are sync + IO-free, so they can't read
//      each pack's `pack.json` to discover the format — this hardcoded
//      map is the alternative.  Custom packs (any name not in this map)
//      fall through both checks; the validator warns instead of erroring
//      because it can't read their `pack.json` to know better.
//
// Adding a new built-in pack: drop the pack directory under `designs/`,
// add an entry here.  Both consumers pick it up automatically.
// ---------------------------------------------------------------------------

export const BUILTIN_PACK_FORMATS = {
  mantine: "tsx",
  shadcn: "tsx",
  mui: "tsx",
  chakra: "tsx",
  ashPhoenix: "heex",
} as const satisfies Record<string, "tsx" | "heex">;

export type BuiltinPackName = keyof typeof BUILTIN_PACK_FORMATS;

/** Format the named built-in pack produces, or `undefined` if `name` is
 *  not a built-in.  Used by the validator to cross-check a deployable's
 *  `design:` against its framework's expected pack format. */
export function packFormatForBuiltin(
  name: string,
): "tsx" | "heex" | undefined {
  return (BUILTIN_PACK_FORMATS as Record<string, "tsx" | "heex">)[name];
}

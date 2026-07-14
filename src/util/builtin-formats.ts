// ---------------------------------------------------------------------------
// Single source of truth for the built-in design packs that ship under
// `<repo>/designs/<family>/<version>/`.  Every built-in pack is
// identified by a `family@version` pair (e.g. "mantine@v7"), with the
// `family` half corresponding to a directory under `designs/` and the
// `version` half corresponding to a subdirectory inside it.
//
// Two consumers read this map:
//   1. The Node + browser pack loaders (`loader-fs.ts`, `loader-vfs.ts`)
//      decide whether a `design:` value resolves under the bundled
//      designs/ directory (built-in) or as a path relative to the .ddd
//      file (custom) via `parseBuiltinDesignRef`.
//   2. The Langium validator (`ddd-validator.ts`) uses the format value
//      to reject a `design:` whose format doesn't match the deployable's
//      framework (e.g. `platform: react, design: coreComponents` would
//      render a HEEx pack through the TSX renderer).
//
// Adding a new built-in pack version: drop the pack directory under
// `designs/<family>/<vNN>/`, add an entry to `BUILTIN_PACK_FORMATS`,
// and optionally bump `BUILTIN_PACK_LATEST[family]` once the new
// version is the recommended default.  Both consumers pick it up
// automatically; no other code edits required.
// ---------------------------------------------------------------------------

/** Output format a design pack produces.  `tsx` packs render React
 *  (JSX) markup, `heex` packs render Phoenix LiveView templates,
 *  `svelte` packs render Svelte 5 component markup, `vue` packs
 *  render Vue 3 SFC template markup, and `angular` packs render
 *  Angular standalone-component templates.  Canonical home of
 *  the union — the pack loader re-exports it so `generator/` consumers
 *  keep their import path. */
export type PackFormat = "tsx" | "heex" | "svelte" | "vue" | "angular";

export const BUILTIN_PACK_FORMATS = {
  "mantine@v7": "tsx",
  "mantine@v9": "tsx",
  "chakra@v2": "tsx",
  "chakra@v3": "tsx",
  "mui@v5": "tsx",
  "mui@v7": "tsx",
  "shadcn@v3": "tsx",
  "shadcn@v4": "tsx",
  "coreComponents@v3": "heex",
  "daisyui@v1": "heex",
  "shadcnSvelte@v1": "svelte",
  "flowbite@v1": "svelte",
  "vuetify@v3": "vue",
  "shadcnVue@v1": "vue",
  "angularMaterial@v1": "angular",
  "primeng@v1": "angular",
  "spartanNg@v1": "angular",
} as const satisfies Record<string, PackFormat>;

/** What bareword `design: mantine` (no `@version`) resolves to in
 *  this toolchain build.  When we ship a new major version of a pack,
 *  flip the entry here and every bareword consumer rolls forward
 *  automatically — explicit pins (`design: "mantine@v7"`) are the
 *  opt-out for projects that want determinism across toolchain
 *  upgrades.  Every default currently points at today's behaviour so
 *  the existing examples generate byte-identical output. */
export const BUILTIN_PACK_LATEST = {
  // mantine promoted to v9 (Mantine 9 / React 19, stack v3) once the
  // pinned v9 pack proved out live in the playground.  Bareword
  // `design: mantine` now resolves to mantine@v9; the v7 pack stays
  // loadable via the explicit pin `design: "mantine@v7"` for projects
  // that want React 18.  This flip was paired with refreshing
  // `test/fixtures/baseline-output/` (acme.ddd uses the bareword).
  mantine: "v9",
  // chakra promoted to v3 (Chakra UI 3 / React 19, stack v3) and mui
  // to v7 (Material UI 7) once their pinned packs proved out via the
  // tsc + vite-build shards and runtime-gate e2e specs.  Bareword
  // `design: chakra` / `design: mui` now resolve to the new majors;
  // the old packs stay loadable via the explicit pins
  // `design: "chakra@v2"` / `design: "mui@v5"`.  acme.ddd (the
  // baseline fixture source) has no `design:` slot so it tracks
  // mantine — these flips don't touch test/fixtures/baseline-output/.
  chakra: "v3",
  mui: "v7",
  // shadcn promoted to v4 (Tailwind 4 CSS-first / React 19, stack
  // v3).  The blocker — the in-browser playground only knew the
  // Tailwind 3 Play CDN — was cleared: `iframe-html.ts`'s
  // `tailwindFlavor` now routes `@import "tailwindcss"` CSS through
  // `@tailwindcss/browser`, and the bundler externalises the v4
  // `@import`s.  Bareword `design: shadcn` now resolves to
  // shadcn@v4; the Tailwind-3 pack stays loadable via the explicit
  // pin `design: "shadcn@v3"`.  acme.ddd has no `design:` slot so
  // this doesn't touch test/fixtures/baseline-output/.
  shadcn: "v4",
  coreComponents: "v3",
  // The genuine-daisyUI HEEx pack ships its first version; bareword
  // `design: daisyui` resolves to daisyui@v1.  coreComponents (plain
  // Tailwind core_components) stays the elixir default; daisyui is the
  // opt-in design-system look.
  daisyui: "v1",
  // Svelte packs ship a single version each so far; barewords resolve
  // straight to v1.
  shadcnSvelte: "v1",
  flowbite: "v1",
  // Vue packs: vuetify tracks Vuetify 3 (hence v3); shadcnVue ships
  // its first pack version.
  vuetify: "v3",
  shadcnVue: "v1",
  // Angular packs ship a single version each so far; barewords resolve
  // straight to v1.  angularMaterial is the default (D-ANGULAR-FRONTEND).
  angularMaterial: "v1",
  primeng: "v1",
  spartanNg: "v1",
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
export function parseBuiltinDesignRef(s: string): ParsedBuiltinDesignRef | null {
  // Custom path — leave to the loader's reference-dir resolution.
  if (s.startsWith(".") || s.startsWith("/")) return null;
  const at = s.indexOf("@");
  const family = (at === -1 ? s : s.slice(0, at)) as BuiltinPackFamily;
  if (!(family in BUILTIN_PACK_LATEST)) return null;
  const version = at === -1 ? BUILTIN_PACK_LATEST[family] : s.slice(at + 1);
  return { family, version, qualified: `${family}@${version}` };
}

/** Format the named built-in pack produces, or `undefined` if `name`
 *  is not a built-in or names a built-in family at an unknown
 *  version.  Used by the validator to cross-check a deployable's
 *  `design:` against its framework's expected pack format, and to
 *  emit "no such version" errors. */
export function packFormatForBuiltin(name: string): PackFormat | undefined {
  const parsed = parseBuiltinDesignRef(name);
  if (!parsed) return undefined;
  return (BUILTIN_PACK_FORMATS as Record<string, PackFormat>)[parsed.qualified];
}

/** Every version registered for a given built-in family.  Used by
 *  the validator's "unknown version" error to list the available
 *  pins for a family the user typo'd a version of. */
export function builtinVersionsForFamily(family: BuiltinPackFamily): string[] {
  const prefix = `${family}@`;
  return Object.keys(BUILTIN_PACK_FORMATS)
    .filter((k) => k.startsWith(prefix))
    .map((k) => k.slice(prefix.length))
    .sort();
}

// ---------------------------------------------------------------------------
// Feliz design themes.  Feliz renders F#, not a component-library pack — its
// design system is daisyUI, so a feliz deployable's `design:` slot selects a
// daisyUI THEME (`data-theme`) rather than a pack family.  This is daisyUI v4's
// built-in theme set.  Two consumers read it:
//   1. The validator (Rule 14, feliz branch) rejects a `design:` that isn't one
//      of these.
//   2. The Feliz generator maps `design:` → the emitted `data-theme` + the
//      compiled-in `tailwind.config.js` theme list.
// The Loom defaults (`corporate` light + `business` dark) are always available.
// ---------------------------------------------------------------------------

export const DAISYUI_THEMES: readonly string[] = [
  "light",
  "dark",
  "cupcake",
  "bumblebee",
  "emerald",
  "corporate",
  "synthwave",
  "retro",
  "cyberpunk",
  "valentine",
  "halloween",
  "garden",
  "forest",
  "aqua",
  "lofi",
  "pastel",
  "fantasy",
  "wireframe",
  "black",
  "luxury",
  "dracula",
  "cmyk",
  "autumn",
  "business",
  "acid",
  "lemonade",
  "night",
  "coffee",
  "winter",
  "dim",
  "nord",
  "sunset",
];

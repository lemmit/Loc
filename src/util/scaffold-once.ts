// Scaffold-once files — the regeneration-preservation mechanic.
//
// A *scaffold-once* file is one Loom writes on the FIRST `generate` and then
// leaves entirely to the user: subsequent regenerations must NOT overwrite it,
// so a hand-written implementation survives.  This is the storage seam for
// user-owned domain-extension code — established by the Elixir `extern` hook
// (proposal: `docs/old/proposals/extern-domain-extension-point.md`, Slice 1) and
// reused by the .NET / TS / Python / Java extern slices (2–5).
//
// The bit that says "this file is scaffold-once" travels IN-BAND: the generator
// emits a sentinel token in the file's first line (as a language-appropriate
// comment), and the CLI writer detects it in the freshly-generated content.
// When a file already exists on disk at that path, the writer keeps the on-disk
// copy instead of overwriting.  Carrying the marker in-band (rather than a
// side-channel `Set<path>` threaded through every `PlatformSurface.emitProject`
// return) means a new backend opts a file into the mechanic by emitting one
// comment line — no signature change anywhere in the pipeline — and the marker
// doubles as human-readable documentation the user sees at the top of the file.

/** The sentinel token embedded (inside a comment) on the FIRST line of a
 *  scaffold-once file.  Distinctive enough to never collide with real source.
 *  Backends emit it in their own comment syntax, e.g. Elixir `# loom:scaffold-once …`. */
export const SCAFFOLD_ONCE_MARKER = "loom:scaffold-once";

/** True when `content` is a scaffold-once file — i.e. its first line carries
 *  {@link SCAFFOLD_ONCE_MARKER}.  Only the first line is scanned so the token
 *  appearing later (in a string literal, say) can't produce a false positive. */
export function isScaffoldOnce(content: string): boolean {
  const nl = content.indexOf("\n");
  const firstLine = nl === -1 ? content : content.slice(0, nl);
  return firstLine.includes(SCAFFOLD_ONCE_MARKER);
}

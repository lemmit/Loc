// The Loom standard prelude, written in Loom (stdlib Phase C).
//
// These are ordinary expression-form top-level `function`s (Phase B).  They
// are AMBIENT — available in every `.ddd` with nothing imported, like a
// language builtin — and, being expression-form, they INLINE at each call
// site during lowering, so an UNCALLED std function emits nothing into any
// generated project (zero bytes of bloat).  A user-declared top-level
// function of the same name WINS (the prelude is a default, not an override);
// see `stdFunctions()` in `stdlib.ts` and the user-wins ordering at each
// resolution layer (unknown-name gate, type system, lowering).
//
// The source lives here as string constants (not `.ddd` files) so it is
// self-contained and browser-safe — parsed once on `EmptyFileSystem`, with no
// filesystem or bundler dependency on either the Node CLI or the playground.
// Keep every function EXPRESSION-form and NON-recursive (both are enforced by
// `checkTopLevelFunctions`, and the prelude is covered by a parse+validate
// test).

/** Prelude modules, name → Loom source.  One entry per conceptual `std/*`
 *  group; all are ambient (there is no selective import yet). */
export const STD_SOURCES: Readonly<Record<string, string>> = {
  strings: `
// Loom stdlib — strings.
function isBlank(s: string): bool = s.trim().length == 0
function isPresent(s: string): bool = s.trim().length > 0
function truncate(s: string, n: int): string = s.substring(0, n)
`,
  math: `
// Loom stdlib — math.
function clamp(n: int, lo: int, hi: int): int = n.max(lo).min(hi)
function percentOf(part: decimal, whole: decimal): decimal = part / whole * 100
function roundTo(n: decimal, places: int): decimal = n.round(places)
`,
  temporal: `
// Loom stdlib — temporal.
function isOverdue(due: datetime): bool = now() > due
function isFuture(t: datetime): bool = t > now()
function isPast(t: datetime): bool = t < now()
`,
};

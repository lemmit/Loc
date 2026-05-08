// Tiny string-hash util — used to derive a per-source PGlite OPFS
// path so each unique `.ddd` gets its own data island.  No need
// for cryptographic strength: we want a short, deterministic,
// path-safe identifier.  FNV-1a 32-bit gives us that in 8 hex
// chars, no deps, browser + Node.
//
// Collisions across distinct sources are theoretically possible
// (~1 in 4 billion) but the consequence is "two sources share a
// PGlite", which the auto-DDL re-apply tolerates because the
// generator emits idempotent CREATE TABLE / CREATE TYPE / CREATE
// INDEX statements (see runtime/ddl.ts).
export function fnv1a32(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    // 32-bit unsigned multiply.  `Math.imul` gives us the low 32
    // bits without the precision loss bigger products would
    // suffer in plain JS.
    h = Math.imul(h, 0x01000193);
  }
  // `h >>> 0` re-normalises to unsigned before stringifying so
  // negative-int representations don't leak into the hex.
  return (h >>> 0).toString(16).padStart(8, "0");
}

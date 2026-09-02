// ---------------------------------------------------------------------------
// Deterministic per-deployable secret material.
//
// A generated stack needs a session-signing key in its `docker-compose.yml`
// (Phoenix's `SECRET_KEY_BASE`) — and it must be DIFFERENT per deployable, so
// two services in one stack (and two stacks on one machine) don't share a
// session key.  Minting it with `crypto.getRandomValues()` at generate time
// achieved that and broke something bigger: `generate system` stopped being a
// pure function of its input.  Regenerating in place — the documented workflow
// that `--dry-run`, `.loomignore` and scaffold-once all exist to make safe —
// rewrote `docker-compose.yml` on every run, produced a spurious VCS diff, and
// ROTATED the session key of a running dev stack (logging every user out).
//
// So the material is DERIVED instead: a pure function of the caller's key
// parts (system name + deployable slug + purpose).  Same model in, same bytes
// out; different deployable, different bytes.
//
// This is a DEV DEFAULT, not a KDF, and it deliberately doesn't pretend to be
// one: the value is reproducible by anyone holding the `.ddd`.  That is the
// same guarantee the generated `config/dev.exs` already ships (one hard-coded
// literal, identical in every generated project) and strictly stronger — this
// one at least varies per system and per deployable.  PRODUCTION never uses
// it: the generated `config/runtime.exs` RAISES unless `SECRET_KEY_BASE` comes
// from the environment, and the k8s emitter routes the key into a Secret the
// operator overwrites.
//
// Dependency-free and browser-safe (the playground generates too): no
// `node:crypto`, and Web Crypto's `subtle.digest` is async, so the mixing is
// the standard xmur3 seed + sfc32 stream — well-distributed, ~20 lines, and
// identical in every JS runtime.
// ---------------------------------------------------------------------------

/** xmur3 — a 32-bit string hash producing a well-mixed seed sequence.  Each
 *  call to the returned function yields the next 32-bit seed word. */
function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

/** sfc32 — a small fast counter PRNG.  Four 32-bit words of state, uniform
 *  32-bit output, no dependence on the host's RNG. */
function sfc32(a: number, b: number, c: number, d: number): () => number {
  return () => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return t >>> 0;
  };
}

/** `bytes` bytes of deterministic material as lowercase hex (2 chars per
 *  byte), derived from `parts`.  Distinct `parts` tuples give unrelated
 *  output; the same tuple always gives the same string.
 *
 *  Each part is LENGTH-PREFIXED before hashing, so `("ab", "c")` and
 *  `("a", "bc")` cannot collide into the same seed. */
export function deterministicHex(bytes: number, ...parts: string[]): string {
  const key = parts.map((p) => `${p.length}:${p}`).join("");
  const seed = xmur3(key);
  const next = sfc32(seed(), seed(), seed(), seed());
  // Warm the state before use: sfc32's author recommends discarding the first
  // outputs so a low-entropy seed doesn't show through the leading words.
  for (let i = 0; i < 12; i++) next();
  let out = "";
  while (out.length < bytes * 2) out += next().toString(16).padStart(8, "0");
  return out.slice(0, bytes * 2);
}

import { describe, expect, it } from "vitest";
import { contentHash } from "../../src/util/content-hash.js";
import { messageCode } from "../../src/util/message-code.js";

// `contentHash` (src/util/content-hash.ts) is the ONE hash primitive behind the
// whole i18n key family — the `msg.<hash>` validation-message wire codes and the
// user-visible-string catalog keys.  Its contract (D-I18N-KEY) is entirely about
// STABILITY and SHAPE, not strength: the same source text must always yield the
// same 6-char key (so a translated catalog entry keeps matching), and any
// rephrase must yield a different one (so `ddd i18n sync` sees delete-old +
// add-new rather than silently re-using a stale translation).
//
// Deliberately NOT pinned here: the exact digest of any given string.  The
// module's own comment reserves the right to swap FNV-1a for sha512-6 while
// keeping the 6-char shape, and a golden-digest test would block that swap for
// no benefit — the properties below are what the consumers actually rely on.

const SAMPLES = [
  "",
  "a",
  "b",
  "Order total must be positive",
  "Order total must be positive.",
  "order total must be positive",
  "Quantity must be at least {min}",
  "Ünïcödé — em dash, ellipsis …",
  "🙂 emoji and a tab\tand a newline\n",
  "x".repeat(1000),
];

describe("contentHash — shape", () => {
  it("is always exactly 6 characters", () => {
    for (const s of SAMPLES) expect(contentHash(s)).toHaveLength(6);
  });

  it("is lowercase base-36 (digits + a-z), so it is safe in a key / identifier", () => {
    for (const s of SAMPLES) expect(contentHash(s)).toMatch(/^[0-9a-z]{6}$/);
  });

  it("stays 6 chars across a large corpus (the padStart/slice keeps it fixed-width)", () => {
    // A 32-bit FNV value renders as 6 OR 7 base-36 digits; `padStart(6).slice(-6)`
    // normalises both ends, so neither a short nor a long digest escapes the width.
    const widths = new Set<number>();
    for (let i = 0; i < 5000; i++) widths.add(contentHash(`sample string number ${i}`).length);
    expect([...widths]).toEqual([6]);
  });

  it("hashes the empty string to a well-formed 6-char key (no crash, no empty key)", () => {
    expect(contentHash("")).toMatch(/^[0-9a-z]{6}$/);
  });
});

describe("contentHash — stability", () => {
  it("is deterministic: repeated calls on the same text agree", () => {
    for (const s of SAMPLES) {
      const first = contentHash(s);
      expect(contentHash(s)).toBe(first);
      expect(contentHash(`${s}`.slice(0))).toBe(first); // a distinct String instance
    }
  });

  it("is pure — hashing other strings in between does not perturb it", () => {
    const before = contentHash("Order total must be positive");
    for (let i = 0; i < 100; i++) contentHash(`noise ${i}`);
    expect(contentHash("Order total must be positive")).toBe(before);
  });
});

describe("contentHash — sensitivity", () => {
  it("differs on a one-character change (a reword is a NEW key, never a silent re-use)", () => {
    const base = "Order total must be positive";
    expect(contentHash(base)).not.toBe(contentHash(`${base}.`)); // added period
    expect(contentHash(base)).not.toBe(contentHash("order total must be positive")); // case
    expect(contentHash(base)).not.toBe(contentHash("Order  total must be positive")); // spacing
  });

  it("differs on single-byte inputs", () => {
    expect(contentHash("a")).not.toBe(contentHash("b"));
    expect(contentHash("a")).not.toBe(contentHash("A"));
    expect(contentHash("a")).not.toBe(contentHash(""));
  });

  it("is order-sensitive (not a commutative checksum)", () => {
    expect(contentHash("ab")).not.toBe(contentHash("ba"));
    expect(contentHash("abc")).not.toBe(contentHash("cba"));
  });

  it("keeps collisions rare enough to key a catalog on (0 over 5k realistic strings)", () => {
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (let i = 0; i < 5000; i++) {
      const text = `Field ${i} must be between ${i} and ${i + 10}`;
      const h = contentHash(text);
      const prev = seen.get(h);
      if (prev !== undefined) collisions.push(`${prev} ⟂ ${text}`);
      else seen.set(h, text);
    }
    expect(collisions).toEqual([]);
  });
});

describe("contentHash — the message-code consumer agrees", () => {
  it("`messageCode` is `msg.` + the content hash of the same text", () => {
    // src/util/message-code.ts is the wire-code half of the same key family;
    // pinning it here is what makes a change to `contentHash` visible as a
    // CHANGED WIRE CODE rather than as an isolated util-level edit.
    for (const s of ["Order total must be positive", "", "Quantity must be at least {min}"]) {
      expect(messageCode(s)).toBe(`msg.${contentHash(s)}`);
    }
  });
});

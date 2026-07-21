// The dependency-free synchronous SHA-256 backing the RabbitMQ
// definitions.json password hashes (M-T4.4 slice 5 — src/util/sha256.ts).
// Pinned against the FIPS 180-4 example vectors + a >1-block input so the
// padding and multi-block compression paths are both exercised.

import { describe, expect, it } from "vitest";
import { sha256 } from "../../src/util/sha256.js";

const hex = (bytes: Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("sha256 (util)", () => {
  it("matches the FIPS 180-4 vectors", () => {
    expect(hex(sha256(utf8("")))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(hex(sha256(utf8("abc")))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(hex(sha256(utf8("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")))).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
  });

  it("handles inputs spanning the one-block padding boundary", () => {
    // 55 bytes fits length-in-block; 56+ forces a second padding block.
    expect(hex(sha256(utf8("a".repeat(55))))).toBe(
      "9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318",
    );
    expect(hex(sha256(utf8("a".repeat(64))))).toBe(
      "ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb",
    );
  });
});

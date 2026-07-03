import { describe, expect, it } from "vitest";
import { platformFor } from "../../src/platform/registry.js";

// C9 — the Phoenix SECRET_KEY_BASE (session signing/encryption key) is
// generated per project at `generate` time, not shared from a hard-coded
// literal.  So no two generated stacks — nor two deployables — reuse a
// session-signing key, and each satisfies Phoenix's ≥64-byte minimum.
function secretOf(slug: string): string {
  const shape = platformFor("elixir").composeService({
    deployable: { name: "app" } as never,
    sys: { name: "S" } as never,
    slug,
  });
  const entry = shape.env?.find(([k]) => k === "SECRET_KEY_BASE");
  expect(entry).toBeDefined();
  return entry![1];
}

describe("elixir platform — SECRET_KEY_BASE randomness (C9)", () => {
  it("is at least 64 bytes (Phoenix minimum)", () => {
    // 64 random bytes rendered as hex = 128 chars, comfortably past the
    // 64-byte floor Phoenix enforces in `Plug.Session.assert_secret/2`.
    expect(secretOf("s_app").length).toBeGreaterThanOrEqual(64);
  });

  it("differs across two generations (per-project randomness)", () => {
    const a = secretOf("s_app");
    const b = secretOf("s_app");
    expect(a).not.toEqual(b);
  });

  it("is lowercase hex", () => {
    expect(secretOf("s_app")).toMatch(/^[0-9a-f]+$/);
  });
});

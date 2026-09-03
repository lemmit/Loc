import { describe, expect, it } from "vitest";
import { platformFor } from "../../src/platform/registry.js";

// C9 — the Phoenix SECRET_KEY_BASE (session signing/encryption key) is minted
// per project at `generate` time, not shared from a hard-coded literal: no two
// generated stacks, and no two deployables, reuse a session-signing key, and
// each satisfies Phoenix's ≥64-byte minimum.
//
// That guarantee is unchanged; the MECHANISM is not.  It used to come from
// `crypto.getRandomValues()`, which bought uniqueness by making `generate
// system` non-deterministic — one line of `docker-compose.yml` (and the
// matching k8s Secret) re-randomised on every run, so every regen rewrote the
// file, showed up as a spurious VCS diff, and rotated the session key of a
// RUNNING dev stack, logging every user out of a `docker compose up` that was
// only picking up a model change.  The key is now DERIVED from (system,
// deployable) instead — same uniqueness, and stable across regenerations.
//
// So the third case below is INVERTED on purpose: it used to assert that two
// generations differ.  It now asserts they don't, and the uniqueness the old
// case was really protecting is asserted directly, across deployables and
// across systems.
function secretOf(sysName: string, slug: string): string {
  const shape = platformFor("elixir").composeService({
    deployable: { name: "app" } as never,
    sys: { name: sysName } as never,
    slug,
  });
  const entry = shape.env?.find(([k]) => k === "SECRET_KEY_BASE");
  expect(entry).toBeDefined();
  return entry![1];
}

describe("elixir platform — SECRET_KEY_BASE (C9)", () => {
  it("is at least 64 bytes (Phoenix minimum)", () => {
    // 64 bytes rendered as hex = 128 chars, comfortably past the 64-byte floor
    // Phoenix enforces in `Plug.Session.assert_secret/2`.
    expect(secretOf("S", "s_app").length).toBeGreaterThanOrEqual(64);
  });

  it("is lowercase hex", () => {
    expect(secretOf("S", "s_app")).toMatch(/^[0-9a-f]+$/);
  });

  it("differs per deployable and per system (the uniqueness guarantee)", () => {
    const a = secretOf("S", "s_app");
    const b = secretOf("S", "s_worker");
    const c = secretOf("Other", "s_app");
    expect(a).not.toEqual(b);
    expect(a).not.toEqual(c);
    expect(b).not.toEqual(c);
  });

  it("is STABLE across generations — a regen must not rotate a running stack's key", () => {
    expect(secretOf("S", "s_app")).toEqual(secretOf("S", "s_app"));
  });
});

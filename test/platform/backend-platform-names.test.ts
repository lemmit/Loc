// C15 (full-review-remediation §C): validator messages that enumerate the
// backend / frontend platforms are DERIVED from the descriptor table so they
// can't drift.  These pin the derivation (every name a helper returns carries
// the matching `isFrontend` flag, and the two lists partition the platforms)
// and guard the specific entries the stale hand-lists were missing (python as
// a backend, angular as a frontend).

import { describe, expect, it } from "vitest";
import type { Platform } from "../../src/ir/types/loom-ir.js";
import {
  backendPlatformNames,
  descriptorFor,
  frontendPlatformNames,
} from "../../src/platform/metadata.js";

describe("C15 — derived backend/frontend platform name lists", () => {
  it("every backendPlatformNames() entry is a non-frontend descriptor", () => {
    for (const name of backendPlatformNames()) {
      expect(descriptorFor(name as Platform).isFrontend, name).toBe(false);
    }
  });

  it("every frontendPlatformNames() entry is a frontend descriptor", () => {
    for (const name of frontendPlatformNames()) {
      expect(descriptorFor(name as Platform).isFrontend, name).toBe(true);
    }
  });

  it("the two lists are disjoint", () => {
    const back = new Set(backendPlatformNames());
    expect(frontendPlatformNames().some((n) => back.has(n))).toBe(false);
  });

  it("includes the entries the stale hand-lists omitted", () => {
    // The serves-list / target hints previously omitted these.
    expect(backendPlatformNames()).toContain("python");
    expect(frontendPlatformNames()).toContain("angular");
  });
});

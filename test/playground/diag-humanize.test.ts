import { describe, expect, it } from "vitest";
import { CRASH_REASONS } from "../../web/src/util/diagnostics.js";
import {
  DIAG_REASON_SENTENCE,
  diagBadgeText,
  humanizeDiagReason,
  humanizeHashLen,
} from "../../web/src/util/diag-humanize.js";

// The Diagnostics stream's sentences (M-T8.22 slice 5, audit M10).  The ring
// keys are the contract with `crash-report.ts` and the boundaries; this map
// is the user-facing layer over them.

describe("humanizeDiagReason", () => {
  it("has a sentence for every crash reason the boundaries can record", () => {
    for (const r of CRASH_REASONS) {
      expect(DIAG_REASON_SENTENCE[r], r).toBeTruthy();
      expect(humanizeDiagReason(r)).toBe(DIAG_REASON_SENTENCE[r]);
    }
  });

  it("names the reach of a React crash — whole playground vs one panel", () => {
    expect(humanizeDiagReason("react-error")).toMatch(/whole playground crashed/);
    expect(humanizeDiagReason("react-error-pane")).toMatch(/A panel crashed while rendering/);
    expect(humanizeDiagReason("react-error-pane")).toMatch(/kept running/);
  });

  it("says the pressure breadcrumbs are not errors", () => {
    expect(humanizeDiagReason("hidden")).toMatch(/not an error/);
    expect(humanizeDiagReason("pagehide")).toMatch(/not an error/);
  });

  it("never shows the raw key as the sentence, and never returns an empty row", () => {
    for (const [k, v] of Object.entries(DIAG_REASON_SENTENCE)) {
      expect(v).not.toBe(k);
      expect(v.length).toBeGreaterThan(20);
    }
    expect(humanizeDiagReason("something-new")).toBe("Diagnostics snapshot recorded (something-new).");
  });
});

describe("humanizeHashLen", () => {
  it("turns `hash 341b` into a sentence and hides a zero", () => {
    expect(humanizeHashLen(341)).toBe("URL hash 341 bytes — the model shared in the link");
    expect(humanizeHashLen(0)).toBe("");
    expect(humanizeHashLen(Number.NaN)).toBe("");
  });
});

describe("diagBadgeText", () => {
  it("reads error / snapshot, not the internal key", () => {
    expect(diagBadgeText(true)).toBe("error");
    expect(diagBadgeText(false)).toBe("snapshot");
  });
});

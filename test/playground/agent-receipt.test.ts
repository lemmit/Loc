import { describe, expect, it } from "vitest";
import { validate } from "../../src/api/index.js";
import type { Message } from "../../src/tools/index.js";
import { foldTranscript } from "../../web/src/agent/live.js";
import {
  collectToolCalls,
  diffStat,
  fileDelta,
  fileDeltaIsEmpty,
  foldReceipt,
  unifiedDiff,
} from "../../web/src/agent/receipt.js";

// ---------------------------------------------------------------------------
// The per-turn RECEIPT (M-T8.19 slice 3) — a transcript plus two source
// versions folded into what the turn actually did.
//
// The reason the receipt is COMPUTED rather than quoted is NN/g's sycophancy
// finding: "it's fixed" has to be verified by the compiler.  So the validator
// delta here is produced by the REAL `validate()` on both sides of the write,
// and the fold is checked to carry it through untouched.
// ---------------------------------------------------------------------------

const BEFORE = `context Sales {
  aggregate Order {
    total: int
  }
}
`;

// The turn's write: one added member, one added aggregate.
const AFTER = `context Sales {
  aggregate Order {
    total: int
    placedAt: datetime
  }

  aggregate Invoice {
    amount: int
  }
}
`;

/** A two-step transcript: the model validates the candidate, then concludes. */
const TRANSCRIPT: Message[] = [
  { role: "user", content: [{ type: "text", text: "Add an invoice." }] },
  {
    role: "assistant",
    content: [
      { type: "text", text: "Validating the candidate." },
      { type: "tool_use", id: "v1", name: "loom_validate", input: { source: AFTER } },
    ],
  },
  {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "v1", content: JSON.stringify({ ok: true }) }],
  },
  { role: "assistant", content: [{ type: "text", text: "Done — 0 errors." }] },
];

describe("unifiedDiff", () => {
  it("is empty for identical text", () => {
    expect(unifiedDiff(BEFORE, BEFORE)).toBe("");
  });

  it("emits hunk headers and ±lines for a real edit", () => {
    const diff = unifiedDiff(BEFORE, AFTER);
    expect(diff).toMatch(/^@@ -\d+,\d+ \+\d+,\d+ @@/m);
    expect(diff).toContain("+    placedAt: datetime");
    expect(diff).toContain("+  aggregate Invoice {");
    // Unchanged context lines carry a leading space, not a sign.
    expect(diff).toContain("     total: int");
  });

  it("counts a pure deletion on the removed side", () => {
    const diff = unifiedDiff(AFTER, BEFORE);
    const stat = diffStat(diff);
    expect(stat.removed).toBeGreaterThan(0);
    expect(stat.added).toBe(0);
  });

  it("keeps only `context` lines around a hunk in a long file", () => {
    const long = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    const edited = long.replace("line 20", "line 20 CHANGED");
    const diff = unifiedDiff(long, edited, 2);
    // 2 context either side + the -/+ pair = 6 body lines, plus one header.
    expect(diff.split("\n")).toHaveLength(7);
    expect(diff).toContain("-line 20");
    expect(diff).toContain("+line 20 CHANGED");
    expect(diff).not.toContain("line 5");
  });
});

describe("diffStat", () => {
  it("ignores hunk headers", () => {
    expect(diffStat("@@ -1,2 +1,3 @@\n a\n+b\n-c")).toEqual({ added: 1, removed: 1 });
  });
});

describe("fileDelta", () => {
  const before = [
    { path: "a.ts", content: "1" },
    { path: "b.ts", content: "2" },
  ];
  const after = [
    { path: "a.ts", content: "1" },
    { path: "b.ts", content: "CHANGED" },
    { path: "c.ts", content: "3" },
  ];

  it("splits added / changed / removed and sorts each", () => {
    expect(fileDelta(before, after)).toEqual({
      added: ["c.ts"],
      changed: ["b.ts"],
      removed: [],
    });
    expect(fileDelta(after, before)).toEqual({
      added: [],
      changed: ["b.ts"],
      removed: ["c.ts"],
    });
  });

  it("is empty when nothing moved", () => {
    expect(fileDeltaIsEmpty(fileDelta(before, before))).toBe(true);
    expect(fileDeltaIsEmpty(fileDelta(before, after))).toBe(false);
  });
});

describe("collectToolCalls", () => {
  it("rolls every turn's cards up in order", () => {
    const bubbles = foldTranscript(TRANSCRIPT);
    const calls = collectToolCalls(bubbles);
    expect(calls.map((c) => c.tool)).toEqual(["loom_validate"]);
    expect(calls[0]!.status).toBe("ok");
  });
});

describe("foldReceipt over a transcript + two source versions", () => {
  it("carries the real validator delta, the diff, the files and the tokens", async () => {
    // The compiler's verdict, not the model's — the point of the whole card.
    const errorsOf = async (src: string): Promise<number> =>
      (await validate(src)).diagnostics.filter((d) => d.severity === "error").length;
    const before = await errorsOf(BEFORE);
    const after = await errorsOf(AFTER);

    const receipt = foldReceipt({
      bubbles: foldTranscript(TRANSCRIPT),
      before: BEFORE,
      after: AFTER,
      filesBefore: [{ path: "api/src/order.ts", content: "old" }],
      filesAfter: [
        { path: "api/src/order.ts", content: "new" },
        { path: "api/src/invoice.ts", content: "new" },
      ],
      validator: { before, after },
      usage: { input: 1200, output: 340 },
    });

    expect(receipt.wrote).toBe(true);
    expect(receipt.validator).toEqual({ before: 0, after: 0 });
    expect(receipt.added).toBeGreaterThan(0);
    expect(receipt.removed).toBe(0);
    expect(receipt.diff).toContain("+  aggregate Invoice {");
    expect(receipt.files).toEqual({
      added: ["api/src/invoice.ts"],
      changed: ["api/src/order.ts"],
      removed: [],
    });
    expect(receipt.toolCalls.map((c) => c.tool)).toEqual(["loom_validate"]);
    expect(receipt.usage).toEqual({ input: 1200, output: 340 });
  });

  it("reports a repair turn as an error count that actually fell", async () => {
    const broken = `context Sales {
  aggregate Order {
    total: NotAType
  }
}
`;
    const errorsOf = async (src: string): Promise<number> =>
      (await validate(src)).diagnostics.filter((d) => d.severity === "error").length;
    const brokenErrors = await errorsOf(broken);
    expect(brokenErrors).toBeGreaterThan(0);

    const receipt = foldReceipt({
      bubbles: [],
      before: broken,
      after: BEFORE,
      filesBefore: [],
      filesAfter: [],
      validator: { before: brokenErrors, after: await errorsOf(BEFORE) },
    });
    expect(receipt.validator.before).toBe(brokenErrors);
    expect(receipt.validator.after).toBe(0);
    expect(receipt.wrote).toBe(true);
  });

  it("marks a read-only turn as having written nothing", () => {
    const receipt = foldReceipt({
      bubbles: foldTranscript(TRANSCRIPT),
      before: BEFORE,
      after: BEFORE,
      filesBefore: [],
      filesAfter: [],
      validator: { before: 0, after: 0 },
    });
    expect(receipt.wrote).toBe(false);
    expect(receipt.diff).toBe("");
    expect(receipt.added + receipt.removed).toBe(0);
    expect(fileDeltaIsEmpty(receipt.files)).toBe(true);
    // No provider usage reported → the card shows no token line at all
    // rather than inventing a zero.
    expect(receipt.usage).toBeUndefined();
  });
});

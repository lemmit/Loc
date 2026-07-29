import { beforeEach, describe, expect, it, vi } from "vitest";

// The size-1 linked-model cache in `expr-slots.ts` keys on the source text, so a
// REJECTED build used to stay cached: every later slot on the same (unchanged)
// source replayed the rejection, and expression hints stayed dead until the user
// happened to edit.  Eviction on rejection is what this pins.

const buildLinkedModel = vi.fn();
vi.mock("../../web/src/builder/system/linked-doc.js", () => ({
  buildLinkedModel,
  buildLinkedDocument: vi.fn(),
}));

const SRC = `system S {
  context C {
    aggregate A {
      total: int
      function double(): int = this.total * 2
    }
  }
}`;
const SLOT = { kind: "function", owner: "A", name: "double" } as const;

describe("expr hints — linked-model cache", () => {
  beforeEach(async () => {
    const { clearLinkedModelCache } = await import("../../web/src/builder/system/expr-slots.js");
    clearLinkedModelCache();
    buildLinkedModel.mockReset();
  });

  it("caches a successful build (one build for repeated slots on the same source)", async () => {
    const { exprHints } = await import("../../web/src/builder/system/expr-slots.js");
    buildLinkedModel.mockResolvedValue(null);
    await exprHints(SRC, SLOT);
    await exprHints(SRC, SLOT);
    expect(buildLinkedModel).toHaveBeenCalledTimes(1);
  });

  it("evicts a rejected build so the next call retries instead of replaying the failure", async () => {
    const { exprHints } = await import("../../web/src/builder/system/expr-slots.js");
    buildLinkedModel.mockRejectedValueOnce(new Error("boom"));

    // The rejection is swallowed — hints degrade to empty, they don't throw.
    const first = await exprHints(SRC, SLOT);
    expect(first.members.size).toBe(0);
    expect(first.argLabels.size).toBe(0);

    buildLinkedModel.mockResolvedValue(null);
    await exprHints(SRC, SLOT);
    expect(buildLinkedModel).toHaveBeenCalledTimes(2);
  });

  it("keeps retrying while the build keeps failing", async () => {
    const { exprHints } = await import("../../web/src/builder/system/expr-slots.js");
    buildLinkedModel.mockRejectedValue(new Error("boom"));
    await exprHints(SRC, SLOT);
    await exprHints(SRC, SLOT);
    await exprHints(SRC, SLOT);
    expect(buildLinkedModel).toHaveBeenCalledTimes(3);
  });
});

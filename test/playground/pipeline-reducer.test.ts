import { describe, expect, it } from "vitest";
import { initialPipelineState, pipelineReducer } from "../../web/src/pipeline/reducer.js";

// ---------------------------------------------------------------------------
// Pipeline reducer — invariants the playground UI depends on.
//
// Most stage transitions are covered indirectly by the e2e suite,
// but RUNTIME_LOST is hard to drive there (we'd need a backgrounded
// tab + a browser that actually kills idle workers).  This file
// pins the transition explicitly: a fresh runtime worker should
// drop the booted slot to a labelled failure and clear dispatch,
// while leaving generate + bundle intact (they're main-thread
// state, unaffected by worker death).
// ---------------------------------------------------------------------------

const SAMPLE_BUNDLE = {
  ok: true as const,
  kind: "hono" as const,
  code: "export const x = 1;",
  size: 20,
  durationMs: 5,
  fetchedUrls: [],
  diagnostics: [],
};

const SAMPLE_GENERATE = {
  ok: true as const,
  mode: "ts" as const,
  files: [{ path: "http/index.ts", content: "", size: 0 }],
  diagnostics: [],
};

const SAMPLE_DISPATCH = {
  ok: true as const,
  durationMs: 5,
  response: {
    status: 200,
    statusText: "OK",
    headers: {},
    body: "[]",
  },
};

function bootedState(persistent: boolean) {
  let s = pipelineReducer(initialPipelineState, { type: "GENERATE_START" });
  s = pipelineReducer(s, { type: "GENERATE_DONE", result: SAMPLE_GENERATE });
  s = pipelineReducer(s, { type: "BUNDLE_START" });
  s = pipelineReducer(s, { type: "BUNDLE_DONE", hono: SAMPLE_BUNDLE, react: null });
  s = pipelineReducer(s, { type: "BOOT_START" });
  s = pipelineReducer(s, {
    type: "BOOT_OK",
    ddl: "CREATE TABLE foo();",
    persistent,
    migrated: false,
  });
  s = pipelineReducer(s, { type: "DISPATCH_START" });
  s = pipelineReducer(s, { type: "DISPATCH_DONE", result: SAMPLE_DISPATCH });
  return s;
}

describe("pipelineReducer — RUNTIME_LOST", () => {
  it("flips boot to fail with the persisted-restored message when the prior boot was OPFS-backed", () => {
    // Persistent boot: PGlite's data island lives in OPFS, keyed
    // by source hash (see runtime/runtime.worker.ts).  When the
    // worker respawns, the next Boot reattaches the same island
    // and the rows come back.  The message has to reflect that —
    // misleading the user into thinking their data is gone was
    // the bug this commit corrects.
    const after = pipelineReducer(bootedState(true), { type: "RUNTIME_LOST" });
    expect(after.boot.kind).toBe("fail");
    if (after.boot.kind === "fail") {
      expect(after.boot.message).toMatch(/runtime worker.*terminated/i);
      expect(after.boot.message).toMatch(/persisted in OPFS/i);
      expect(after.boot.message).toMatch(/will be restored/i);
      expect(after.boot.message).toMatch(/click Boot/i);
    }
  });

  it("flips boot to fail with the in-memory-lost message when the prior boot was ephemeral", () => {
    // In-memory boot (Safari private mode, hostile-storage
    // policies — `persistent: false`): the data lived in the dead
    // worker's heap.  Genuinely gone, and the message says so.
    const after = pipelineReducer(bootedState(false), { type: "RUNTIME_LOST" });
    expect(after.boot.kind).toBe("fail");
    if (after.boot.kind === "fail") {
      expect(after.boot.message).toMatch(/in-memory only/i);
      expect(after.boot.message).toMatch(/are gone/i);
      // The persistent-restored phrase MUST NOT appear — that
      // would falsely promise recovery.
      expect(after.boot.message).not.toMatch(/will be restored/i);
    }
  });

  it("clears dispatch (the old worker's reply will never arrive)", () => {
    const after = pipelineReducer(bootedState(true), { type: "RUNTIME_LOST" });
    expect(after.dispatch.kind).toBe("none");
  });

  it("leaves generate + bundle intact (they're main-thread state)", () => {
    const before = bootedState(true);
    const after = pipelineReducer(before, { type: "RUNTIME_LOST" });
    expect(after.generate).toEqual(before.generate);
    expect(after.bundle).toEqual(before.bundle);
  });

  it("does not flip the booting / dispatching flags on its own", () => {
    // RUNTIME_LOST fires on a respawn that's external to any
    // in-flight pipeline call.  If a Boot was somehow mid-flight,
    // its own DONE/FAIL action is the one that flips `booting`
    // back — we don't want RUNTIME_LOST to silently swallow that.
    const after = pipelineReducer(bootedState(true), { type: "RUNTIME_LOST" });
    expect(after.booting).toBe(false);
    expect(after.dispatching).toBe(false);
  });

  it("from a never-booted state, RUNTIME_LOST still produces a labelled fail", () => {
    // Defence in depth: even if some external trigger fires the
    // action on a fresh pipeline, the reducer must produce a
    // consistent state (no `undefined`s, no half-booted slot).
    // No prior `persistent` to read, so the message falls into
    // the in-memory branch (no promise of recovery).
    const after = pipelineReducer(initialPipelineState, { type: "RUNTIME_LOST" });
    expect(after.boot.kind).toBe("fail");
    if (after.boot.kind === "fail") {
      expect(after.boot.message).not.toMatch(/will be restored/i);
    }
  });
});

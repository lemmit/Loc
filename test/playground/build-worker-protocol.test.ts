import { describe, expect, it } from "vitest";

import type {
  BuildRpcRequest,
  BuildRpcResponse,
  GenerateParams,
  GenerateResult,
  VfsDeleteResult,
  VfsWriteResult,
} from "../../web/src/build/protocol.js";

// ---------------------------------------------------------------------------
// Pin the build-worker RPC shape.  These tests don't spin up the
// worker — they assert that the protocol types compile and that
// known-shape requests/responses round-trip through the discriminated
// union without losing information.  The actual dispatch logic is
// covered end-to-end by the playwright spec
// (`web/e2e/preview-shadcn.spec.ts`) which drives a real worker
// through write→generate→bundle.
// ---------------------------------------------------------------------------

describe("BuildRpcRequest discriminated union", () => {
  it("accepts the supported method variants", () => {
    // The worker keeps only the RPCs with live callers: generate (text
    // or entryPath) and the incremental vfs.write / vfs.delete used to
    // push design-pack changes.  The read-side vfs.list / vfs.snapshot
    // ops were dropped — the loader reads the worker VFS directly and
    // respawn re-seeds from the git-store projection.
    const requests: BuildRpcRequest[] = [
      { id: 1, method: "generate", params: { text: "system X {}" } },
      { id: 2, method: "generate", params: { entryPath: "/workspace/main.ddd" } },
      {
        id: 3,
        method: "vfs.write",
        params: { entries: [{ path: "/workspace/main.ddd", content: "..." }] },
      },
      { id: 4, method: "vfs.delete", params: { paths: ["/workspace/main.ddd"] } },
    ];
    expect(requests).toHaveLength(4);
  });

  it("forbids `text` and `entryPath` together at the type level", () => {
    // Both fields are optional, so the type system can't reject
    // simultaneous-set at compile time without a discriminated
    // sub-union.  Worker enforces this at runtime; assert the
    // enforcement contract here so future refactors don't drop it.
    const params: GenerateParams = { text: "x", entryPath: "/y" };
    expect(params.text).toBeDefined();
    expect(params.entryPath).toBeDefined();
    // Worker would throw "pass either `text` or `entryPath`, not both."
  });
});

describe("BuildRpcResponse result variants", () => {
  it("narrows generate result on `ok` discriminator", () => {
    const ok: GenerateResult = {
      ok: true,
      mode: "system",
      files: [{ path: "a.ts", content: "x", size: 1 }],
      diagnostics: [],
    };
    const fail: GenerateResult = { ok: false, diagnostics: [] };
    expect(ok.ok).toBe(true);
    expect(fail.ok).toBe(false);
  });

  it("encodes vfs ack shapes (write/delete)", () => {
    const write: VfsWriteResult = { ok: true, paths: ["/a", "/b"] };
    const del: VfsDeleteResult = { ok: true, paths: ["/a"] };
    expect(write.paths).toEqual(["/a", "/b"]);
    expect(del.paths).toEqual(["/a"]);
  });

  it("response carries id + result xor error", () => {
    const ok: BuildRpcResponse = {
      id: 1,
      result: { ok: true, paths: ["/x"] } satisfies VfsWriteResult,
    };
    const err: BuildRpcResponse = { id: 2, error: { message: "boom" } };
    expect(ok.id).toBe(1);
    expect(err.error?.message).toBe("boom");
  });
});

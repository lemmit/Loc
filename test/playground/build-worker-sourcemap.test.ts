// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { generateSystems } from "../../src/system/index.js";
import { parseString } from "../_helpers/index.js";

// ---------------------------------------------------------------------------
// Playground DevTools `.ddd` debugging — headless gate (see
// docs/debugging.md §2 "In the browser playground").
//
// Two things are pinned here, mirroring the two ends the build changed:
//
//   End A — `web/src/build/build.worker.ts` threads an opt-in `sourcemap`
//   request field through to `generateSystems`/`generateSystemsFromLoom`,
//   ALONGSIDE a `sourceTexts` map (keyed by `doc.uri.path`, exactly like the
//   CLI's `src/cli/main.ts`) — without `sourceTexts` the sidecars are
//   skipped entirely (see `src/system/index.ts`), so this test reproduces
//   that derivation rather than trusting `{sourcemap:true}` alone.  The
//   actual worker dispatch can't run headlessly (no browser Worker host),
//   so this exercises the identical parse→sourceTexts→generateSystems path
//   the worker's `parse()` + `generateFromAst` now run — the real proof
//   that the chain the worker wires produces `.ddd`-chained sidecars.
//
//   client.ts / vfs-bundler-client.ts — the RPC-shape threading (request →
//   worker message) is asserted directly against a fake Worker, the same
//   pattern `build-client-respawn.test.ts` already uses.
//
// The esbuild-wasm composition itself (bundle's own map chaining through
// the `.ts.map` sidecars to `.ddd`) was proven by hand per the build brief
// and is not re-asserted here — wasm-worker composition isn't a sane unit
// test target.
// ---------------------------------------------------------------------------

const ACME_DDD = path.resolve(__dirname, "../../web/src/examples/acme.ddd");

describe("generateSystems sourcemap sidecars (playground fixture)", () => {
  it("emits .ts.map sidecars chaining to .ddd, with the sourceMappingURL comment, when sourcemap is on", async () => {
    const source = readFileSync(ACME_DDD, "utf-8");
    const { model, doc, errors } = await parseString(source, { validate: true });
    expect(errors).toEqual([]);
    // Keyed by `doc.uri.path` — parseHelper mints an incrementing synthetic
    // URI (`/1.ddd`, `/2.ddd`, …) per test file run, so never hardcode it;
    // read it back off the doc the same way build.worker.ts's `parse()` and
    // the CLI's `parseFile` do.
    const sourceTexts = new Map([[doc.uri.path, source]]);

    const withFlag = generateSystems(model, { sourcemap: true, sourceTexts }).files;

    const mapEntries = [...withFlag.entries()].filter(
      ([path]) => path.endsWith(".ts.map") && path.includes("/domain/"),
    );
    expect(mapEntries.length).toBeGreaterThan(0);

    for (const [mapPath, mapContent] of mapEntries) {
      const v3 = JSON.parse(mapContent) as {
        sources: string[];
        sourcesContent?: string[];
      };
      expect(v3.sources.some((s) => s.endsWith(".ddd"))).toBe(true);
      expect(v3.sourcesContent).toBeDefined();
      expect(v3.sourcesContent!.length).toBeGreaterThan(0);
      expect(v3.sourcesContent!.some((c) => c && c.length > 0)).toBe(true);

      const tsPath = mapPath.slice(0, -".map".length);
      const tsContent = withFlag.get(tsPath);
      expect(tsContent).toBeDefined();
      const basename = mapPath.split("/").pop()!;
      expect(tsContent).toContain(`//# sourceMappingURL=${basename}`);
    }
  });

  it("emits NO .ts.map / .loom/sourcemap.json when sourcemap is off (default)", async () => {
    const source = readFileSync(ACME_DDD, "utf-8");
    const { model, errors } = await parseString(source, { validate: true });
    expect(errors).toEqual([]);

    const withoutFlag = generateSystems(model).files;

    expect([...withoutFlag.keys()].some((p) => p.endsWith(".ts.map"))).toBe(false);
    expect(withoutFlag.has(".loom/sourcemap.json")).toBe(false);
    for (const content of withoutFlag.values()) {
      expect(content).not.toContain("//# sourceMappingURL=");
    }
  });
});

// ---------------------------------------------------------------------------
// Request-shape threading — a fake `Worker` global, same pattern as
// `build-client-respawn.test.ts`.  These pin that the opt-in flag actually
// reaches the posted message; they don't spin up a real worker.
// ---------------------------------------------------------------------------

interface MessageRecord {
  message: unknown;
}

class FakeWorker {
  static all: FakeWorker[] = [];
  static messages: MessageRecord[] = [];
  static reset(): void {
    FakeWorker.all = [];
    FakeWorker.messages = [];
  }

  onmessage: ((ev: MessageEvent) => void) | null = null;

  constructor(_url: URL | string, _opts?: WorkerOptions) {
    FakeWorker.all.push(this);
  }

  postMessage(message: unknown): void {
    FakeWorker.messages.push({ message });
  }

  terminate(): void {
    /* not exercised here */
  }
  addEventListener(): void {
    /* not used */
  }
  removeEventListener(): void {
    /* not used */
  }
  dispatchEvent(): boolean {
    return true;
  }
}

beforeEach(() => {
  FakeWorker.reset();
  (globalThis as unknown as { Worker: unknown }).Worker = FakeWorker;
});

afterEach(() => {
  delete (globalThis as unknown as { Worker?: unknown }).Worker;
});

describe("LoomBuildClient — sourcemap request threading", () => {
  it("omits `sourcemap` from the posted params when the caller doesn't opt in", async () => {
    const { LoomBuildClient } = await import("../../web/src/build/client.js");
    const client = new LoomBuildClient();
    void client.generateFromPath("/workspace/main.ddd");
    const msg = FakeWorker.messages.at(-1)!.message as {
      method: string;
      params: { entryPath: string; sourcemap?: boolean };
    };
    expect(msg.method).toBe("generate");
    expect(msg.params.entryPath).toBe("/workspace/main.ddd");
    expect(msg.params.sourcemap).toBeUndefined();
  });

  it("threads `sourcemap: true` through generateFromPath into the posted params", async () => {
    const { LoomBuildClient } = await import("../../web/src/build/client.js");
    const client = new LoomBuildClient();
    void client.generateFromPath("/workspace/main.ddd", { sourcemap: true });
    const msg = FakeWorker.messages.at(-1)!.message as {
      params: { sourcemap?: boolean };
    };
    expect(msg.params.sourcemap).toBe(true);
  });

  it("threads `sourcemap: true` through the legacy text-based generate too", async () => {
    const { LoomBuildClient } = await import("../../web/src/build/client.js");
    const client = new LoomBuildClient();
    void client.generate("system X {}", { sourcemap: true });
    const msg = FakeWorker.messages.at(-1)!.message as {
      params: { sourcemap?: boolean };
    };
    expect(msg.params.sourcemap).toBe(true);
  });
});

describe("VfsBundlerClient — sourcemap request threading (End B)", () => {
  it("forwards EsbuildRunInput.sourcemap onto the posted VfsBundleRequest", async () => {
    const { VfsBundlerClient } = await import("../../web/src/engine/npm/vfs-bundler-client.js");
    const client = new VfsBundlerClient();
    void client.run({
      generatedFiles: new Map(),
      rootDeps: {},
      stdinContents: "export default 1;",
      sourcemap: true,
    });
    const msg = FakeWorker.messages.at(-1)!.message as { sourcemap?: boolean };
    expect(msg.sourcemap).toBe(true);
  });

  it("leaves `sourcemap` undefined on the posted request when the caller doesn't set it", async () => {
    const { VfsBundlerClient } = await import("../../web/src/engine/npm/vfs-bundler-client.js");
    const client = new VfsBundlerClient();
    void client.run({
      generatedFiles: new Map(),
      rootDeps: {},
      stdinContents: "export default 1;",
    });
    const msg = FakeWorker.messages.at(-1)!.message as { sourcemap?: boolean };
    expect(msg.sourcemap).toBeUndefined();
  });
});

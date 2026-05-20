// Unit tests for the playground's in-browser API test runner core
// (web/src/testing/*).  Covers the harness, the dispatch-backed fetch,
// and the orchestrator — exercising the exact shapes the Loom system
// generator emits (`describe`/`it`, `expect(x).toBe(true)`,
// `expect(async () => …).rejects.toThrow()`, `__post`/`__get` helpers,
// `process.env` fallbacks, the `vitest` import that must be stripped).
//
// Browser-only seams (esbuild-wasm transpile, the reporter UI) are not
// exercised here; `compile` is injected as a passthrough.

import { describe, it, expect } from "vitest";
import {
  createHarness,
  runTests,
} from "../web/src/testing/harness.js";
import { makeDispatchFetch } from "../web/src/testing/fetch-dispatch.js";
import { runApiTests, findApiTestFile } from "../web/src/testing/run-api-tests.js";
import type {
  DispatchResult,
  SerializedRequest,
} from "../web/src/runtime/protocol.js";

// A tiny in-memory backend standing in for the booted runtime worker.
function fakeBackend(): (req: SerializedRequest) => Promise<DispatchResult> {
  const store = new Map<string, Record<string, unknown>>();
  let seq = 0;
  const ok = (status: number, json: unknown): DispatchResult => ({
    ok: true,
    durationMs: 0,
    response: {
      status,
      statusText: status === 201 ? "Created" : "OK",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(json),
    },
  });
  const notFound = (): DispatchResult => ({
    ok: true,
    durationMs: 0,
    response: {
      status: 404,
      statusText: "Not Found",
      headers: { "content-type": "text/plain" },
      body: "not found",
    },
  });
  return async (req) => {
    const path = new URL(req.url).pathname;
    if (req.method === "POST" && path === "/products") {
      const id = `p${++seq}`;
      const rec = { id, ...(JSON.parse(req.body ?? "{}") as object) };
      store.set(id, rec);
      return ok(201, rec);
    }
    const m = /^\/products\/(.+)$/.exec(path);
    if (req.method === "GET" && m) {
      const rec = store.get(m[1]);
      return rec ? ok(200, rec) : notFound();
    }
    return notFound();
  };
}

describe("harness", () => {
  it("expect(x).toBe(true) passes for true, fails otherwise", async () => {
    const h = createHarness();
    h.it("ok", () => h.expect(1 === 1).toBe(true));
    h.it("bad", () => h.expect(1 === 2).toBe(true));
    const results = await runTests(h.tests);
    expect(results.map((r) => r.status)).toEqual(["pass", "fail"]);
    expect(results[1].error).toMatch(/to be true/);
  });

  it("describe threads the suite name onto its tests", async () => {
    const h = createHarness();
    h.describe("Group", () => {
      h.it("a", () => {});
    });
    const results = await runTests(h.tests);
    expect(results[0].suite).toBe("Group");
  });

  it("rejects.toThrow passes when the call rejects, fails when it resolves", async () => {
    const h = createHarness();
    h.it("throws", async () =>
      h.expect(async () => {
        throw new Error("boom");
      }).rejects.toThrow(),
    );
    h.it("resolves", async () =>
      h.expect(async () => 42).rejects.toThrow(),
    );
    const results = await runTests(h.tests);
    expect(results.map((r) => r.status)).toEqual(["pass", "fail"]);
  });
});

describe("makeDispatchFetch", () => {
  it("reconstructs a real Response from the dispatch result", async () => {
    const fetchImpl = makeDispatchFetch(fakeBackend());
    const res = await fetchImpl("http://localhost:8080/products", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sku: "X" }),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { id: string; sku: string };
    expect(json.sku).toBe("X");
  });

  it("throws on a dispatch failure (network-level error)", async () => {
    const fetchImpl = makeDispatchFetch(async () => ({
      ok: false,
      message: "boom",
    }));
    await expect(fetchImpl("http://localhost/x")).rejects.toThrow(/boom/);
  });
});

describe("findApiTestFile", () => {
  it("picks the generated e2e suite out of the file tree", () => {
    const f = findApiTestFile([
      { path: "web_app/src/main.tsx", content: "", size: 0 },
      { path: "e2e/Acme.e2e.test.ts", content: "x", size: 1 },
      { path: "e2e/package.json", content: "{}", size: 2 },
    ]);
    expect(f?.path).toBe("e2e/Acme.e2e.test.ts");
  });
});

describe("runApiTests end-to-end (passthrough compile)", () => {
  // Mirrors the generator's emitted shape: vitest import (must be
  // stripped or `new Function` would SyntaxError), process.env
  // fallback, __post/__get helpers using injected `fetch`.
  const SUITE = `
import { describe, it, expect } from "vitest";
const ENDPOINTS = { api: process.env.E2E_API_BASE ?? "http://localhost:8080" };
async function __post(url, body) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
  const text = await r.text();
  const json = text ? JSON.parse(text) : {};
  if (!r.ok) throw new Error("POST " + url + " -> " + r.status);
  return json;
}
async function __get(url) {
  const r = await fetch(url);
  const text = await r.text();
  const json = text ? JSON.parse(text) : {};
  if (!r.ok) throw new Error("GET " + url + " -> " + r.status);
  return json;
}
describe("Demo e2e", () => {
  it("create + read", async () => {
    const base = ENDPOINTS["api"];
    const p = await __post(\`\${base}/products\`, { sku: "WIDGET-1" });
    const read = await __get(\`\${base}/products/\${p.id}\`);
    expect(read.sku === "WIDGET-1").toBe(true);
  });
  it("read of a missing product rejects", async () => {
    const base = ENDPOINTS["api"];
    await expect(async () => { await __get(\`\${base}/products/nope\`); }).rejects.toThrow();
  });
  it("a deliberately failing assertion", async () => {
    expect(false).toBe(true);
  });
});
`;

  it("runs the suite against the fake backend and reports per-test status", async () => {
    const results = await runApiTests({
      source: SUITE,
      compile: async (s) => s, // passthrough — SUITE is already valid JS
      dispatch: fakeBackend(),
    });
    expect(results.map((r) => `${r.name}:${r.status}`)).toEqual([
      "create + read:pass",
      "read of a missing product rejects:pass",
      "a deliberately failing assertion:fail",
    ]);
    expect(results.every((r) => r.suite === "Demo e2e")).toBe(true);
  });
});

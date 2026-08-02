import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import snapshot from "../../web/scripts/worker-globals.json" with { type: "json" };
// @ts-expect-error — plain .mjs helper, no types; exercised for behaviour only.
import { createWorkerRealm, WORKER_INSTALLED_GLOBALS } from "../../web/scripts/worker-realm.mjs";

// ---------------------------------------------------------------------------
// Guards on the worker-realm model behind `npm run e2e:realm` (web/).
//
// That gate evaluates the generated bundle against the globals a real worker
// has, to catch the class of bug where a dependency reads a Node global while
// its module body evaluates — which kills `await import(blobUrl)` outright and
// which the Node-side smoke cannot see (it has a real `process` and `Buffer`).
//
// The gate is only as good as its model of the realm, and a model can fail in
// two directions:
//   - TOO PERMISSIVE — a global present here but absent in a real worker means
//     the gate accepts bundles the browser will reject.  Silent; the dangerous
//     direction, and what these tests mainly defend.
//   - TOO STRICT — a global absent here but present in a real worker means
//     false rejections.  Loud, so it needs no test.
// ---------------------------------------------------------------------------

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../../web/src/${rel}`, import.meta.url)), "utf8");

describe("worker-globals snapshot", () => {
  it("is a real measurement, not a hand-written list", () => {
    expect(snapshot.chromium).toMatch(/^\d+\./);
    expect(snapshot._comment).toMatch(/MEASURED/);
    expect(snapshot.names).toHaveLength(snapshot.count);
  });

  it("excludes every Node-only global — this is what the gate enforces", () => {
    for (const name of [
      "process",
      "Buffer",
      "setImmediate",
      "clearImmediate",
      "require",
      "module",
      "__dirname",
      "__filename",
      "global",
    ]) {
      expect(snapshot.names, name).not.toContain(name);
    }
  });

  // Regression: the first measurement used `getOwnPropertyNames(globalThis)`
  // alone, which misses everything on WorkerGlobalScope.prototype — the realm
  // came out with no `performance`/`fetch`/`crypto` and rejected a correct
  // bundle.  These are the prototype-chain names; their presence proves the
  // measurement still walks it.
  it("includes the worker API surface that lives on the prototype chain", () => {
    for (const name of [
      "performance",
      "fetch",
      "location",
      "navigator",
      "crypto",
      "indexedDB",
      "caches",
      "WebAssembly",
    ]) {
      expect(snapshot.names, name).toContain(name);
    }
  });
});

describe("worker-installed globals", () => {
  // The realm the bundle actually gets is the browser's PLUS whatever the
  // worker installs for itself before `await import(...)`.  If the worker
  // grows another polyfill and the model doesn't, the gate silently runs
  // against a realm that no longer matches the thing it claims to model.
  it("models every side-effect polyfill the runtime worker imports", () => {
    const src = read("runtime/runtime.worker.ts");
    const sideEffectImports = [...src.matchAll(/^import\s+["']([^"']+)["'];/gm)].map((m) => m[1]);
    const polyfills = sideEffectImports.filter((s) => s.includes("polyfill"));
    expect(polyfills).toEqual(["../buffer-polyfill"]);
    // …and that one is modelled.
    expect(Object.keys(WORKER_INSTALLED_GLOBALS)).toEqual(["Buffer"]);
  });

  it("installs the SAME implementation the polyfill does", () => {
    // Reusing the `buffer` package (rather than re-implementing) is what
    // keeps model and reality from diverging.
    expect(read("buffer-polyfill.ts")).toMatch(/from "buffer"/);
    expect(WORKER_INSTALLED_GLOBALS.Buffer).toBe(Buffer);
  });
});

describe("createWorkerRealm", () => {
  it("withholds the Node globals and provides the worker ones", () => {
    const ctx = createWorkerRealm();
    const typeOf = (expr: string): string => vm.runInContext(`typeof ${expr}`, ctx);
    expect(typeOf("process")).toBe("undefined");
    expect(typeOf("require")).toBe("undefined");
    expect(typeOf("setImmediate")).toBe("undefined");
    // Present: browser-measured, and worker-installed respectively.
    expect(typeOf("performance")).toBe("object");
    expect(typeOf("Buffer")).toBe("function");
    // A worker's `self` is its own global scope.
    expect(typeOf("self")).toBe("object");
  });
});

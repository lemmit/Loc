// Out-of-tree sourceType plugin loader (RFC §8 / Phase 3 follow-up).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverSourceTypePlugins } from "../../src/platform/source-type-plugins.js";
import {
  capabilitiesFor,
  configSchemaFor,
  registeredSourceTypes,
  sourceTypeFor,
  supportsSurfaceKind,
  unregisterSourceType,
} from "../../src/util/source-types.js";

let dir: string;
// The sourceType registry is module-global and this file registers real
// plugins into it.  Under `isolate: false` (vitest.config.ts) one module graph
// is shared by every file in a worker, so a leaked registration reaches
// whichever later file asserts the registry's exact contents — an
// order-dependent failure that only surfaces when the two land in one shard.
let preexisting: string[];

function writePkg(name: string, pkg: unknown): void {
  const root = path.join(dir, name);
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, "package.json"), JSON.stringify(pkg), "utf8");
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "loom-stplugins-"));
  preexisting = registeredSourceTypes();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const name of registeredSourceTypes()) {
    if (!preexisting.includes(name)) unregisterSourceType(name);
  }
  // Proves the restore above actually happened: without it this file leaves
  // `clickhouseCloud` behind for every later file in the worker.
  expect(registeredSourceTypes()).toEqual(preexisting);
});

describe("sourceType plugin discovery", () => {
  it("registers a declarative sourceType descriptor into the registry", () => {
    writePkg("clickhouse-cloud", {
      name: "@acme/clickhouse-cloud",
      loom: {
        kind: "sourceType",
        sourceType: {
          name: "clickhouseCloud",
          supports: { database: { capabilities: ["query", "state"], interfaces: ["sql"] } },
          configKeys: [{ name: "endpoint", type: "string", required: true }],
        },
      },
    });

    const registered = discoverSourceTypePlugins(dir);
    expect(registered).toContain("clickhouseCloud");

    // Resolves through every registry lookup just like a built-in.
    expect(sourceTypeFor("clickhouseCloud")).toBeDefined();
    expect(supportsSurfaceKind("clickhouseCloud", "state")).toBe(true);
    expect([...capabilitiesFor("clickhouseCloud", "state")]).toEqual(
      expect.arrayContaining(["query", "state"]),
    );
    expect(configSchemaFor("clickhouseCloud")).toEqual([
      { name: "endpoint", type: "string", required: true },
    ]);
  });

  it("skips backend packages and malformed manifests", () => {
    writePkg("a-backend", { name: "b", loom: { kind: "backend", family: "node" } });
    writePkg("not-loom", { name: "n" });
    writePkg("bad-iface", {
      name: "x",
      loom: {
        kind: "sourceType",
        sourceType: {
          name: "bad",
          supports: { database: { capabilities: [], interfaces: ["nope"] } },
        },
      },
    });
    expect(discoverSourceTypePlugins(dir)).toEqual([]);
    expect(sourceTypeFor("bad")).toBeUndefined();
  });

  it("returns [] when the packages dir does not exist", () => {
    expect(discoverSourceTypePlugins(path.join(dir, "missing"))).toEqual([]);
  });
});

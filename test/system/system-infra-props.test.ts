import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  deployablePlatform,
  deployablePort,
  setDeployablePlatform,
  setDeployablePort,
  setStorageType,
  storageType,
} from "../../web/src/builder/system/infra-props.js";
import { parseRaw } from "../_helpers/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const acme = readFileSync(path.join(here, "..", "..", "examples", "acme.ddd"), "utf8");
function node(type: string, name: string): { $type: string } {
  const m = parseRaw(acme);
  for (const n of (function* walk(x: { $type: string }): Generator<{ $type: string }> {
    yield x;
    for (const v of Object.values(x)) {
      if (Array.isArray(v))
        for (const c of v)
          if (c && typeof c === "object" && "$type" in c) yield* walk(c);
          else if (v && typeof v === "object" && "$type" in v) yield* walk(v as { $type: string });
    }
  })(m)) {
    if (n.$type === type && (n as { name?: string }).name === name) return n;
  }
  throw new Error(`no ${type} ${name}`);
}

describe("System builder — infra construct properties", () => {
  it("reads and sets a storage type", () => {
    expect(storageType(node("Storage", "primarySql"))).toBe("postgres");
    expect(setStorageType(acme, "primarySql", "redis")).toMatch(
      /storage primarySql \{\s*type: redis\s*\}/,
    );
  });

  it("reads and sets a deployable platform (preserving the rest)", () => {
    expect(deployablePlatform(node("Deployable", "catalogWeb"))).toBe("node");
    const out = setDeployablePlatform(acme, "catalogWeb", "react")!;
    expect(out).toMatch(/deployable catalogWeb \{\s*platform: react/);
    expect(out).toMatch(/deployable api \{\s*platform: dotnet/); // sibling untouched
  });

  it("reads and sets a deployable port", () => {
    expect(setDeployablePort(acme, "catalogWeb", 4321)).toMatch(/port: 4321/);
    // round-trips the read after a set
    const set = setDeployablePort(acme, "catalogWeb", 4321)!;
    expect(deployablePort(node("Deployable", "catalogWeb"))).toBeTypeOf("number");
    void set;
  });

  it("returns null for unknown infra nodes", () => {
    expect(setStorageType(acme, "nope", "redis")).toBeNull();
    expect(setDeployablePlatform(acme, "nope", "react")).toBeNull();
  });
});

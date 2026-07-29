// Lossless-edit gate for the infra scalar-property mutators (storage `type`,
// deployable `platform`/`port`).  Sibling of `lossless-edits.test.ts`: these
// mutators used to reprint the whole `storage { … }` / `deployable { … }`
// through `printStructural` (no comment handling), so every comment inside
// the construct was deleted on any scalar edit.  Assertions go through
// `lineDiff` (the builder's own hunk differ) to pin exactly which line(s)
// changed.

import { describe, expect, it } from "vitest";
import { lineDiff } from "../../../web/src/builder/edit-engine.js";
import {
  deployablePlatform,
  deployablePort,
  setDeployablePlatform,
  setDeployablePort,
  setStorageType,
  storageType,
} from "../../../web/src/builder/system/infra-props.js";
import { parseRaw as parse } from "../../_helpers/index.js";

// Deliberately littered with comments inside every construct the mutators
// touch, plus one deployable with no `port:` clause (to exercise insert) and
// one with a `port:` clause (to exercise rewrite/drop).
const SRC = `system Shop {

  context Sales {
    aggregate Order {
      total: decimal = 0
    }
  }

  storage primarySql {
    // primary transactional store
    type: postgres
  }

  // Main backend — hosts Sales, dev port pinned.
  deployable api {
    // node runtime
    platform: node
    contexts: [Sales]
    // default dev port
    port: 8080
  }

  // Static frontend — no port configured yet.
  deployable web {
    // targets the api deployable above
    platform: static
    targets: api
  }
}`;

const COMMENTS = [
  "// primary transactional store",
  "// Main backend — hosts Sales, dev port pinned.",
  "// node runtime",
  "// default dev port",
  "// Static frontend — no port configured yet.",
  "// targets the api deployable above",
];

const expectCommentsIntact = (out: string | null): void => {
  expect(out).not.toBeNull();
  for (const c of COMMENTS) expect(out).toContain(c);
};

/** Assert the edit is exactly this hunk — nothing else in the file moved. */
const expectHunk = (
  before: string,
  after: string | null,
  removed: string[],
  added: string[],
): void => {
  expect(after).not.toBeNull();
  const hunk = lineDiff(before, after as string);
  expect({ removed: hunk.removed, added: hunk.added }).toEqual({ removed, added });
};

// A source the parser rejects — every mutator must refuse it rather than
// splice at offsets the error-recovery parser invented.
const BROKEN = SRC.replace("aggregate Order {", "aggregate Order {{");

function* walk(x: { $type: string }): Generator<{ $type: string }> {
  yield x;
  for (const v of Object.values(x)) {
    if (Array.isArray(v))
      for (const c of v)
        if (c && typeof c === "object" && "$type" in c) yield* walk(c);
        else if (v && typeof v === "object" && "$type" in v) yield* walk(v as { $type: string });
  }
}

function nodeIn(source: string, type: string, name: string): { $type: string } {
  for (const n of walk(parse(source))) {
    if (n.$type === type && (n as { name?: string }).name === name) return n;
  }
  throw new Error(`no ${type} ${name} in source`);
}
const node = (type: string, name: string): { $type: string } => nodeIn(SRC, type, name);

describe("builder lossless edits — infra scalar props", () => {
  it("setStorageType rewrites only the type value", () => {
    const out = setStorageType(SRC, "primarySql", "redis");
    expectHunk(SRC, out, ["    type: postgres"], ["    type: redis"]);
    expectCommentsIntact(out);
  });

  it("setDeployablePlatform rewrites only the platform value, sibling untouched", () => {
    const out = setDeployablePlatform(SRC, "api", "dotnet");
    expectHunk(SRC, out, ["    platform: node"], ["    platform: dotnet"]);
    expectCommentsIntact(out);
    // The sibling deployable's own platform clause is a distinct line —
    // asserting the hunk above already proves it wasn't touched.
    expect(out).toContain("platform: static");
  });

  it("setDeployablePort rewrites an existing port value", () => {
    const out = setDeployablePort(SRC, "api", 4321);
    expectHunk(SRC, out, ["    port: 8080"], ["    port: 4321"]);
    expectCommentsIntact(out);
  });

  it("setDeployablePort inserts a missing port clause", () => {
    const out = setDeployablePort(SRC, "web", 3001);
    expectHunk(SRC, out, [], ["    port: 3001"]);
    expectCommentsIntact(out);
  });

  it("setDeployablePort(undefined) drops an existing port clause", () => {
    const out = setDeployablePort(SRC, "api", undefined);
    expectHunk(SRC, out, ["    port: 8080"], []);
    expectCommentsIntact(out);
  });

  it("setDeployablePort(undefined) is a no-op when there is no port clause", () => {
    expect(setDeployablePort(SRC, "web", undefined)).toBe(SRC);
  });

  it("round-trips read after set", () => {
    expect(deployablePort(node("Deployable", "web"))).toBeUndefined();
    const out = setDeployablePort(SRC, "web", 3001) as string;
    expect(deployablePort(nodeIn(out, "Deployable", "web"))).toBe(3001);
  });

  it("reads storage type / deployable platform", () => {
    expect(storageType(node("Storage", "primarySql"))).toBe("postgres");
    expect(deployablePlatform(node("Deployable", "api"))).toBe("node");
  });

  it("returns null on a source with parser errors", () => {
    expect(setStorageType(BROKEN, "primarySql", "redis")).toBeNull();
    expect(setDeployablePlatform(BROKEN, "api", "dotnet")).toBeNull();
    expect(setDeployablePort(BROKEN, "api", 1)).toBeNull();
  });

  it("returns null for an unknown storage / deployable name", () => {
    expect(setStorageType(SRC, "nope", "redis")).toBeNull();
    expect(setDeployablePlatform(SRC, "nope", "dotnet")).toBeNull();
    expect(setDeployablePort(SRC, "nope", 1)).toBeNull();
  });

  it("returns null when the resulting source would not parse (re-parse guard)", () => {
    // `bogus` is not a StorageType keyword — the grammar has no STRING
    // fallback for it (unlike Platform), so this can never parse.
    expect(setStorageType(SRC, "primarySql", "bogus")).toBeNull();
    // Same for an unquoted, unrecognised platform bareword.
    expect(setDeployablePlatform(SRC, "api", "bogus nonsense")).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { escapesOutDir } from "../../src/cli/output-containment.js";

// C13 — the CLI write loop rejects generated keys that would resolve outside
// the out dir, so a generator (in particular an untrusted, out-of-tree
// backend / design pack) cannot write anywhere on disk.
describe("escapesOutDir — CLI output-path containment", () => {
  const out = "/tmp/loom-out";

  it("accepts ordinary nested keys", () => {
    expect(escapesOutDir(out, "src/index.ts")).toBe(false);
    expect(escapesOutDir(out, "a/b/c/deep.txt")).toBe(false);
    expect(escapesOutDir(out, "LICENSE")).toBe(false);
    expect(escapesOutDir(out, ".loom/wire-spec.json")).toBe(false);
  });

  it("rejects a `..` climb out of the out dir", () => {
    expect(escapesOutDir(out, "../evil.ts")).toBe(true);
    expect(escapesOutDir(out, "a/../../evil.ts")).toBe(true);
    expect(escapesOutDir(out, "../../etc/cron.d/pwn")).toBe(true);
  });

  it("rejects an absolute key", () => {
    expect(escapesOutDir(out, "/etc/passwd")).toBe(true);
    expect(escapesOutDir(out, "/tmp/loom-out-sibling/x")).toBe(true);
  });

  it("rejects a key that resolves to the out dir itself", () => {
    expect(escapesOutDir(out, "")).toBe(true);
    expect(escapesOutDir(out, ".")).toBe(true);
    expect(escapesOutDir(out, "sub/..")).toBe(true);
  });

  it("keeps an inner `..` that stays inside contained", () => {
    // `a/b/../c` normalises to `a/c` — still inside the tree.
    expect(escapesOutDir(out, "a/b/../c.ts")).toBe(false);
  });
});

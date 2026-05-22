import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { routerPackageForStack } from "../../src/generator/_packs/stack-runtime.js";

// ---------------------------------------------------------------------------
// React Router 7 (stack v3) renamed its npm package
// `react-router-dom` → `react-router`.  Library mode keeps the v6
// API, so the only emitted-source change is the import specifier.
// `routerPackageForStack` is the single source of truth both
// emission paths read — pack shell templates (`main.hbs` /
// `app-shell.hbs` via the `{{routerPackage}}` Handlebars var) and
// the page body-walker.  This pins the contract + the default so
// pre-v3 packs stay byte-identical.
// ---------------------------------------------------------------------------

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("routerPackageForStack", () => {
  it("maps stack v3 → react-router (Router 7 package rename)", () => {
    expect(routerPackageForStack("v3")).toBe("react-router");
  });

  it("keeps pre-v3 stacks on react-router-dom (Router 6)", () => {
    expect(routerPackageForStack("v1")).toBe("react-router-dom");
    expect(routerPackageForStack("v2")).toBe("react-router-dom");
  });

  it("defaults to react-router-dom for custom packs with no stack", () => {
    expect(routerPackageForStack(undefined)).toBe("react-router-dom");
    expect(routerPackageForStack("anything-else")).toBe("react-router-dom");
  });
});

describe("stacks/v3 partials", () => {
  const v3 = path.join(repoRoot, "stacks", "v3");

  it("ships the React 19 + Router 7 + Zod 4 dependency set", () => {
    const deps = fs.readFileSync(path.join(v3, "stack-package-deps.hbs"), "utf-8");
    // Router 7: the renamed package, NOT react-router-dom.
    expect(deps).toMatch(/"react-router":\s*"\^7\./);
    expect(deps).not.toContain("react-router-dom");
    // Zod 4 + the zod-4-compatible resolvers major.
    expect(deps).toMatch(/"zod":\s*"\^4\./);
    expect(deps).toMatch(/"@hookform\/resolvers":\s*"\^5\./);
    // Same React 19 baseline as v2.
    expect(deps).toMatch(/"react":\s*"\^19\./);
  });

  it("has no trailing newline (spliced as a package.json partial)", () => {
    const deps = fs.readFileSync(path.join(v3, "stack-package-deps.hbs"), "utf-8");
    expect(deps.endsWith("\n")).toBe(false);
  });

  it("declares stack id v3 in stack.json", () => {
    const meta = JSON.parse(fs.readFileSync(path.join(v3, "stack.json"), "utf-8"));
    expect(meta.id).toBe("v3");
  });
});

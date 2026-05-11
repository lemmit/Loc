import { describe, it, expect } from "vitest";
import {
  applyTsconfigAlias,
  harvestTsconfigPaths,
} from "../web/src/bundle/plugin.js";

// ---------------------------------------------------------------------------
// `harvestTsconfigPaths` + `applyTsconfigAlias` — the bundler's path-
// alias resolver.  Regression for the shadcn-pack bundling failure
// where `@/components/ui/button` was treated as a bare package and
// shipped off to esm.sh as "package not declared".
// ---------------------------------------------------------------------------

function makeShadcnLikeFs(): Map<string, string> {
  // Shape mirrors what the React generator emits for a system-mode
  // deployable named `webApp` (slug `web_app`).  Only the files the
  // resolver needs are included.
  const fs = new Map<string, string>();
  fs.set(
    "web_app/tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        baseUrl: ".",
        paths: { "@/*": ["./src/*"] },
      },
    }),
  );
  fs.set("web_app/src/main.tsx", "");
  fs.set("web_app/src/components/ui/button.tsx", "");
  fs.set("web_app/src/components/ui/alert.tsx", "");
  fs.set("web_app/src/lib/utils.ts", "");
  return fs;
}

describe("harvestTsconfigPaths", () => {
  it("reads paths from the entry's nearest tsconfig", () => {
    const fs = makeShadcnLikeFs();
    const entries = harvestTsconfigPaths(fs, "web_app/src/main.tsx");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      prefix: "@/",
      wildcard: true,
      targets: ["web_app/src/*"],
    });
  });

  it("returns an empty list when no tsconfig is anywhere upstream", () => {
    const fs = new Map<string, string>([["http/index.ts", ""]]);
    expect(harvestTsconfigPaths(fs, "http/index.ts")).toEqual([]);
  });

  it("tolerates // line comments in the tsconfig", () => {
    const fs = new Map<string, string>([
      [
        "web_app/tsconfig.json",
        [
          "// header banner",
          "{",
          `  "compilerOptions": {`,
          `    "paths": { "@/*": ["./src/*"] } // trailing`,
          "  }",
          "}",
        ].join("\n"),
      ],
      ["web_app/src/main.tsx", ""],
    ]);
    const entries = harvestTsconfigPaths(fs, "web_app/src/main.tsx");
    expect(entries).toHaveLength(1);
    expect(entries[0].prefix).toBe("@/");
  });

  it("walks upward through multiple directories to find tsconfig", () => {
    const fs = new Map<string, string>([
      [
        "system/web_app/tsconfig.json",
        JSON.stringify({
          compilerOptions: { paths: { "@/*": ["./src/*"] } },
        }),
      ],
      ["system/web_app/src/pages/Home.tsx", ""],
    ]);
    const entries = harvestTsconfigPaths(fs, "system/web_app/src/pages/Home.tsx");
    expect(entries[0].targets).toEqual(["system/web_app/src/*"]);
  });

  it("orders aliases longest-prefix first (more specific wins)", () => {
    const fs = new Map<string, string>([
      [
        "tsconfig.json",
        JSON.stringify({
          compilerOptions: {
            paths: {
              "@/*": ["./src/*"],
              "@/components/*": ["./components/*"],
            },
          },
        }),
      ],
      ["src/main.tsx", ""],
    ]);
    const entries = harvestTsconfigPaths(fs, "src/main.tsx");
    expect(entries[0].prefix).toBe("@/components/");
    expect(entries[1].prefix).toBe("@/");
  });
});

describe("applyTsconfigAlias", () => {
  it("rewrites @/components/ui/button to the virtual-fs file path", () => {
    const fs = makeShadcnLikeFs();
    const aliases = harvestTsconfigPaths(fs, "web_app/src/main.tsx");
    expect(applyTsconfigAlias("@/components/ui/button", aliases, fs)).toBe(
      "web_app/src/components/ui/button.tsx",
    );
  });

  it("rewrites @/lib/utils to the .ts file (no extension on the spec)", () => {
    const fs = makeShadcnLikeFs();
    const aliases = harvestTsconfigPaths(fs, "web_app/src/main.tsx");
    expect(applyTsconfigAlias("@/lib/utils", aliases, fs)).toBe(
      "web_app/src/lib/utils.ts",
    );
  });

  it("falls through (returns null) when the aliased target isn't in fs", () => {
    const fs = makeShadcnLikeFs();
    const aliases = harvestTsconfigPaths(fs, "web_app/src/main.tsx");
    expect(applyTsconfigAlias("@/components/ui/missing", aliases, fs)).toBeNull();
  });

  it("doesn't match unaliased bare specifiers", () => {
    const fs = makeShadcnLikeFs();
    const aliases = harvestTsconfigPaths(fs, "web_app/src/main.tsx");
    expect(applyTsconfigAlias("@radix-ui/react-slot", aliases, fs)).toBeNull();
    expect(applyTsconfigAlias("react", aliases, fs)).toBeNull();
  });

  it("returns null when there are no aliases at all", () => {
    expect(applyTsconfigAlias("@/foo", [], new Map())).toBeNull();
  });
});

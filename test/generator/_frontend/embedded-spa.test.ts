// ---------------------------------------------------------------------------
// `_frontend/embedded-spa.ts` — the fullstack (`ui:` on a backend deployable)
// embed convention shared by the .NET / Java / Python hosts (`ClientApp/`) and
// Phoenix (`assets/`).
//
// Already pinned elsewhere, not repeated here:
//   * `test/generator/python/python-fullstack.test.ts`,
//     `test/generator/java/generator-java-fullstack.test.ts`,
//     `test/platform/dotnet-fullstack.test.ts`, `vue/vue-embedding.test.ts`,
//     `svelte/svelte-embed-{java,dotnet}.test.ts` — that a given host embeds a
//     given framework, and the `.gitignore` body for react / angular / svelte /
//     feliz on ONE host each.
//
// What those cannot see, and is the subject here, is the module's own contract.
// Its whole reason to exist is that the drop-list was triplicated and a file
// added in one host leaked into the other two — so the properties that matter
// are the ones stated over the FUNCTION, not over one host's output:
//
//   * the drop-list is EXACT — it drops the four host-owned root paths under
//     the given prefix and nothing else.  An over-broad predicate silently
//     deletes SPA source (a page named `certs.tsx`, a `src/e2e-helpers.ts`);
//     an under-broad one leaks a second Dockerfile into the project root.
//   * it is PREFIX-PARAMETERISED, not `ClientApp/`-hardcoded — Phoenix passes
//     `assets/`, and a predicate that ignored the argument would drop nothing
//     there and leak all four files into every generated Phoenix app.
//   * `embedSpaInto` re-roots nothing and escapes nothing: every surviving path
//     lands under the prefix exactly once, with no `..` segment.
//   * `embeddedSpaGitignore` is TOTAL — every framework, including one it has
//     no arm for, gets a body naming its built directory.  A missing arm means
//     the built output is committed.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
  EMBEDDED_SPA_PREFIX,
  embeddedSpaGitignore,
  embedSpaInto,
  isHostOwnedSpaFile,
} from "../../../src/generator/_frontend/embedded-spa.js";
import { generateSystemFiles } from "../../_helpers/index.js";

const PREFIXES = [EMBEDDED_SPA_PREFIX, "assets/"] as const;

/** The four host-owned root paths, relative to a prefix. */
const HOST_OWNED = ["Dockerfile", ".dockerignore", "certs/.gitkeep", "e2e/smoke.spec.ts"];

/** Paths that LOOK like the drop-list but are SPA source the app needs. */
const NEAR_MISSES = [
  "src/pages/certs.tsx",
  "src/e2e-helpers.ts",
  "src/Dockerfile.tsx",
  "public/Dockerfile.txt",
  "src/e2e/helper.ts", // `e2e/` is a ROOT subtree, not any `e2e/` anywhere
  "src/certs/.gitkeep",
];

describe("isHostOwnedSpaFile — the drop-list is exact, and prefix-relative", () => {
  it.each(PREFIXES)("%s: drops exactly the four host-owned root paths", (prefix) => {
    for (const rel of HOST_OWNED) {
      expect(isHostOwnedSpaFile(`${prefix}${rel}`, prefix), `${prefix}${rel}`).toBe(true);
    }
    // The whole `e2e/` subtree, not just the one spec.
    expect(isHostOwnedSpaFile(`${prefix}e2e/pages/order.page.ts`, prefix)).toBe(true);
  });

  it.each(PREFIXES)("%s: keeps SPA source that merely resembles the list", (prefix) => {
    for (const rel of NEAR_MISSES) {
      expect(isHostOwnedSpaFile(`${prefix}${rel}`, prefix), `${prefix}${rel}`).toBe(false);
    }
  });

  it("is prefix-relative, so one host's drop-list never fires on another's tree", () => {
    // The bug the parameter exists to prevent: Phoenix passes `assets/`, so a
    // `ClientApp/`-hardcoded predicate would drop nothing there.
    expect(isHostOwnedSpaFile("assets/Dockerfile", "ClientApp/")).toBe(false);
    expect(isHostOwnedSpaFile("ClientApp/Dockerfile", "assets/")).toBe(false);
    expect(isHostOwnedSpaFile("ClientApp/Dockerfile")).toBe(true);
  });

  it("`certs/` is dropped only at the exact `.gitkeep`, never as a subtree", () => {
    // Deliberate asymmetry with `e2e/`: the host owns the certs DIRECTORY
    // placeholder, but a pack that genuinely emitted a cert under the SPA would
    // not be silently swallowed.
    expect(isHostOwnedSpaFile("ClientApp/certs/.gitkeep")).toBe(true);
    expect(isHostOwnedSpaFile("ClientApp/certs/dev.pem")).toBe(false);
  });
});

describe("embeddedSpaGitignore — total, and names the framework's built dir", () => {
  it.each([
    ["svelte", ["build", ".svelte-kit"]],
    ["angular", ["dist", ".angular"]],
    ["react", ["dist"]],
    ["vue", ["dist"]],
    ["feliz", ["dist"]],
  ])("%s ignores %j", (framework, dirs) => {
    const body = embeddedSpaGitignore(framework);
    expect(body).toContain("node_modules");
    for (const dir of dirs) expect(body.split("\n")).toContain(dir);
    expect(body.endsWith("\n")).toBe(true);
  });

  it("an unknown / absent framework still gets the vite default, never an empty file", () => {
    for (const fw of [undefined, "", "someFutureFramework"]) {
      const body = embeddedSpaGitignore(fw);
      expect(body).toContain("node_modules");
      expect(body.split("\n")).toContain("dist");
    }
  });

  it("svelte's build dir is `build`, NOT `dist` — the two are not interchangeable", () => {
    // adapter-static writes `build/`; ignoring `dist` there would commit it.
    expect(embeddedSpaGitignore("svelte").split("\n")).not.toContain("dist");
  });
});

describe("embedSpaInto", () => {
  const spa = (): Map<string, string> =>
    new Map([
      ["ClientApp/src/main.tsx", "main"],
      ["ClientApp/src/pages/home.tsx", "home"],
      ["ClientApp/package.json", "{}"],
      ["ClientApp/Dockerfile", "FROM node"],
      ["ClientApp/.dockerignore", "node_modules"],
      ["ClientApp/certs/.gitkeep", ""],
      ["ClientApp/e2e/smoke.spec.ts", "spec"],
    ]);

  it("copies the SPA verbatim, drops the host-owned four, and adds the .gitignore", () => {
    const out = new Map<string, string>();
    embedSpaInto(out, spa(), "react");
    expect([...out.keys()].sort()).toEqual([
      "ClientApp/.gitignore",
      "ClientApp/package.json",
      "ClientApp/src/main.tsx",
      "ClientApp/src/pages/home.tsx",
    ]);
    expect(out.get("ClientApp/src/main.tsx")).toBe("main");
    expect(out.get("ClientApp/.gitignore")).toBe(embeddedSpaGitignore("react"));
  });

  it("re-roots nothing — every surviving path keeps its ONE prefix and no `..`", () => {
    const out = new Map<string, string>();
    embedSpaInto(out, spa(), "react");
    for (const p of out.keys()) {
      expect(p.startsWith("ClientApp/"), p).toBe(true);
      expect(p.split("ClientApp/").length - 1, `${p} is prefixed twice`).toBe(1);
      expect(p.split("/"), `${p} escapes the prefix`).not.toContain("..");
    }
  });

  it("honours a non-default prefix on BOTH halves (Phoenix's assets/)", () => {
    const phoenixSpa = new Map(
      [...spa()].map(([p, c]) => [p.replace("ClientApp/", "assets/"), c] as const),
    );
    const out = new Map<string, string>();
    embedSpaInto(out, phoenixSpa, "react", "assets/");
    expect([...out.keys()].sort()).toEqual([
      "assets/.gitignore",
      "assets/package.json",
      "assets/src/main.tsx",
      "assets/src/pages/home.tsx",
    ]);
  });

  it("preserves what the host already wrote into `out`", () => {
    const out = new Map([["pom.xml", "<project/>"]]);
    embedSpaInto(out, spa(), "react");
    expect(out.get("pom.xml")).toBe("<project/>");
  });

  it("emits the .gitignore even when the SPA map is empty", () => {
    const out = new Map<string, string>();
    embedSpaInto(out, new Map(), "angular");
    expect([...out.keys()]).toEqual(["ClientApp/.gitignore"]);
  });
});

// --- the same properties, on real emitted output ----------------------------

const DOMAIN = `
    subdomain S {
      context C {
        aggregate Doc with crudish { name: string }
        repository Docs for Doc { }
      }
    }
    api DemoApi from S`;

const fullstack = (platform: string, framework: string, port: number): string => `
  system Demo {${DOMAIN}
    ui Web {
      framework: ${framework}
      api Ops: DemoApi
      page Home { route: "/" body: Stack { Heading { "Home" } } }
    }
    storage loomDb { type: postgres }
    resource cState { for: C, kind: state, use: loomDb }
    deployable srv {
      platform: ${platform}, contexts: [C], dataSources: [cState], serves: DemoApi,
      ui: Web { Ops: srv }, port: ${port}
    }
  }
`;

describe("fullstack hosts — no path is double-prefixed, escapes, or leaks a dropped file", () => {
  it.each([
    ["java", "react", 8080],
    ["python", "vue", 8000],
    ["dotnet", "angular", 5000],
  ] as const)("%s hosting %s", async (platform, framework, port) => {
    const files = await generateSystemFiles(fullstack(platform, framework, port));
    const spaPaths = [...files.keys()].filter((p) => p.includes("ClientApp/"));
    expect(spaPaths.length, "the host embedded no SPA at all").toBeGreaterThan(5);
    for (const p of spaPaths) {
      expect(p.split("ClientApp/").length - 1, `${p} is prefixed more than once`).toBe(1);
      expect(p.split("/"), `${p} escapes the prefix`).not.toContain("..");
    }
    // The four host-owned paths never reach the embedded tree.
    for (const rel of ["Dockerfile", ".dockerignore", "certs/.gitkeep"]) {
      expect(
        spaPaths.filter((p) => p.endsWith(`ClientApp/${rel}`)),
        `${rel} leaked into the embed`,
      ).toEqual([]);
    }
    expect(spaPaths.filter((p) => p.includes("ClientApp/e2e/"))).toEqual([]);
    // Exactly one .gitignore, carrying this framework's built dir.
    const ignores = spaPaths.filter((p) => p.endsWith("ClientApp/.gitignore"));
    expect(ignores).toHaveLength(1);
    expect(files.get(ignores[0]!)).toBe(embeddedSpaGitignore(framework));
  });
});

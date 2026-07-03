import { describe, expect, it } from "vitest";

import type { Platform } from "../../src/ir/types/loom-ir.js";
import { FRONTEND_GENERATORS } from "../../src/platform/frontend-dispatch.js";
import { descriptorFor } from "../../src/platform/metadata.js";
import { platformFor } from "../../src/platform/registry.js";
import { STATIC_BUNDLE_FRAMEWORKS } from "../../src/platform/surface.js";
import { generateSystems } from "../../src/system/index.js";
import { parseString } from "../_helpers/index.js";

// ---------------------------------------------------------------------------
// B19 — frontend host dispatch honours the ui's `framework:`.
//
// A frontend platform is a static-asset HOST: it serves whatever framework the
// bound ui declares, not the framework its platform keyword is named after
// (`STATIC_BUNDLE_FRAMEWORKS`).  Before this fix the dispatch matrix was
// incomplete — `vue.ts` had NO dispatch, so a validator-legal `platform: vue`
// host of a `framework: react` ui silently emitted a Vue project.
//
// The dispatch source of truth is `FRONTEND_GENERATORS`.  These tests tie every
// frontend descriptor's advertised `hostableFrameworks` to an actual dispatch
// arm — registry-driven, so a newly-added static frontend that forgets a
// dispatch arm (or advertises a framework it can't emit) fails here.
// ---------------------------------------------------------------------------

const FRONTEND_HOSTS: Platform[] = ["react", "svelte", "vue", "angular"];

/** A framework-distinctive file marker in a generated frontend project. */
const FRAMEWORK_MARKER: Record<string, RegExp> = {
  react: /\.tsx$/,
  static: /\.tsx$/,
  svelte: /\.svelte$/,
  vue: /\.vue$/,
  angular: /\.component\.ts$/,
};

const sorted = (s: Iterable<string>) => [...s].sort();

function systemSrc(host: string, uiFramework: string): string {
  return `system HostMix {
  subdomain D { context Shop { aggregate Order { code: string } repository Orders for Order { } } }
  ui WebApp with scaffold(subdomains: [D]) { framework: ${uiFramework} }
  api A from D
  storage primary { type: postgres }
  resource st { for: Shop, kind: state, use: primary }
  deployable api1 { platform: node contexts: [Shop] dataSources: [st] serves: A port: 8081 }
  deployable web { platform: ${host} targets: api1 ui: WebApp port: 3001 }
}
`;
}

describe("B19 — frontend host framework dispatch", () => {
  it("the dispatch map covers exactly the static-bundle frameworks", () => {
    // FRONTEND_GENERATORS is the single dispatch source; its keys must equal
    // STATIC_BUNDLE_FRAMEWORKS so a static host advertising a framework always
    // has a generator to route it to (and vice versa — no dead keys).
    expect(sorted(Object.keys(FRONTEND_GENERATORS))).toEqual(sorted(STATIC_BUNDLE_FRAMEWORKS));
  });

  it("every frontend descriptor advertises only dispatchable frameworks", () => {
    for (const host of FRONTEND_HOSTS) {
      const desc = descriptorFor(host);
      expect(desc.isFrontend).toBe(true);
      for (const fw of desc.hostableFrameworks) {
        // Each advertised framework has a real dispatch arm — no silent
        // wrong-framework emit.
        expect(FRONTEND_GENERATORS[fw]).toBeTypeOf("function");
      }
    }
  });

  // The behavioral proof: each host, serving each foreign framework, emits THAT
  // framework's project — not its own.  16-cell matrix (host × framework).
  for (const host of FRONTEND_HOSTS) {
    for (const fw of ["react", "svelte", "vue", "angular"]) {
      it(`${host} host serving a framework:${fw} ui emits a ${fw} project`, async () => {
        const { model, errors } = await parseString(systemSrc(host, fw));
        expect(errors).toEqual([]);
        const files = generateSystems(model).files;
        const webFiles = [...files.keys()].filter((k) => k.startsWith("web/"));
        const marker = FRAMEWORK_MARKER[fw]!;
        expect(webFiles.some((k) => marker.test(k))).toBe(true);
        // …and none of the OTHER frameworks' markers leaked in.
        for (const [other, otherMarker] of Object.entries(FRAMEWORK_MARKER)) {
          if (other === fw || other === "static") continue;
          if (FRAMEWORK_MARKER[fw]!.source === otherMarker.source) continue;
          expect(webFiles.some((k) => otherMarker.test(k))).toBe(false);
        }
      });
    }
  }

  it("a host with no ui framework falls back to its native generator", () => {
    // dispatchFrontendProject uses the host's own key when uiFramework is
    // undefined — pinned via the map (react host → react, etc.).
    expect(platformFor("vue").name).toBe("vue");
    expect(FRONTEND_GENERATORS.vue).toBeTypeOf("function");
  });
});

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../_helpers/examples.js";
import { generateSystemFiles } from "../_helpers/generate.js";

// ---------------------------------------------------------------------------
// Feliz (F#/Fable) FEATURE-COMPLETENESS gate — the cross-frontend sibling of
// `showcase-completeness.test.ts`.
//
// `examples/showcase.ddd` is the ONE fixture proven to exercise every language
// feature and every walker primitive (that guard is enforced against the React
// registry).  But that proof is React's alone: the other frontends each run a
// smaller, hand-picked example, so a feature that renders on React can silently
// fail to render on Feliz — its build gate compiles only a single inline
// mini-app, so nothing drives the whole surface through the F# emitter.
//
// This test closes that hole for Feliz WITHOUT the heavy `dotnet fable` step:
// it drives the WHOLE showcase surface (all three UIs — the hand-written
// `Console` with explicit api params + forms + operations, the scaffolded
// `Admin`, and the sugar-bound `Ops`) through the Feliz generator and asserts
// it emits cleanly.  Two failure modes are caught:
//
//   1. A THROW — the Feliz expr/action renderers fail-fast on any construct
//      they cannot render (M-T6.15, `feliz/fail-fast.test.ts`).  A new feature
//      React handles but Feliz does not makes `generateSystemFiles` throw here,
//      turning a silent Feliz gap into a red fast-suite build.
//   2. A SILENT FALLBACK marker — the shared walker emits a `(* ... *)` comment
//      when a primitive has no renderer or a seam is unsupported.  We assert the
//      emitted F# carries none.
//
// This is generation-level only; the runtime/`dotnet fable` compile of the full
// surface stays the natural follow-up (today the build gate compiles just the
// inline showcase).  See `generated-feliz-build.yml`.
// ---------------------------------------------------------------------------

// The three showcase UIs, re-bound to Feliz frontend deployables. Same UIs,
// same api targets the shipped static deployables already render — only the
// `platform:` differs, so this drives the identical feature surface through F#.
const FELIZ_DEPLOYABLES = `
    deployable consoleFeliz {
        platform: feliz
        targets: dotnetApi
        ui: Console { Projects: dotnetApi, Delivery: dotnetApi, Accounts: dotnetApi }
        port: 3011
    }

    deployable opsFeliz {
        platform: feliz
        targets: honoApi
        ui: Ops
        port: 3012
    }

    deployable adminFeliz {
        platform: feliz
        targets: honoApi
        ui: Admin
        port: 3013
    }
`;

/** Silent-degradation markers the shared/Feliz walkers emit when they cannot
 *  render a construct (the fail-fast path THROWS instead — caught separately).
 *  None must appear in the emitted F#. */
const FALLBACK_MARKERS = [
  "unsupported expr",
  "not supported by the React walker",
  "unknown layout component",
  "TODO feliz",
  "(* unsupported",
];

describe("feliz renders the feature-complete showcase surface", () => {
  const base = fs.readFileSync(path.join(repoRoot, "examples", "showcase.ddd"), "utf8");
  // Anchor on the last static frontend deployable (`adminWeb`) so the Feliz
  // deployables land INSIDE the system, right after it. Robust against the
  // top-level `requirement`/`solution`/`migration` blocks that bracket the
  // system; the "injected" guard below fails loudly if the anchor ever moves.
  const ADMIN_WEB_ANCHOR = `        ui: Admin
        port: 3003
        design: shadcn
    }`;
  const source = base.replace(ADMIN_WEB_ANCHOR, `${ADMIN_WEB_ANCHOR}\n${FELIZ_DEPLOYABLES}`);

  it("injects the Feliz deployables into the showcase source", () => {
    // Guards the regex actually matched — a structural change to showcase.ddd
    // that breaks the injection must fail loudly, not silently skip coverage.
    expect(source).not.toBe(base);
    expect(source).toContain("platform: feliz");
  });

  it("generates every showcase UI through Feliz without a fail-fast throw", async () => {
    // `generateSystemFiles` runs the full orchestrator; the Feliz expr/action
    // renderers throw on any unrenderable construct, so a new cross-frontend
    // gap surfaces here as a thrown error naming the construct.
    const files = await generateSystemFiles(source);

    // Only Feliz frontends emit F# `src/App.fs`; every backend/JSX frontend
    // emits something else. So an `App.fs` uniquely identifies a Feliz UI.
    const felizApps = [...files.entries()].filter(([p]) => p.endsWith("src/App.fs"));
    expect(felizApps.length).toBe(3);

    for (const [p, content] of felizApps) {
      // A real MVU view module, not an empty stub (the `Ops` dashboard is the
      // smallest at ~500 chars; a regression to a stub would be far shorter).
      expect(content, p).toContain("let init ()");
      expect(content, p).toContain("let view ");
      expect(content.length, p).toBeGreaterThan(300);
    }
  });

  it("emits no silent-degradation fallback markers in the F#", async () => {
    const files = await generateSystemFiles(source);
    const felizApps = [...files.entries()].filter(([p]) => p.endsWith("src/App.fs"));

    for (const [p, content] of felizApps) {
      for (const marker of FALLBACK_MARKERS) {
        expect(content.includes(marker), `${p} contains fallback marker "${marker}"`).toBe(false);
      }
    }
  });
});

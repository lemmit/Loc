import { describe, expect, it } from "vitest";
import {
  flattenRequired,
  REQUIRED_PRIMITIVES,
} from "../../src/generator/_packs/required-primitives.js";
import { felizPack } from "../../src/generator/feliz/pack.js";

// ---------------------------------------------------------------------------
// Feliz pack-format groundwork — the structural sibling of the load-time
// `REQUIRED_PRIMITIVES` gate for a PROCEDURAL pack (fable-elmish-frontend.md §4).
//
// Feliz "markup" is F# code (`Html.div [ … ]`), so it ships a procedural
// `LoadedPack` (`src/generator/feliz/pack.ts`) with an empty `templates` map and
// a hand-written `render(name)` dispatch, constructed directly in
// `feliz/index.ts` — it NEVER passes through `compilePack`, so the load-time gate
// (`loader.ts:346`) that makes a missing template fail loudly on the
// Vue/Svelte/Angular Handlebars packs does not run for it.  A primitive its
// `RENDERERS` table lacks returns a compile-clean `(* feliz pack: no renderer
// for "X" *)` F# block comment that silently drops the UI element — the exact
// 🔴 silent gap the 2026-07 frontend audit (F1) found.
//
// This test is that gate: every primitive the `feliz` required set names must
// have a real renderer (no missing-renderer sentinel), so a future primitive
// added to `SHARED_PRIMITIVES` / `TSX_ONLY_PRIMITIVES` without a Feliz renderer
// fails CI here instead of silently vanishing from the rendered app.  The
// bidirectional twin at render-time is the `feliz pack: no renderer` entry in
// `frontend-showcase-render.test.ts`'s `FALLBACK_MARKERS`.  Pure TS — no Fable/
// dotnet SDK.
// ---------------------------------------------------------------------------

const MISSING = /^\(\* loom:unrendered feliz pack: no renderer/;

describe("feliz pack format groundwork", () => {
  it("feliz required set is the JSX-family display + input surface minus form-of (forms render inline)", () => {
    const feliz = new Set(flattenRequired(REQUIRED_PRIMITIVES.feliz));
    const tsx = new Set(flattenRequired(REQUIRED_PRIMITIVES.tsx));

    // Every display / layout / input primitive the TSX set requires is required
    // for Feliz too — EXCEPT `primitive-form-of`, which Feliz renders inline
    // through the Elmish `renderCreateForm`… seams (never pack-dispatched, the
    // same drop as Angular).  Unlike Angular, Feliz keeps `primitive-modal`.
    // `primitive-chart` is TSX-ONLY (M-T1.3 Phase 5): each react pack binds its
    // own charting library, and no feliz pack ships a chart template — `Chart`
    // stays an honest `loom.chart-unsupported-target` gap here.
    tsx.delete("primitive-chart");
    for (const name of tsx) {
      // The TSX form-pipeline surface has no procedural analogue: Feliz builds
      // form inputs inline via the walker seams, so none of the field-input-* /
      // form-* / op-dialog templates (nor the Vite/npm shell files) are pack
      // templates — the shell is emitted by `feliz/index.ts` directly.
      // `primitive-data-grid` used to be exempt here on the theory that
      // TanStack has no F#/Fable adapter.  It needs none: Fable compiles F# to
      // JavaScript, so the Feliz target binds `@tanstack/table-core` — the
      // framework-agnostic package every official adapter wraps — directly
      // (M-T1.1 slice 10e).  Feliz therefore REQUIRES the grid like every JS
      // pack.  Flutter remains exempt, for the reason this exemption was
      // wrongly borrowed from: its native build has no JS runtime at all.
      if (
        name === "primitive-form-of" ||
        name.startsWith("field-input-") ||
        name.startsWith("form-") ||
        name === "op-dialog" ||
        name === "realtime-toast" ||
        REQUIRED_PRIMITIVES.tsx.shell.includes(name)
      ) {
        expect(feliz.has(name), `feliz should NOT require inline/seam-covered "${name}"`).toBe(
          false,
        );
        continue;
      }
      expect(feliz.has(name), `feliz set missing tsx-required primitive "${name}"`).toBe(true);
    }

    // Procedural pack: no form / field-input template surface, no shell set.
    expect(REQUIRED_PRIMITIVES.feliz.fieldInput).toBeUndefined();
    expect(REQUIRED_PRIMITIVES.feliz.form).toBeUndefined();
    expect(REQUIRED_PRIMITIVES.feliz.shell).toEqual([]);
  });

  it("the felizBasic pack renders every required core primitive — no missing-renderer sentinel", () => {
    const pack = felizPack();
    expect(pack.manifest.name).toBe("felizBasic");

    // Consistency: every primitive the `feliz` required-set names must have a
    // real renderer in the procedural pack (no missing-renderer sentinel, non-
    // empty output).  This is the load-time gate the Handlebars packs get from
    // `compilePack`, asserted structurally for the procedural pack.
    for (const name of REQUIRED_PRIMITIVES.feliz.core) {
      const out = pack.render(name, {});
      expect(out, `pack has no renderer for required core primitive "${name}"`).not.toMatch(
        MISSING,
      );
      expect(out.length, `renderer for "${name}" produced empty output`).toBeGreaterThan(0);
    }
  });

  it("returns the missing-renderer sentinel for an unknown primitive", () => {
    expect(felizPack().render("primitive-does-not-exist", {})).toMatch(MISSING);
  });
});

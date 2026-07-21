import { describe, expect, it } from "vitest";
import * as pageObjectsBuilder from "../../../src/generator/_frontend/page-objects-builder.js";
import * as walkerPageObjects from "../../../src/generator/_frontend/walker-page-objects.js";
import * as workflowPageObject from "../../../src/generator/_frontend/workflow-page-object.js";

// ---------------------------------------------------------------------------
// React/Vue/Svelte/Angular ↔ Phoenix/HEEx page-object PARITY TRACKER
// (frontend-test-parity audit, finding F4).
//
// The four JSX/markup SPA frontends share ONE set of page-object builders in
// `src/generator/_frontend/` (buildPageObjectModule / buildWorkflowPageObject /
// buildViewPageObject / buildWalkerPageObject) — change one, every SPA picks it
// up.  Phoenix/HEEx does NOT consume them: `elixir/page-objects-emit.ts` runs a
// PARALLEL reimplementation (its own buildAggregate{List,New,Detail}PageObject,
// buildWorkflowFormPageObject, …), reusing only the
// `fillBlock` helper, because LiveView's page-object topology diverges from the
// `@loom/ui-test-driver` shape the SPAs emit.
//
// That fork is legitimate, but it means a NEW shared `_frontend` page-object
// builder (a new page archetype the SPAs gain a page object for) has NO
// compile-time link to Phoenix — a contributor can add it and silently leave
// Phoenix's parallel emitter without the matching archetype, and only the
// heex-parity / conformance gates might (or might not) notice.
//
// This test FREEZES the shared page-object builder surface.  Adding a new
// `build*` export under `_frontend/` fails CI until the author records — in the
// map below — how Phoenix's parallel emitter covers (or deliberately declines)
// the same archetype.  Removing one also fails: delete the entry.  Same
// pinned-allowlist discipline as heex-parity.test.ts and
// walker-stdlib-completeness.test.ts.
// ---------------------------------------------------------------------------

/** Every page-object builder the `_frontend/` modules export to the SPA
 *  frontends, mapped to how `elixir/page-objects-emit.ts` covers the SAME
 *  archetype in its parallel reimplementation.  FROZEN — see the header.
 *  `fillBlock` (the one helper Phoenix DOES reuse) is excluded: it's a shared
 *  utility, not an archetype builder, so it carries no drift risk. */
const SHARED_PAGE_OBJECT_BUILDERS: Record<string, string> = {
  buildPageObjectModule:
    "Phoenix splits the one combined list/detail/new module into per-archetype " +
    "builders (buildAggregateListPageObject / buildAggregateNewPageObject / " +
    "buildAggregateDetailPageObject), dispatched off classifyPage.",
  buildWorkflowPageObject: "Phoenix: buildWorkflowFormPageObject (workflow-form archetype).",
  buildWalkerPageObject:
    "Phoenix: buildGenericPageObject (custom/walker pages) + buildFallback (when " +
    "the aggregate/context can't be resolved).",
};

/** Reflectively collect the `build*` function exports across the shared
 *  `_frontend/` page-object modules — the surface the SPAs depend on. */
function sharedBuilderNames(): string[] {
  const modules = [pageObjectsBuilder, walkerPageObjects, workflowPageObject];
  const names = new Set<string>();
  for (const mod of modules) {
    for (const [name, value] of Object.entries(mod)) {
      if (typeof value === "function" && name.startsWith("build")) names.add(name);
    }
  }
  return [...names].sort();
}

describe("frontend ↔ Phoenix page-object parity (audit F4)", () => {
  it("the shared _frontend page-object builder surface matches the pinned map", () => {
    expect(sharedBuilderNames()).toEqual(Object.keys(SHARED_PAGE_OBJECT_BUILDERS).sort());
  });

  it("every pinned builder records how Phoenix covers the same archetype", () => {
    for (const [name, note] of Object.entries(SHARED_PAGE_OBJECT_BUILDERS)) {
      expect(
        note.trim().length,
        `pinned shared builder '${name}' needs a Phoenix note`,
      ).toBeGreaterThan(0);
    }
  });
});

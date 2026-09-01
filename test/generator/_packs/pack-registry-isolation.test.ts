// G2667-D8 — each pack compiles in its OWN Handlebars environment.
//
// `compilePack` used to register every template as a partial, and every
// manifest-declared lookup helper as a helper, on the PROCESS-GLOBAL
// Handlebars registry, behind the comment:
//
//   "Helpers register globally on Handlebars (no per-pack scoping).  In
//    practice each generation loads exactly one pack, so the global
//    registration is fine"
//
// That premise is false for any multi-frontend system.  One `generate system`
// over a react + vue + svelte + angular set of deployables loads five or six
// packs into the same process, and they all share the logical names
// (`primitive-button`, `primitive-field`, `app-shell`, …).  Worse, the damage
// is RETROACTIVE: a Handlebars template resolves its partials and helpers at
// RENDER time against the environment it was compiled in, so loading a second
// pack changed what an ALREADY-COMPILED first pack rendered.
//
// Each pack now gets `Handlebars.create()`.

import { describe, expect, it } from "vitest";
import { compilePack } from "../../../src/generator/_packs/loader.js";

function pack(
  name: string,
  sources: Record<string, string>,
  helpers?: Record<string, Record<string, string>>,
) {
  const emits = Object.fromEntries(Object.keys(sources).map((k) => [k, `${k}.hbs`]));
  return compilePack(
    `/${name}`,
    { name, version: "0.0.0", emits, ...(helpers ? { helpers } : {}) },
    sources,
    (f) => `/${name}/${f}`,
    {},
    { validateRequired: false },
  );
}

describe("pack Handlebars-registry isolation", () => {
  it("two packs' same-named PARTIALS do not overwrite each other", () => {
    const a = pack("packA", {
      "primitive-button": "<AButton>{{{label}}}</AButton>",
      outer: '<div>{{> primitive-button label="x"}}</div>',
    });
    // Loading B second is what used to clobber A's partial registration.
    const b = pack("packB", {
      "primitive-button": "<BButton>{{{label}}}</BButton>",
      outer: '<div>{{> primitive-button label="x"}}</div>',
    });

    expect(b.render("outer", {})).toBe("<div><BButton>x</BButton></div>");
    // …and A, compiled FIRST, must still render its OWN button.  Partials
    // resolve at render time, so this is the assertion the global registry
    // could not satisfy.
    expect(a.render("outer", {})).toBe("<div><AButton>x</AButton></div>");
  });

  it("two packs' same-named lookup HELPERS keep their own tables", () => {
    const a = pack("helperA", { out: "{{icon 'check'}}" }, { icon: { check: "IconCheckA" } });
    const b = pack("helperB", { out: "{{icon 'check'}}" }, { icon: { check: "IconCheckB" } });

    expect(b.render("out", {})).toBe("IconCheckB");
    expect(a.render("out", {})).toBe("IconCheckA");
  });

  it("the IR-semantic core helpers are present in every pack environment", () => {
    // They are contract invariants, not theme decisions — so isolating the
    // environments must not lose them.  (`registerHelpersOnce`'s module-level
    // latch would have registered them into the first environment only.)
    const a = pack("coreA", { out: "{{pascal name}}|{{plural name}}|{{snake name}}" });
    const b = pack("coreB", { out: "{{humanize name}}|{{camel name}}" });
    expect(a.render("out", { name: "orderLine" })).toBe("OrderLine|orderLines|order_line");
    expect(b.render("out", { name: "orderLine" })).toBe("Order Line|orderLine");
  });

  it("a pack template still overrides a SHARED template of the same name", () => {
    // The within-pack precedence rule must survive the isolation change.
    const p = compilePack(
      "/ovr",
      { name: "ovr", version: "0.0.0", emits: { "primitive-button": "primitive-button.hbs" } },
      { "primitive-button": "<Own/>" },
      (f) => `/ovr/${f}`,
      { "primitive-button": "<Shared/>", "shared-only": "<SharedOnly/>" },
      { validateRequired: false },
    );
    expect(p.render("primitive-button", {})).toBe("<Own/>");
    // …and a shared template the pack did NOT override stays renderable.
    expect(p.render("shared-only", {})).toBe("<SharedOnly/>");
  });
});

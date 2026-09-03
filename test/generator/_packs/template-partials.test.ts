import { describe, expect, it } from "vitest";
import { compilePack } from "../../../src/generator/_packs/loader.js";

// ---------------------------------------------------------------------------
// Partial composition — every template loaded into a pack is also
// registered as a Handlebars partial under its logical name.  This
// lets higher-level templates compose primitives via
// `{{> primitive-X args}}` instead of duplicating design-system
// specifics in every consumer.
//
// Pin the contract here so the loader doesn't quietly stop
// registering partials in a future refactor.
// ---------------------------------------------------------------------------

describe("template partial composition", () => {
  it("primitives are usable as partials from other templates in the same pack", () => {
    const manifest = {
      name: "fixture",
      version: "0.0.0",
      emits: {
        "primitive-button": "primitive-button.hbs",
        outer: "outer.hbs",
      },
    } as const;
    const sources = {
      "primitive-button": "<Button onClick={{expr onClick}}>{{{label}}}</Button>",
      outer: '<div>{{> primitive-button label="Click me" onClick="() => doThing()"}}</div>',
    };
    const pack = compilePack(
      "/fixture",
      manifest,
      sources,
      (f) => `/fixture/${f}`,
      {},
      { validateRequired: false },
    );
    const out = pack.render("outer", {});
    expect(out).toBe("<div><Button onClick={() => doThing()}>Click me</Button></div>");
  });

  it("partials inherit the calling context unless overridden", () => {
    const manifest = {
      name: "fixture",
      version: "0.0.0",
      emits: {
        greeting: "greeting.hbs",
        outer: "outer.hbs",
      },
    } as const;
    const sources = {
      greeting: "Hello {{name}}",
      outer: "{{> greeting}}, {{name}}!",
    };
    const pack = compilePack(
      "/fixture",
      manifest,
      sources,
      (f) => `/fixture/${f}`,
      {},
      { validateRequired: false },
    );
    const out = pack.render("outer", { name: "World" });
    expect(out).toBe("Hello World, World!");
  });

  it("explicit partial-args override the parent context", () => {
    const manifest = {
      name: "fixture",
      version: "0.0.0",
      emits: {
        greeting: "greeting.hbs",
        outer: "outer.hbs",
      },
    } as const;
    const sources = {
      greeting: "Hi {{name}}",
      outer: '{{> greeting name="Alice"}} and {{> greeting name="Bob"}}',
    };
    const pack = compilePack(
      "/fixture",
      manifest,
      sources,
      (f) => `/fixture/${f}`,
      {},
      { validateRequired: false },
    );
    expect(pack.render("outer", {})).toBe("Hi Alice and Hi Bob");
  });
});

// ---------------------------------------------------------------------------
// G2667-D8 — pack ISOLATION.  Partials and manifest helpers used to register
// into the module-global Handlebars registry, safe only under the loader's own
// (by then false) "one pack per generation" comment: a `react + vue + svelte +
// angular` system loads FOUR packs into one process, and the last one to
// register a given logical name won for everyone.  Each pack now compiles in
// its own `Handlebars.create()` environment, so output cannot depend on load
// order.
// ---------------------------------------------------------------------------

describe("pack isolation", () => {
  const packWith = (button: string, helperTable: Record<string, string>) =>
    compilePack(
      "/fixture",
      {
        name: `fixture-${button.length}`,
        version: "0.0.0",
        emits: { "primitive-button": "primitive-button.hbs", outer: "outer.hbs" },
        helpers: { icon: helperTable },
      } as const,
      {
        "primitive-button": button,
        outer: '<div>{{> primitive-button}}{{icon "plus"}}</div>',
      },
      (f) => `/fixture/${f}`,
      {},
      { validateRequired: false },
    );

  it("a later pack's same-named partial + helper does not leak into an earlier one", () => {
    const a = packWith("<AButton />", { plus: "APlus" });
    const b = packWith("<BButton />", { plus: "BPlus" });
    // Rendered AFTER b was loaded — a must still see its own template + table.
    expect(a.render("outer", {})).toBe("<div><AButton />APlus</div>");
    expect(b.render("outer", {})).toBe("<div><BButton />BPlus</div>");
  });

  it("load order does not change either pack's output", () => {
    const first = packWith("<AButton />", { plus: "APlus" }).render("outer", {});
    const b = packWith("<BButton />", { plus: "BPlus" });
    const reloadedA = packWith("<AButton />", { plus: "APlus" });
    expect(reloadedA.render("outer", {})).toBe(first);
    expect(b.render("outer", {})).toBe("<div><BButton />BPlus</div>");
  });
});

import { describe, expect, it } from "vitest";
import { compilePack } from "../src/generator/_packs/loader.js";

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
    const pack = compilePack("/fixture", manifest, sources, (f) => `/fixture/${f}`);
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
    const pack = compilePack("/fixture", manifest, sources, (f) => `/fixture/${f}`);
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
    const pack = compilePack("/fixture", manifest, sources, (f) => `/fixture/${f}`);
    expect(pack.render("outer", {})).toBe("Hi Alice and Hi Bob");
  });
});

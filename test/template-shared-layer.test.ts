import { describe, expect, it } from "vitest";
import { compilePack } from "../src/generator/_packs/loader.js";

// ---------------------------------------------------------------------------
// Shared template layer — pack-agnostic partials available to every
// loaded pack via the new `sharedSources` argument to `compilePack`.
//
// Pin the contract:
//   - Shared partials are invocable from pack templates.
//   - Pack templates with the same logical name override the
//     shared default.
//   - Shared templates can compose pack primitives via partials
//     and produce different output per pack (the partial-dispatch
//     resolves to whichever pack is currently loaded).
//   - Shared templates are also renderable via `pack.render()` so
//     orchestration code can pick them by name.
// ---------------------------------------------------------------------------

const baseManifest = {
  name: "fixture",
  version: "0.0.0",
  emits: {} as Record<string, string>,
};

describe("shared template layer", () => {
  it("registers shared sources as Handlebars partials", () => {
    const pack = compilePack(
      "/p",
      { ...baseManifest, emits: { entry: "entry.hbs" } },
      { entry: "{{> shared-greeting name='World'}}" },
      (f) => `/p/${f}`,
      { "shared-greeting": "Hello {{name}}" },
    );
    expect(pack.render("entry", {})).toBe("Hello World");
  });

  it("pack templates override same-named shared templates", () => {
    const pack = compilePack(
      "/p",
      { ...baseManifest, emits: { greeting: "greeting.hbs", entry: "entry.hbs" } },
      {
        greeting: "Hi {{name}}",
        entry: "{{> greeting name='Alice'}}",
      },
      (f) => `/p/${f}`,
      { greeting: "Hello {{name}}" },
    );
    // Pack's `greeting` overrode shared `greeting`.
    expect(pack.render("entry", {})).toBe("Hi Alice");
  });

  it("shared templates compose pack primitives — output adapts to whichever pack is currently loaded", () => {
    // Same shared template, evaluated against two packs in
    // sequence.  Handlebars' partial registry is global (one
    // process), so loading pack B overwrites partials from pack
    // A.  In production this is fine because exactly one pack
    // is loaded per generation; the contract we're pinning here
    // is "the *currently loaded* pack drives composition".
    const sharedTemplates = {
      "page-header": "<header>{{> primitive-button label='Save'}}</header>",
    };
    const mantineLike = compilePack(
      "/m",
      {
        ...baseManifest,
        name: "mantine-like",
        emits: { "primitive-button": "primitive-button.hbs" },
      },
      { "primitive-button": "<MantineBtn>{{label}}</MantineBtn>" },
      (f) => `/m/${f}`,
      sharedTemplates,
    );
    expect(mantineLike.render("page-header", {})).toBe(
      "<header><MantineBtn>Save</MantineBtn></header>",
    );
    // Load a second pack; its primitive-button now drives shared
    // template rendering.
    const shadcnLike = compilePack(
      "/s",
      {
        ...baseManifest,
        name: "shadcn-like",
        emits: { "primitive-button": "primitive-button.hbs" },
      },
      {
        "primitive-button": '<button className="btn btn-primary">{{label}}</button>',
      },
      (f) => `/s/${f}`,
      sharedTemplates,
    );
    expect(shadcnLike.render("page-header", {})).toBe(
      '<header><button className="btn btn-primary">Save</button></header>',
    );
  });

  it("renderable via pack.render even when not in pack's emits", () => {
    const pack = compilePack("/p", { ...baseManifest, emits: {} }, {}, (f) => `/p/${f}`, {
      "shared-only": "Shared content",
    });
    expect(pack.render("shared-only", {})).toBe("Shared content");
  });
});

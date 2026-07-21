// ---------------------------------------------------------------------------
// Cross-target TEXT-ESCAPING property gate (audit finding 13 / slice B23).
//
// heex-parity.test.ts measures registry PRESENCE — it stays green while the
// TSX and HEEx renderers both exist but DISAGREE on escaping (exactly what
// shipped as finding 13).  This file measures BEHAVIOUR: a hostile text
// literal must come out ESCAPED on every target that renders text, so a
// `<`, `&`, `<%= … %>` or `{{ … }}` in `.ddd` source can never open a tag,
// an entity, an EEx tag or a mustache interpolation in generated markup.
//
// Two layers:
//   1. FUNNEL property (seam-level, auto-covering) — every `WalkerTarget`'s
//      `escapeText` neutralizes the text-position specials.  Every text
//      primitive routes its literal through this seam (`ctx.target.escapeText`
//      / `unwrapTextLiteral(…, ctx.target.escapeText)`), so proving the seam
//      escapes proves EVERY current-and-future primitive that uses it is
//      covered — no per-primitive enumeration needed.
//   2. END-TO-END render — a page body instantiating every text-rendering
//      primitive with the hostile literal, generated through all five REAL
//      generators (React/Vue/Svelte/Angular via the shared walker, Phoenix
//      via its parallel HEEx engine).  Asserts the raw payload never appears
//      unescaped in any generated file, and the escaped form does — proving
//      the primitives actually route through the funnel end to end.
//   3. REGISTRY classification guard — every `WALKER_PRIMITIVES` entry is
//      classified as a rendered text primitive (tested here) or pinned as
//      non-text with a reason.  A NEW primitive fails until classified, so
//      a new text primitive is auto-pulled into the escaping gate (the same
//      frozen-allowlist discipline as heex-parity / walker-stdlib tests).
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { WALKER_PRIMITIVES } from "../../../src/generator/_walker/registry.js";
import type { WalkerTarget } from "../../../src/generator/_walker/target.js";
import { angularTarget } from "../../../src/generator/angular/walker/angular-target.js";
import { heexTarget } from "../../../src/generator/elixir/heex-target.js";
import { tsxTarget } from "../../../src/generator/react/walker/tsx-target.js";
import { svelteTarget } from "../../../src/generator/svelte/walker/svelte-target.js";
import { vueTarget } from "../../../src/generator/vue/walker/vue-target.js";
import { generateSystemFiles } from "../../_helpers/index.js";

// A single string that is hostile in EVERY text-position grammar:
//   `<`        opens an HTML/HEEx tag
//   `&`        opens an HTML entity
//   `<%= … %>` is an EEx (Phoenix) interpolation
//   `{{ … }}`  is a Vue mustache (and `{`/`}` open a JSX expression / a
//              modern-HEEx `{…}` interpolation)
const HOSTILE = "a < b & c <%= x %> {{ y }}";

// The escaped fragment every target produces for the shared `a < b & c`
// prefix (`<`→`&lt;`, `&`→`&amp;`).  Present ⇒ the funnel ran; the raw
// prefix `a < b & c` absent ⇒ nothing leaked.
const ESCAPED_FRAGMENT = "a &lt; b &amp; c";

// A bare `&` (not the start of a known entity) — the signature of an
// UNescaped ampersand slipping through.
const BARE_AMPERSAND = /&(?!(amp|lt|gt|quot|apos|#\d+);)/;

// ---------------------------------------------------------------------------
// 1. Funnel property — every target's `escapeText` seam.
// ---------------------------------------------------------------------------

const ALL_TARGETS: ReadonlyArray<{ name: string; target: WalkerTarget }> = [
  { name: "tsx", target: tsxTarget },
  { name: "vue", target: vueTarget },
  { name: "svelte", target: svelteTarget },
  { name: "angular", target: angularTarget },
  { name: "heex", target: heexTarget },
];

// The JSX/markup family additionally neutralizes `{`/`}` (mustache / JSX
// expression openers); HEEx text position doesn't treat `{{` as a mustache
// in the classic `<%= %>` templates it emits, so it isn't required to.
const JS_FAMILY = new Set(["tsx", "vue", "svelte", "angular"]);

describe("text-escaping funnel — every WalkerTarget.escapeText", () => {
  for (const { name, target } of ALL_TARGETS) {
    it(`${name}: no raw '<' survives (tags / EEx openers are inert)`, () => {
      expect(target.escapeText(HOSTILE)).not.toContain("<");
    });

    it(`${name}: every '&' is a well-formed entity (no bare ampersand)`, () => {
      expect(target.escapeText(HOSTILE)).not.toMatch(BARE_AMPERSAND);
    });

    it(`${name}: the shared '<'/'&' prefix escapes to ${ESCAPED_FRAGMENT}`, () => {
      expect(target.escapeText(HOSTILE)).toContain(ESCAPED_FRAGMENT);
    });

    if (JS_FAMILY.has(name)) {
      it(`${name}: no raw '{' / '}' survives (mustache / JSX openers are inert)`, () => {
        const out = target.escapeText(HOSTILE);
        expect(out).not.toContain("{");
        expect(out).not.toContain("}");
      });
    }
  }

  it("leaves ordinary text byte-identical on every target", () => {
    for (const { target } of ALL_TARGETS) {
      expect(target.escapeText("Order total")).toBe("Order total");
    }
  });
});

// ---------------------------------------------------------------------------
// 2. + 3. End-to-end render + registry classification.
// ---------------------------------------------------------------------------

// A `.ddd` string-literal spelling of the hostile payload.
const H = JSON.stringify(HOSTILE);

// Registry primitives that render a `.ddd` text LITERAL in text position
// (routing it through `ctx.target.escapeText`), each with a body snippet
// that puts the hostile literal in that position.  These are the entries the
// end-to-end render exercises on all five targets.
// Block-form (`Name { … }`) so multiple siblings comma-separate inside the
// parent `Stack { … }` (the page-body grammar — see store.test.ts).
const TEXT_PRIMITIVE_CALLS: Record<string, string> = {
  Heading: `Heading { ${H} }`,
  Text: `Text { ${H} }`,
  Bold: `Bold { ${H} }`,
  Italic: `Italic { ${H} }`,
  InlineCode: `InlineCode { ${H} }`,
  Empty: `Empty { ${H} }`,
  Anchor: `Anchor { ${H}, to: "/x" }`,
  Badge: `Badge { ${H} }`,
  Alert: `Alert { ${H} }`,
  Stat: `Stat { ${H}, "v" }`,
  KeyValueRow: `KeyValueRow { ${H}, Text { "v" } }`,
  CodeBlock: `CodeBlock { ${H}, language: "text" }`,
};

// Registry primitives that do NOT render a caller-supplied text literal in
// text position — so the text-escaping property doesn't apply to them.
// Pinned WITH A REASON so a NEW primitive can't silently escape the gate:
// adding one fails the classification guard until it's sorted into one bucket
// or the other.
const NON_TEXT_PRIMITIVES: Record<string, string> = {
  // Layout / container — recurse into children, emit no own text literal.
  Stack: "layout container",
  Group: "layout container",
  Grid: "layout container",
  Container: "layout container",
  Tabs: "layout container",
  Toolbar: "layout container",
  Card: "layout container",
  Paper: "layout container",
  Section: "layout container",
  Sticky: "layout container",
  Breadcrumbs: "layout container",
  Modal: "layout container",
  Slot: "children placeholder — no literal",
  // Value/formatter primitives — render an EXPRESSION (ref/op), not a text
  // literal, so escaping is the expression renderer's concern, not text.
  Money: "renders a value expression, not a text literal",
  DateDisplay: "renders a value expression, not a text literal",
  EnumBadge: "renders a value expression, not a text literal",
  // Attribute-valued media — literal lands in an attr (src/alt), covered by
  // attribute escaping, not the text funnel.
  Image: "literal renders in an attribute, not text position",
  Avatar: "literal renders in an attribute, not text position",
  Icon: "icon name → attribute/class, not free text",
  // Inputs — bound to page/form state; labels come from the field metadata,
  // not a caller text literal in body position.
  Field: "form input — no body text literal",
  NumberField: "form input — no body text literal",
  PasswordField: "form input — no body text literal",
  MultilineField: "form input — no body text literal",
  SelectField: "form input — no body text literal",
  FileUpload: "form input — no body text literal",
  Toggle: "form input — no body text literal",
  // Structural / data / control — no caller text literal in text position.
  Table: "data grid — cell text comes from row bindings",
  Column: "sub-element of Table",
  Tab: "sub-element of Tabs",
  Divider: "rule/separator — optional label handled separately",
  Loader: "spinner — no text",
  Skeleton: "placeholder — no text",
  Button: "action label handled via control/label seam",
  Action: "action primitive — no body text literal",
  IdLink: "renders a ref link, not a text literal",
  FileLink: "renders a FileRef value (url/key), not a caller text literal",
  QueryView: "query-driven region — no caller text literal",
  For: "list comprehension — item text via bindings",
  CreateForm: "form shell — no body text literal",
  OperationForm: "form shell — no body text literal",
  WorkflowForm: "form shell — no body text literal",
  DestroyForm: "confirm form — no body text literal",
};

describe("text-escaping registry classification (auto-covers new primitives)", () => {
  it("every WALKER_PRIMITIVES entry is classified text or pinned non-text", () => {
    for (const name of Object.keys(WALKER_PRIMITIVES)) {
      const classified =
        Object.hasOwn(TEXT_PRIMITIVE_CALLS, name) || Object.hasOwn(NON_TEXT_PRIMITIVES, name);
      expect(
        classified,
        `primitive '${name}' is unclassified — add it to TEXT_PRIMITIVE_CALLS ` +
          "(if it renders a text literal, so the escaping gate covers it) or to " +
          "NON_TEXT_PRIMITIVES with a reason.",
      ).toBe(true);
    }
  });

  it("no stale classification entry references a removed primitive", () => {
    for (const name of [
      ...Object.keys(TEXT_PRIMITIVE_CALLS),
      ...Object.keys(NON_TEXT_PRIMITIVES),
    ]) {
      expect(Object.hasOwn(WALKER_PRIMITIVES, name), `'${name}' no longer exists`).toBe(true);
    }
  });

  it("every tested text primitive carries a tsx AND a heex renderer", () => {
    for (const name of Object.keys(TEXT_PRIMITIVE_CALLS)) {
      const def = WALKER_PRIMITIVES[name]!;
      expect(def.tsx, `${name} needs a tsx renderer`).toBeDefined();
      expect(def.heex, `${name} needs a heex renderer`).toBeDefined();
    }
  });
});

// The page body that instantiates every text primitive with the hostile
// literal — shared across all five target systems.
const BODY = `Stack {\n${Object.values(TEXT_PRIMITIVE_CALLS)
  .map((c) => `        ${c}`)
  .join(",\n")}\n      }`;

const frontendSystem = (platform: string): string => `
  system Demo {
    subdomain S { context C { } }
    ui Web {
      page Landing { route: "/" body: ${BODY} }
    }
    deployable api { platform: node, contexts: [C], port: 3000 }
    deployable web { platform: ${platform}, targets: api, ui: Web, port: 3001 }
  }
`;

const phoenixSystem = (): string => `
  system Demo {
    subdomain S {
      context C {
        aggregate Doc { name: string  derived display: string = name }
        repository Docs for Doc { }
      }
    }
    api DemoApi from S
    ui Web {
      page Landing { route: "/" body: ${BODY} }
    }
    deployable phoenixApp {
      platform: elixir, contexts: [C], serves: DemoApi,
      ui: Web, port: 4000
    }
  }
`;

/** Concatenate every generated file whose content mentions the escaped
 *  fragment or the raw payload — i.e. the page(s) the body rendered into.
 *  Scanning all files keeps the assertion path-agnostic across the four
 *  frontend layouts + Phoenix. */
function renderedText(files: Map<string, string>): string {
  let all = "";
  for (const content of files.values()) all += `\n${content}`;
  return all;
}

const CASES: ReadonlyArray<{ target: string; source: () => string }> = [
  { target: "react", source: () => frontendSystem("react") },
  { target: "vue", source: () => frontendSystem("vue") },
  { target: "svelte", source: () => frontendSystem("svelte") },
  { target: "angular", source: () => frontendSystem("angular") },
  { target: "phoenix", source: phoenixSystem },
];

describe("text-escaping end-to-end — hostile literal through every generator", () => {
  for (const { target, source } of CASES) {
    it(`${target}: the raw hostile payload never appears unescaped`, async () => {
      const files = await generateSystemFiles(source());
      const out = renderedText(files);
      // The contiguous raw payload can only appear if a target failed to
      // escape `<` (every target escapes it), so its absence proves no
      // text-position leak on this generator.
      expect(out).not.toContain(HOSTILE);
      // And the escaped form is present — the primitives DID render the
      // literal (a vacuous "no raw payload" pass is impossible).
      expect(out).toContain(ESCAPED_FRAGMENT);
    });
  }
});

// ---------------------------------------------------------------------------
// Attribute-position escaping (companion of the text funnel above).  A string
// literal in an ATTRIBUTE slot — an input `label:` (`unwrapAsAttr`) or any
// primitive's `testid:` (`testidAttr`) — is emitted inside `attr="…"`.  A JS
// backslash-escaped quote (`data-testid="a\"b"`) does NOT work: JSX/HTML
// attribute values aren't JS strings, so the value terminates at the inner
// `"`.  The value must be HTML-entity-escaped (`&quot;`), which decodes back
// in attribute values on every frontend.  Regression for the audit F3 finding.
// ---------------------------------------------------------------------------
describe("attribute-escaping — quotes in testid / label attributes (F3)", () => {
  // `.ddd` source fragment: a value with an embedded quote (`\"`), amp and `<`.
  // The parsed value is `a " b & c < d`.
  const ATTR_HOSTILE_SRC = 'a \\" b & c < d';
  const attrSystem = (platform: string): string => `
    system Demo {
      subdomain S { context C { } }
      ui Web {
        page Landing {
          route: "/"
          state { draft: string = "" }
          body: Stack {
            Field { "${ATTR_HOSTILE_SRC}", bind: draft },
            Button { "Go", testid: "${ATTR_HOSTILE_SRC}" }
          }
        }
      }
      deployable api { platform: node, contexts: [C], port: 3000 }
      deployable web { platform: ${platform}, targets: api, ui: Web, port: 3001 }
    }
  `;
  for (const platform of ["react", "vue"]) {
    it(`${platform}: an embedded quote is entity-escaped, never breaking out of the attribute`, async () => {
      const files = await generateSystemFiles(attrSystem(platform));
      const out = renderedText(files);
      // Escaping ran — the quote and amp became entities.
      expect(out).toContain("&quot;");
      expect(out).toContain("&amp;");
      // The attribute-breaking JS-escaped quote must NEVER appear inside a
      // testid or label attribute value (that is the pre-fix TS1382 defect).
      expect(out).not.toMatch(/data-testid="[^"\n]*\\"/);
      expect(out).not.toMatch(/label="[^"\n]*\\"/);
    });
  }
});

// Coverage for walker primitives that the previous test surface only
// touched incidentally (as filler in unrelated tests).  Each `it` block
// pins one variant of one primitive's React/Mantine emission.
//
// Pattern mirrors `walker-shell-primitives.test.ts`.  Each case isolates
// the primitive in a one-page system, generates, and asserts on the
// emitted TSX.  Where a primitive supports named args, at least one
// variant exercises a non-default value plus the `testid:` thread.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

async function emit(body: string): Promise<string> {
  const files = await generateSystemFiles(`
    system S {
      subdomain M { context C { } }
      ui WebApp {
        page P { route: "/p"  body: ${body} }
      }
      deployable api { platform: node, contexts: [C], port: 3000 }
      deployable web { platform: static, targets: api, ui: WebApp, port: 3001 }
    }
  `);
  const tsx = files.get("web/src/pages/p.tsx");
  if (!tsx) throw new Error(`MISSING; keys = ${[...files.keys()].join(", ")}`);
  return tsx;
}

describe("walker primitives — Heading", () => {
  it("Heading { text } emits <Title order={2}>text</Title> at default level", async () => {
    const tsx = await emit(`Heading { "Welcome" }`);
    expect(tsx).toMatch(/<Title order=\{2\}[^>]*>Welcome<\/Title>/);
  });

  it("Heading level: 1 overrides the default", async () => {
    const tsx = await emit(`Heading { "Top", level: 1 }`);
    expect(tsx).toMatch(/<Title order=\{1\}/);
  });

  it("Heading testid: threads onto the rendered <Title>", async () => {
    const tsx = await emit(`Heading { "X", testid: "page-h" }`);
    expect(tsx).toMatch(/<Title[^>]*\bdata-testid="page-h"/);
  });

  it("Heading size: emits a Mantine size= prop", async () => {
    const tsx = await emit(`Heading { "Big", size: "h1" }`);
    expect(tsx).toMatch(/<Title[^>]*\bsize="h1"/);
  });

  it("Heading weight: lands as inline style fontWeight", async () => {
    const tsx = await emit(`Heading { "Bold", weight: 700 }`);
    expect(tsx).toMatch(/fontWeight: 700/);
  });
});

describe("walker primitives — Card", () => {
  it('Card { "title" } emits a Mantine <Card> with a level-3 <Title>', async () => {
    const tsx = await emit(`Card { "Profile" }`);
    expect(tsx).toMatch(/<Card[^>]*>/);
    expect(tsx).toMatch(/<Title order=\{3\}>Profile<\/Title>/);
  });

  it("Card { title, ...children } wraps children below the title", async () => {
    const tsx = await emit(`Card { "Bio", Text { "Hello" } }`);
    expect(tsx).toMatch(/<Title order=\{3\}>Bio<\/Title>/);
    expect(tsx).toMatch(/<Text>Hello<\/Text>/);
  });

  it('Card { title, variant: "raised" } emits a shadow prop instead of withBorder', async () => {
    const tsx = await emit(`Card { "Hero", variant: "raised" }`);
    expect(tsx).toMatch(/<Card[^>]*\bshadow=/);
    expect(tsx).not.toMatch(/<Card[^>]*\bwithBorder/);
  });

  it("Card testid: threads onto the rendered <Card>", async () => {
    const tsx = await emit(`Card { "X", testid: "info-card" }`);
    expect(tsx).toMatch(/<Card[^>]*\bdata-testid="info-card"/);
  });
});

describe("walker primitives — Icon", () => {
  it("Icon { svg } emits an inline span with dangerouslySetInnerHTML", async () => {
    const tsx = await emit(`Icon { svg: "<svg viewBox='0 0 1 1'/>" }`);
    expect(tsx).toMatch(/<span className="loom-icon"[^>]*dangerouslySetInnerHTML/);
    expect(tsx).toMatch(/<svg viewBox='0 0 1 1'\/>/);
  });

  it("an unlabelled Icon is decorative — aria-hidden hides it from assistive tech", async () => {
    const tsx = await emit(`Icon { svg: "<svg/>" }`);
    expect(tsx).toMatch(/<span className="loom-icon" aria-hidden="true"/);
  });

  it("a labelled Icon becomes a named img (role=img + aria-label), not aria-hidden", async () => {
    const tsx = await emit(`Icon { svg: "<svg/>", label: "Search" }`);
    expect(tsx).toMatch(/role="img" aria-label="Search"/);
    expect(tsx).not.toContain('aria-hidden="true"');
  });

  it("Icon size: lands as a loom-icon-<size> modifier class", async () => {
    const tsx = await emit(`Icon { svg: "<svg/>", size: "lg" }`);
    expect(tsx).toMatch(/className="loom-icon loom-icon-lg"/);
  });

  it("Icon testid: threads onto the inline span", async () => {
    const tsx = await emit(`Icon { svg: "<svg/>", testid: "logo" }`);
    expect(tsx).toMatch(/<span[^>]*\bdata-testid="logo"/);
  });
});

describe("walker primitives — CodeBlock", () => {
  // The React emitter accepts both shapes: `source:` named arg (the
  // historical surface, used by `web/src/examples/loom-landing.ddd`) and
  // a positional first arg (the Phoenix surface, used by
  // `test/generator/elixir/heex-section-sticky-codeblock-icon.test.ts`).
  // These tests pin both — see `src/generator/react/walker/primitives/code-block.ts`.
  it("CodeBlock { source:, language: } (named) emits a <pre><code class=language-…>", async () => {
    const tsx = await emit(`CodeBlock { source: "const x = 1", language: "ts" }`);
    expect(tsx).toMatch(/<pre className="loom-code-block"/);
    expect(tsx).toMatch(/<code className="language-ts">const x = 1<\/code>/);
  });

  it("CodeBlock { positional, language: } also threads the source", async () => {
    const tsx = await emit(`CodeBlock { "const y = 2", language: "ts" }`);
    expect(tsx).toMatch(/<code className="language-ts">const y = 2<\/code>/);
  });

  it("named `source:` wins over a positional arg when both are supplied", async () => {
    const tsx = await emit(`CodeBlock { "ignored", source: "const z = 3", language: "ts" }`);
    expect(tsx).toMatch(/<code className="language-ts">const z = 3<\/code>/);
    expect(tsx).not.toMatch(/ignored/);
  });

  it("CodeBlock title: emits a wrapping <div> with the title header", async () => {
    const tsx = await emit(`CodeBlock { source: "npm i", title: "Install", language: "bash" }`);
    expect(tsx).toMatch(/<div className="loom-code-block-title">Install<\/div>/);
    expect(tsx).toMatch(/<code className="language-bash">npm i<\/code>/);
  });

  it("CodeBlock testid: threads onto the outer wrapper", async () => {
    const tsx = await emit(`CodeBlock { source: "x", language: "ts", testid: "snippet" }`);
    expect(tsx).toMatch(/\bdata-testid="snippet"/);
  });
});

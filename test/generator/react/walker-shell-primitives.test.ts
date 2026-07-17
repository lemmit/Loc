// shell primitives (Breadcrumbs / Paper / Skeleton / Alert).
//
// Page-chrome primitives that the scaffold archetype path
// composes inline; the walker now exposes them so explicit pages
// can compose the same chrome by hand.  Together with the other walker primitives
// they cover the typical "container + state-cued content" shape
// of a list/detail page.
//
// What this test pins:
//   1. Breadcrumbs { ...children, testid? } — wraps each positional
//      child as a breadcrumb (Mantine renders separators
//      automatically; shadcn uses a flex row).
//   2. Paper { ...children, padding?, testid? } — surface container
//      with consistent padding + border + subtle shadow.
//   3. Skeleton { height?, count?, testid? } — loading placeholder.
//      `count > 1` emits a stacked group of placeholders.
//   4. Alert { message, color?, title?, testid? } — error / info
//      callout.
//   5. All four accept the standard `testid:` named arg and
//      thread it to the rendered root element.

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

describe("shell primitives", () => {
  it("Breadcrumbs { Anchor, Anchor, Text } emits a Mantine <Breadcrumbs>", async () => {
    const tsx = await emit(
      `Breadcrumbs { Anchor { "Home", to: "/" }, Anchor { "Orders", to: "/orders" }, Text { "Detail" } }`,
    );
    expect(tsx).toMatch(/import \{[^}]*\bBreadcrumbs\b/);
    expect(tsx).toMatch(/<Breadcrumbs>/);
    expect(tsx).toMatch(/<Anchor[^>]*to="\/"/);
    expect(tsx).toMatch(/<Anchor[^>]*to="\/orders"/);
    expect(tsx).toMatch(/<Text>Detail<\/Text>/);
    expect(tsx).toMatch(/<\/Breadcrumbs>/);
  });

  it("Breadcrumbs testid lands on the root element", async () => {
    const tsx = await emit(`Breadcrumbs { Text { "X" }, testid: "page-crumbs" }`);
    expect(tsx).toMatch(/<Breadcrumbs[^>]*\bdata-testid="page-crumbs"/);
  });

  it("Paper { ...children } wraps in a Mantine <Paper> with default padding", async () => {
    const tsx = await emit(`Paper { Text { "body" } }`);
    expect(tsx).toMatch(/import \{[^}]*\bPaper\b/);
    expect(tsx).toMatch(/<Paper p="md">/);
    expect(tsx).toMatch(/<Text>body<\/Text>/);
  });

  it("Paper padding: overrides the default", async () => {
    const tsx = await emit(`Paper { Text { "x" }, padding: "lg" }`);
    expect(tsx).toMatch(/<Paper p="lg">/);
  });

  it("Paper testid lands on the root", async () => {
    const tsx = await emit(`Paper { Text { "x" }, testid: "shell" }`);
    expect(tsx).toMatch(/<Paper [^>]*\bdata-testid="shell"/);
  });

  it("Skeleton {} emits a single Mantine <Skeleton> at default height", async () => {
    const tsx = await emit(`Skeleton {}`);
    expect(tsx).toMatch(/import \{[^}]*\bSkeleton\b/);
    // Decorative loading placeholder → hidden from assistive tech.
    expect(tsx).toMatch(/<Skeleton height=\{ 28 \} radius="sm" aria-hidden="true" \/>/);
  });

  it("Skeleton { count: 5 } emits a stacked group of skeleton lines", async () => {
    const tsx = await emit(`Skeleton { count: 5 }`);
    // The group container is aria-hidden (the whole placeholder is decorative).
    expect(tsx).toMatch(/<Stack gap="xs" aria-hidden="true">/);
    expect(tsx).toMatch(/Array\.from\(\{ length: 5 \}\)\.map/);
    expect(tsx).toMatch(/<Skeleton key=\{i\} height=\{ 28 \} radius="sm" \/>/);
  });

  it("Skeleton { height: 60, count: 3 } honours both args", async () => {
    const tsx = await emit(`Skeleton { height: 60, count: 3 }`);
    expect(tsx).toMatch(/Array\.from\(\{ length: 3 \}\)/);
    expect(tsx).toMatch(/<Skeleton key=\{i\} height=\{ 60 \}/);
  });

  it("Skeleton testid lands on the root", async () => {
    const tsx = await emit(`Skeleton { testid: "loading" }`);
    expect(tsx).toMatch(/<Skeleton[^>]*\bdata-testid="loading"/);
  });

  it("Alert { message } emits a default-color alert", async () => {
    const tsx = await emit(`Alert { "Couldn't load" }`);
    expect(tsx).toMatch(/import \{[^}]*\bAlert\b/);
    expect(tsx).toMatch(/<Alert color="red" variant="light">Couldn't load<\/Alert>/);
  });

  it('Alert { message, color: "yellow", title: "Heads up" } threads both', async () => {
    const tsx = await emit(`Alert { "Disk almost full", color: "yellow", title: "Heads up" }`);
    expect(tsx).toMatch(
      /<Alert color="yellow"[^>]*title="Heads up"[^>]*>Disk almost full<\/Alert>/,
    );
  });

  it("Alert testid lands on the root", async () => {
    const tsx = await emit(`Alert { "err", testid: "load-error" }`);
    expect(tsx).toMatch(/<Alert[^>]*\bdata-testid="load-error"/);
  });
});

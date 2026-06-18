// Route-driven Playwright smoke spec — framework-neutral (navigates
// param-less page routes and asserts the URL); shared by the React,
// Svelte, and Vue frontends.  Extracted from src/generator/react/index.ts.

import type { UiIR } from "../../ir/types/loom-ir.js";

/** Auto-generated minimal Playwright smoke: every param-less page this
 *  ui declares navigates and loads.  Driven by route (not by importing
 *  the page objects) so it stays correct regardless of how the ui's
 *  pages map onto page-object files.  Richer per-page scenarios live
 *  in the page objects under e2e/pages/ and the generated
 *  `*.ui.spec.ts`. */
export function smokeSpec(ui: UiIR): string {
  // Auto-generated minimal Playwright smoke: every param-less page this
  // ui declares navigates and loads.  Driven by route (not by importing
  // the page objects) so it stays correct regardless of how the ui's
  // pages map onto page-object files — a custom-page ui emits
  // `pages/<page>.ts` (class `<Page>Page`), a scaffold ui emits
  // `pages/<aggregate>.ts` (class `<Agg>ListPage`), and a ui covers only
  // the aggregates it actually shows.  The old per-served-aggregate
  // `import { <Agg>ListPage } from "./pages/<agg>"` assumed the scaffold
  // shape for every served aggregate and broke (module-not-found →
  // Playwright "No tests found" → non-zero exit) on any ui with custom or
  // partial pages.  Richer per-page scenarios live in the page objects
  // under e2e/pages/ and the generated `*.ui.spec.ts`.
  const cases: string[] = [];
  for (const page of ui.pages) {
    // Parameterised routes (`/x/:id`) need a seeded entity — out of scope
    // for a smoke; they're exercised by the per-page specs.
    if (page.params.length > 0) continue;
    const route = page.route;
    if (!route || route.includes(":")) continue;
    const routeRe = `${route.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
    // Title qualifies the page by its `area` containment path so role-named
    // pages (`List`/`Detail`, repeated across per-aggregate areas) yield
    // distinct test titles (`Orders List loads`, `Products List loads`).
    const title = [...(page.area ?? []).map(titleCase), page.name].join(" ");
    cases.push(
      `test(${JSON.stringify(`${title} loads`)}, async ({ page }) => {\n` +
        `  await page.goto(${JSON.stringify(route)});\n` +
        `  await expect(page).toHaveURL(new RegExp(${JSON.stringify(routeRe)}));\n` +
        `});`,
    );
  }
  // A ui made up entirely of parameterised pages would otherwise produce a
  // spec with zero tests — which Playwright reports as "No tests found"
  // and exits non-zero.  Fall back to loading the SPA root.
  if (cases.length === 0) {
    cases.push(
      `test("app root loads", async ({ page }) => {\n` +
        `  await page.goto("/");\n` +
        `  await expect(page.locator("body")).toBeVisible();\n` +
        `});`,
    );
  }
  return `// Auto-generated smoke spec.
import { test, expect } from "./fixtures";

${cases.join("\n\n")}
`;
}

// `orders` → `Orders` for a readable, unique smoke-test title segment.
function titleCase(segment: string): string {
  return segment.length === 0 ? segment : segment[0]!.toUpperCase() + segment.slice(1);
}

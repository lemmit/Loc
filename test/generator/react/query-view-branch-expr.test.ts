// F2-CFE-3 — a `QueryView` branch that renders a JSX BRACE BLOCK.
//
// Every `QueryView` branch is spliced into a JS EXPRESSION slot: the pack
// template emits `{ <query>.data && … && ( <branch> ) }`.  Most primitives put
// an element there and are fine.  `For` does not — its child form is
// `{rows.map((r, i) => …)}`, and in expression position that leading `{` opens
// an OBJECT LITERAL:
//
//   { itemAll.data && itemAll.data.items.length > 0 && (
//     {itemAll.data.items.map((r, rIdx) => ( … ))}     // <-- does not parse
//   ) }
//
// So `QueryView { of: X.all, data: rows => For { each: rows, r => … } }` — the
// canonical hand-written list body — emitted a page the generated project
// could not build at all.  It now goes through the existing `wrapMultiRoot`
// seam (`<>…</>`), the same one a multi-root `Table` uses in this same slot.
//
// The strict-template frameworks put the branch in a markup BLOCK (Vue
// `v-if`, Svelte `{#if}`, Angular `@if`) where a child form is already legal,
// and they omit `wrapMultiRoot` — so their output is untouched.  Feliz and
// Flutter have the same class of defect through their own emitters (a bare
// `yield!` inside a lambda body; a `...` spread in expression position) and
// belong to those packets, not this seam.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

async function pageFor(platform: string, body: string): Promise<string> {
  const files = await generateSystemFiles(`
    system Demo {
      subdomain S {
        context C {
          aggregate Item { name: string }
          repository Items for Item { }
        }
      }
      api Api from S
      ui Web {
        api C: Api
        page P1 { route: "/p1" body: ${body} }
      }
      storage loomDb { type: postgres }
      resource st { for: C, kind: state, use: loomDb }
      deployable api { platform: node, contexts: [C], dataSources: [st], serves: Api, port: 3000 }
      deployable web { platform: ${platform}, targets: api, ui: Web { C: api }, port: 3001 }
    }
  `);
  for (const [path, src] of files) {
    if (!path.startsWith("web/src")) continue;
    if (/p1/.test(path)) return src;
  }
  throw new Error(`no page emitted for ${platform}`);
}

const FOR_BODY = `QueryView { of: C.Item.all, data: rows => For { each: rows, r => Text { r.name } } }`;
const ELEMENT_BODY = `QueryView { of: C.Item.all, data: rows => Text { "ok" } }`;

describe("QueryView branch in expression position", () => {
  it("react: a `For` data branch is fragment-wrapped so the page parses", async () => {
    const tsx = await pageFor("react", FOR_BODY);
    expect(tsx).toContain("<>{itemAll.data.items.map((r, rIdx) => (");
    expect(tsx).toContain("))}</>");
    // The bare brace block in expression position is what did not parse:
    // `&& (` on one line followed by a line whose first non-space char is `{`.
    expect(tsx).not.toMatch(/&&\s*\(\s*\n\s*\{[A-Za-z_$]/);
  });

  it("react: an ELEMENT data branch is untouched (no gratuitous fragment)", async () => {
    const tsx = await pageFor("react", ELEMENT_BODY);
    // (the literal rides the i18n catalog, hence the `t(…)` hole)
    expect(tsx).toMatch(/<Text>\{t\("page\.P1\.text\.[a-z0-9]+", "ok"\)}<\/Text>/);
    expect(tsx).not.toMatch(/<><Text>/);
  });

  // The markup-block frameworks never had the defect and must not change.
  it("vue: renders the `For` inside a v-for template, unwrapped", async () => {
    const vue = await pageFor("vue", FOR_BODY);
    expect(vue).toContain('<template v-for="(r, rIdx) in itemAll.data.items" :key="rIdx">');
    expect(vue).not.toContain("<>");
  });

  it("svelte: renders the `For` as an {#each} block, unwrapped", async () => {
    const sv = await pageFor("svelte", FOR_BODY);
    expect(sv).toContain("{#each itemAll.data.items as r, rIdx (rIdx)}");
    expect(sv).not.toContain("<>");
  });
});

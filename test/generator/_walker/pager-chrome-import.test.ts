// A paged `Table`'s pager chrome must bring its own `t` into scope.
//
// `i18n-emit.ts` deliberately offers two spellings of the same translate call:
// `translateCall` registers the `t` import and then emits; `translateExpr`
// only emits.  The second exists for chrome that lands in a HOISTED CHILD file
// — on Vue/Svelte/Angular a `DataGrid`'s markup is emitted into its own
// component, so the PAGE's import map is the wrong place for its `t` and the
// child's renderer places the import itself.  `localizedChromeText` and
// `localizedChromeIcuText` therefore take the no-registration path.
//
// A plain `Table`'s pager is NOT that case: it renders straight into the page
// body.  So nothing registered the import and the page emitted
//
//     {t("chrome.prev", "Prev")}   {t("chrome.pageOf", "Page {page} of {pages}", …)}
//
// against an unresolvable name — TS2304, twice, in every generated project
// with a paged list and i18n on.  The existing safety net could not see it
// either: `wirePackChromeImport` greps for `PACK_CHROME_T_CALL` (`t("pack.`),
// and these keys are `chrome.*`.
//
// It stayed latent because the PR-scoped react build job compiles a slim
// subset of examples, and the one fixture with a paged list + extractable
// strings was not in it — the same shape of coverage gap #2489 closed for the
// degradation gate.
//
// The invariant is not "the import line exists" but the one that actually
// matters: EVERY `t(` call in an emitted page file has a `t` binding in that
// file.  Asserted that way so it keeps holding if the chrome keys, the shim
// path, or the set of translated slots change.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

/** Page files per frontend, and how each brings the shim's `t` into scope. */
const TARGETS = [
  { framework: "react", pages: /\/src\/pages\/.*\.tsx$/ },
  { framework: "vue", pages: /\/src\/pages\/.*\.vue$/ },
  { framework: "svelte", pages: /\+page\.svelte$/ },
  { framework: "angular", pages: /\/src\/app\/pages\/.*\.component\.ts$/ },
] as const;

/** A paged list + at least one authored user-visible string (so the catalog is
 *  non-empty and i18n turns on), which is exactly the shape that was broken. */
const SYSTEM = (framework: string): string => `
system Shop {
  subdomain S {
    context Sales {
      aggregate Order with crudish { code: string }
      repository Orders for Order {
        find recent(): Order paged
      }
    }
  }
  api SalesApi from S
  storage pg { type: postgres }
  resource st { for: Sales, kind: state, use: pg }
  ui Web {
    framework: ${framework}
    api Sales: SalesApi
    // The authored string lives on a DIFFERENT page.  i18n is a ui-wide
    // decision (a non-empty catalog turns it on), so this is what turns the
    // runtime on WITHOUT giving the paged page below a translated slot of its
    // own — otherwise that slot registers the t import via translateCall and
    // masks the pager's missing registration entirely.  (That masking is why
    // the bug survived: most real pages carry a heading.)
    page Home {
      route: "/"
      body: Heading { "Home" }
    }
    page Orders {
      route: "/orders"
      body: QueryView { of: Sales.Order.all, data: rows => Table {
        Column { "Code", o => o.code },
        rows: rows
      } }
    }
  }
  deployable api { platform: node, contexts: [Sales], dataSources: [st], serves: SalesApi, port: 3000 }
  deployable web { platform: static, targets: api, ui: Web { Sales: api }, port: 3001 }
}
`;

/** Every `t(`-calling page file that does NOT also bind `t`.  Returns the
 *  offending paths so a failure names them. */
function unboundTCalls(files: Map<string, string>, pages: RegExp): string[] {
  const bad: string[] = [];
  for (const [path, content] of files) {
    if (!pages.test(path)) continue;
    if (!/\bt\(/.test(content)) continue;
    // Any binding form counts: a named import (`import { t } from …`), an
    // Angular class member (`protected readonly t = t`), or a local alias.
    const bound =
      /\bimport\s*\{[^}]*\bt\b[^}]*\}/.test(content) || /\breadonly t = t\b/.test(content);
    if (!bound) bad.push(path);
  }
  return bad;
}

describe("a paged Table's pager brings its own `t` into scope", () => {
  for (const target of TARGETS) {
    it(`${target.framework}: no page calls \`t(\` without binding it`, async () => {
      const files = await generateSystemFiles(SYSTEM(target.framework));
      const pages = [...files.keys()].filter((k) => target.pages.test(k));
      expect(pages.length, `no page files matched for ${target.framework}`).toBeGreaterThan(0);

      // The fixture must actually reach the pager, or this test proves nothing.
      const emitted = [...files].filter(([k]) => target.pages.test(k));
      expect(
        emitted.some(([, c]) => c.includes("chrome.prev")),
        `${target.framework}: fixture no longer renders pager chrome — this test would pass vacuously`,
      ).toBe(true);

      expect(
        unboundTCalls(files, target.pages),
        `${target.framework}: page calls \`t(\` with no \`t\` in scope (TS2304)`,
      ).toEqual([]);
    }, 120_000);
  }
});

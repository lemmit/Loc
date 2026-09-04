// A hand-written page that reads a ZERO-PARAMETER find must emit a call the
// emitted hook's own signature accepts (field-test finding B1).
//
// The defect: `QueryView { of: Tracking.Issue.openIssues }` over
// `find openIssues(): Issue[] where …` emits `useOpenIssuesIssue()` — the
// walker's `adjustFindHookArgs` builds a query bag only when the call site
// passed arguments — against `export function useOpenIssuesIssue(query:
// OpenIssuesQuery)`.  Every JS frontend rejected it (TS2554 "Expected 1
// arguments, but got 0" from react `tsc`, `vue-tsc`, `svelte-check` and
// `ng build`), and had it ever run, `Object.entries(undefined)` would have
// thrown inside `queryFn` so the QueryView took its `error:` branch.
//
// The invariant asserted here is ARITY, not spelling: the number of arguments
// the emitted call site passes is compared against the number of parameters
// the emitted declaration REQUIRES (those without a default).  A future
// emitter that fixes this by rendering `{}` at the call site instead of
// defaulting the parameter still passes; one that reintroduces the mismatch by
// any route fails.  The compile tier (`generated-react-build` and its
// vue/svelte/angular twins) is what proves the arity rule corresponds to what
// the type checkers accept; this is its per-PR, seconds-scale twin.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

/** The model: a zero-parameter find, plus a hand-written page whose
 *  `QueryView` reads it.  `openIssues` takes no arguments, so the walker has
 *  nothing to render into a query bag — the exact shape of the finding. */
const SRC = (platform: string, design: string) => `
system Fable {
  subdomain Core {
    context Tracking {
      enum IssueStatus { Open, InProgress, Closed }

      aggregate Issue {
        title: string
        status: IssueStatus
        derived display: string = title
      }

      repository Issues for Issue {
        find openIssues(): Issue[] where this.status != Closed
        find byStatus(status: IssueStatus): Issue[] where this.status == status
      }
    }
  }

  api TrackingApi from Core

  ui WebApp {
    api Tracking: TrackingApi

    page Board {
      route: "/board"
      title: "Board"
      body: Stack {
        QueryView {
          of: Tracking.Issue.openIssues,
          loading: Skeleton { count: 3 },
          error: Alert { "Couldn't load issues" },
          empty: Empty { "Nothing open." },
          data: rows => Table {
            rows: rows,
            Column { "Title", i => Text { i.title } }
          }
        }
      }
    }
  }

  storage primary { type: postgres }
  resource appState { for: Tracking, kind: state, use: primary }

  deployable api {
    platform: node
    contexts: [Tracking]
    dataSources: [appState]
    serves: TrackingApi
    port: 3000
  }

  deployable webApp {
    platform: ${platform}
    targets: api
    ui: WebApp { Tracking: api }
    port: 3001
    design: ${design}
  }
}
`;

/** Split a parameter/argument list on TOP-LEVEL commas — the emitted lists
 *  carry nested `<>`/`{}`/`()` (`MaybeRefOrGetter<Q>`, `() => ({})`), so a
 *  bare `.split(",")` would miscount. */
function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    // `=>` is an arrow, not a closing angle bracket — counting its `>` would
    // drive the depth negative on `query: () => Q` and split the wrong commas.
    const isArrow = ch === ">" && text[i - 1] === "=";
    if (ch === "(" || ch === "[" || ch === "{" || ch === "<") depth++;
    else if (!isArrow && (ch === ")" || ch === "]" || ch === "}" || ch === ">")) depth--;
    if (ch === "," && depth === 0) {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim() !== "") out.push(current);
  return out.map((s) => s.trim()).filter((s) => s !== "");
}

/** The text between `<needle>(` and its matching `)`.
 *
 *  The `(` must IMMEDIATELY follow the needle.  Searching for the next `(`
 *  after the needle anywhere would latch onto the wrong parenthesis — an
 *  emitted page names the hook in its import line first (`import {
 *  useOpenIssuesIssue } from …`), and the next `(` in the file may belong to a
 *  wrapper (`reactive(useOpenIssuesIssue())`) or to unrelated markup, which
 *  reads as "one argument was passed" and silently defeats the check. */
function parenBodyAfter(text: string, needle: string): string | undefined {
  const open = text.indexOf(`${needle}(`);
  if (open < 0) return undefined;
  let depth = 0;
  for (let i = open + needle.length; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return text.slice(open + needle.length + 1, i);
    }
  }
  return undefined;
}

/** Parameters the declaration REQUIRES: no default (`=`), not optional (`?:`),
 *  not a rest element. */
function requiredParamCount(paramList: string): number {
  return splitTopLevel(paramList).filter((p) => {
    // Arrow types (`query: () => Q`) carry an `=` that is NOT a default —
    // erase them before looking for the initializer.
    const withoutArrows = p.replaceAll("=>", "");
    return !withoutArrows.includes("=") && !p.startsWith("...") && !/^\w+\?/.test(p);
  }).length;
}

interface FrontendCase {
  readonly label: string;
  readonly platform: string;
  readonly design: string;
  /** Where the emitted find hooks live. */
  readonly apiModule: string;
  /** The page file whose body calls the hook. */
  readonly page: string;
}

const CASES: readonly FrontendCase[] = [
  {
    label: "react",
    platform: "react",
    design: "mantine",
    apiModule: "web_app/src/api/issue.ts",
    page: "web_app/src/pages/board.tsx",
  },
  {
    label: "vue",
    platform: "vue",
    design: "vuetify",
    apiModule: "web_app/src/api/issue.ts",
    page: "web_app/src/pages/board.vue",
  },
  {
    label: "svelte",
    platform: "svelte",
    design: "shadcnSvelte",
    apiModule: "web_app/src/lib/api/issue.ts",
    page: "web_app/src/routes/(app)/board/+page.svelte",
  },
  {
    label: "angular",
    platform: "angular",
    design: "angularMaterial",
    apiModule: "web_app/src/api/issue.ts",
    page: "web_app/src/app/pages/board.component.ts",
  },
];

const HOOK = "useOpenIssuesIssue";
const PARAM_HOOK = "useByStatusIssue";

describe("a page over a zero-parameter find calls the hook with an accepted arity", () => {
  for (const c of CASES) {
    it(`${c.label}: \`${HOOK}\` needs no argument the call site cannot supply`, async () => {
      const files = await generateSystemFiles(SRC(c.platform, c.design));

      const api = files.get(c.apiModule);
      const page = files.get(c.page);
      expect(api, `${c.label}: no ${c.apiModule} emitted`).toBeDefined();
      expect(page, `${c.label}: no ${c.page} emitted`).toBeDefined();

      const decl = parenBodyAfter(api as string, `export function ${HOOK}`);
      expect(decl, `${c.label}: ${c.apiModule} declares no ${HOOK}`).toBeDefined();

      const call = parenBodyAfter(page as string, HOOK);
      expect(call, `${c.label}: ${c.page} never calls ${HOOK}`).toBeDefined();

      const required = requiredParamCount(decl as string);
      const passed = splitTopLevel(call as string).length;
      expect(
        passed,
        `${c.label}: ${c.page} calls ${HOOK} with ${passed} argument(s) but ` +
          `${c.apiModule} requires ${required} — "Expected ${required} arguments, but got ` +
          `${passed}" under the frontend's type checker (declared as \`(${decl})\`)`,
      ).toBeGreaterThanOrEqual(required);
    }, 60_000);

    // Non-vacuity: the arity rule must still BITE somewhere, or an emitter that
    // defaulted EVERY query parameter would sail through the case above while
    // silently letting a real filter find be called with nothing.
    it(`${c.label}: a find WITH a parameter still requires its argument`, async () => {
      const files = await generateSystemFiles(SRC(c.platform, c.design));
      const api = files.get(c.apiModule);
      const decl = parenBodyAfter(api as string, `export function ${PARAM_HOOK}`);
      expect(decl, `${c.label}: ${c.apiModule} declares no ${PARAM_HOOK}`).toBeDefined();
      expect(
        requiredParamCount(decl as string),
        `${c.label}: ${PARAM_HOOK} takes a \`status\` filter — defaulting it would let a ` +
          `call site silently query with no filter at all`,
      ).toBe(1);
    }, 60_000);
  }
});

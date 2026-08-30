// ---------------------------------------------------------------------------
// `QueryView { of: <handle>.<Agg>.all, single: true, data: row => … }` types its
// data-lambda binding.
//
// `singleAggregateOfQuery` resolved the aggregate from the `of:` expression by
// taking ONE hop off the receiver chain.  That is right for
// `<handle>.<Agg>.byId(id)` — a method call whose receiver ends at the
// aggregate — and wrong for `<handle>.<Agg>.all`, which is a plain member chain
// whose last hop is the VERB.  So `recv.member` was `"all"`, the
// `aggregatesByName` lookup missed, `childParamTypes` fell back to the parent
// map, and every `OperationForm { row.<op> }` / `Action { row.<op> }` inside the
// lambda degraded to
//     Form(row.<op>): 'row' is not an in-scope aggregate instance
// on react / vue / svelte / feliz / flutter, and to NOTHING at all on Angular
// (its forked `renderOperationForm` returns a null resolution).  Nothing raised
// a `loom.*`; the operation simply vanished from the page.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const HOST: Record<string, string> = {
  react: "static",
  vue: "static",
  svelte: "static",
  angular: "static",
  feliz: "feliz",
  flutter: "flutter",
};

const sys = (framework: string, query: string) => `
system QvSingle {
  subdomain S {
    context Ops {
      aggregate Item {
        name: string
        active: bool
        operation activate(reason: string) { active := true }
      }
      repository Items for Item { }
    }
  }
  ui App {
    framework: ${framework}
    api Ops: OpsApi
    page Kitchen {
      route: "/kitchen/:id"
      body: Stack {
        QueryView {
          of: ${query},
          single: true,
          loading: Skeleton { count: 1 },
          error: Alert { "err" },
          empty: Empty { "none" },
          data: row => OperationForm { row.activate }
        }
      }
    }
  }
  api OpsApi from S
  storage primary { type: postgres }
  resource st { for: Ops, kind: state, use: primary }
  deployable api { platform: node contexts: [Ops] dataSources: [st] serves: OpsApi port: 4400 }
  deployable app { platform: ${HOST[framework]} targets: api ui: App { Ops: api } port: 3007 }
}`;

/** The PAGE the frontend renders — not the whole project.  Scoped deliberately:
 *  the generated api module declares `useActivateItem` whatever the page does
 *  with it, so a project-wide scan would have made the "the op survived"
 *  assertion vacuous (it did — Angular passed the mutation on the api module
 *  alone). */
const PAGE_FILE =
  /(pages?\/kitchen(_page|\.component)?\.(tsx|vue|ts|dart)|routes\/.*kitchen.*\+page\.svelte|src\/App\.fs)$/;

async function rendered(framework: string, query: string): Promise<string> {
  const files = await generateSystemFiles(sys(framework, query));
  let out = "";
  for (const [p, c] of files) if (PAGE_FILE.test(p)) out += `\n${c}`;
  expect(out, `no Kitchen page emitted for ${framework}`).not.toBe("");
  return out;
}

// The degradation wording `emitFormOfOperation` (and the Angular/Feliz/Flutter
// forks) fall back to.  Its ABSENCE is the fix; `FALLBACK_MARKERS` in the
// showcase matrix cannot see this wording, which is why five frontends stayed
// green on the same cell.
const NOT_IN_SCOPE = /is not an in-scope aggregate instance/;

describe.each([
  "react",
  "vue",
  "svelte",
  "angular",
  "feliz",
  "flutter",
])("%s — single QueryView over `.all`", (framework) => {
  it("types the data-lambda binding, so the operation form survives", async () => {
    const src = await rendered(framework, "Ops.Item.all");
    expect(src, `${framework}: the op form degraded to a comment`).not.toMatch(NOT_IN_SCOPE);
    if (framework === "flutter") {
      // Flutter's pack ships no `primitive-modal` template and its forked
      // `renderOperationForm` matches only the by-name shape, so the binding
      // now resolves but there is still nothing to render.  That residue is
      // its own ledger row (`flutter-modal-instance-operationform`); what
      // this slice owns is that the residue is a SYNTACTICALLY INERT, VISIBLE
      // marker rather than the resolution failure — Flutter's pack fallback
      // for a missing template is a Dart LINE comment, illegal in the
      // expression position this slot occupies.
      expect(src).toMatch(/renders no operation-form trigger/);
      expect(src, "flutter: a line comment here would not compile").not.toMatch(
        /flutter pack: no renderer for "primitive-modal"/,
      );
      return;
    }
    // …and the operation actually reached the emitted app.  Every other target
    // spells the mutation hook `useActivateItem` / `activateItem`; assert the
    // op name is present rather than a per-framework call shape.
    expect(src, `${framework}: no trace of the 'activate' operation`).toMatch(/[Aa]ctivateItem/);
  });

  it("still resolves the `byId(...)` shape it always did", async () => {
    const src = await rendered(framework, "Ops.Item.byId(id)");
    expect(src).not.toMatch(NOT_IN_SCOPE);
  });
});

it("does not step past a verb that is itself a declared aggregate", async () => {
  // `aggregatesByName` wins over the verb set, so an aggregate named `All`
  // still resolves as the aggregate rather than being skipped as a verb.
  const files = await generateSystemFiles(`
system VerbName {
  subdomain S {
    context Ops {
      aggregate All {
        name: string
        operation touch() { name := name }
      }
      repository Alls for All { }
    }
  }
  ui App {
    framework: react
    api Ops: OpsApi
    page Kitchen {
      route: "/kitchen/:id"
      body: Stack {
        QueryView { of: Ops.All.byId(id), single: true, data: row => OperationForm { row.touch } }
      }
    }
  }
  api OpsApi from S
  storage primary { type: postgres }
  resource st { for: Ops, kind: state, use: primary }
  deployable api { platform: node contexts: [Ops] dataSources: [st] serves: OpsApi port: 4400 }
  deployable app { platform: static targets: api ui: App { Ops: api } port: 3007 }
}`);
  const page = [...files].find(([p]) => /kitchen\.tsx$/.test(p))?.[1] ?? "";
  expect(page).not.toBe("");
  expect(page).not.toMatch(NOT_IN_SCOPE);
});

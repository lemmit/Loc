// ---------------------------------------------------------------------------
// An unrecognised NAMED argument must not SWALLOW the content it carries.
//
// `Tab`'s caption is positional 0.  `emitTabs` read it unconditionally and
// treated `slice(1)` as the panel, so `Tab { title: "One", Text { "first" } }`
// — where the only positional is the BODY — turned the body into the caption
// (rendered as the indexed fallback "Tab 1") and left the panel empty:
//
//     <Tabs.Tab value="tab-1">Tab 1</Tabs.Tab>
//     <Tabs.Panel value="tab-1">{/* missing tab body */}</Tabs.Panel>
//
// on every frontend, with `"first"` still shipped to translators as a live
// catalog key — the exact defect class #2567 and the `Tab`/`Column` placement
// gate were built to close, one argument position over.
//
// The rule is now the one `emitCard` already used for its title: positional 0
// is the caption only when it is TEXT-LIKE; a CALL there is body.  That covers
// the swallow on the seven targets; naming the unrecognised `title:` itself is
// an IR gate (`loom.page-primitive-unknown-arg` — see IMPL-NOTES.md), which is
// the honest half and is not this file's subject.
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

const sys = (framework: string, deployables: string) => `
system TabArg {
  subdomain S {
    context Ops {
      aggregate Item { name: string }
      repository Items for Item { }
    }
  }
  ui App {
    framework: ${framework}
    page Home {
      route: "/"
      body: Stack {
        Tabs {
          Tab { title: "One", Text { "swallowed-one" } },
          Tab { "Two", Text { "kept-two" } }
        }
      }
    }
  }
  api OpsApi from S
  storage primary { type: postgres }
  resource st { for: Ops, kind: state, use: primary }
  ${deployables}
}`;

const staticSys = (framework: string) =>
  sys(
    framework,
    `deployable api { platform: node contexts: [Ops] dataSources: [st] serves: OpsApi port: 4400 }
  deployable app { platform: ${HOST[framework]} targets: api ui: App port: 3007 }`,
  );

const heexSys = () =>
  sys(
    "phoenixLiveView",
    `deployable api { platform: elixir contexts: [Ops] dataSources: [st] serves: OpsApi ui: App port: 4400 }`,
  );

const HOME_FILE =
  /(pages?\/home(_page|\.component)?\.(tsx|vue|ts|dart)|routes\/\(app\)\/\+page\.svelte|src\/App\.fs|live\/home_live\.ex)$/;

async function homePage(source: string, label: string): Promise<string> {
  const files = await generateSystemFiles(source);
  let out = "";
  for (const [p, c] of files) if (HOME_FILE.test(p)) out += `\n${c}`;
  expect(out, `no Home page emitted for ${label}`).not.toBe("");
  return out;
}

describe.each([
  "react",
  "vue",
  "svelte",
  "angular",
  "feliz",
  "flutter",
])("%s — Tab with an unrecognised named arg", (framework) => {
  it("still renders the panel body", async () => {
    const src = await homePage(staticSys(framework), framework);
    expect(src, `${framework}: the tab body was swallowed by the caption slot`).toMatch(
      /swallowed-one/,
    );
    expect(src, `${framework}: the drop marker is still emitted`).not.toMatch(/missing tab body/);
    // The well-formed sibling is untouched — the caption is still consumed as
    // the caption there, not re-rendered into the panel.
    expect(src).toMatch(/kept-two/);
  });
});

it("phoenixLiveView — still renders the panel body", async () => {
  const src = await homePage(heexSys(), "heex");
  expect(src, "heex: the tab body was swallowed by the caption slot").toMatch(/swallowed-one/);
  expect(src).toMatch(/kept-two/);
});

it("a text-like caption is still consumed as the caption, not duplicated into the body", async () => {
  const src = await homePage(staticSys("react"), "react");
  // `Tab { "Two", … }` — exactly one occurrence (the trigger), never a second
  // in the panel.  The regression this guards is over-correcting the rule into
  // "every positional is body".
  expect(src.match(/Two/g)?.length).toBe(1);
});

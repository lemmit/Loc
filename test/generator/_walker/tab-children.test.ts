// ---------------------------------------------------------------------------
// A `Tab` panel renders EVERY body child — every one after the first was
// dropped, on all SEVEN targets (A7, the #2567 `Card` class).
//
// `emitTabs` read the panel body as ONE expression (`tabPositionals[1]`), and
// the HEEx engine carried the identical line (`body: pos[1]`).  So
// `Tab { "Ovw", Text { "A" }, Text { "B" } }` rendered `A` and silently deleted
// `B` — while the exact same body under a `Stack` worked.  The give-away that
// it was a DROP rather than a language limit: the deleted literal still
// reached `.loom/messages.en.json`, so translators got a key nothing renders.
//
// A tab panel is a children container like `Stack`/`Card` and now joins its
// children the same way.  The two packs that emit a PROGRAMMING LANGUAGE take
// them UNJOINED (`bodyChildren`) and join them their own way: an F#
// `prop.children [ … ]` list needs `;` between elements (a bare newline reads
// as function application — §24) and a Dart `TabBarView` takes exactly ONE
// widget per tab, so several fold into a `Column`.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

/** Which deployable platform hosts a given ui framework. */
const HOST: Record<string, string> = {
  react: "static",
  vue: "static",
  svelte: "static",
  angular: "static",
  feliz: "feliz",
  flutter: "flutter",
};

const sys = (framework: string, body: string) => `
system TabChildren {
  subdomain S {
    context Ops {
      aggregate Job { name: string }
      repository Jobs for Job { }
    }
  }
  ui App {
    framework: ${framework}
    page Home {
      route: "/"
      body: ${body}
    }
  }
  api OpsApi from S
  storage primary { type: postgres }
  resource st { for: Ops, kind: state, use: primary }
  deployable api { platform: node contexts: [Ops] dataSources: [st] serves: OpsApi port: 4400 }
  deployable app { platform: ${HOST[framework]} targets: api ui: App port: 3007 }
}`;

/** The emitted page source, whatever file the framework puts it in. */
async function pageSource(framework: string, body: string): Promise<string> {
  const files = await generateSystemFiles(sys(framework, body));
  let out = "";
  for (const [p, c] of files) {
    if (/\/pages?\/|\/routes\/|App\.fs$|\.dart$|home\.(tsx|vue|svelte|ts|html)$/.test(p)) {
      out += `\n${c}`;
    }
  }
  expect(out, `no page source emitted for ${framework}`).not.toBe("");
  return out;
}

/** The rendered marker, ignoring the message catalog: the dropped literal was
 *  always PRESENT in `.loom/messages.en.json`, so a bare `toContain("second")`
 *  over the whole tree would have passed against the bug. */
const rendered = (src: string, text: string): boolean =>
  src.split("\n").some((l) => l.includes(text) && !/^\s*["']?(page|pack)\./.test(l.trim()));

describe("a Tab panel keeps every body child", () => {
  for (const framework of Object.keys(HOST)) {
    it(`${framework} — the second panel child still renders`, async () => {
      const src = await pageSource(
        framework,
        `Tabs { Tab { "Ovw", Text { "tab-first" }, Text { "tab-second" } } }`,
      );
      expect(rendered(src, "tab-first"), `${framework} lost the FIRST child`).toBe(true);
      expect(rendered(src, "tab-second"), `${framework} dropped the Tab's second child`).toBe(true);
    });
  }

  it("feliz separates the panel's children with `;` — a bare newline is F# application", async () => {
    const src = await pageSource(
      "feliz",
      `Tabs { Tab { "Ovw", Text { "tab-first" }, Text { "tab-second" } } }`,
    );
    expect(src).toMatch(/tab-first[^\n]*\]; Html\.p/);
  });

  it("flutter folds several panel children into ONE TabBarView widget", async () => {
    const src = await pageSource(
      "flutter",
      `Tabs { Tab { "Ovw", Text { "tab-first" }, Text { "tab-second" } } }`,
    );
    // A `TabBarView` takes one widget per tab — two comma-separated siblings
    // would shift every later tab onto the wrong panel.
    expect(src).toMatch(
      /TabBarView\(children: <Widget>\[ Column\(mainAxisSize: MainAxisSize\.min, crossAxisAlignment: CrossAxisAlignment\.start, children: <Widget>\[[^\]]*tab-first[^\]]*tab-second[^\]]*\]\) \]\)/,
    );
  });

  it("a single-child Tab is unchanged — no separator, no Column fold", async () => {
    const react = await pageSource("react", `Tabs { Tab { "Ovw", Text { "only-child" } } }`);
    expect(rendered(react, "only-child")).toBe(true);
    const flutter = await pageSource("flutter", `Tabs { Tab { "Ovw", Text { "only-child" } } }`);
    expect(flutter).not.toContain(
      "crossAxisAlignment: CrossAxisAlignment.start, children: <Widget>[Text",
    );
  });

  it("a bodyless Tab still renders its placeholder comment", async () => {
    const src = await pageSource("react", `Tabs { Tab { "Ovw" } }`);
    expect(src).toContain("missing tab body");
  });

  it("HEEx — the parallel engine renders every panel child too", async () => {
    // Phoenix/LiveView does not consume `walkBody`; `heex-primitives.ts` had
    // the identical single-slot read and needed the identical fix.  Pinned so
    // the two engines cannot drift apart again.
    const files = await generateSystemFiles(`
system TabChildrenHeex {
  subdomain M {
    context C {
      aggregate Doc { name: string }
      repository Docs for Doc { }
    }
  }
  api DemoApi from M
  ui DemoUi {
    page Landing {
      route: "/"
      body: Tabs { Tab { "Ovw", Text { "tab-first" }, Text { "tab-second" } } }
    }
  }
  deployable phoenixApp { platform: elixir, contexts: [C], serves: DemoApi, ui: DemoUi, port: 4000 }
}`);
    const page = [...files.entries()].find(([p]) => /landing_live\.ex$/.test(p))?.[1];
    expect(page, "no landing LiveView emitted").toBeDefined();
    // Both children inside the SAME tabpanel div.
    const panel = page!.slice(page!.indexOf('role="tabpanel"'));
    expect(panel).toContain("tab-first");
    expect(panel, "heex dropped the Tab's second child").toContain("tab-second");
  });
});

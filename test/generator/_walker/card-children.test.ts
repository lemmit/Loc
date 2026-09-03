// ---------------------------------------------------------------------------
// `Card` renders EVERY body child — the second one was dropped on all six
// frontends.
//
// `emitCard` read the body as ONE expression (`positionals[1]`, or
// `positionals[0]` when the card carries no title).  A card with a title and
// more than one child therefore rendered the first child and silently deleted
// the rest — `Card { "T", Text { … }, Slot { } }` lost the `Slot`, which is how
// this surfaced: the children a caller passed a component never appeared,
// while the same body under a `Stack` worked.
//
// The two packs that emit a PROGRAMMING LANGUAGE rather than markup take the
// children unjoined (`contentChildren`) and join them their own way, because
// the walker's `\n`-joined block is a syntax hazard in both: an F#
// `prop.children [ … ]` list needs `;` between elements (a bare newline reads
// as function application — §24) and a Dart `<Widget>[ … ]` literal needs `,`.
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

const sys = (framework: string, componentBody: string) => `
system CardSlot {
  subdomain S {
    context Ops {
      aggregate Job { name: string }
      repository Jobs for Job { }
    }
  }
  ui App {
    framework: ${framework}
    component Panel(title: string) {
      body: ${componentBody}
    }
    page Home {
      route: "/"
      body: Stack { Panel("Hi", Text { "passed-in" }) }
    }
  }
  api OpsApi from S
  storage primary { type: postgres }
  resource st { for: Ops, kind: state, use: primary }
  deployable api { platform: node contexts: [Ops] dataSources: [st] serves: OpsApi port: 4400 }
  deployable app { platform: ${HOST[framework]} targets: api ui: App port: 3007 }
}`;

/** The emitted source of the `Panel` component, whatever file the framework
 *  puts it in (`Panel.tsx` / `Panel.vue` / `Panel.svelte` / `Panel.ts`, the
 *  Feliz `App.fs` module, the Flutter `components.dart`). */
async function panelSource(framework: string, componentBody: string): Promise<string> {
  const files = await generateSystemFiles(sys(framework, componentBody));
  let out = "";
  for (const [p, c] of files) {
    if (/(^|\/)Panel\.(tsx|vue|svelte|ts)$/.test(p) || /(App\.fs|components\.dart)$/.test(p)) {
      out += `\n${c}`;
    }
  }
  expect(out, `no Panel source emitted for ${framework}`).not.toBe("");
  return out;
}

/** How each frontend spells the children slot (the `renderChildrenSlot` seam;
 *  React alone takes the shared JSX default). */
const CHILDREN_SLOT: Record<string, string> = {
  react: "{children}",
  vue: "<slot />",
  svelte: "{@render children?.()}",
  angular: "<ng-content></ng-content>",
  feliz: "(props.children)",
  flutter: "(child ?? const SizedBox.shrink())",
};

describe("Card keeps every body child", () => {
  for (const framework of Object.keys(HOST)) {
    it(`${framework} — a title + Text + Slot renders the Slot too`, async () => {
      const src = await panelSource(framework, `Card { "T", Text { "a" }, Slot { } }`);
      // The FIRST child still renders (it always did) …
      expect(src).toContain("a");
      // … and so does the second, which used to be dropped outright.
      expect(src, `${framework} dropped the Card's second child`).toContain(
        CHILDREN_SLOT[framework]!,
      );
    });
  }

  it("feliz separates the card's children with `;` — a bare newline is F# application", async () => {
    const src = await panelSource("feliz", `Card { "T", Text { "a" }, Slot { } }`);
    // Both children on ONE `prop.children [ … ]` line, `;`-separated.  A
    // `\n`-joined pair inside this inline list is the §24 curry error.
    expect(src).toMatch(/Html\.p \[[^\n]*\]; \(props\.children\)/);
  });

  it("flutter separates the card's children with `,` — a Dart list literal", async () => {
    const src = await panelSource("flutter", `Card { "T", Text { "a" }, Slot { } }`);
    expect(src).toMatch(/Text\([^\n]*\), \(child \?\? const SizedBox\.shrink\(\)\)\]/);
  });

  it("CONTROL: HEEx was already correct — its own engine renders every child", async () => {
    // Phoenix/LiveView does not consume `walkBody`; `heex-walker-core.ts` walks
    // Card as a `takesChildren` container, so the second child never went
    // missing there.  Pinned so the two engines cannot drift apart again.
    const files = await generateSystemFiles(`
system CardSlotHeex {
  subdomain M {
    context C {
      aggregate Doc { name: string }
      repository Docs for Doc { }
    }
  }
  api DemoApi from M
  ui DemoUi {
    component Panel(title: string) {
      body: Card { "T", Text { "a" }, Slot { } }
    }
    page Landing { route: "/"  body: Stack { Heading { "Hi" } } }
  }
  storage loomDb { type: postgres }
  resource cState { for: C, kind: state, use: loomDb }
  deployable phoenixApp { platform: elixir, contexts: [C], dataSources: [cState], serves: DemoApi, ui: DemoUi, port: 4000 }
}`);
    const comps = [...files.entries()].find(([p]) => p.endsWith("/ui_components.ex"))![1];
    expect(comps).toContain("{render_slot(@inner_block)}");
    expect(comps).toContain("a");
  });

  it("a single-child Card is unchanged — one child, no separator", async () => {
    const src = await panelSource("react", `Card { "T", Slot { } }`);
    expect(src).toContain("{children}");
    expect(src).toMatch(/<Card[^>]*>\n\s+<Title order=\{3\}>/);
  });

  it("a titleless Card renders all of its children", async () => {
    const src = await panelSource("react", `Card { Text { "a" }, Slot { } }`);
    expect(src).toContain("{children}");
    expect(src).toContain("a");
  });
});

// ---------------------------------------------------------------------------
// Cross-target NAVIGATION-DESTINATION gate (audit finding A12).
//
// `Anchor(to:)` / `Button(to:)` used to read their destination through
// `stringOrRefArgValue`, which accepted exactly two shapes — a string literal
// and a bare route-param ref — and returned `undefined` for anything else.  The
// primitives then rendered WITHOUT navigation and said nothing: a computed
// destination (`to: "/greet/" + who`) produced a link that goes nowhere and a
// button that does nothing, on SIX of the seven frontends, with no diagnostic
// anywhere in the pipeline.  HEEx — which runs its own engine — always rendered
// it correctly, which is what fixed the intended semantics.
//
// The destination now rides `emitExpr`, i.e. the same per-target leaf table the
// rest of the body uses, and reaches markup through `navAttrFragment` (a static
// path stays a plain attribute; a computed one binds the framework's way).
//
// Two properties, per target:
//   1. DYNAMIC — the computed destination reaches BOTH the anchor's attribute
//      and the button's navigate call, in that target's own language.
//   2. STATIC — a literal path still renders as the plain attribute each pack
//      has always emitted (the byte-identity claim of the fix).
//
// The regexes accept any of the attribute NAMES a pack may pick (`to` on a
// React `RouterLink`, `href` on a plain `<a>`, `routerLink` on Angular), since
// the attribute name is the pack's decision and the spelling is the target's.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const BODY = `Stack {
        Anchor { "Greet", to: "/greet/" + who },
        Button { "Go", to: "/greet/" + who },
        Anchor { "Static", to: "/x" }
      }`;

const spaSystem = (platform: string): string => `
  system Demo {
    subdomain S { context C { } }
    ui Web {
      page Landing { route: "/" body: Stack { Text { "home" } } }
      page Greet(who: string) { route: "/greet/:who" body: ${BODY} }
    }
    storage loomDb { type: postgres }
    resource cState { for: C, kind: state, use: loomDb }
    deployable api { platform: node, contexts: [C], dataSources: [cState], port: 3000 }
    deployable web { platform: ${platform}, targets: api, ui: Web, port: 3001 }
  }
`;

// Phoenix SELF-HOSTS the ui (`targets:` is a validator error on a backend
// deployable), so its system shape differs — same page bodies.
const phoenixSystem = `
  system Demo {
    subdomain S {
      context C {
        aggregate Doc { name: string }
        repository Docs for Doc { }
      }
    }
    api DemoApi from S
    ui Web {
      page Landing { route: "/" body: Stack { Text { "home" } } }
      page Greet(who: string) { route: "/greet/:who" body: ${BODY} }
    }
    storage loomDb { type: postgres }
    resource cState { for: C, kind: state, use: loomDb }
    deployable phoenixApp {
      platform: elixir, contexts: [C], dataSources: [cState], serves: DemoApi,
      ui: Web, port: 4000
    }
  }
`;

interface Target {
  readonly name: string;
  readonly source: string;
  /** Emitted files carrying the Greet page's rendered body. */
  readonly page: RegExp;
  /** The computed destination bound as the anchor's link attribute. */
  readonly dynamicAnchor: RegExp;
  /** The computed destination reaching the button's navigate call. */
  readonly dynamicButton: RegExp;
  /** A literal path as the plain attribute the packs have always emitted. */
  readonly staticAnchor: RegExp;
}

const TARGETS: readonly Target[] = [
  {
    name: "react",
    source: spaSystem("react"),
    page: /\/src\/pages\/greet\.tsx$/,
    dynamicAnchor: /\b(to|href)=\{\("\/greet\/" \+ who\)\}/,
    dynamicButton: /navigate\(\("\/greet\/" \+ who\)\)/,
    staticAnchor: /\b(to|href)="\/x"/,
  },
  {
    name: "vue",
    source: spaSystem("vue"),
    page: /\/src\/pages\/greet\.vue$/,
    dynamicAnchor: /:(to|href)='\("\/greet\/" \+ who\)'/,
    dynamicButton: /navigate\(\("\/greet\/" \+ who\)\)/,
    staticAnchor: /\s(to|href)="\/x"/,
  },
  {
    name: "svelte",
    source: spaSystem("svelte"),
    page: /\+page\.svelte$/,
    dynamicAnchor: /\b(to|href)=\{\("\/greet\/" \+ who\)\}/,
    dynamicButton: /navigate\(\("\/greet\/" \+ who\)\)/,
    staticAnchor: /\b(to|href)="\/x"/,
  },
  {
    name: "angular",
    source: spaSystem("angular"),
    page: /\/src\/app\/pages\/greet\.component\.ts$/,
    dynamicAnchor: /\[(routerLink|href)\]='\("\/greet\/" \+ who\)'/,
    dynamicButton: /router\.navigateByUrl\(\("\/greet\/" \+ who\)\)/,
    // Angular binds even a static destination — `navAttrAlwaysBound`.
    staticAnchor: /\[(routerLink|href)\]='"\/x"'/,
  },
  {
    name: "feliz",
    source: spaSystem("feliz"),
    page: /src\/App\.fs$/,
    // F#, not JS: `prop.href` takes the expression directly.
    dynamicAnchor: /prop\.href \("\/greet\/" \+ who\)/,
    dynamicButton: /Router\.navigatePath\(\("\/greet\/" \+ who\)\)/,
    staticAnchor: /prop\.href "\/x"/,
  },
  {
    name: "flutter",
    source: spaSystem("flutter"),
    page: /lib\/pages\/greet_page\.dart$/,
    // Dart string literals are single-quoted.
    dynamicAnchor: /Navigator\.of\(context\)\.pushNamed\(\('\/greet\/' \+ who\)\)/,
    dynamicButton: /Navigator\.pushNamed\(context, \('\/greet\/' \+ who\)\)/,
    staticAnchor: /pushNamed\('\/x'\)/,
  },
  {
    name: "phoenixLiveView",
    source: phoenixSystem,
    page: /greet_live\.ex$/,
    // The reference implementation — HEEx already rendered both correctly.
    dynamicAnchor: /<\.link navigate=\{"\/greet\/" <> @who\}/,
    dynamicButton: /<\.button to=\{"\/greet\/" <> @who\}/,
    staticAnchor: /<\.link navigate=\{~p"\/x"\}/,
  },
];

/** The rendered page file(s) for a target, concatenated. */
async function renderGreet(t: Target): Promise<string> {
  const files = await generateSystemFiles(t.source);
  const matched = [...files].filter(([p]) => t.page.test(p));
  expect(
    matched.length,
    `${t.name}: no emitted path matched ${t.page} — the assertions below would be vacuous`,
  ).toBeGreaterThan(0);
  return matched.map(([, c]) => c).join("\n");
}

describe("computed `to:` destinations render on every frontend", () => {
  for (const t of TARGETS) {
    it(`${t.name}: an Anchor with a computed destination links to it`, async () => {
      expect(await renderGreet(t)).toMatch(t.dynamicAnchor);
    });

    it(`${t.name}: a Button with a computed destination navigates to it`, async () => {
      expect(await renderGreet(t)).toMatch(t.dynamicButton);
    });

    it(`${t.name}: a literal destination still renders as a static link`, async () => {
      expect(await renderGreet(t)).toMatch(t.staticAnchor);
    });
  }
});

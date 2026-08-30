// ---------------------------------------------------------------------------
// `navigate(<Page>)` as a STATEMENT in a page `action` body.
//
// docs/actions.md makes this THE supported spelling — the lambda form is
// refused by `loom.effect-in-lambda` — and it was the one call shape with no
// arm anywhere.  `emitStmt case "call"` fell through to the generic
// `${name}(${args});` line, so:
//
//   react / vue / svelte / angular  `navigate(/* unresolved: Other */ undefined)`
//                                   with no navigator bound  → TS2304
//   heex                            `|> tap(fn _ -> navigate(other) end)`
//                                   — undefined fn, unbound `other` → CompileError
//   feliz                           THREW out of `update-emit.ts`, killing
//                                   `ddd generate system` for the whole system
//
// …while the SAME call in `then:` position on the SAME page rendered correctly.
// That asymmetry is the shape of the fix: one resolver
// (`tryRenderNavigateCall`) now serves both positions on the shared walker, and
// the two engines that do not consume it (Feliz's MVU `update`, LiveView's pipe)
// each grew the matching arm.
//
// The action ctx also had to LEARN the route table: every shell built it
// without `pageRoutes`, so even a working navigate resolved the fallback
// `/<snake(Page)>` instead of the destination's declared `route:`.
//
// Flutter is the documented residue: a Riverpod `Notifier` method holds no
// `BuildContext`, so it keeps its visible `TODO(flutter full-parity)` comment.
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

/** `Other`'s route is deliberately NOT `/other`: the fallback the resolver uses
 *  when it has no route table is `/<snake(Page)>`, so a fixture whose declared
 *  route happens to equal the fallback cannot tell the two apart. */
const OTHER_ROUTE = "/elsewhere";

const sys = (framework: string) => `
system Nav {
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
      state { n: int = 0 }
      action go() {
        n := n + 1
        navigate(Other)
      }
      body: Stack { Button { "Go", onClick: go } }
    }
    page Other {
      route: "${OTHER_ROUTE}"
      body: Stack { Text { "there" } }
    }
  }
  api OpsApi from S
  storage primary { type: postgres }
  resource st { for: Ops, kind: state, use: primary }
  deployable api { platform: node contexts: [Ops] dataSources: [st] serves: OpsApi port: 4400 }
  deployable app { platform: ${HOST[framework]} targets: api ui: App port: 3007 }
}`;

/** The same system on Phoenix LiveView — HEEx has no separate frontend
 *  deployable; the elixir backend mounts the ui. */
const heexSys = () => `
system Nav {
  subdomain S {
    context Ops {
      aggregate Item { name: string }
      repository Items for Item { }
    }
  }
  ui App {
    framework: phoenixLiveView
    page Home {
      route: "/"
      state { n: int = 0 }
      action go() {
        n := n + 1
        navigate(Other)
      }
      body: Stack { Button { "Go", onClick: go } }
    }
    page Other {
      route: "${OTHER_ROUTE}"
      body: Stack { Text { "there" } }
    }
  }
  api OpsApi from S
  storage primary { type: postgres }
  resource st { for: Ops, kind: state, use: primary }
  deployable api { platform: elixir contexts: [Ops] dataSources: [st] serves: OpsApi ui: App port: 4400 }
}`;

const HOME_FILE =
  /(pages?\/home(_page|\.component)?\.(tsx|vue|ts|dart)|routes\/\(app\)\/\+page\.svelte|src\/App\.fs)$/;

async function homePage(framework: string): Promise<string> {
  const files = await generateSystemFiles(sys(framework));
  let out = "";
  for (const [p, c] of files) if (HOME_FILE.test(p)) out += `\n${c}`;
  expect(out, `no Home page emitted for ${framework}`).not.toBe("");
  return out;
}

/** The unresolved-page-ref sentinel `emitExpr` returns for a bare page ref —
 *  what the generic call line rendered the destination as. */
const UNRESOLVED = /unresolved: Other/;

/** How each frontend binds its navigator, and the navigation it must emit. */
const EXPECT: Record<string, { binds: RegExp; navigates: RegExp }> = {
  react: { binds: /const navigate = useNavigate\(\)/, navigates: /navigate\("\/elsewhere"\)/ },
  vue: { binds: /const router = useRouter\(\)/, navigates: /router\.push\("\/elsewhere"\)/ },
  // SvelteKit's `goto` is imported under the `navigate` alias — the import IS
  // the binding.
  svelte: {
    binds: /import \{ goto as navigate \} from "\$app\/navigation"/,
    navigates: /navigate\("\/elsewhere"\)/,
  },
  // Angular's action body is a class METHOD, so the injected member needs
  // `this.` — the template-position spelling (`router.…`) does not compile there.
  angular: {
    binds: /readonly router = inject\(Router\)/,
    navigates: /this\.router\.navigateByUrl\("\/elsewhere"\)/,
  },
  // Feliz's MVU arm returns a Cmd; `Router`/`Cmd` are opened by the app module.
  feliz: { binds: /Cmd\.navigatePath/, navigates: /Cmd\.navigatePath\("elsewhere"\)/ },
};

describe.each(Object.keys(EXPECT))("%s — navigate() in an action body", (framework) => {
  it("resolves the destination route and binds the navigator", async () => {
    const src = await homePage(framework);
    expect(src, `${framework}: the page ref stayed unresolved`).not.toMatch(UNRESOLVED);
    expect(src, `${framework}: navigator not bound`).toMatch(EXPECT[framework]!.binds);
    // The DECLARED route, not the `/<snake(Page)>` fallback the action ctx used
    // before it was handed the route table.
    expect(src, `${framework}: wrong (or no) destination route`).toMatch(
      EXPECT[framework]!.navigates,
    );
    expect(src, `${framework}: resolved the fallback route, not the declared one`).not.toMatch(
      /["/]other["/]/,
    );
  });
});

it("feliz: generating the system no longer throws", async () => {
  // The regression that killed `ddd generate system` outright: `update-emit.ts`
  // threw on the `private-operation` call rather than rendering a Cmd, so NO
  // file was written for ANY deployable in the system.
  await expect(generateSystemFiles(sys("feliz"))).resolves.toBeInstanceOf(Map);
});

it("heex: emits a real push_navigate pipe step, not a call to an undefined fn", async () => {
  const files = await generateSystemFiles(heexSys());
  const live = [...files].find(([p]) => /live\/home_live\.ex$/.test(p))?.[1] ?? "";
  expect(live, "no HomeLive emitted").not.toBe("");
  expect(live).toMatch(/push_navigate\(socket, to: ~p"/);
  // The CompileError shape: a bare `navigate(<unbound>)` inside a `tap`.
  expect(live, "heex: still calls an undefined `navigate/1`").not.toMatch(
    /tap\(fn _ -> navigate\(/,
  );
});

it("flutter: the Notifier residue stays a VISIBLE, compiling TODO", async () => {
  // A Riverpod `Notifier` method has no `BuildContext`, which is what
  // `Navigator.pushNamed` needs — so Flutter keeps the honest marker rather
  // than emitting Dart that cannot compile.  Pinned so the day it is fixed,
  // this test says so.
  const src = await homePage("flutter");
  expect(src).toMatch(/TODO\(flutter full-parity\).*navigate/);
});

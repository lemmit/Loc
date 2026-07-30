import { describe, expect, it } from "vitest";
import { generateSystems } from "../../src/system/index.js";
import { parseString } from "../_helpers/index.js";

// ---------------------------------------------------------------------------
// M-T9.24 F2 — `match { … }` used as a VALUE.
//
// The shared walker handled `match` in markup-CHILD position (`renderMatchChild`
// picks an element branch) but not in EXPRESSION position — a Text / Heading /
// Button label, a `Field error:`, the RHS of `state := …`, an operand of a
// string concat.  Those hit `emitExpr`'s default arm and emitted
// `{/* unsupported expr: match */ undefined}`: valid code, wrong value, on
// every frontend.  Silent, because it compiles.
//
// The fix folds the arms right into nested `exprTernary`s, which every target
// already implements in its own language — so one arm in the shared core lands
// the fix on all six frontends, in idiomatic form each (JSX/Vue/Svelte/Angular
// ternary, F# `if/then/else`, Dart conditional).  That breadth is the point of
// this test: it drives the same page through every frontend.
// ---------------------------------------------------------------------------

const source = (platform: string) => `
system MatchExpr {
  subdomain Ops {
    context Ops {
      aggregate Task with crudish {
        title: string
        score: int
      }
      repository Tasks for Task { }
    }
  }
  api OpsApi from Ops
  ui Web {
    api ops: OpsApi
    page Board {
      route: "/board"
      state { score: int = 0 }
      body: Stack {
        Text(match {
          score > 10 => "hot"
          score > 5 => "warm"
          else => "cold"
        })
      }
    }
  }
  storage primary { type: postgres }
  resource opsState { for: Ops, kind: state, use: primary }
  deployable svc {
    platform: node
    contexts: [Ops]
    dataSources: [opsState]
    serves: OpsApi
    port: 4000
  }
  deployable web {
    platform: ${platform}
    targets: svc
    ui: Web { ops: svc }
    port: 3000
  }
}
`;

async function pageFor(platform: string, match: (path: string) => boolean): Promise<string> {
  const { model, errors } = await parseString(source(platform));
  if (errors.length) throw new Error(`fixture has validation errors:\n${errors.join("\n")}`);
  const files = generateSystems(model).files;
  const hit = [...files].find(([p]) => match(p));
  if (!hit) throw new Error(`no page file for ${platform} in:\n${[...files.keys()].join("\n")}`);
  return hit[1];
}

describe("`match` in expression position", () => {
  it("folds into a ternary chain on every JSX-family frontend", async () => {
    const react = await pageFor("react", (p) => p.endsWith("src/pages/board.tsx"));
    expect(react).toContain(`((score > 10) ? "hot" : ((score > 5) ? "warm" : "cold"))`);

    const vue = await pageFor("vue", (p) => p.endsWith("src/pages/board.vue"));
    expect(vue).toContain(`((score > 10) ? "hot" : ((score > 5) ? "warm" : "cold"))`);

    const svelte = await pageFor("svelte", (p) => p.endsWith("board/+page.svelte"));
    expect(svelte).toContain(`((score > 10) ? "hot" : ((score > 5) ? "warm" : "cold"))`);

    // Angular reads signals, so the operands carry the call.
    const angular = await pageFor("angular", (p) => p.includes("board") && p.endsWith(".ts"));
    expect(angular).toContain(`((score() > 10) ? "hot" : ((score() > 5) ? "warm" : "cold"))`);
  });

  it("uses each non-JSX target's own conditional form", async () => {
    // Proof the fix rides the shared `exprTernary` seam rather than baking in
    // JS syntax: F# gets `if/then/else`, Dart a conditional over its state
    // object.  Neither frontend renders JSX at all.
    const feliz = await pageFor("feliz", (p) => p.endsWith("src/App.fs"));
    expect(feliz).toContain(
      `(if (model.Score > 10) then "hot" else (if (model.Score > 5) then "warm" else "cold"))`,
    );

    const flutter = await pageFor("flutter", (p) => p.includes("board") && p.endsWith(".dart"));
    expect(flutter).toContain(
      `((state.score > 10) ? 'hot' : ((state.score > 5) ? 'warm' : 'cold'))`,
    );
  });

  it("no longer emits the unsupported-expression marker", async () => {
    for (const platform of ["react", "vue", "svelte", "angular", "feliz", "flutter"]) {
      const { model } = await parseString(source(platform));
      for (const [path, content] of generateSystems(model).files) {
        expect(content, `${platform}: ${path}`).not.toContain("unsupported expr: match");
      }
    }
  });
});

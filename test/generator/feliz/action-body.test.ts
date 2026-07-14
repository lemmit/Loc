// Feliz frontend — MVU action-body coverage (M-T6.15).
//
// The `update` arm renders the full action-body statement/expression set the
// reference JSX walker handles: scalar AND collection state writes, `let`,
// bare expression statements, `call`s to a sibling action / ui function, plus
// the expression arms (predicate `match`, single-expr lambda, and the bounded
// collection/string method set).  These are pinned here; a comprehensive
// project exercising every arm is proven to `dotnet fable`-compile in CI.

import { describe, expect, it } from "vitest";
import { generateFelizForContexts } from "../../../src/generator/feliz/index.js";
import { buildLoomModel } from "../../_helpers/ir.js";

const SYS = `
system P {
  subdomain S { context C { } }
  ui WebApp {
    page Home {
      route: "/"
      state {
        items: string[]
        tags: string[]
        n: int = 0
        has: bool = false
        label: string = ""
        tier: string = ""
      }
      action bump() { n := n + 1 }
      action bumpTwice() { bump()  bump() }
      action addTag(t: string) { tags += t }
      action rmTag(t: string) { tags -= t }
      action probe(x: string) { has := items.contains(x) }
      action lower(s: string) { label := s.toLower() }
      action classify() {
        tier := match { n > 10 => "hi"  n > 0 => "mid"  else => "lo" }
      }
      body: Stack { Heading { "H", level: 1 }, Button { "b", onClick: bumpTwice } }
    }
  }
  deployable api { platform: node contexts: [C] port: 3000 }
  deployable web { platform: feliz targets: api ui: WebApp port: 3005 }
}`;

async function app(): Promise<string> {
  const model = await buildLoomModel(SYS);
  const sys = model.systems[0]!;
  const web = sys.deployables.find((d) => d.name === "web")!;
  return generateFelizForContexts([], sys, web).get("src/App.fs")!;
}

describe("feliz action-body (M-T6.15)", () => {
  it("scalar `+=` stays arithmetic; collection `+=`/`-=` become F# list ops", async () => {
    const fs = await app();
    expect(fs).toContain("{ model with N = (model.N + 1) }");
    // append (`@ [ v ]`) and remove-by-value (`List.filter`) — NOT `+`/`-`.
    expect(fs).toContain("{ model with Tags = (model.Tags @ [ t ]) }");
    expect(fs).toContain("{ model with Tags = (model.Tags |> List.filter (fun x -> x <> t)) }");
    expect(fs).not.toContain("model.Tags +");
  });

  it("a sibling-action call dispatches via Cmd.ofMsg (batched when repeated)", async () => {
    const fs = await app();
    expect(fs).toContain("| BumpTwice ->");
    expect(fs).toContain("model, Cmd.batch [ Cmd.ofMsg (Bump); Cmd.ofMsg (Bump) ]");
  });

  it("collection membership → List.contains; string method → .NET member", async () => {
    const fs = await app();
    expect(fs).toContain("{ model with Has = (List.contains x model.Items) }");
    expect(fs).toContain("{ model with Label = (s.ToLower()) }");
  });

  it("a predicate `match` renders an F# if/elif/else chain", async () => {
    const fs = await app();
    expect(fs).toContain(
      '{ model with Tier = (if (model.N > 10) then "hi" elif (model.N > 0) then "mid" else "lo") }',
    );
  });

  it("no silent-drop markers leak into the emitted F#", async () => {
    const fs = await app();
    expect(fs).not.toContain("// TODO feliz update");
    expect(fs).not.toContain("unsupported fs-expr");
  });
});

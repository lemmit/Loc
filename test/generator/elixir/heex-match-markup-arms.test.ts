// A `match` whose ARM VALUES are page PRIMITIVES must render HEEx's BLOCK
// `cond`, not its EXPRESSION `cond` — otherwise the emitted project does not
// COMPILE and the whole backend never boots.
//
// HEEx has two `cond` spellings and they are not interchangeable:
//
//   EXPRESSION   <%= cond do  p -> term  end %>        arms are Elixir terms
//   BLOCK        <%= cond do %>                        arms are MARKUP
//                  <% p -> %>
//                    <div>…</div>
//                <% end %>
//
// `renderMatch` only ever emitted the expression form. When an arm value was a
// primitive — which renders markup carrying its own `<%= … %>` / `<% end %>` —
// the outer `cond do` was opened and never closed, because its `end` landed
// inside the arm's nested block:
//
//   <%= cond do
//         @by_owner_owner != "" -> <%= cond do %>     ← two forms, interleaved
//     <% is_nil(@items) -> %>
//     …
//     <% end %>                                        ← closes the INNER one
//
// ** (TokenMissingError) missing terminator: end
//  128 │           cond do     ← unclosed delimiter
//  158 │            end        ← missing closing delimiter (expected "end")
//
// ── Why this is a compile failure and not a bad render ──────────────────────
// `mix compile` fails on the project, so `mix ecto.create` never runs and the
// app never starts. This is what the schemathesis elixir leg had been
// reporting (F27, found on run 33382822525): the leg could not fuzz at all,
// and its empty report upload was an honest empty rather than the dropped
// upload the other four legs had.
//
// The third bug in this lineage, all in the same function pair: `renderMatch`
// self-wraps in `<%= %>`, and (D6, `heex-vo-match-expr.test.ts`)
// `renderChild`/`renderInTemplate` wrapped it again. Here the wrapping is
// right and the FORM is wrong. Same root shape each time — HEEx distinguishes
// markup position from expression position and `match` straddles both.
//
// ── Verified beyond the emitted string ─────────────────────────────────────
// `web/src/examples/storefront-elixir.ddd` (a list page with two filter-driven
// finds, the real-world shape) was generated and compiled in a container:
// `mix compile` succeeds with the fix ("Generated phoenix_app app") and fails
// with the emitter arm reverted, reproducing the error above at the same file
// and the same line 158.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SYSTEM = (body: string): string => `
system Shop {
  subdomain S {
    context Sales {
      aggregate Order with crudish { status: string }
      repository Orders for Order { }
    }
  }
  api SalesApi from S
  storage pg { type: postgres }
  resource st { for: Sales, kind: state, use: pg }
  ui Web {
    framework: phoenixLiveView
    api Sales: SalesApi
    page Home {
      route: "/"
      state { count: int = 3 }
      body: ${body}
    }
  }
  deployable app {
    platform: elixir
    contexts: [Sales]
    dataSources: [st]
    serves: SalesApi
    ui: Web { Sales: app }
    port: 4000
  }
}
`;

async function homeLive(body: string): Promise<string> {
  const files = await generateSystemFiles(SYSTEM(body));
  const live = [...files].find(([p]) => p.endsWith("live/home_live.ex"))?.[1];
  expect(live, `no home_live.ex in: ${[...files.keys()].join(", ")}`).toBeDefined();
  return live as string;
}

/** Every `cond` opened in a template must be closed. Counting the two block
 *  delimiters is the cheap structural stand-in for the compile the runtime
 *  proof does — an unbalanced count IS the TokenMissingError. */
function condBalance(live: string): { opens: number; ends: number } {
  return {
    opens: (live.match(/<%= cond do %>/g) ?? []).length,
    ends: (live.match(/<% end %>/g) ?? []).length,
  };
}

describe("a `match` with MARKUP arms renders HEEx's block `cond`", () => {
  it("uses the block form, and every opened `cond` is closed", async () => {
    const live = await homeLive(
      'match { count > 1 => Card { Text("many") }, else => Card { Text("none") } }',
    );
    expect(live).toContain("<%= cond do %>");
    // The signature of the bug: an expression-form `cond do` with an arm whose
    // body is markup. `<%= cond do\n` (no closing `%>` on the line) is exactly
    // what could never be closed.
    expect(live).not.toMatch(/<%= cond do\n/);
    const { opens, ends } = condBalance(live);
    expect(opens).toBeGreaterThan(0);
    expect(ends).toBeGreaterThanOrEqual(opens);
  });

  it("a `cond` with no authored else still cannot raise CondClauseError", async () => {
    // `cond` raises at RENDER time when no arm matches, so the fallback is not
    // cosmetic: without it a page whose predicates all go false 500s on a live
    // request — a runtime fault a compile gate would never see.
    const live = await homeLive('match { count > 1 => Card { Text("many") } }');
    expect(live).toContain("<% true -> %>");
  });

  it("a TERM-armed match keeps the expression form", async () => {
    // The narrow fix must stay narrow. Arms that are plain Elixir terms have
    // always been correct in the expression form, and that output is what the
    // other value slots (attributes, `Stat` values) depend on.
    const live = await homeLive(
      'Stat { "tier", match { count > 5 => "many", count > 1 => "some", else => "none" } }',
    );
    expect(live).toContain("cond do");
    expect(live).not.toContain("<%= cond do %>");
  });

  it("MIXED arms — one markup, one term — stay valid", async () => {
    // Each arm is routed through `renderChild` individually, so a term arm
    // still gets its own `<%= … %>` inside the block form. A per-match
    // (rather than per-arm) decision would emit a bare term in markup position.
    const live = await homeLive('match { count > 1 => Card { Text("many") }, else => "none" }');
    expect(live).toContain("<%= cond do %>");
    const { opens, ends } = condBalance(live);
    expect(ends).toBeGreaterThanOrEqual(opens);
  });
});

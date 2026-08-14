// Two HEEx page-body expression bugs found while verifying the frontend
// intrinsics slice (#2471) against a real `mix compile` — both surfaced by
// `web/src/examples/expression-showcase.ddd`'s Kinds page, both pre-existing
// (confirmed via `git stash` + regenerate-on-plain-`main`, byte-identical
// broken output at the same lines).
//
// D5 — a VALUE-OBJECT construction collided with a WALKER PRIMITIVE of the
// same name.  `Money(9.99, "USD").currency` lowers to a `member` access on a
// `call` node with `callKind: "free"` (page-body call-kind resolution never
// sees the VO — see `resolveCallKind` in lower-expr.ts, which only resolves
// `"value-object-ctor"` when `env.ctx` is set, which UI/page-body lowering
// never sets).  `heex-walker-core.ts`'s `renderCall` therefore fell straight
// to the `WALKER_PRIMITIVES["Money"]` registry lookup — a REAL primitive
// (`Money(value, currency?, decimals?)` renders a `<span class="money">…`
// display widget, `heex-primitives.ts::renderMoney`) — producing that
// primitive's raw HEEx MARKUP in a VALUE position, with the trailing
// `.currency` appended as literal text after the closing tag:
//
//   <%= <span class="money">…</span>.currency %>
//
// invalid HEEx.  The shared JSX/Feliz/Flutter walker (`_walker/walker-
// core.ts`) already carries the fix for the SAME collision
// (`declaredValueObject`, added when the JSX frontends hit their own version
// of this bug — see its inline comment) — this is HEEx's independent parallel
// engine catching up.  Fixed by checking the call's NAME against the page's
// `valueObjectsByName` registry BEFORE the primitive lookup, and rendering a
// plain Elixir map (vanilla stores VOs as JSON, not `%Ctx.VO{}` structs) with
// positional args backfilled from the VO's declared field order — mirroring
// both the shared walker's approach and the domain-side `value-object-ctor`
// renderer (`render-expr.ts`).
//
// D6 — `match` self-wraps in `<%= %>` when rendered in template position
// (`renderMatch`), but `renderChild`/`renderInTemplate` — the two functions
// that place a value into a HEEx text slot — ALSO unconditionally wrap
// whatever `renderExpr` returns in `<%= %>`.  A `match` reaching a `Stat`'s
// value slot (routed through `renderInTemplate`) got wrapped twice:
//
//   <%= <%= cond do … end %> %>
//
// invalid HEEx (nested `<%= %>`).  Fixed by special-casing `child.kind ===
// "match"` in both functions, exactly like the pre-existing `isHEExCall`
// check just above it (a primitive call that already produces markup is
// rendered unwrapped too — same shape of fix, same file).
//
// Both fixtures below self-host (`contexts: […], dataSources: […]`) rather
// than reusing `expression-showcase.ddd`'s `targets: api` topology — that
// fixture's phoenixLiveView case leaves `web_app` with NO local domain
// knowledge (`elixir.ts` is correctly `isFrontend: false`, so the
// enrichment-level `contextNames` backfill that react/vue/svelte/angular/
// feliz/flutter get from `targets:` doesn't reach it — a separate,
// pre-existing test-topology gap, not touched here), which would make a VO
// genuinely unresolvable rather than exercising the fix.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SYSTEM = (body: string): string => `
system Shop {
  subdomain S {
    context Sales {
      valueobject Money {
        amount: decimal
        currency: string
      }
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
  return live!;
}

describe("HEEx page bodies — a value-object construction does not collide with a same-named primitive", () => {
  it('renders `Money(9.99, "USD").currency` as a plain map, not the Money display primitive\'s markup', async () => {
    const live = await homeLive('Text(Money(9.99, "USD").currency)');
    expect(live).toContain('%{amount: Decimal.new("9.99"), currency: "USD"}.currency');
    // The bug's signature: the display primitive's markup leaking into an
    // expression slot.
    expect(live).not.toContain('<span class="money"');
  });

  it("backfills positional args from the VO's declared field order", async () => {
    // Field order is amount, currency — a positional ctor binds by that
    // order even though this call passes them positionally, not by name.
    const live = await homeLive('Text(Money(9.99, "USD").amount)');
    expect(live).toContain('%{amount: Decimal.new("9.99"), currency: "USD"}.amount');
  });
});

describe("HEEx page bodies — `match` does not double-wrap in `<%= %>`", () => {
  it("a `match` in a value slot (Stat) renders with exactly one `<%= %>` wrapper", async () => {
    const live = await homeLive(
      'Stat { "tier", match { count > 5 => "many", count > 1 => "some", else => "none" } }',
    );
    expect(live).toContain("<%= cond do");
    expect(live).not.toContain("<%= <%=");
    expect(live).not.toContain("%> %>");
  });
});

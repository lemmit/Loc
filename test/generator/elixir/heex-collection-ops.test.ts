import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// Inline collection-op lambdas on Phoenix/HEEx (DEBT-31).
//
// `orders.filter(o => …)` / `.map(o => …)` in page-body expression
// position render on the JS frontends via the shared `emitExpr` (native
// `Array.prototype` methods).  HEEx runs a PARALLEL engine
// (`heex-walker-core.ts`); these ops aren't in the shared `isCollectionOp`
// catalogue, so they used to fall through to the generic method-call path
// — the callback lambda was hoisted into a `handle_event` clause and the
// op emitted as an invalid `recv.filter(event_1)` chain.  They now route
// to `renderCollectionOp` → `Enum.filter/2` / `Enum.map/2`, the Elixir
// idiom mirroring the JS frontends' native methods.
//
// (`sortBy` is intentionally NOT covered: it has no native JS array method
// and no runtime helper, so it's unsupported on the JS frontends too —
// there's no parity target to mirror.)
// ---------------------------------------------------------------------------

const phoenixSystem = (uiBody: string): string => `
  system Demo {
    subdomain M {
      context C {
        aggregate Doc { name: string  rank: int  derived display: string = name }
        repository Docs for Doc { }
      }
    }
    api DemoApi from M
    ui DemoUi {
      page Landing { route: "/" body: ${uiBody} }
    }
    deployable phoenixApp {
      platform: elixir, contexts: [C], serves: DemoApi, ui: DemoUi, port: 4000
    }
  }
`;

async function landingHeex(uiBody: string): Promise<string> {
  const files = await generateSystemFiles(phoenixSystem(uiBody));
  for (const [path, content] of files) {
    if (path.endsWith("/landing_live.ex")) return content;
  }
  throw new Error("Landing LiveView not found");
}

describe("HEEx inline collection-op lambdas (DEBT-31)", () => {
  it("renders a `filter` callback as `Enum.filter/2` with an inline `fn`", async () => {
    const heex = await landingHeex(
      `Stack { For { each: [1, 2, 3].filter(n => n > 1), n => Bold { "x" } } }`,
    );
    expect(heex).toContain("Enum.filter([1, 2, 3], fn n -> n > 1 end)");
    // The callback must NOT be hoisted to a handle_event clause, and the
    // raw JS-style `.filter(...)` chain must be gone.
    expect(heex).not.toMatch(/\.filter\(event_/);
    expect(heex).not.toContain("[1, 2, 3].filter(");
  });

  it("renders a `map` callback as `Enum.map/2`", async () => {
    const heex = await landingHeex(
      `Stack { For { each: [1, 2, 3].map(n => n), n => Bold { "x" } } }`,
    );
    expect(heex).toContain("Enum.map([1, 2, 3], fn n -> n end)");
    expect(heex).not.toMatch(/\.map\(event_/);
  });

  it("nests chained filter+map (Elixir has no fluent chain — composes inside-out)", async () => {
    const heex = await landingHeex(
      `Stack { For { each: [1, 2, 3].filter(n => n > 1).map(n => n), n => Bold { "x" } } }`,
    );
    expect(heex).toContain("Enum.map(Enum.filter([1, 2, 3], fn n -> n > 1 end), fn n -> n end)");
  });

  it("the callback param resolves to a bare local inside the body (no `@` assign, no event hoist)", async () => {
    const heex = await landingHeex(
      `Stack { For { each: [1, 2, 3].filter(n => n > 1), n => Bold { "x" } } }`,
    );
    expect(heex).not.toContain("@n");
    expect(heex).not.toMatch(/def handle_event\("event_/);
  });
});

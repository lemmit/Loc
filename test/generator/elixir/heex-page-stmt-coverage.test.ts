import { describe, expect, it } from "vitest";
import { walkBodyToHeex } from "../../../src/generator/elixir/heex-walker-core.js";
import type { ExprIR, PageIR, UiIR } from "../../../src/ir/types/loom-ir.js";
import { generateSystemFiles } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// Bucket E2 — Phoenix LiveView page statement coverage.
//
// The hoisted-handler `renderStmt` in `heex-walker-core.ts` used to handle
// only `assign` / `let` / `expression`; every other StmtIR kind that can
// reach a page event-handler block fell through to a `# TODO <kind>` line:
//
//   - `add` / `remove`  — compound `+=` / `-=` on a page-`state` field
//                         (scalar arithmetic) or list field (append/reject)
//   - `precondition`    — domain guard → flash + halt the socket pipe
//   - `requires`        — authorization guard → forbidden flash
//   - `emit` / `call` / `return` — defensive arms (not authorable in a page
//                         handler today, but no longer a TODO if reached)
//
// A page-body `new Part { … }` struct literal (an EntityPart BuilderCall)
// also emitted a `<%-- TODO: new … --%>` marker; it now renders a qualified
// Elixir struct literal mirroring the domain emitter.  EntityPart refs are
// aggregate-scoped, so a page can't author one through the public grammar —
// the `new` arm is exercised here white-box via `walkBodyToHeex`.
// ---------------------------------------------------------------------------

async function landingHeex(uiBody: string, extra = ""): Promise<string> {
  const src = `
    system Demo {
      subdomain M {
        context C {
          aggregate Doc { name: string  derived display: string = name }
          repository Docs for Doc { }
        }
      }
      api DemoApi from M
      ui DemoUi {
        page Landing {
          route: "/"
          state { count: int = 0  picked: string[] = [] }
          ${extra}
          body: ${uiBody}
        }
      }
      deployable phoenixApp {
        platform: elixir, contexts: [C], serves: DemoApi, ui: DemoUi, port: 4000
      }
    }
  `;
  const files = await generateSystemFiles(src);
  for (const [path, content] of files) {
    if (path.endsWith("/landing_live.ex")) return content;
  }
  throw new Error("Landing LiveView not found");
}

describe("HEEx page statement coverage (Bucket E2)", () => {
  it("scalar `+=` on a state field → pipe-assign with handler-scope read + arithmetic", async () => {
    const heex = await landingHeex(`Stack { Button { "inc", onClick: e => { count += 1 } } }`);
    expect(heex).toContain("|> assign(:count, socket.assigns.count + 1)");
    expect(heex).not.toMatch(/# TODO/);
  });

  it("scalar `-=` on a state field → subtraction", async () => {
    const heex = await landingHeex(`Stack { Button { "dec", onClick: e => { count -= 1 } } }`);
    expect(heex).toContain("|> assign(:count, socket.assigns.count - 1)");
    expect(heex).not.toMatch(/# TODO/);
  });

  it("collection `+=` on a list state field → list append", async () => {
    const heex = await landingHeex(`Stack { Button { "add", onClick: e => { picked += "x" } } }`);
    expect(heex).toContain('|> assign(:picked, socket.assigns.picked ++ ["x"])');
    expect(heex).not.toMatch(/# TODO/);
  });

  it("collection `-=` on a list state field → Enum.reject", async () => {
    const heex = await landingHeex(`Stack { Button { "rm", onClick: e => { picked -= "x" } } }`);
    expect(heex).toContain('|> assign(:picked, Enum.reject(socket.assigns.picked, &(&1 == "x")))');
    expect(heex).not.toMatch(/# TODO/);
  });

  it("`precondition` in a handler → flash + halt the socket pipe (no TODO)", async () => {
    const heex = await landingHeex(
      `Stack { Button { "go", onClick: e => { precondition count > 0 } } }`,
    );
    expect(heex).toContain(
      'then(fn socket -> if socket.assigns.count > 0, do: socket, else: put_flash(socket, :error, "Precondition failed: count > 0") end)',
    );
    expect(heex).not.toMatch(/# TODO/);
  });

  it("`requires` in a handler → forbidden flash (no TODO)", async () => {
    const heex = await landingHeex(
      `Stack { Button { "go", onClick: e => { requires count > 0 } } }`,
    );
    expect(heex).toContain('put_flash(socket, :error, "Forbidden: count > 0")');
    expect(heex).not.toMatch(/# TODO/);
  });

  it("never emits a TODO sentinel anywhere in the generated LiveView", async () => {
    const heex = await landingHeex(`Stack { Button { "inc", onClick: e => { count += 1 } } }`);
    expect(heex).not.toContain("# TODO");
    expect(heex).not.toContain("TODO:");
  });

  it("white-box: a `new Part { … }` body → a qualified struct literal, not a TODO marker", () => {
    // EntityPart refs are aggregate-scoped, so a page can't author one
    // through the grammar; drive the defensive `new` arm directly.
    const body: ExprIR = {
      kind: "new",
      partName: "Line",
      fields: [{ name: "sku", value: { kind: "literal", lit: "string", value: "abc" } }],
    };
    const page = {
      name: "Landing",
      params: [],
      state: [],
      derived: [],
      body,
    } as unknown as PageIR;
    const ui = { pages: [], components: [], helperImports: [] } as unknown as UiIR;
    const heex = walkBodyToHeex(
      body,
      page,
      ui,
      "PhoenixApp",
      new Map(),
      new Map(),
      new Map(),
      false,
      new Map([["Line", "PhoenixApp.Sales"]]),
    ).heex;
    expect(heex).toBe('%PhoenixApp.Sales.Line{sku: "abc"}');
    expect(heex).not.toContain("TODO");
    expect(heex).not.toContain("unsupported in page body");
  });

  it("white-box: a `new Part { … }` falls back to the app module when the part is unmapped", () => {
    const body: ExprIR = { kind: "new", partName: "Line", fields: [] };
    const page = {
      name: "Landing",
      params: [],
      state: [],
      derived: [],
      body,
    } as unknown as PageIR;
    const ui = { pages: [], components: [], helperImports: [] } as unknown as UiIR;
    const heex = walkBodyToHeex(body, page, ui, "PhoenixApp").heex;
    expect(heex).toBe("%PhoenixApp.Line{}");
    expect(heex).not.toContain("TODO");
  });
});

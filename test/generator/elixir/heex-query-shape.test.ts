import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// The LiveView QueryView derives the read's SHAPE; the `paged:` / `single:`
// flags are opt-ins on top.
//
// Both facts are properties of the FIND — `.all` returns the paged envelope
// (M-T2.6), `byId` returns one record — and the LiveView renderer used to take
// them from the author's flags ALONE.  A hand-written page omits both, which is
// the natural thing to write, and produced Elixir that raises or renders
// nothing:
//
//   - a list read without `paged:` assigned the `%{items, page, …}` ENVELOPE and
//     then asked `Enum.empty?/1` of it.  A 5-key map is never empty, so the
//     empty arm was dead code and `<.table rows={@items}>` iterated the map's
//     key/value PAIRS — `o.title` on a `{:page, 1}` tuple raises at render.
//   - a byId read without `single:` took the LIST cond, so `Enum.empty?/1` ran
//     against an `%Aggregate{}` struct — `Protocol.UndefinedError`, because a
//     struct is not Enumerable.
//
// The JSX walker had always derived paged-ness; HEEx runs a parallel engine and
// did not.  Both now go through the one `queryShape` derivation
// (`_walker/paged-query.ts`), which is what makes the two engines' answers
// impossible to disagree rather than merely equal today.
// ---------------------------------------------------------------------------

const phoenixSystem = (route: string, uiBody: string): string => `
  system Demo {
    subdomain M {
      context C {
        aggregate Doc with crudish { name: string  derived display: string = name }
        repository Docs for Doc {
          find named(name: string): Doc[] where this.name == name
        }
      }
    }
    api DemoApi from M
    ui DemoUi {
      api Api: DemoApi
      page Landing { route: "${route}" body: ${uiBody} }
    }
    storage pg { type: postgres }
    resource st { for: C, kind: state, use: pg }
    deployable phoenixApp {
      platform: elixir, contexts: [C], dataSources: [st], serves: DemoApi, port: 4000
      ui: DemoUi { Api: phoenixApp }
    }
  }
`;

async function landingHeex(route: string, uiBody: string): Promise<string> {
  const files = await generateSystemFiles(phoenixSystem(route, uiBody));
  for (const [path, content] of files) {
    if (path.endsWith("/landing_live.ex")) return content;
  }
  throw new Error(`Landing LiveView not found among: ${[...files.keys()].join(", ")}`);
}

describe("HEEx QueryView — the read's shape is derived, not declared", () => {
  it("a hand-written list read unwraps the envelope without a `paged:` flag", async () => {
    const heex = await landingHeex(
      "/",
      `QueryView {
        of: Api.Doc.all,
        empty: Empty { "none" },
        data: rows => Table { rows: rows, Column { "Name", o => Text { o.name } } }
      }`,
    );
    // Emptiness is asked of the ROWS, not of the 5-key envelope map.
    expect(heex).toContain("Enum.empty?(@items.items)");
    // …and the table iterates the rows, not the map's key/value pairs.
    expect(heex).toContain("rows={@items.items}");
    expect(heex).not.toContain("rows={@items}>");
  });

  it("an explicit `paged: true` body still binds the ENVELOPE (the scaffold shape)", async () => {
    const heex = await landingHeex(
      "/",
      `QueryView {
        of: Api.Doc.all,
        paged: true,
        empty: Empty { "none" },
        data: rows => Table { rows: rows.items, Column { "Name", o => Text { o.name } } }
      }`,
    );
    // The body reads `rows.items` itself, so the binding must NOT be unwrapped
    // a second time — that would emit `@items.items.items`.
    expect(heex).toContain("rows={@items.items}");
    expect(heex).not.toContain("@items.items.items");
    expect(heex).toContain("Enum.empty?(@items.items)");
  });

  it("a byId read takes the single-record cond without a `single:` flag", async () => {
    const heex = await landingHeex(
      "/:id",
      `QueryView {
        of: Api.Doc.byId(id),
        empty: Empty { "not found" },
        data: rec => Text { rec.name }
      }`,
    );
    // The single-record ladder: nil → loading, :error → error, :not_found →
    // empty.  `Enum.empty?/1` would raise here — a struct is not Enumerable.
    // (The assign is named off the lambda param, so `rec => …` binds `@rec`.)
    expect(heex).toContain("@rec == :not_found");
    expect(heex).not.toContain("Enum.empty?");
  });

  it("a plain array find keeps bare-collection semantics", async () => {
    const heex = await landingHeex(
      "/",
      `QueryView {
        of: Api.Doc.named("x"),
        empty: Empty { "none" },
        data: rows => Table { rows: rows, Column { "Name", o => Text { o.name } } }
      }`,
    );
    // A user find returning `Doc[]` is neither paged nor single — no `.items`
    // unwrap, and the collection cond.
    expect(heex).toContain("Enum.empty?(@items)");
    expect(heex).toContain("rows={@items}");
  });
});

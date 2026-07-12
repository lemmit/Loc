import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// A shorthand view (`view X = Agg where …`) returns the aggregate's STRUCTS,
// which the ViewsController projects through the aggregate's full `wireShape`.
// So the view query MUST `Repo.preload(...)` the same collection associations
// the REST repository read does — a value-object collection / relational
// containment / reference collection left unloaded comes back as
// `%Ecto.Association.NotLoaded{}`, and the serializer's `Enum.map` over it
// raises `Protocol.UndefinedError` → 500 (audit generated-code-ddd-review-2026-07:
// "a NotLoaded Jason crash on the no-preload shorthand view").
//
// Shared preload list with `repository-emit.ts` (`read-preload.ts`).
// ---------------------------------------------------------------------------

const sys = (body: string) => `
system Demo {
  subdomain Core {
    context Shop {
      ${body}
      view ActiveCarts = Cart where this.active
    }
  }
  storage s { type: postgres }
  resource st { for: Shop, kind: state, use: s }
  deployable api { platform: elixir  contexts: [Shop]  dataSources: [st]  port: 8080 }
}
`;

async function viewModule(body: string): Promise<string> {
  const files = await generateSystemFiles(sys(body));
  return files.get([...files.keys()].find((k) => k.endsWith("/views/active_carts.ex"))!)!;
}

describe("vanilla — shorthand view preloads wireShape associations", () => {
  it("preloads a value-object collection (Money[]) before serializing", async () => {
    const mod = await viewModule(`
      valueobject Money { amount: money }
      aggregate Cart { active: bool  charges: Money[] }
      repository Carts for Cart { }
    `);
    expect(mod).toContain("|> Repo.all()");
    expect(mod).toContain("|> Repo.preload([:charges])");
  });

  it("preloads a reference collection (Tag id[]) before serializing", async () => {
    const mod = await viewModule(`
      aggregate Tag { name: string }
      repository Tags for Tag { }
      aggregate Cart { active: bool  tags: Tag id[] }
      repository Carts for Cart { }
    `);
    expect(mod).toContain("|> Repo.preload([:tags])");
  });

  it("no preload for a plain scalar aggregate (byte-clean, no empty preload)", async () => {
    const mod = await viewModule(`
      aggregate Cart { active: bool  label: string }
      repository Carts for Cart { }
    `);
    expect(mod).toContain("|> Repo.all()");
    expect(mod).not.toContain("Repo.preload");
  });
});

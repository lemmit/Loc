// Feliz scaffold primitives — a `with scaffold(...)` ui emits List / New / Detail
// / Home pages built from container/leaf primitives (Paper, Toolbar, Breadcrumbs,
// Alert, Empty, Skeleton, KeyValueRow, Table, IdLink, Anchor, Modal).  This pins
// that the Feliz pack renders ALL of them (no `no renderer` placeholder) so a
// scaffold-generated app reaches e2e parity with the JSX frontends.  The emitted
// F# is proven to compile via `dotnet fable` + vite build (SDK:8.0 container).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";
import { parseString } from "../../_helpers/parse.js";

const SCAFFOLD = `
system Shop {
  api ShopApi from Catalog
  subdomain Catalog {
    context Cat {
      aggregate Product with crudish { name: string  price: money }
      repository Products for Product { }
    }
  }
  storage db { type: postgres }
  resource catState { for: Cat, kind: state, use: db }
  ui WebApp with scaffold(aggregates: [Product]) {
    api Shop: ShopApi
  }
  deployable api { platform: node contexts: [Cat] dataSources: [catState] serves: ShopApi port: 3000 }
  deployable web { platform: feliz targets: api ui: WebApp { Shop: api } port: 3005 }
}
`;

async function appFs(source: string): Promise<string> {
  const files = await generateSystemFiles(source);
  return [...files.entries()].find(([p]) => p.endsWith("src/App.fs"))![1];
}

describe("feliz scaffold primitives", () => {
  it("renders every scaffold primitive — no pack placeholders leak", async () => {
    const app = await appFs(SCAFFOLD);
    // The single most important assertion: nothing falls through to the
    // missing-renderer sentinel (which would also fail to compile in value
    // position).
    expect(app).not.toContain("no renderer");
  });

  it("emits the container/leaf primitives with their Feliz classes", async () => {
    const app = await appFs(SCAFFOLD);
    expect(app).toContain('prop.className "loom-toolbar"'); // list page header
    expect(app).toContain('prop.className "loom-breadcrumbs"'); // nav trail
    expect(app).toContain('prop.className "loom-paper"'); // surface container
    expect(app).toContain('prop.className "loom-skeleton"'); // loading branch
    expect(app).toContain('prop.className "loom-alert"'); // error branch
    expect(app).toContain('prop.className "loom-empty"'); // empty branch
    expect(app).toContain('prop.className "loom-kv"'); // detail field row
  });

  it("emits the list Table with a header row + a yield! row map", async () => {
    const app = await appFs(SCAFFOLD);
    expect(app).toContain('Html.table [ prop.className "loom-table"');
    expect(app).toContain("Html.thead [ prop.children [ Html.tr [ prop.children [");
    // Rows iterate the loaded data via a yield! List.map (offside-safe).
    expect(app).toMatch(/yield! \w+ \|> List\.map \(fun \w+ ->/);
    expect(app).toContain("Html.tbody [ prop.children [");
  });

  it("emits IdLink cells + hash-route Anchors", async () => {
    const app = await appFs(SCAFFOLD);
    // The id column links to the row's detail page (Feliz.Router hash path).
    expect(app).toMatch(/Html\.a \[ prop\.href \("#\/products\/" \+ \w+\.id\)/);
    // Breadcrumb anchors fold a literal route into a static hash href.
    expect(app).toContain('Html.a [ prop.href "#/"; prop.text "Home" ]');
  });

  // Reachability — a scaffold system must PARSE + VALIDATE cleanly.
  it("validates cleanly through validateLoomModel", async () => {
    const { errors } = await parseString(SCAFFOLD, { validate: true });
    expect(errors).toEqual([]);
  });

  // `Html.text` needs a `string`.  A value that is provably a string from its
  // own structure (a Yes/No conditional of string literals) is passed straight
  // to `Html.text`; a non-string field (money → decimal) KEEPS the `string (…)`
  // cast — without it `dotnet fable` rejects `Html.text (decimal)`.  The
  // accessor's *resolved* type is unreliable for untyped scaffold rows, so the
  // cast is dropped only for the structurally-provable case.
  it("drops the redundant cast on a Yes/No bool, keeps it on a money field", async () => {
    const withBool = SCAFFOLD.replace(
      "aggregate Product with crudish { name: string  price: money }",
      "aggregate Product with crudish { name: string  price: money  active: bool }",
    );
    const app = await appFs(withBool);
    // Bool renders as a string-valued conditional — no `string (…)` wrap.
    expect(app).toContain('Html.text ((if row.active then "Yes" else "No"))');
    expect(app).not.toContain('string ((if row.active then "Yes" else "No"))');
    // Money stays coerced (it is a `decimal` in F#, which `Html.text` can't take).
    expect(app).toContain("Html.text (string (row.price))");
  });
});

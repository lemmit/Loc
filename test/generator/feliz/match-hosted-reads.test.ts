// Reads that live inside a `match` arm — the Feliz read collector used to stop
// at the `match` node.
//
// THE GAP THIS CLOSES (silent, uncompilable F#).  `collectBodyReads`
// (src/generator/feliz/wire.ts) walks a page body for read-bearing `of:`
// arguments through a local `exprChildren` helper, which had no `match` arm.
// Every `QueryView` hosted by a `match` was therefore invisible to the MVU
// wiring, while the VIEW walk (which has no such gap) still emitted
// `View.remoteList model.<Field> …` for it.  The result was an `App.fs` whose
// view named Model fields that:
//
//   * the `Model` record never declares,
//   * `init` never seeds,
//   * no `Msg` case ever carries and no `update` arm ever stores,
//   * and no `Cmd` ever fetches.
//
// The scaffolded FILTER BAR is exactly that shape — `scaffoldList` renders the
// filtered find's `QueryView` in a `match` arm and the unfiltered `.all` view
// in `otherwise` — so ANY scaffolded aggregate whose repository declares a
// filterable find emitted an uncompilable Feliz app (both reads were dropped,
// not just the filtered one).  A hand-written `match` over page state has the
// same shape and the same bug.
//
// Not proven by compilation here: `dotnet fable` is not available in this
// container, so these assertions read the emitted F# structurally.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

/** A scaffolded aggregate whose repository declares a `string`-param find — the
 *  scaffold grows a filter bar and puts both views in a `match`. */
const SCAFFOLD_FILTER = `
system Shop {
  api ShopApi from Catalog
  subdomain Catalog {
    context Cat {
      aggregate Product with crudish { name: string  price: money }
      repository Products for Product {
        find byName(name: string): Product[]
      }
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

/** The same shape written by hand — a `match` over a page `state {}` cell whose
 *  arms each host a `QueryView`. */
const HAND_WRITTEN_MATCH = `
system Docs {
  subdomain Knowledge {
    context Library {
      aggregate Doc {
        title: string
        vis: string
        derived display: string = title
      }
      repository Docs for Doc {
        find byVis(vis: string): Doc[] where this.vis == vis
      }
    }
  }
  api LibApi from Knowledge
  storage pg { type: postgres }
  resource libState { for: Library, kind: state, use: pg }
  ui WebApp {
    api K: LibApi
    page Browse {
      route: "/browse"
      title: "Browse"
      state { chosen: string = "" }
      body: Stack {
        Field("Visibility", bind: chosen),
        match {
          chosen != "" => QueryView {
            of: K.Doc.byVis(chosen),
            empty: Text { "No docs" },
            data: rows => For { each: rows, d => Text { d.title } }
          }
          else => QueryView {
            of: K.Doc.all,
            empty: Text { "No docs" },
            data: rows => For { each: rows, d => Text { d.title } }
          }
        }
      }
    }
  }
  deployable api { platform: node contexts: [Library] dataSources: [libState] serves: LibApi port: 8080 }
  deployable web { platform: feliz targets: api ui: WebApp { K: api } port: 3000 }
}
`;

async function appFs(src: string): Promise<string> {
  const files = await generateSystemFiles(src);
  return [...files].find(([p]) => p.endsWith("App.fs"))![1];
}

/** Every `model.<Field>` the emitted app READS, minus the record labels the
 *  `Model` type DECLARES — i.e. the fields nothing binds.  Empty is the
 *  invariant; a non-empty set is an F# "The record label is not defined"
 *  (FS0039) waiting to happen. */
function undeclaredModelFields(app: string): string[] {
  const decl = app.slice(app.indexOf("type Model ="), app.indexOf("type Msg ="));
  const declared = new Set([...decl.matchAll(/^\s{4}(\w+):/gm)].map((m) => m[1]!));
  const used = new Set([...app.matchAll(/\bmodel\.(\w+)/g)].map((m) => m[1]!));
  return [...used].filter((f) => !declared.has(f)).sort();
}

describe("feliz reads hosted by a match arm", () => {
  it("scaffolded filter bar: both the filtered find and the `.all` fallback reach the Model", async () => {
    const app = await appFs(SCAFFOLD_FILTER);
    // The filter-bar state cell was never the missing half — it always landed.
    expect(app).toContain("ByNameName: string");
    // The two reads the `match` hosts.  Before the fix NEITHER was declared.
    expect(app).toContain("ProductByName: Remote<Product list>");
    expect(app).toContain("AllProducts: Remote<Product list>");
    // …and each is fully wired: Msg case, init seed, update arms, fetch Cmd.
    expect(app).toContain("| ProductByNameLoaded of Result<Product list, string>");
    expect(app).toContain("ProductByName = Loading");
    expect(app).toContain(
      "| ProductByNameLoaded (Ok data) -> { model with ProductByName = Loaded data }",
    );
    expect(app).toContain("Api.productByName");
    expect(app).toContain("Api.allProducts");
  });

  it("scaffolded filter bar: the view names no Model field the Model does not declare", async () => {
    expect(undeclaredModelFields(await appFs(SCAFFOLD_FILTER))).toEqual([]);
  });

  it("a hand-written match over page state wires both arms' reads", async () => {
    const app = await appFs(HAND_WRITTEN_MATCH);
    expect(app).toContain("DocByVis: Remote<Doc list>");
    expect(app).toContain("AllDocs: Remote<Doc list>");
    expect(undeclaredModelFields(app)).toEqual([]);
  });
});

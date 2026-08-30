// A USER-DECLARED repository find read on the Feliz (F#/Fable) frontend —
// `QueryView { of: K.Doc.byVis(chosen) }`.
//
// THE GAP THIS CLOSES (silent, uncompilable F#).  `felizTarget.buildHookUse`
// mapped every operation that was not `byId` / `history` onto `readFieldName`
// (`All<Plural>`), while the read collector only ever registered `.all` /
// `byId` / `history` / projection reads.  So a parameterised find produced:
//
//   * a view naming `model.AllDocs` — a field the Model never declared,
//   * `type Model = { Unit: unit }` (no read at all, so no wire layer, no
//     `Api` module and no `View` matchers either),
//   * and a query that was NEVER ISSUED — the page rendered the unfiltered
//     list's loading state forever, from a model with no diagnostic.
//
// Flutter, on the same `.ddd`, emits a `docByVisProvider` (`reads-emit.ts` —
// a `.family` keyed by the find's declared params over
// `GET /<aggs>/<find_snake>`), so this is the Feliz half of a contract the
// other six frontends already keep.
//
// The four assertions below are the four halves that have to agree: the Model
// field, the api fn (route + args), the view's reference, and the ABSENCE of
// the old `All<Plural>` binding.

import { describe, expect, it } from "vitest";
import { generateSystemFiles, generateSystemFilesUnchecked } from "../../_helpers/generate.js";

/** A list-returning find, its argument bound to a page `state {}` cell that a
 *  `Select` also writes — so the refetch-on-control-change arm is exercised. */
const SRC = `
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
      state { chosen: string = "public" }
      body: Stack {
        Field { label: "Visibility", bind: chosen },
        QueryView {
          of: K.Doc.byVis(chosen),
          empty: Text { "No docs" },
          data: rows => For { each: rows, d => Text { d.title } }
        }
      }
    }
  }
  deployable api { platform: node contexts: [Library] dataSources: [libState] serves: LibApi port: 8080 }
  deployable web { platform: feliz targets: api ui: WebApp { K: api } port: 3000 }
}
`;

/** The emitted `App.fs` — Feliz puts the whole MVU app in one file. */
async function appFs(src = SRC): Promise<string> {
  const files = await generateSystemFiles(src);
  const hit = [...files].find(([p]) => p.endsWith("App.fs"));
  if (!hit) throw new Error(`no App.fs emitted; got ${[...files.keys()].join(", ")}`);
  return hit[1];
}

/** The `.ddd` above with its find declaration and its call site rewritten. */
function withFind(decl: string, callSite: string, extra = ""): string {
  return SRC.replace("find byVis(vis: string): Doc[] where this.vis == vis", decl)
    .replace("K.Doc.byVis(chosen)", callSite)
    .replace("aggregate Doc {", `aggregate Doc {${extra}`);
}

describe("feliz user-find read — the Model field is op-derived, not All<Plural>", () => {
  it("declares a Remote field named off the AGGREGATE AND THE FIND", async () => {
    const fs = await appFs();
    expect(fs).toContain("DocByVis: Remote<Doc list>");
  });

  it("never binds the find to the unfiltered list field", async () => {
    // The exact regression: `All<Plural>` for a read that is not `.all`.  The
    // ui has no `.all` read at all, so any mention of `AllDocs` is the bug.
    const fs = await appFs();
    expect(fs).not.toContain("AllDocs");
  });

  it("carries the decoded Result on its own Msg case and update arms", async () => {
    const fs = await appFs();
    expect(fs).toContain("| DocByVisLoaded of Result<Doc list, string>");
    expect(fs).toContain("| DocByVisLoaded (Ok data) -> { model with DocByVis = Loaded data }");
    expect(fs).toContain("| DocByVisLoaded (Error e) -> { model with DocByVis = LoadError e }");
  });

  it("emits the wire layer the read needs — the record, its decoder, the matcher", async () => {
    // Before the fix the read set was EMPTY, so `hasWire` / `hasHttp` were
    // false: no `type Doc`, no `Decoders.doc`, no `Api`, no `View.remoteList`.
    const fs = await appFs();
    expect(fs).toContain("type Doc =");
    expect(fs).toContain("let doc : Decoder<Doc> =");
    expect(fs).toContain("let remoteList (r: Remote<'T list>)");
  });
});

describe("feliz user-find read — the query is actually issued, with its args", () => {
  it("generates the api fn from the DECLARATION — one param per find param", async () => {
    const fs = await appFs();
    expect(fs).toContain("let docByVis (vis: string) : Async<Result<Doc list, string>> =");
  });

  it("fetches the find's own route with the params as a query string", async () => {
    // `GET /<aggs>/<find_snake>?<param>=…` — the same route the React / Vue /
    // Svelte / Angular / Flutter clients call, so all seven agree.
    const fs = await appFs();
    expect(fs).toContain('Http.get (sprintf "/api/docs/by_vis?vis=%s" vis)');
    expect(fs).toContain("Decode.fromString (Decode.list Decoders.doc) body");
  });

  it("fires at INIT with the argument read off the initial model", async () => {
    // `__m` — the record `init` is returning — not `model`, which does not
    // exist there, and not a literal, which would ignore the state cell.
    const fs = await appFs();
    expect(fs).toContain(
      "Cmd.OfAsync.perform (fun () -> Api.docByVis (__m.Chosen)) () DocByVisLoaded",
    );
  });

  it("re-issues the query when the control the argument names changes", async () => {
    // Riverpod re-watches the `.family` provider for free when the arg changes;
    // Elmish has to be told.  Off `__m` — the model the arm just updated — so
    // the request carries the NEW value, not the one it replaced.
    const fs = await appFs();
    expect(fs).toContain(
      "| SetChosen v -> let __m = { model with Chosen = v } in " +
        "__m, Cmd.OfAsync.perform (fun () -> Api.docByVis (__m.Chosen)) () DocByVisLoaded",
    );
  });
});

describe("feliz user-find read — the view names the read's own field", () => {
  it("matches on the find's Remote field through the list matcher", async () => {
    const fs = await appFs();
    expect(fs).toContain("View.remoteList model.DocByVis");
    // The `data:` lambda binds the read's own binding, and the body iterates it.
    expect(fs).toContain("fun docByVis ->");
    expect(fs).toContain("yield! docByVis |> List.map");
  });

  it("emits no F# that references an undeclared model field", async () => {
    // Shape sanity across the whole file: every `model.<Field>` the app names
    // must be declared by the `Model` record.  This is the general form of the
    // dangling-`AllDocs` bug — it would have caught it without naming it.
    const fs = await appFs();
    const declared = new Set(
      [
        ...(/type Model =\n {2}\{\n([\s\S]*?)\n {2}\}/.exec(fs)?.[1] ?? "").matchAll(
          /^ {4}(\w+):/gm,
        ),
      ].map((m) => m[1]!),
    );
    expect(declared.size).toBeGreaterThan(0);
    const used = new Set([...fs.matchAll(/\bmodel\.(\w+)/g)].map((m) => m[1]!));
    expect([...used].filter((f) => !declared.has(f))).toEqual([]);
  });
});

describe("feliz user-find read — the other return shapes", () => {
  it("renders an OPTIONAL find as a single-record read (404 → Ok None)", async () => {
    const fs = await appFs(
      withFind(
        "find byTitle(title: string): Doc? where this.title == title",
        "K.Doc.byTitle(chosen)",
      ).replace(
        "data: rows => For { each: rows, d => Text { d.title } }",
        "data: d => Text { d.title }",
      ),
    );
    expect(fs).toContain("DocByTitle: Remote<Doc option>");
    expect(fs).toContain("let docByTitle (title: string) : Async<Result<Doc option, string>> =");
    expect(fs).toContain("(Decode.option Decoders.doc)");
    expect(fs).toContain("elif status = 404 then");
    expect(fs).toContain("View.remoteOne model.DocByTitle");
  });

  it("decodes a PAGED find through the existing paged-envelope path", async () => {
    // Not a new path: the read gets the same `PageMeta` SIBLING field an
    // uncontrolled paged `.all` gets, so the pager's counts render truthfully.
    const fs = await appFs(
      withFind("find byVis(vis: string): Doc paged where this.vis == vis", "K.Doc.byVis(chosen)"),
    );
    expect(fs).toContain("DocByVis: Remote<Doc list>");
    expect(fs).toContain("DocByVisPageMeta: PageMeta");
    expect(fs).toContain(
      "let docByVis (vis: string) : Async<Result<Doc list * PageMeta, string>> =",
    );
    expect(fs).toContain('Decode.field "items"');
  });

  it("carries a NON-string parameter with an explicit, culture-safe conversion", async () => {
    // F#'s `string true` is "True" and a decimal stringifies per culture — both
    // would reach the backend as something its query parser does not accept.
    const fs = await appFs(
      withFind(
        'find recent(limit: int, since: datetime): Doc[] where this.title != ""',
        "K.Doc.recent(3, now())",
      ),
    );
    expect(fs).toContain(
      "let docRecent (limit: int) (since: System.DateTime) : Async<Result<Doc list, string>> =",
    );
    expect(fs).toContain(
      'Http.get (sprintf "/api/docs/recent?limit=%s&since=%s" (string limit) (since.ToString("o")))',
    );
    expect(fs).toContain(
      "Cmd.OfAsync.perform (fun () -> Api.docRecent (3) (System.DateTime.UtcNow)) () DocRecentLoaded",
    );
  });
});

describe("feliz user-find read — unsupported shapes fail LOUDLY", () => {
  it("names an undeclared operation instead of silently binding All<Plural>", async () => {
    // The AST validator gates this shape HONESTLY first (`Operation 'byNothing'
    // is not declared…`), so a user never reaches codegen with it.  The
    // generator's own throw is the backstop for the paths that skip phase ④
    // (the api toolkit's generate-from-partial, a macro-built body): it must
    // still refuse rather than fall back to the unfiltered list, which is what
    // it used to do.
    await expect(
      generateSystemFilesUnchecked(
        SRC.replace("K.Doc.byVis(chosen)", "K.Doc.byNothing(chosen)"),
        "the subject IS the codegen backstop behind the validator gate on an undeclared read op",
      ),
    ).rejects.toThrow(/is neither a lifecycle read/);
  });

  it("throws when a find parameter has no query-string spelling", async () => {
    await expect(
      appFs(
        withFind(
          'find byTags(tags: string[]): Doc[] where this.title != ""',
          "K.Doc.byTags(picked)",
        ).replace(
          'state { chosen: string = "public" }',
          'state {\n        chosen: string = "public"\n        picked: string[] = []\n      }',
        ),
      ),
    ).rejects.toThrow(/unsupported type \(array\)/);
  });

  it("throws when an argument is not resolvable where the query is issued", async () => {
    // A find read's fetch is built in `init` / an `update` arm, where a lambda
    // binding from the surrounding view is not in scope.
    await expect(
      appFs(
        SRC.replace(
          "data: rows => For { each: rows, d => Text { d.title } }",
          'data: rows => For { each: rows, d => Stack { QueryView { of: K.Doc.byVis(d.title), data: r2 => Text { "x" } } } }',
        ),
      ),
    ).rejects.toThrow(/not resolvable where the Feliz frontend issues the query/);
  });
});

// The NON-RELATIONAL node repository builders were cloned from the relational
// one, and each dropped a piece the original carries.  Two pairwise-corpus
// findings, same shape one level apart (register:
// `docs/audits/pairwise-corpus-findings-2026-08.md`, F2 + F5):
//
//   F2  `mask unless` × `shape: document` / `shape: embedded` /
//       `persistedAs: eventLog` (drizzle).  The route builder calls
//       `repo.toWireMasked(row, __maskUser)` for EVERY masked aggregate
//       regardless of saving shape, but only `repository-builder.ts` emitted
//       the method → TS2339 on the generated project.
//
//   F5  a principal capability filter × `shape: document` × `persistence:
//       mikroorm`.  On a document the filter cannot be pushed into the query
//       (the row is one opaque jsonb blob), so it is evaluated in-app over the
//       rehydrated record — which needs `currentUser` BOUND.  The drizzle
//       document builder binds it; the mikro one bound nothing → TS2304.
//
// Neither is reachable from a single-feature fixture: `mask unless` has one,
// the saving shapes have one each, `persistence: mikroorm` has a matrix — and
// the bug lives only where two of them meet.  So the fixtures here are
// CROSSINGS by construction.
//
// The assertions come in two tiers, because a compile-only proof of an
// authorization feature is precisely the hollow green this class of bug hides
// in — a repository that emits `toWireMasked` and never redacts type-checks
// just as well as one that does:
//
//   structural — the emitted repository carries the method / the bind, and the
//                names it introduces are imported;
//   runtime    — the emitted method text is TRANSPILED AND EXECUTED against
//                stubs, and asserted on VALUES: the masked field comes back
//                null while its unmasked neighbour survives, and the principal
//                filter actually drops the other tenant's row.

import ts from "typescript";
import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// --- fixtures --------------------------------------------------------------

/** `mask unless` on a non-relational saving shape.  `__SHAPE__` is the
 *  aggregate's shape clause; everything else is held constant so the three
 *  cases differ ONLY in the axis under test. */
const maskSource = (shapeClause: string, extra = ""): string => `
system MaskShape {
  user { id: string  role: string  permissions: string[] }
  subdomain Cms {
    permissions { unmask }
    context Cms {
      aggregate Article ${shapeClause} {
        title: string
        secretNote: string mask unless currentUser.permissions.contains(permissions.unmask)
        viewCount: int = 0
        ${extra}
      }
      repository Articles for Article { }
    }
  }
  api CmsApi from Cms
  storage primary { type: postgres }
  resource cmsState { for: Cms, kind: __KIND__, use: primary }
  deployable d {
    platform: node
    contexts: [Cms]
    dataSources: [cmsState]
    serves: CmsApi
    port: 4000
    auth: required
  }
}
`;

const DOCUMENT_SRC = maskSource("shape: document, with crudish", "").replace("__KIND__", "state");
const EMBEDDED_SRC = maskSource(
  "shape: embedded, with crudish",
  "contains sections: Section[]\n        entity Section { heading: string }",
).replace("__KIND__", "state");
const EVENTLOG_SRC = maskSource(
  "persistedAs: eventLog",
  `create open(title: string, secretNote: string) { emit Opened { article: id, title: title, secretNote: secretNote } }
        operation bump() { emit Bumped { article: id } }
        apply(e: Opened) { title := e.title  secretNote := e.secretNote  viewCount := 0 }
        apply(e: Bumped) { viewCount := viewCount + 1 }`,
)
  .replace("__KIND__", "eventLog")
  .replace(
    "    context Cms {",
    `    context Cms {
      event Opened { article: Article id, title: string, secretNote: string }
      event Bumped { article: Article id }`,
  );

/** F5: a principal capability filter on a document-shaped aggregate, under the
 *  MikroORM persistence adapter. */
const MIKRO_DOC_SRC = `
system TenancyDocMikro {
  user { id: guid  tenantId: string }
  subdomain Core {
    context Ledger {
      aggregate Account shape: document, with crudish {
        tenantId: string
        balance: int
        filter this.tenantId == currentUser.tenantId
      }
      repository Accounts for Account {
        find byMinBalance(min: int): Account[] where this.balance >= min
      }
    }
  }
  api LedgerApi from Core
  storage primary { type: postgres }
  resource ledgerState { for: Ledger, kind: state, use: primary }
  deployable d {
    platform: node { persistence: mikroorm }
    contexts: [Ledger]
    dataSources: [ledgerState]
    serves: LedgerApi
    port: 4000
    auth: required
  }
}
`;

// --- helpers ---------------------------------------------------------------

/** Lift one 2-space-indented class method out of an emitted repository file,
 *  verbatim.  Executing the EMITTED text (rather than a re-typed copy of it)
 *  is what makes the runtime tier a proof about the generator. */
function methodText(src: string, name: string): string {
  const lines = src.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^ {2}(async )?${name}\\(`).test(l));
  expect(start, `emitted repository declares \`${name}(\``).toBeGreaterThanOrEqual(0);
  const end = lines.findIndex((l, i) => i > start && l === "  }");
  expect(end, `\`${name}(\` has a closing brace`).toBeGreaterThan(start);
  return lines.slice(start, end + 1).join("\n");
}

/** Transpile a TS snippet and evaluate it, returning whatever it exports via
 *  `return`.  `stubs` are bound as parameters, so the emitted code's free
 *  names (its imports, in the real project) resolve to test doubles. */
function evalTs(code: string, stubs: Record<string, unknown> = {}): unknown {
  const js = ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  const names = Object.keys(stubs);
  // `new Function` over the transpiled text: executing the emitted code IS the
  // test, so the indirection is the point rather than a smell.
  const factory = new Function(...names, js) as (...args: unknown[]) => unknown;
  return factory(...names.map((n) => stubs[n]));
}

const repoFileOf = (files: Map<string, string>, agg: string): string => {
  const path = `d/db/repositories/${agg}-repository.ts`;
  const src = files.get(path);
  expect(src, `emitted ${path}`).toBeDefined();
  return src as string;
};

// --- F2 --------------------------------------------------------------------

describe("F2 — `mask unless` reaches the non-relational repository builders", () => {
  // Each case pairs its source with a WITNESS: a string only that shape's
  // builder emits.  Without it a fixture whose shape clause silently failed to
  // apply would be checked against the RELATIONAL builder — which has emitted
  // `toWireMasked` all along — and this suite would pass while testing
  // nothing (experience_gathered.md §63).
  const CASES: ReadonlyArray<readonly [string, string, string]> = [
    ["shape: document", DOCUMENT_SRC, "articleFromDoc("],
    ["shape: embedded", EMBEDDED_SRC, "sectionFromDoc("],
    ["persistedAs: eventLog", EVENTLOG_SRC, "_fromEvents("],
  ];

  it.each(
    CASES,
  )("%s — the repository emits the method the routes call", async (shape, src, witness) => {
    const files = await generateSystemFiles(src);
    const repo = repoFileOf(files, "article");
    expect(repo, `${shape} reached its own repository builder`).toContain(witness);
    const routes = files.get("d/http/article.routes.ts") as string;
    expect(routes, "emitted routes").toBeDefined();

    // The routes call it — this is what makes the missing method a TS2339 and
    // not merely dead code.  Asserting BOTH sides is the point: the bug was an
    // ASYMMETRY between two emitters, so a test that looked at one alone would
    // have stayed green through it.
    expect(routes).toContain("repo.toWireMasked(");
    expect(repo).toMatch(
      /^ {2}toWireMasked\(root: Article, currentUser: User \| null\): unknown \{$/m,
    );
    // …and the signature's `User` is imported, or the file names a free type.
    expect(repo).toContain('import type { User } from "../../auth/user-types";');
  });

  it("a mask-free aggregate on the same shape emits NO toWireMasked", async () => {
    // The gate has to be the MASK, not the shape — otherwise this fix would
    // hand every document repository a method referencing a `User` import it
    // has no other reason to carry (and the Biome unused-import gate on
    // emitted code would fail).
    const files = await generateSystemFiles(DOCUMENT_SRC.replace(/ mask unless [^\n]+/, ""));
    const repo = repoFileOf(files, "article");
    expect(repo).not.toContain("toWireMasked");
    expect(repo).not.toContain("auth/user-types");
  });

  it("the emitted mask REDACTS — an unprivileged principal reads null", async () => {
    // Compile-tier green says the method exists.  Whether it redacts is a
    // VALUE question, and an unredacted `secretNote` is the data leak this
    // feature exists to prevent — so execute the emitted pair.
    const files = await generateSystemFiles(DOCUMENT_SRC);
    const repo = repoFileOf(files, "article");
    const Klass = evalTs(
      `return class R {\n${methodText(repo, "toWire")}\n${methodText(repo, "toWireMasked")}\n}`,
    ) as new () => {
      toWire(r: unknown): unknown;
      toWireMasked(r: unknown, u: unknown): Record<string, unknown>;
    };
    const r = new Klass();
    const row = { id: "a1", title: "T", secretNote: "nuclear-codes", viewCount: 3, version: 1 };

    // Unprivileged (authenticated, but without `cms.unmask`): the masked field
    // is null and its unmasked NEIGHBOURS on the same projection survive — the
    // half that a blanket "return {}" would also satisfy.
    const unprivileged = r.toWireMasked(row, { permissions: ["cms.read"] });
    expect(unprivileged.secretNote).toBeNull();
    expect(unprivileged.title).toBe("T");
    expect(unprivileged.viewCount).toBe(3);

    // Unauthenticated → fail-closed, never "no principal, no predicate, pass".
    expect(r.toWireMasked(row, null).secretNote).toBeNull();

    // Privileged: the mask is load-bearing in BOTH directions.  A mask that
    // always fires is merely useless; one that never fires is a leak — only
    // asserting both proves the predicate is actually evaluated.
    expect(r.toWireMasked(row, { permissions: ["cms.unmask"] }).secretNote).toBe("nuclear-codes");
  });
});

// --- F5 --------------------------------------------------------------------

describe("F5 — the mikroorm document repository binds the request principal", () => {
  it("every read that names `currentUser` binds it, and the accessor is imported", async () => {
    const files = await generateSystemFiles(MIKRO_DOC_SRC);
    const repo = repoFileOf(files, "account");
    expect(repo).toContain('import { requireCurrentUser } from "../../auth/middleware";');

    // The real invariant is not "the bind appears somewhere" — it is that no
    // read USES `currentUser` without binding it first.  Check that per
    // method, so a bind emitted into one read and forgotten in the next
    // (exactly how this bug looked) still fails.
    for (const name of ["findById", "findManyByIds", "all", "byMinBalance"]) {
      const body = methodText(repo, name);
      if (!/\bcurrentUser\b/.test(body)) continue;
      expect(body, `${name} binds the principal before using it`).toContain(
        "const currentUser = requireCurrentUser();",
      );
      expect(
        body.indexOf("const currentUser = requireCurrentUser();"),
        `${name} binds the principal BEFORE the first use`,
      ).toBeLessThan(body.search(/currentUser\.\w/));
    }
  });

  it("the emitted find FILTERS — the other tenant's row is not returned", async () => {
    const files = await generateSystemFiles(MIKRO_DOC_SRC);
    const repo = repoFileOf(files, "account");

    const rows = [
      { data: { id: "a", tenantId: "acme", balance: 100 }, version: 1 },
      { data: { id: "b", tenantId: "other", balance: 200 }, version: 1 },
    ];
    const Klass = evalTs(
      `return class R {
         constructor(em) { this.em = em; }
${methodText(repo, "byMinBalance")}
       }`,
      {
        AccountRow: class {},
        accountFromDoc: (d: Record<string, unknown>, v: number) => ({ ...d, version: v }),
        requestLog: () => ({ debug: () => {} }),
        // The authenticated principal — `acme`.  Binding this is the whole
        // fix: without it the emitted body throws ReferenceError on the first
        // read (and never type-checked in the first place).
        requireCurrentUser: () => ({ tenantId: "acme" }),
      },
    ) as new (
      em: unknown,
    ) => { byMinBalance(min: number): Promise<Array<{ tenantId: string }>> };

    const em = { fork: () => ({ find: async () => rows }) };
    const result = await new Klass(em).byMinBalance(0);

    // Both rows clear the find's own `balance >= 0` predicate, so the ONLY
    // thing that can drop the second one is the capability filter.  A
    // repository that emitted the filter but never bound the principal cannot
    // reach this assertion at all — it throws first.
    expect(result.map((a) => a.tenantId)).toEqual(["acme"]);
  });
});

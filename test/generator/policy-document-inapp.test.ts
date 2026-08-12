// `policy { allow deep … }` / `deny` on a `shape: document` aggregate — the
// IN-APP authorization filter (pairwise finding F1).
//
// The `authz-filter` node is a SENTINEL each backend's QUERY-filter translator
// intercepts (Drizzle operator tree / JPQL / SQLAlchemy / EF).  A document
// aggregate has no query to translate into — the whole tree is one opaque jsonb
// column, so node/java/python filter document reads IN-APP over the rehydrated
// instance.  The sentinel reached the GENERIC expression dispatcher there and
// threw its internal invariant ("must be handled by the backend's query-filter
// translator"), taking codegen down on all three backends for an ordinary
// system: a tenant-owned document aggregate under a `deep` read ladder.
//
// `desugarAuthzFilterInApp` lowers the sentinel to ordinary IR once, so the
// three in-app sites render it through their existing expression renderer.
// This file pins, per backend, that:
//
//   1. it generates at all (the crash regression);
//   2. the rendered predicate is `DEEP_SCOPE_SEMANTICS` — descendant-or-self
//      path prefix, with the NULL-`dataKey` fallback to the tenant floor;
//   3. `deny` becomes the always-false in-app conjunct;
//   4. Java compares the two STRING sides with `Objects.equals`, not `==`.
//      Java `==` on String is REFERENCE equality: it compiles green and is
//      silently wrong at runtime (two equal paths from different rows would not
//      match), which is exactly the failure mode a compile gate cannot see.
//
// Assertion (5) is the behavioural one: the emitted node predicate is EXECUTED
// against fabricated rows, so the ladder is proven to FILTER — in-subtree rows
// visible, a sibling subtree and a delimiter-trap neighbour excluded — not
// merely to render.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/generate.js";

// `Thing` is tenant-owned + document-shaped under a `deep` ladder; `Note` is
// document-shaped and read-DENIED.  `Org` is the hierarchy registry the `deep`
// rung anchors on (`allow deep` needs the materialized path).
const system = (platform: string) => `
  system DocPolicy {
    user { id: guid  role: string  tenantId: string }
    tenancy by user.tenantId of Org
    subdomain S {
      context C {
        aggregate Thing shape: document, with crudish, tenantOwned {
          label: string
          amount: int = 0
        }
        aggregate Note shape: document, with crudish, tenantOwned {
          body: string
        }
        repository Things for Thing {
          find byLabel(l: string): Thing[] where this.label == l
        }
        repository Notes for Note { }
        policy {
          allow deep on Thing
          deny on Note
        }
      }
      context R {
        aggregate Org with crudish {
          name: string
          implements tenantRegistry
        }
        repository Orgs for Org { }
      }
    }
    api DocApi from S
    storage primarySql { type: postgres }
    resource cState { for: C, kind: state, use: primarySql }
    resource rState { for: R, kind: state, use: primarySql }
    deployable api {
      platform: ${platform}
      contexts: [C, R]
      dataSources: [cState, rState]
      serves: DocApi
      port: 3001
      auth: required
    }
  }
`;

async function fileContaining(platform: string, needle: string): Promise<string> {
  const files = await generateSystemFiles(system(platform));
  for (const [p, body] of files) if (p.includes(needle)) return body;
  return "";
}

describe("policy × shape: document — node (Hono/Drizzle)", () => {
  it("renders the deep ladder as the in-app descendant-or-self predicate", async () => {
    const thing = await fileContaining("node", "thing-repository");
    // Descendant-or-self on the materialized path, delimiter-correct.
    expect(thing).toContain(
      'rec.dataKey !== null && (rec.dataKey === currentUser.orgPath || rec.dataKey.startsWith(currentUser.orgPath + "."))',
    );
    // NULL-dataKey rows degrade to the flat tenant floor (never wider).
    expect(thing).toContain("rec.dataKey === null && rec.tenantId === currentUser.tenantId");
    // The principal is bound fail-closed from the ambient accessor.
    expect(thing).toContain("const currentUser = requireCurrentUser();");
    // ... and the same predicate narrows the declared find, not just findById.
    expect(thing).toContain(".filter((x) => x.label === l)");
  });

  it("renders deny as the always-false in-app conjunct", async () => {
    const note = await fileContaining("node", "note-repository");
    // Deny is AND-ed beside the tenant floor, so the aggregate is invisible.
    expect(note).toContain("if (!((rec.tenantId === currentUser.tenantId) && (false)))");
    expect(note).toContain("all.filter((x) => (x.tenantId === currentUser.tenantId) && (false))");
  });

  // ---- (5) the ladder actually FILTERS -----------------------------------
  // Execute the emitted predicate over fabricated rows.  `org_a.b` is the
  // caller's node; `org_a.b.c` is a descendant; `org_a` is an ANCESTOR (must
  // NOT be visible — the ladder scopes downward); `org_a.bb` is the delimiter
  // trap a bare prefix match would wrongly admit; `org_z` is a foreign subtree.
  it("admits the caller's subtree and excludes everything else (executed)", async () => {
    const thing = await fileContaining("node", "thing-repository");
    const line = thing
      .split("\n")
      .find((l) => l.includes("all.filter((x) =>") && l.includes("dataKey"));
    expect(line, "the findAll in-app filter should be emitted").toBeTruthy();
    const body = line!.slice(line!.indexOf("all.filter((x) =>") + "all.filter((x) =>".length);
    // Take the predicate up to the closing paren of the `.filter(` call.
    const pred = body.slice(0, body.lastIndexOf("))") + 1);
    const visible = new Function("all", "currentUser", `return all.filter((x) => ${pred});`) as (
      all: { dataKey: string | null; tenantId: string }[],
      currentUser: { orgPath: string; tenantId: string },
    ) => { dataKey: string | null; tenantId: string }[];

    const rows = [
      { dataKey: "org_a.b", tenantId: "t1" }, // the caller's own node
      { dataKey: "org_a.b.c", tenantId: "t1" }, // a descendant
      { dataKey: "org_a", tenantId: "t1" }, // an ANCESTOR — out of scope
      { dataKey: "org_a.bb", tenantId: "t1" }, // delimiter trap — out of scope
      { dataKey: "org_z", tenantId: "t1" }, // a foreign subtree
      { dataKey: null, tenantId: "t1" }, // legacy row, same tenant → floor
      { dataKey: null, tenantId: "t2" }, // legacy row, OTHER tenant → hidden
    ];
    const got = visible(rows, { orgPath: "org_a.b", tenantId: "t1" }).map((r) => r.dataKey);
    expect(got).toEqual(["org_a.b", "org_a.b.c", null]);
  });
});

describe("policy × shape: document — python (FastAPI/SQLAlchemy)", () => {
  it("renders the deep ladder as the in-app descendant-or-self predicate", async () => {
    const thing = await fileContaining("python", "thing_repository");
    expect(thing).toContain(
      'rec.data_key is not None and (rec.data_key == current_user.org_path or rec.data_key.startswith(current_user.org_path + "."))',
    );
    expect(thing).toContain("rec.data_key is None and rec.tenant_id == current_user.tenant_id");
    expect(thing).toContain("current_user = require_current_user()");
  });

  it("renders deny as the always-false in-app conjunct", async () => {
    expect(await fileContaining("python", "note_repository")).toContain(
      "if not ((rec.tenant_id == current_user.tenant_id) and (False)):",
    );
  });
});

describe("policy × shape: document — java (Spring Boot)", () => {
  it("renders the deep ladder as the in-app descendant-or-self predicate", async () => {
    const thing = await fileContaining("java", "ThingRepositoryImpl");
    expect(thing).toContain(
      'rec.dataKey() != null && (Objects.equals(rec.dataKey(), currentUser.orgPath()) || rec.dataKey().startsWith(currentUser.orgPath() + "."))',
    );
    expect(thing).toContain(
      "rec.dataKey() == null && Objects.equals(rec.tenantId(), currentUser.tenantId())",
    );
    // Fail-closed: a null principal matches nothing rather than NPE-ing.
    expect(thing).toContain("currentUser != null &&");
    // `java.util.Objects` must actually be imported, or this does not compile.
    expect(thing).toContain("import java.util.Objects;");
  });

  it("compares the string sides with Objects.equals, never Java reference ==", async () => {
    const thing = await fileContaining("java", "ThingRepositoryImpl");
    // The regression this pins: `leftType`-less binary nodes render `==`, which
    // on String is reference equality — green under `gradle testClasses` and
    // silently wrong at runtime.
    expect(thing).not.toContain("rec.dataKey() == currentUser.orgPath()");
    expect(thing).not.toContain("rec.tenantId() == currentUser.tenantId()");
  });

  it("renders deny as the always-false in-app conjunct", async () => {
    expect(await fileContaining("java", "NoteRepositoryImpl")).toContain("(false)");
  });
});

describe("policy × shape: document — .NET is unaffected", () => {
  // .NET never crashed on this crossing, and the in-app desugar is deliberately
  // NOT on its path (EF filters via `HasQueryFilter`, a column predicate).  This
  // pins that the change did not leak into it.
  //
  // SEPARATE, PRE-EXISTING GAP (found while fixing F1, deliberately NOT fixed
  // here — different files, different gates): on .NET a `shape: document`
  // aggregate gets NO `HasQueryFilter` AT ALL, with or without a policy — so a
  // `tenantOwned` document aggregate reads UNFILTERED across tenants, silently.
  // `validateContextFilterSupport` currently asserts the opposite ("`.NET (EF)`
  // filters every shape"), so nothing gates it.  See the PR body.
  it("does not render the in-app form on the EF path", async () => {
    const ctx = await fileContaining("dotnet", "DbContext");
    expect(ctx).not.toContain("startsWith");
    expect(ctx).not.toContain("dataKey");
  });
});

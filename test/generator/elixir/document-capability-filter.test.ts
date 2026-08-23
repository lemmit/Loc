// ---------------------------------------------------------------------------
// Elixir / Phoenix (vanilla Ecto) — capability `filter` on a `shape: document`
// aggregate.
//
// A document aggregate persists as ONE jsonb `data` column, so there is no
// flattened column for an Ecto `where:` to narrow.  Every document read
// therefore evaluates the capability predicate IN-APP over the rehydrated
// `%<Agg>.Data{}` embed (`record = row.data`), exactly as node / java / python /
// dotnet do over their rehydrated instances.  Until this landed, elixir +
// `document` was the ONE unwired (family, shape) cell in
// `supportsNonRelationalFilter`'s whole inventory: the emitter routed document
// aggregates to a filter-less `renderDocRepository`, so the validator refused
// the crossing (`loom.context-filter-unsupported`).
//
// The four things this pins, each of which was a distinct way to get it wrong:
//
//   1. EVERY read is scoped — `list`, `find_by_id`, each custom find, and the
//      write-scope `find_by_id_for_write` the context facade delegates to
//      whenever `writeScopeFilter` is set (its absence was an undefined-function
//      break, not just a missing filter).
//   2. The `authz-filter` SENTINELS are desugared, not rendered.  `deny` is the
//      literal `false`; `allow deep` is DEEP_SCOPE_SEMANTICS over the row's own
//      `dataKey`/`tenantId`.  Left alone they would emit an Ecto
//      `fragment(...)`, which is not valid Elixir outside a query.
//   3. A NIL principal is fail-CLOSED: `current_user != nil and (…)` guards the
//      conjunction, and each claim reads through `(current_user && …)`.  Without
//      the outer guard a nil claim compares EQUAL to a nil field in Elixir
//      (SQL's `= NULL` never matches) — a cross-tenant read for an actor-less
//      caller.
//   4. The descendant prefix is INTERPOLATED (`"#{claim}."`), never `<>`.
//      Elixir's `nil <> "."` raises ArgumentError — a 500 for an ordinary token
//      that carries no `orgPath` claim.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

/** Tenant-owned document aggregates under a `deep` read ladder + a `deny`
 *  carve-out — the `policy-document` corpus fixture's shape. */
const DEEP_AND_DENY = `system PD {
  user { id: guid  role: string  tenantId: string }

  tenancy by user.tenantId of Org

  subdomain Core {
    context Main {
      aggregate Thing shape: document, with crudish, tenantOwned {
        label: string
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
    context Registry {
      aggregate Org with crudish {
        name: string
        implements tenantRegistry
      }
      repository Orgs for Org { }
    }
  }
  api MainApi from Core
  storage primary { type: postgres }
  resource mainState { for: Main, kind: state, use: primary }
  resource registryState { for: Registry, kind: state, use: primary }
  deployable d {
    platform: elixir
    contexts: [Main, Registry]
    dataSources: [mainState, registryState]
    serves: MainApi
    port: 4000
    auth: required
  }
}`;

/** A NON-principal capability filter (softDelete) on a document aggregate — the
 *  actor-free half of the crossing.  No `current_user` anywhere. */
const NON_PRINCIPAL = `system SD {
  subdomain Core {
    context Main {
      aggregate Doc shape: document, with crudish, softDeletable {
        label: string
      }
      repository Docs for Doc {
        find byLabel(l: string): Doc[] where this.label == l
      }
    }
  }
  api MainApi from Core
  storage primary { type: postgres }
  resource mainState { for: Main, kind: state, use: primary }
  deployable d {
    platform: elixir
    contexts: [Main]
    dataSources: [mainState]
    serves: MainApi
    port: 4000
  }
}`;

/** The emitted module with `#` comment lines stripped — for assertions about
 *  what the generated CODE does, which must not be satisfied (or broken) by
 *  prose in a generated comment.  The `fragment(` assertions below are exactly
 *  that: the `__denied?/1` helper's comment names `fragment("false")` while
 *  explaining why the in-app path cannot use it, and a raw substring check
 *  cannot tell the two apart. */
const codeOf = (src: string): string =>
  src
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("#"))
    .join("\n");

const THING_REPO = "d/lib/d/main/thing_repository.ex";
const NOTE_REPO = "d/lib/d/main/note_repository.ex";
const DOC_REPO = "d/lib/d/main/doc_repository.ex";
const CONTEXT = "d/lib/d/main.ex";

describe("elixir/vanilla — capability filter on a shape: document aggregate", () => {
  it("scopes every document read: list, find_by_id, the custom find, and the write-scope load", async () => {
    const files = await generateSystemFiles(DEEP_AND_DENY);
    const repo = files.get(THING_REPO)!;

    // Each read rehydrates the embed and filters in memory.  `Repo.all/1` with
    // no `Enum.filter` after it would be the unfiltered cross-tenant read.
    expect(repo).toContain("def list(current_user \\\\ nil) do");
    expect(repo).toContain("|> Enum.filter(fn row ->");
    expect(repo).toContain("record = row.data");
    expect(repo).not.toMatch(/\{:ok, Repo\.all\(D\.Main\.Thing\)\}/);

    expect(repo).toContain("def find_by_id(id, current_user \\\\ nil) when is_binary(id) do");
    expect(repo).toContain("else: {:error, :not_found}");

    // The write-scope command-load member the context facade delegates to.
    expect(repo).toContain(
      "def find_by_id_for_write(id, current_user \\\\ nil) when is_binary(id) do",
    );
    expect(files.get(CONTEXT)!).toContain(
      "defdelegate get_thing_for_write(id, current_user \\\\ nil), to: D.Main.ThingRepository, as: :find_by_id_for_write",
    );

    // The author's own `where` is narrowed too, not only the auto-findAll.
    expect(repo).toContain("def by_label(l, current_user \\\\ nil) do");
    expect(repo).toContain("(record.label == l) and (current_user != nil and (");
    // …and the facade's find defdelegate declares the matching arity.
    expect(files.get(CONTEXT)!).toContain(
      "defdelegate by_label_thing(l, current_user \\\\ nil), to: D.Main.ThingRepository, as: :by_label",
    );
  });

  it("renders `allow deep` as the in-memory subtree scope, never an Ecto fragment", async () => {
    const repo = (await generateSystemFiles(DEEP_AND_DENY)).get(THING_REPO)!;
    // The sentinel must not reach the query renderer: `fragment(...)` is only
    // legal inside an Ecto query, and a document read has none.  Asserted over
    // CODE, not comments — the emitted `__denied?/1` doc comment cites
    // `fragment("false")` when explaining why the SQL path needs no equivalent.
    expect(codeOf(repo)).not.toContain("fragment(");
    // Descendant-or-self over the materialized path, with the NULL-dataKey
    // fallback to the flat tenant floor (DEEP_SCOPE_SEMANTICS).
    expect(repo).toContain("record.data_key != nil");
    expect(repo).toContain("record.data_key == (current_user && current_user.org_path)");
    expect(repo).toContain(
      'String.starts_with?(record.data_key, "#{(current_user && current_user.org_path)}.")',
    );
    expect(repo).toContain(
      "record.data_key == nil and record.tenant_id == (current_user && current_user.tenant_id)",
    );
    // The prefix is INTERPOLATED, not concatenated — `nil <> "."` raises.
    expect(repo).not.toContain('current_user.org_path) <> "."');
  });

  it("renders `deny` as an always-false conjunct — the aggregate reads as invisible", async () => {
    const repo = (await generateSystemFiles(DEEP_AND_DENY)).get(NOTE_REPO)!;
    expect(codeOf(repo)).not.toContain("fragment(");
    // Tenant floor AND the always-false carve-out.
    expect(repo).toContain("record.tenant_id == (current_user && current_user.tenant_id)");
    // NOT the literal `false`: the compiler folds it, and `… and false` is a
    // typing violation whose narrowed return type also makes each CALLER's
    // `{:ok, _}` branch dead code — both `--warnings-as-errors` failures.
    expect(repo).toContain("and (__denied?(row))");
    expect(repo).toContain("defp __denied?(row), do: Enum.member?([], row)");
    expect(codeOf(repo)).not.toContain("and (false)");
  });

  it("is fail-closed for an actor-less read (a nil principal matches no rows)", async () => {
    const repo = (await generateSystemFiles(DEEP_AND_DENY)).get(THING_REPO)!;
    // Every principal-referencing conjunction is guarded.  Without this, an
    // in-process caller (`current_user` defaulting to nil) would compare nil to
    // a nil `dataKey`/claim and read ACROSS tenants — Elixir's `nil == nil` is
    // true where SQL's `= NULL` is not.
    const guards = repo.match(/current_user != nil and \(/g) ?? [];
    expect(guards.length).toBe(4); // list, find_by_id, find_by_id_for_write, by_label
  });

  it("keeps a NON-principal document filter actor-free (no current_user seam)", async () => {
    const repo = (await generateSystemFiles(NON_PRINCIPAL)).get(DOC_REPO)!;
    expect(repo).not.toContain("current_user");
    expect(repo).toContain("def list do");
    expect(repo).toContain("def find_by_id(id) when is_binary(id) do");
    // The soft-delete predicate runs in memory over the rehydrated embed.
    expect(repo).toContain("record = row.data");
    expect(repo).toContain("not record.is_deleted");
  });
});

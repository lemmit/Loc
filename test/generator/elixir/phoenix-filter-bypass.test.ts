// `ignoring` filter-bypass on the Phoenix/Ash backend (named-filter-bypass.md
// §11.6 — the "pay for what you use" triage).
//
// Ash 3.x `base_filter` is ALWAYS-ON with no per-query skip, so a capability
// some read `ignoring`s cannot ride `base_filter`.  The triage:
//   (a) a capability NEVER bypassed on an aggregate stays in `base_filter`;
//   (b) a capability bypassed by SOME read is PROMOTED — removed from
//       `base_filter` and applied per-read via `filter expr(...)`, OMITTED on
//       the reads that `ignoring` it (and `ignoring *` omits all promoted caps);
//   (c) a bare (non-capability) filter is NEVER bypassable → stays in
//       `base_filter` regardless.

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseValid } from "../../_helpers/parse.js";

async function generate(src: string): Promise<Map<string, string>> {
  return (await generateSystems(await parseValid(src))).files;
}

function find(files: Map<string, string>, pred: (k: string) => boolean, label: string): string {
  const key = [...files.keys()].find(pred);
  expect(key, `${label} not emitted`).toBeDefined();
  return files.get(key!)!;
}

/** The `base_filter` line of an Ash resource module, or undefined when none. */
function baseFilter(resource: string): string | undefined {
  return resource.split("\n").find((l) => l.includes("base_filter"));
}

/** The body of one named read action (`read :<name> do … end`). */
function readAction(resource: string, name: string): string {
  const lines = resource.split("\n");
  const start = lines.findIndex((l) => l.trim() === `read :${name} do`);
  expect(start, `read :${name} not emitted`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  const out: string[] = [];
  for (let i = start; i < lines.length; i++) {
    out.push(lines[i]!);
    if (/\bdo\b/.test(lines[i]!)) depth++;
    if (lines[i]!.trim() === "end") {
      depth--;
      if (depth === 0) break;
    }
  }
  return out.join("\n");
}

// softDeletable contributes a `base_filter` predicate; auditable is stamps-only
// (no filter).  `recent` ignores softDeletable; `normal` does not; `allRows`
// ignores * (every promoted cap).  A bare `filter this.total > 0` is never
// bypassable.
function sys(repoBody: string, extraFilters = ""): string {
  return `
system Sys {
  capability softDeletable { isDeleted: bool  filter this.isDeleted == false }
  subdomain Sales {
    context Docs {
      aggregate Doc with softDeletable {
        subject: string
        total: int
        ${extraFilters}
      }
      repository Docs for Doc {
        ${repoBody}
      }
    }
  }
  api DocsApi from Sales
  storage primary { type: postgres }
  resource docsState { for: Docs, kind: state, use: primary }
  deployable api {
    platform: elixir { foundation: ash }
    contexts: [Docs]
    dataSources: [docsState]
    serves: DocsApi
    port: 4000
  }
}
`;
}

describe("Phoenix/Ash filter-bypass triage (§11.6)", () => {
  it("(a) a never-bypassed capability stays in base_filter", async () => {
    const files = await generate(sys(`find normal(): Doc[] where this.total > 0`));
    const doc = find(files, (k) => k.endsWith("/docs/doc.ex"), "doc.ex");
    // No read ignores softDeletable → it stays always-on in base_filter.
    expect(baseFilter(doc)).toBe("    base_filter expr(is_deleted == false)");
    // The default :read stays a plain default (no explicit override).
    expect(doc).not.toContain("read :read do");
  });

  it("(b) a bypassed capability is REMOVED from base_filter and applied per-read", async () => {
    const files = await generate(
      sys(`find recent(): Doc[] where this.total > 0 ignoring softDeletable
        find normal(): Doc[] where this.total > 0`),
    );
    const doc = find(files, (k) => k.endsWith("/docs/doc.ex"), "doc.ex");
    // softDeletable is promoted → no longer in base_filter (it was the ONLY
    // capability filter, so base_filter disappears entirely).
    expect(baseFilter(doc)).toBeUndefined();
    // The default :read is now an explicit action re-applying the promoted
    // predicate (Ash.get / by-id / auto findAll all resolve through :read).
    const def = readAction(doc, "read");
    expect(def).toContain("primary? true");
    expect(def).toContain("filter expr(is_deleted == false)");
  });

  it("(c) the ignoring read OMITS the promoted predicate; the normal read INCLUDES it", async () => {
    const files = await generate(
      sys(`find recent(): Doc[] where this.total > 0 ignoring softDeletable
        find normal(): Doc[] where this.total > 0`),
    );
    const doc = find(files, (k) => k.endsWith("/docs/doc.ex"), "doc.ex");
    // The `ignoring softDeletable` read does NOT re-apply the predicate.
    // (A find's OWN `where` keeps the `record.` receiver — only the promoted
    // capability predicate is stripped to bare names, matching base_filter.)
    const recent = readAction(doc, "recent");
    expect(recent).not.toContain("is_deleted");
    expect(recent).toContain("filter expr(record.total > 0)");
    // The normal read DOES re-apply it (as its own promoted `filter` line).
    const normal = readAction(doc, "normal");
    expect(normal).toContain("filter expr(is_deleted == false)");
    expect(normal).toContain("filter expr(record.total > 0)");
  });

  it("(c) ignoring * omits ALL promoted capabilities on that read", async () => {
    const files = await generate(
      sys(`find allRows(): Doc[] ignoring *
        find normal(): Doc[] where this.total > 0`),
    );
    const doc = find(files, (k) => k.endsWith("/docs/doc.ex"), "doc.ex");
    // softDeletable is promoted by the `ignoring *` read.
    expect(baseFilter(doc)).toBeUndefined();
    const all = readAction(doc, "all_rows");
    expect(all).not.toContain("is_deleted");
    // A non-bypassing read still gets the promoted predicate.
    const normal = readAction(doc, "normal");
    expect(normal).toContain("filter expr(is_deleted == false)");
  });

  it("(d) a bare (non-capability) filter stays in base_filter even when a cap is bypassed", async () => {
    const files = await generate(
      sys(
        `find recent(): Doc[] where this.subject != "" ignoring softDeletable`,
        `filter this.total > 0`,
      ),
    );
    const doc = find(files, (k) => k.endsWith("/docs/doc.ex"), "doc.ex");
    // softDeletable (a capability) is promoted out; the bare `filter this.total`
    // (undefined origin) is NOT bypassable, so it stays in base_filter.
    expect(baseFilter(doc)).toBe("    base_filter expr(total > 0)");
    // The promoted softDeletable predicate is omitted on the ignoring read,
    // but the bare base_filter still applies to it (always-on).
    const recent = readAction(doc, "recent");
    expect(recent).not.toContain("is_deleted");
  });

  it("a view's ignoring clause promotes the cap and omits it on the view read", async () => {
    const files = await generate(`
system Sys {
  capability softDeletable { isDeleted: bool  filter this.isDeleted == false }
  subdomain Sales {
    context Docs {
      aggregate Doc with softDeletable { subject: string  total: int }
      repository Docs for Doc {}
      view ActiveDocs = Doc where this.total > 0 ignoring softDeletable
    }
  }
  api DocsApi from Sales
  storage primary { type: postgres }
  resource docsState { for: Docs, kind: state, use: primary }
  deployable api {
    platform: elixir { foundation: ash }
    contexts: [Docs]
    dataSources: [docsState]
    serves: DocsApi
    port: 4000
  }
}
`);
    const doc = find(files, (k) => k.endsWith("/docs/doc.ex"), "doc.ex");
    // The view read promotes softDeletable.
    expect(baseFilter(doc)).toBeUndefined();
    const view = readAction(doc, "active_docs");
    expect(view).not.toContain("is_deleted");
    expect(view).toContain("filter expr(record.total > 0)");
    // The default :read still re-applies the promoted predicate.
    expect(readAction(doc, "read")).toContain("filter expr(is_deleted == false)");
  });
});

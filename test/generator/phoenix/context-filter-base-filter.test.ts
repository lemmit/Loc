// Phase 3 of "criterion everywhere — full filter targeting" (Phoenix/Ash).
//
// A non-principal `filter <expr>` capability (`filter !this.isDeleted`)
// becomes an Ash `base_filter` on the resource — Ash's analog to EF
// Core's HasQueryFilter, applied to every read. Principal-referencing
// filters (tenancy) and non-relational shapes are deferred (rejected by
// the IR validator); see context-filter-emit / -support tests for Hono.

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseValid } from "../../_helpers/parse.js";

function sys(filter: string): string {
  return `
system Sys {
  subdomain Sales {
    context Docs {
      aggregate Doc {
        subject: string
        isDeleted: bool
        ${filter}
      }
      repository Docs for Doc {}
    }
  }
  storage primary { type: postgres }
  resource docsState { for: Docs, kind: state, use: primary }
  ui WebApp {}
  deployable api {
    platform: phoenix
    contexts: [Docs]
    dataSources: [docsState]
    ui: WebApp
    port: 4000
  }
}
`;
}

async function generate(src: string): Promise<Map<string, string>> {
  return (await generateSystems(await parseValid(src))).files;
}

function find(files: Map<string, string>, pred: (k: string) => boolean, label: string): string {
  const key = [...files.keys()].find(pred);
  expect(key, `${label} not emitted`).toBeDefined();
  return files.get(key!)!;
}

describe("Phoenix capability filter — base_filter", () => {
  it("emits a base_filter for a non-principal capability predicate", async () => {
    const files = await generate(sys("filter !this.isDeleted"));
    const doc = find(files, (k) => k.endsWith("/docs/doc.ex"), "doc.ex");
    // Ash filter expressions reference attributes by bare name (no
    // `record.` receiver), else `record` is read as a relationship.
    // (Scope the negative check to the base_filter line — `record.` is a
    // legitimate Elixir binding elsewhere, e.g. the inspect fn.)
    const baseFilterLine = doc.split("\n").find((l) => l.includes("base_filter"))!;
    // `base_filter` nests inside the `resource do … end` DSL section (Ash 3.x).
    expect(baseFilterLine).toBe("    base_filter expr(not is_deleted)");
    expect(doc).toContain("  resource do\n    base_filter expr(not is_deleted)\n  end");
  });

  it("emits no base_filter when the aggregate has no capability filter", async () => {
    const files = await generate(sys(""));
    const doc = find(files, (k) => k.endsWith("/docs/doc.ex"), "doc.ex");
    expect(doc).not.toContain("base_filter");
  });

  // Multiple capability filters conjoin with Ash's INFIX `and` operator, each
  // predicate parenthesised.  `and` is a reserved word in Elixir, so the
  // function form `and(a, b)` is a parser SyntaxError — never valid in `expr()`.
  it("conjoins multiple filters with the infix `and` operator (not the `and(...)` function)", async () => {
    const doc = find(
      await generate(sys('filter !this.isDeleted\n        filter this.subject != ""')),
      (k) => k.endsWith("/docs/doc.ex"),
      "doc.ex",
    );
    const baseFilterLine = doc.split("\n").find((l) => l.includes("base_filter"))!;
    expect(baseFilterLine).toBe('    base_filter expr((not is_deleted) and (subject != ""))');
    expect(doc).not.toContain("expr(and(");
  });

  // A `filter <Criterion>` capability reifies to an Ash boolean calculation
  // (reified-criteria.md, the anonymous-`filter` row): base_filter references
  // the calc by name instead of inlining the predicate — the Phoenix analog of
  // Hono's `<name>Criterion` fn — and the calc is defined even when the
  // criterion is used ONLY in the filter (a filter-only criterion still needs
  // its `<calc>` or base_filter names an undefined calculation).
  it("reifies a filter that is exactly one named criterion to a base_filter calc reference", async () => {
    const src = `
system Sys {
  subdomain Sales {
    context Docs {
      criterion Active of Doc = !this.isDeleted
      aggregate Doc {
        subject: string
        isDeleted: bool
        filter Active
      }
      repository Docs for Doc {}
    }
  }
  storage primary { type: postgres }
  resource docsState { for: Docs, kind: state, use: primary }
  ui WebApp {}
  deployable api {
    platform: phoenix
    contexts: [Docs]
    dataSources: [docsState]
    ui: WebApp
    port: 4000
  }
}
`;
    const doc = find(await generate(src), (k) => k.endsWith("/docs/doc.ex"), "doc.ex");
    // base_filter references the calc atom (zero-arg → bare name), not the inlined predicate.
    expect(doc.split("\n").find((l) => l.includes("base_filter"))).toBe(
      "    base_filter expr(active)",
    );
    // The calc is defined even though no find/retrieval uses the criterion.
    expect(doc).toContain("calculate :active, :boolean, expr(not record.is_deleted)");
  });

  it("reifies an argument-bearing criterion filter, passing the call-site literal", async () => {
    const src = `
system Sys {
  subdomain Sales {
    context Docs {
      criterion InRegion(region: string) of Doc = this.region == region
      aggregate Doc {
        subject: string
        region: string
        filter InRegion("EU")
      }
      repository Docs for Doc {}
    }
  }
  storage primary { type: postgres }
  resource docsState { for: Docs, kind: state, use: primary }
  ui WebApp {}
  deployable api {
    platform: phoenix
    contexts: [Docs]
    dataSources: [docsState]
    ui: WebApp
    port: 4000
  }
}
`;
    const doc = find(await generate(src), (k) => k.endsWith("/docs/doc.ex"), "doc.ex");
    // The literal argument pairs with the criterion's parameter name; the calc
    // binds it via `^arg(:region)`.
    expect(doc.split("\n").find((l) => l.includes("base_filter"))).toBe(
      '    base_filter expr(in_region(region: "EU"))',
    );
    expect(doc).toContain("calculate :in_region, :boolean, expr(record.region == ^arg(:region))");
  });
});

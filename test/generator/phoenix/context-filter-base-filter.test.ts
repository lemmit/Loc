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
});

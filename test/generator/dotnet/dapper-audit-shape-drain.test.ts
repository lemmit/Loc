// Dapper drains the staged audit buffer on EVERY persistence shape.
//
// The command handlers stage an `AuditRecord` for an audited aggregate
// regardless of how it persists, so all THREE Dapper repository emitters —
// relational (`renderDapperRepository`), document
// (`renderDapperDocumentRepository`) and event-sourced
// (`renderDapperEventSourcedRepository`) — have to drain that buffer inside
// their own transaction.
//
// PR #2387 wired only the relational one.  Document- and event-sourced-shaped
// audited aggregates then COMPILED CLEAN and silently dropped every audit row —
// strictly worse than the CS0246 that preceded it, because a dangling reference
// fails loudly and a missing INSERT does not.  Both shapes are reachable:
// `shape: document` and `persistedAs: eventLog`, each with `audited`, parse with
// zero diagnostics (the Dapper adapter header's claim that the IR validator
// rejects them is not true).
//
// This suite is the cross-shape pin: same audit invariant, one case per shape,
// deliberately ONE file — the property under test is that the three emitters
// AGREE, and a per-shape copy is exactly how they drifted apart.

import { NodeFileSystem } from "langium/node";
import { parseHelper } from "langium/test";
import { describe, expect, it } from "vitest";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Model } from "../../../src/language/generated/ast.js";
import { generateSystems } from "../../../src/system/index.js";

async function build(source: string): Promise<Model> {
  const services = createDddServices(NodeFileSystem);
  const helper = parseHelper(services.Ddd);
  const doc = await helper(source, { validation: true });
  const syntax = doc.parseResult?.parserErrors ?? [];
  if (syntax.length) {
    throw new Error(`.ddd fixture has ${syntax.length} syntax error(s): ${syntax[0]?.message}`);
  }
  return doc.parseResult?.value as Model;
}

/** One audited aggregate per persistence shape.  `header` is spliced onto the
 *  `aggregate` line, `body` supplies the shape's required members. */
const sys = (header: string, body: string): string => `
system S {
  subdomain O {
    context O {
      event Touched { who: string }
      aggregate Doc ${header} {
        name: string
        ${body}
      }
      repository Docs for Doc { }
    }
  }
  api A from O
  storage pg { type: postgres }
  resource st { for: O, kind: ${header.includes("eventLog") ? "eventLog" : "state"}, use: pg }
  deployable d {
    platform: dotnet { persistence: dapper }
    contexts: [O]
    dataSources: [st]
    serves: A
    port: 4000
  }
}`;

const SHAPES: Array<{ shape: string; source: string }> = [
  {
    shape: "relational",
    source: sys(
      "audited",
      `create(name: string) { name := name }
        operation rename(name: string) audited { name := name }`,
    ),
  },
  {
    shape: "document",
    source: sys(
      "shape: document audited",
      `create(name: string) { name := name }
        operation rename(name: string) audited { name := name }`,
    ),
  },
  {
    shape: "event-sourced",
    source: sys(
      "persistedAs: eventLog audited",
      `create open(name: string) { emit Touched { who: name } }
        operation rename(name: string) audited { emit Touched { who: name } }
        apply(e: Touched) { name := e.who }`,
    ),
  },
];

describe("Dapper drains the audit buffer on every persistence shape", () => {
  for (const { shape, source } of SHAPES) {
    it(`${shape}: injects IAuditWriter and drains it inside the save transaction`, async () => {
      const files = generateSystems(await build(source)).files;
      const repo = files.get("d/Infrastructure/Repositories/DocRepository.cs");
      expect(repo, `no DocRepository.cs for ${shape}`).toBeDefined();
      const src = repo!;

      // The port is injected, not reached for statically.
      expect(src).toContain("private readonly IAuditWriter _audit;");
      expect(src).toContain("IAuditWriter audit");
      expect(src).toContain("_audit = audit;");

      // The drain happens, and it targets audit_records.
      expect(src).toContain("foreach (var __ar in _audit.Drain())");
      expect(src).toContain("INSERT INTO audit_records");

      // ATOMICITY: the drain runs on the open transaction and commits with the
      // state change — an audit row that autocommits separately would survive a
      // rolled-back write, which is the whole point of staging it.
      const save = src.slice(src.indexOf("public async Task SaveAsync"));
      const drainIdx = save.indexOf("_audit.Drain()");
      const beginIdx = save.indexOf("BeginTransactionAsync");
      const commitIdx = save.indexOf("__tx.CommitAsync");
      expect(beginIdx, "no transaction opened").toBeGreaterThanOrEqual(0);
      expect(drainIdx).toBeGreaterThan(beginIdx);
      expect(commitIdx).toBeGreaterThan(drainIdx);

      // The audit INSERT itself is enrolled in that transaction.
      const drainStmt = save.slice(drainIdx, commitIdx);
      expect(drainStmt).toContain("transaction: __tx");
    });
  }

  // The un-audited emit must not pay for any of this — the seam is additive.
  it("an un-audited aggregate gets no writer, no drain", async () => {
    const files = generateSystems(
      await build(sys("", "create(name: string) { name := name }")),
    ).files;
    const src = files.get("d/Infrastructure/Repositories/DocRepository.cs")!;
    expect(src).not.toContain("IAuditWriter");
    expect(src).not.toContain("_audit");
  });
});

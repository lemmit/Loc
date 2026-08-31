// M-T6.51 — `ignoring <Cap>` / `ignoring *` on the NON-RELATIONAL node saving
// shapes.  `test/generator/typescript/filter-bypass.test.ts` covers the plain
// relational repository; every other shape computed ONE capability predicate
// per aggregate and reused it for every read, so a declared
// `find … ignoring softDeletable` still filtered the soft-deleted rows out.
// Wrong data, fail-closed, and no diagnostic — the worst of the three failure
// modes, because nothing about the generated project looks wrong.
//
// Three shapes were affected and all three are pinned here:
//   • `shape: document` on drizzle   (repository-document-builder.ts)
//   • `shape: document` on mikroorm  (emit/mikroorm.ts — the same reuse)
//   • `shape: embedded`              (repository-embedded-builder.ts — its
//                                     conjunct is real SQL, not in-app)
//
// Plus the synthesised query-time-projection read, which carries the
// PROJECTION's own `ignoring` on its `FindIR` (`projection-finds.ts`) and so
// inherited the same bug.
//
// The elixir twin of the document half is §A11, fixed in #2667.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

/** Three finds over one soft-deletable aggregate: one bypassing by name, one
 *  bypassing everything, one plain control. */
function src(shape: string, persistence = ""): string {
  return `
  system S {
    capability softDeletable { isDeleted: bool  filter this.isDeleted == false }
    subdomain D { context C {
      aggregate Order ${shape} with softDeletable { total: int  status: string }
      repository OrderRepo for Order {
        find recent(): Order[] where this.total > 0 ignoring softDeletable
        find allRows(): Order[] ignoring *
        find normal(): Order[] where this.total > 0
      }
      projection AllOrders {
        status: string
        from Order as o ignoring softDeletable
        select status = o.status
      }
      projection LiveOrders {
        status: string
        from Order as o
        select status = o.status
      }
    }}
    storage primary { type: postgres }
    resource cState { for: C, kind: state, use: primary }
    deployable api { platform: node ${persistence} contexts: [C]  dataSources: [cState]  port: 3000 }
  }`;
}

async function repoFile(shape: string, persistence = ""): Promise<string> {
  const files = await generateSystemFiles(src(shape, persistence));
  const k = [...files.keys()].find((key) => key.endsWith("db/repositories/order-repository.ts"));
  expect(k, "order-repository.ts not emitted").toBeDefined();
  return files.get(k!)!;
}

function methodBody(file: string, name: string): string {
  const start = file.indexOf(`async ${name}(`);
  expect(start, `method ${name} not found`).toBeGreaterThanOrEqual(0);
  const next = file.indexOf("\n  async ", start + 1);
  return file.slice(start, next === -1 ? undefined : next);
}

/** The soft-delete conjunct in whichever form the shape emits it: an in-app
 *  predicate over the rehydrated row (document) or a Drizzle column predicate
 *  (embedded). */
function mentionsSoftDeleteFilter(body: string): boolean {
  return /x\.isDeleted === false|schema\.orders\.isDeleted/.test(body);
}

describe.each([
  ["shape: document,", "", "document / drizzle"],
  ["shape: document,", "{ persistence: mikroorm }", "document / mikroorm"],
  ["shape: embedded,", "", "embedded / drizzle"],
])("%s %s — `ignoring` on a non-relational shape (%s)", (shape, persistence) => {
  it("`ignoring <Cap>` drops the bypassed conjunct from THAT find only", async () => {
    const file = await repoFile(shape, persistence);
    expect(mentionsSoftDeleteFilter(methodBody(file, "recent"))).toBe(false);
    // The find's OWN predicate survives — only the capability conjunct went.
    expect(methodBody(file, "recent")).toMatch(/total/);
    // …and the control find is untouched, which is what makes this a bypass
    // rather than a capability that stopped working.
    expect(mentionsSoftDeleteFilter(methodBody(file, "normal"))).toBe(true);
  });

  it("`ignoring *` drops every capability conjunct", async () => {
    const file = await repoFile(shape, persistence);
    expect(mentionsSoftDeleteFilter(methodBody(file, "allRows"))).toBe(false);
  });

  it("a query-time projection's read is synthesised at all, and honours its own `ignoring`", async () => {
    const file = await repoFile(shape, persistence);
    // The route calls `repo.<projName>()` by name whatever the saving shape.
    // On `shape: embedded` the method was simply ABSENT — TS2339, a generated
    // project that does not compile — so this assertion is the compile-tier
    // half and the two below are the correctness half.
    expect(file, "synthesised projection read not emitted").toContain("async allOrders(");
    expect(mentionsSoftDeleteFilter(methodBody(file, "allOrders"))).toBe(false);
    expect(mentionsSoftDeleteFilter(methodBody(file, "liveOrders"))).toBe(true);
  });
});

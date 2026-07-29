import { describe, expect, it } from "vitest";
import type { Page } from "../../src/language/generated/ast.js";
import { ifParses, spliceNode, spliceNodeIfParses } from "../../web/src/builder/edit-engine.js";
import { collectBodies } from "../../web/src/builder/page/bodies.js";
import { parseDdd } from "../../web/src/builder/parse.js";
import { renameConstruct } from "../../web/src/builder/system/rename.js";
import { deleteByAstType, deleteInvariant } from "../../web/src/builder/system-v2/delete-extra.js";
import { renameByAstType } from "../../web/src/builder/system-v2/rename-extra.js";

// ---------------------------------------------------------------------------
// Builder write-backs must never commit a source the parser rejects.
//
// The visual builders regenerate a fragment and splice it over a CST range.
// Every one of those write-backs used to commit blind: a body-emit that lost a
// brace, a rename to a non-identifier, a delete run against a source that was
// already broken — all landed in the editor, handing the user a file they never
// typed and which the builders then refuse to reopen (they gate on
// `parserErrors`).  Audit defect #12,
// `docs/audits/playground-file-mgmt-review-2026-07.md`.
//
// The rule these pin: a write-back re-parses its candidate and returns null
// rather than committing.  Every call site already treats null as "nothing
// written", so refusal is a no-op plus a visible message (`RefusalLine`).
// ---------------------------------------------------------------------------

const PAGE_SRC = `system S {
  ui U {
    page P { body: Stack { Text { text: "hi" } } }
  }
}`;

const MODEL_SRC = `system S {
  subdomain Sales {
    context Orders {
      aggregate Order {
        total: int
        invariant total >= 0
        invariant total < 1000
      }
      aggregate Customer {
        name: string
      }
      repository Orders for Order {
        find byTotal(t: int): Order[] where this.total == t
      }
    }
  }
}`;

/** The `body:` expression node of page `name`, parsed from `src`. */
const bodyExprOf = (src: string, name: string) => {
  const page = collectBodies(parseDdd(src).ast).find((p) => p.name === name);
  if (!page) throw new Error(`no page ${name}`);
  return page.expr;
};

describe("edit-engine — the shared parse gate", () => {
  it("ifParses returns the candidate when it still parses", () => {
    expect(ifParses(PAGE_SRC)).toBe(PAGE_SRC);
  });

  it("ifParses returns null for a candidate the parser rejects", () => {
    expect(ifParses(`${PAGE_SRC}\naggregate {{{`)).toBeNull();
  });

  it("spliceNodeIfParses commits a body-emit that keeps the source parsing", () => {
    const expr = bodyExprOf(PAGE_SRC, "P");
    const next = spliceNodeIfParses(PAGE_SRC, expr, `Stack { Text { text: "bye" } }`);
    expect(next).not.toBeNull();
    expect(next).toContain(`text: "bye"`);
    expect(parseDdd(next as string).parserErrors).toHaveLength(0);
  });

  it("spliceNodeIfParses REFUSES a body-emit that corrupts the source", () => {
    const expr = bodyExprOf(PAGE_SRC, "P");
    // An emit that drops its closing brace — the splice runs, the result is
    // unparseable, so nothing is handed back to commit.
    const emitted = `Stack { Text { text: "hi" }`;
    // The unguarded splice happily produces the broken text …
    const raw = spliceNode(PAGE_SRC, expr, emitted);
    expect(parseDdd(raw).parserErrors.length).toBeGreaterThan(0);
    // … the guarded one refuses it.
    expect(spliceNodeIfParses(PAGE_SRC, expr, emitted)).toBeNull();
  });

  it("spliceNodeIfParses returns null (not a throw) for a node with no CST range", () => {
    const detached = { $type: "Page", name: "Ghost" } as unknown as Page;
    expect(spliceNodeIfParses(PAGE_SRC, detached, "Stack {}")).toBeNull();
    expect(() => spliceNode(PAGE_SRC, detached, "Stack {}")).toThrow();
  });
});

describe("renameConstruct — write-back gate", () => {
  it("renames the declaration and every reference to it", async () => {
    const next = await renameConstruct(MODEL_SRC, "aggregate", "Order", "PurchaseOrder");
    expect(next).not.toBeNull();
    expect(next).toContain("aggregate PurchaseOrder {");
    // The repository's `for Order` reference moved with it.
    expect(next).toContain("repository Orders for PurchaseOrder");
    expect(parseDdd(next as string).parserErrors).toHaveLength(0);
  });

  it("REFUSES a rename whose result the parser rejects", async () => {
    // Callers guard on IDENTIFIER, but this is the exported surface: a name
    // that isn't a bare identifier rewrites every span into garbage.
    expect(await renameConstruct(MODEL_SRC, "aggregate", "Order", "}}}")).toBeNull();
    expect(await renameConstruct(MODEL_SRC, "aggregate", "Order", "aggregate")).toBeNull();
  });

  it("still returns null for a construct that isn't there", async () => {
    expect(await renameConstruct(MODEL_SRC, "aggregate", "Nope", "Fine")).toBeNull();
  });
});

describe("renameByAstType (v2) — write-back gate", () => {
  it("renames a kind v1's NodeKind union doesn't cover", async () => {
    const next = await renameByAstType(MODEL_SRC, "BoundedContext", "Orders", "Ordering");
    expect(next).not.toBeNull();
    expect(next).toContain("context Ordering {");
    expect(parseDdd(next as string).parserErrors).toHaveLength(0);
  });

  it("REFUSES a rename whose result the parser rejects", async () => {
    expect(await renameByAstType(MODEL_SRC, "BoundedContext", "Orders", "{ }")).toBeNull();
  });

  it("still returns null for a construct that isn't there", async () => {
    expect(await renameByAstType(MODEL_SRC, "BoundedContext", "Nope", "Fine")).toBeNull();
  });
});

describe("v2 delete splices — write-back gate", () => {
  it("deleteByAstType removes the construct and keeps the source parsing", () => {
    const next = deleteByAstType(MODEL_SRC, "Aggregate", "Customer");
    expect(next).not.toBeNull();
    expect(next).not.toContain("aggregate Customer");
    // Its sibling is untouched.
    expect(next).toContain("aggregate Order {");
    expect(parseDdd(next as string).parserErrors).toHaveLength(0);
  });

  it("deleteByAstType REFUSES when the resulting source doesn't parse", () => {
    // The v2 pane re-parses on a 350 ms debounce, so the helper is routinely
    // handed a source the user is mid-keystroke on.  Deleting against it would
    // splice CST offsets into text that still carries the syntax error — the
    // result can't parse, so the delete must refuse rather than commit.
    const broken = MODEL_SRC.replace("name: string", "name:");
    expect(parseDdd(broken).parserErrors.length).toBeGreaterThan(0);
    expect(deleteByAstType(broken, "Aggregate", "Order")).toBeNull();
  });

  it("deleteByAstType returns null for a construct that isn't there", () => {
    expect(deleteByAstType(MODEL_SRC, "Aggregate", "Nope")).toBeNull();
  });

  it("deleteInvariant removes the indexed invariant, leaving its sibling", () => {
    const next = deleteInvariant(MODEL_SRC, "Order", 0);
    expect(next).not.toBeNull();
    expect(next).not.toContain("invariant total >= 0");
    expect(next).toContain("invariant total < 1000");
    expect(parseDdd(next as string).parserErrors).toHaveLength(0);
  });

  it("deleteInvariant REFUSES when the resulting source doesn't parse", () => {
    const broken = MODEL_SRC.replace("name: string", "name:");
    expect(deleteInvariant(broken, "Order", 0)).toBeNull();
  });

  it("deleteInvariant returns null for an out-of-range index or unknown aggregate", () => {
    expect(deleteInvariant(MODEL_SRC, "Order", 7)).toBeNull();
    expect(deleteInvariant(MODEL_SRC, "Nope", 0)).toBeNull();
  });
});

describe("v2 delete splices — no TOCTOU between lookup and edit", () => {
  it("addresses the node in the SAME source string it splices into", () => {
    // The pane used to locate the node in its memoised parse and splice into a
    // freshly-read `ctx.getSource()`.  When the two differ, the CST offsets
    // describe the wrong text.  The helpers now take one `source` and parse it
    // themselves, so the pair can't drift: deleting from a source with extra
    // leading text still removes exactly the named construct.
    const shifted = `// a comment the memoised parse didn't have\n${MODEL_SRC}`;
    const next = deleteByAstType(shifted, "Aggregate", "Customer");
    expect(next).not.toBeNull();
    expect(next).toContain("// a comment the memoised parse didn't have");
    expect(next).not.toContain("aggregate Customer");
    expect(next).toContain("aggregate Order {");
  });
});

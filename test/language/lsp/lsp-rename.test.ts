import { URI } from "langium";
import { NodeFileSystem } from "langium/node";
import { parseDocument } from "langium/test";
import { describe, expect, it } from "vitest";
import type { TextEdit } from "vscode-languageserver";
import { createDddServices } from "../../../src/language/ddd-module.js";

// ---------------------------------------------------------------------------
// Rename tests.  No `expectRename` helper exists in langium/test, so we drive
// the provider directly: `<|>` marks the cursor, we strip it, rename, then
// apply the returned edits and compare the rewritten source.  Covers a
// cross-reference rename (default path) and a member rename (fallback path).
// ---------------------------------------------------------------------------

const services = createDddServices(NodeFileSystem).Ddd;

async function renameAt(text: string, newName: string): Promise<string> {
  const cursor = text.indexOf("<|>");
  if (cursor < 0) throw new Error("no <|> cursor marker");
  const clean = text.replace("<|>", "");
  const doc = await parseDocument(services, clean);
  const position = doc.textDocument.positionAt(cursor);
  const edit = await services.lsp.RenameProvider!.rename(doc, {
    textDocument: { uri: doc.textDocument.uri },
    position,
    newName,
  });
  const edits = edit?.changes?.[doc.textDocument.uri] ?? [];
  return applyEdits(clean, edits, doc.textDocument.offsetAt.bind(doc.textDocument));
}

function applyEdits(
  text: string,
  edits: TextEdit[],
  offsetAt: (p: { line: number; character: number }) => number,
): string {
  const resolved = edits
    .map((e) => ({ start: offsetAt(e.range.start), end: offsetAt(e.range.end), text: e.newText }))
    .sort((a, b) => b.start - a.start);
  let out = text;
  for (const e of resolved) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

describe("RenameProvider — cross references", () => {
  it("renames an aggregate and its X id usages", async () => {
    const result = await renameAt(
      `context Sales {
  aggregate <|>Order {
    customerId: string
  }
  aggregate Customer {
    primaryOrder: Order id
  }
}`,
      "Sale",
    );
    expect(result).toContain("aggregate Sale {");
    expect(result).toContain("Sale id");
    expect(result).not.toContain("aggregate Order");
    expect(result).not.toContain("Order id");
  });
});

describe("RenameProvider — member access", () => {
  it("renames a property and its `this.` usage", async () => {
    const result = await renameAt(
      `context Sales {
  aggregate Order {
    customerId: string
    function ownerId(): string = this.<|>customerId
  }
}`,
      "ownerKey",
    );
    expect(result).toContain("ownerKey: string");
    expect(result).toContain("this.ownerKey");
    expect(result).not.toContain("customerId");
  });

  it("renames a property from its declaration", async () => {
    const result = await renameAt(
      `context Sales {
  aggregate Order {
    <|>customerId: string
    function ownerId(): string = this.customerId
  }
}`,
      "ownerKey",
    );
    expect(result).toContain("ownerKey: string");
    expect(result).toContain("this.ownerKey");
    expect(result).not.toContain("customerId");
  });

  it("renames a property used as an assignment target", async () => {
    const result = await renameAt(
      `context Sales {
  enum Status { Open, Closed }
  aggregate Order {
    <|>status: Status
    operation close() { status := Closed }
  }
}`,
      "state",
    );
    expect(result).toContain("state: Status");
    expect(result).toContain("state := Closed");
    expect(result).not.toMatch(/\bstatus\b/);
  });
});

describe("RenameProvider — operations", () => {
  // Regression for the bug where `Operation` was excluded from
  // `isRenameableMember`, so renaming an operation went through the index-driven
  // default and rewrote the declaration only — leaving `x.op()` / `op()` call
  // sites (MemberSuffix tokens the index can't see) stale.
  //
  // NB: receivers the type system can't infer (e.g. a workflow `let w =
  // Repo.getById(...)` binding) are a known blind spot for *all* member renames,
  // not just operations — tracked in agent-tools-and-mcp.md §4c. These tests use
  // `this.`/bare call sites, which resolve.
  it("renames an operation declaration and rewrites its call sites", async () => {
    const result = await renameAt(
      `context Sales {
  aggregate Wallet {
    balance: int
    operation <|>debit(amount: int) {
      balance := balance - amount
    }
    operation drain() {
      this.debit(balance)
    }
  }
}`,
      "withdraw",
    );
    expect(result).toContain("operation withdraw(amount: int)");
    expect(result).toContain("this.withdraw(balance)"); // call site must follow
    expect(result).not.toMatch(/\bdebit\b/);
  });
});

describe("RenameProvider — cross-reference categories", () => {
  // These categories reference the declaration through Langium cross-references
  // (type refs / emit / etc.), which the index-driven default rename handles.
  it("renames an enum declaration and its type-ref usage", async () => {
    const result = await renameAt(
      `context Sales {
  enum <|>Status { Open, Closed }
  aggregate Order { kind: Status }
}`,
      "State",
    );
    expect(result).toContain("enum State {");
    expect(result).toContain("kind: State");
    expect(result).not.toMatch(/\bStatus\b/);
  });

  it("renames an event and its emit usage", async () => {
    const result = await renameAt(
      `context Sales {
  event <|>Placed { at: int }
  aggregate Order {
    total: int
    operation place() { emit Placed { at: 1 } }
  }
}`,
      "Created",
    );
    expect(result).toContain("event Created {");
    expect(result).toContain("emit Created");
    expect(result).not.toMatch(/\bPlaced\b/);
  });

  it("renames a value object referenced by name in a field type", async () => {
    const result = await renameAt(
      `context Sales {
  valueobject <|>Money { amount: int }
  aggregate Order { price: Money }
}`,
      "Cash",
    );
    expect(result).toContain("valueobject Cash {");
    expect(result).toContain("price: Cash");
    expect(result).not.toMatch(/\bMoney\b/);
  });

  // Regression for the soft-keyword field-name gap: a field named `state`
  // (a page/storage keyword now admitted in `Property.name`) used to fail to
  // parse, which silently blocked renaming the `Status` type-ref on that field.
  // Renaming the enum now rewrites the `state: Status` type-ref too.
  it("renames an enum type-ref on a field named with a soft keyword (`state`)", async () => {
    const result = await renameAt(
      `context Sales {
  enum <|>Status { Open, Closed }
  aggregate Order { state: Status }
}`,
      "State",
    );
    expect(result).toContain("enum State {");
    expect(result).toContain("state: State");
    expect(result).not.toMatch(/\bStatus\b/);
  });

  // Enum-value rename: bare use sites (`st := Open`) now follow the declaration
  // (`nameRefDecl` resolves them through the same enum scan `lower-expr` uses).
  it("renames an enum value and its bare use sites", async () => {
    const result = await renameAt(
      `context Sales {
  enum Status { <|>Open, Closed }
  aggregate Order {
    st: Status
    operation close() { st := Open }
  }
}`,
      "Active",
    );
    expect(result).toContain("{ Active, Closed }");
    expect(result).toContain("st := Active");
    expect(result).not.toMatch(/\bOpen\b/);
  });

  // The *qualified* enum-value form `Status.Open` now follows too: the head
  // `Status` is an enum NAME (types as `unknown` as a value expression), so the
  // MemberSuffix path's `stepIntoNode` can't reach the value — a dedicated
  // `qualifiedEnumValueDecl` case resolves the head enum by name, then its
  // value.  Covers rename from the declaration with a mixed bare + qualified
  // body, and rename driven from a qualified use site.
  it("renames an enum value used in qualified form (Status.Open)", async () => {
    const result = await renameAt(
      `context Sales {
  enum Status { <|>Open, Closed }
  aggregate Order {
    st: Status
    operation a() { st := Open }
    operation b() { st := Status.Open }
  }
}`,
      "Active",
    );
    expect(result).toContain("{ Active, Closed }");
    expect(result).toContain("st := Active"); // bare form
    expect(result).toContain("st := Status.Active"); // qualified form
    expect(result).not.toMatch(/\bOpen\b/);
  });

  it("renames an enum value from its qualified use site (Status.Open)", async () => {
    const result = await renameAt(
      `context Sales {
  enum Status { Open, Closed }
  aggregate Order {
    st: Status
    operation b() { st := Status.<|>Open }
  }
}`,
      "Active",
    );
    expect(result).toContain("{ Active, Closed }"); // declaration follows
    expect(result).toContain("st := Status.Active");
    expect(result).not.toMatch(/\bOpen\b/);
  });

  it("renames a function and its bare call site", async () => {
    const result = await renameAt(
      `context Sales {
  aggregate Order {
    rate: int
    function <|>tax(): int = rate
    derived total: int = tax()
  }
}`,
      "levy",
    );
    expect(result).toContain("function levy()");
    expect(result).toContain("= levy()"); // bare call site now follows the declaration
    expect(result).not.toMatch(/\btax\b/);
  });
});

describe("RenameProvider — shadowing, prepareRename, multi-file", () => {
  it("does not rename a member reference shadowed by a lambda param", async () => {
    // The lambda param `total` shadows the property `total`; renaming the
    // property must rewrite the declaration + `this.total`, but leave the
    // lambda (`nums.sum(total => total)`) untouched.
    const result = await renameAt(
      `context Sales {
  aggregate Order {
    <|>total: int
    nums: int[]
    function f(): int = nums.sum(total => total) + this.total
  }
}`,
      "amount",
    );
    expect(result).toContain("amount: int");
    expect(result).toContain("this.amount");
    expect(result).toContain("nums.sum(total => total)"); // lambda left alone
  });

  it("prepareRename selects exactly the identifier token", async () => {
    const text = `context Sales {
  aggregate Order {
    total: int
  }
}`;
    const doc = await parseDocument(services, text);
    const range = await services.lsp.RenameProvider!.prepareRename!(doc, {
      textDocument: { uri: doc.textDocument.uri },
      position: doc.textDocument.positionAt(text.indexOf("total")),
    });
    expect(range).toBeDefined();
    expect(doc.textDocument.getText(range ?? undefined)).toBe("total");
  });

  it("renames an aggregate across files (the X id usage in another file)", async () => {
    const shared = services.shared;
    const factory = shared.workspace.LangiumDocumentFactory;
    const a = factory.fromString(
      `context A {\n  aggregate Order {\n    total: int\n  }\n}`,
      URI.parse("memory://rename-a.ddd"),
    );
    const b = factory.fromString(
      `context B {\n  aggregate Cart {\n    order: Order id\n  }\n}`,
      URI.parse("memory://rename-b.ddd"),
    );
    shared.workspace.LangiumDocuments.addDocument(a);
    shared.workspace.LangiumDocuments.addDocument(b);
    await shared.workspace.DocumentBuilder.build([a, b], { validation: true });

    const edit = await services.lsp.RenameProvider!.rename(a, {
      textDocument: { uri: a.textDocument.uri },
      position: a.textDocument.positionAt(a.textDocument.getText().indexOf("Order")),
      newName: "Purchase",
    });
    const bEdits = edit?.changes?.[b.textDocument.uri] ?? [];
    expect(bEdits.length).toBe(1); // the `Order id` cross-ref in file B
    expect(bEdits[0]?.newText).toBe("Purchase");
  });
});

describe("RenameProvider — system-scoped declarations", () => {
  // Deployables and subdomains (modules) are referenced through Langium
  // cross-references (`targets:` / `against` for deployables; `api … from` for
  // subdomains), so the index-driven default rename already rewrites every use
  // site.  These pin that contract across a full `system` fixture — the one
  // scope the member-access tests above don't reach.
  it("renames a deployable and its `targets:` + `against` references", async () => {
    const result = await renameAt(
      `system Acme {
  subdomain Sales { context Orders { aggregate Order { total: int } } }
  deployable <|>backend {
    platform: node
    contexts: [Orders]
    port: 8080
  }
  deployable web {
    platform: static
    targets: backend
    ui: WebUi
    port: 3000
  }
  ui WebUi { }
  test e2e "smoke" against backend { }
}`,
      "core",
    );
    expect(result).toContain("deployable core {");
    expect(result).toContain("targets: core"); // cross-ref in the static deployable
    expect(result).toContain("against core"); // cross-ref in the e2e test
    expect(result).not.toMatch(/\bbackend\b/);
  });

  it("renames a subdomain (module) and its `api … from` reference", async () => {
    const result = await renameAt(
      `system Acme {
  subdomain <|>Sales { context Orders { aggregate Order { total: int } } }
  api SalesApi from Sales
}`,
      "Selling",
    );
    expect(result).toContain("subdomain Selling {");
    expect(result).toContain("from Selling");
    expect(result).not.toMatch(/\bfrom Sales\b/);
  });
});

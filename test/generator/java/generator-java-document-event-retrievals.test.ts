// ---------------------------------------------------------------------------
// Java backend — retrievals (`retrieval` query bundles) on the two
// non-relational persistence shapes.  A document jsonb column and an
// event log are not query targets, so each `run<Name>` rehydrates every
// aggregate via `findAll()`, evaluates the retrieval's `where` (a typed
// ExprIR) in memory through the Java expression renderer, applies the
// `sort:` as a `Comparator`, and offset/limits the paged overload —
// the .NET document-/event-repository hydrate-then-filter shape.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SRC = `
system ReadsShop {
  subdomain Core {
    context Catalog {
      aggregate Product shape: document {
        name: string
        category: string
        price: int
      }
      repository Products for Product { }

      criterion InCategory(cat: string) of Product = category == cat

      retrieval CheapInCategory(cat: string, max: int) of Product {
        where: InCategory(cat) && price <= max
        sort:  [price asc, name desc]
      }

      event AccountOpened { account: Account id, owner: string }
      event Deposited { account: Account id, amount: int }

      aggregate Account persistedAs: eventLog {
        owner: string
        balance: int

        create open(owner: string) {
          emit AccountOpened { account: id, owner: owner }
        }
        operation deposit(amount: int) {
          precondition amount > 0
          emit Deposited { account: id, amount: amount }
        }
        apply(e: AccountOpened) { owner := e.owner balance := 0 }
        apply(e: Deposited) { balance := balance + e.amount }
      }
      repository Accounts for Account { }

      retrieval RichAccounts(min: int) of Account {
        where: balance >= min
        sort:  [balance desc]
      }
    }
  }
  api CatalogApi from Core
  storage primary { type: postgres }
  resource productState { for: Catalog, kind: state, use: primary }
  resource accountEvents { for: Catalog, kind: eventLog, use: primary }
  deployable catalogApi {
    platform: java
    contexts: [Catalog]
    dataSources: [productState, accountEvents]
    serves: CatalogApi
    port: 8080
  }
}
`;

const ROOT = "catalog_api/src/main/java/com/loom/catalogapi";

async function files(): Promise<Map<string, string>> {
  return generateSystemFiles(SRC);
}

describe("java document-shape retrievals (in-memory hydrate-then-filter)", () => {
  async function impl(): Promise<string> {
    return (await files()).get(`${ROOT}/features/products/ProductRepositoryImpl.java`)!;
  }

  it("emits both run<Name> overloads (no throw)", async () => {
    const r = await impl();
    expect(r).toContain("public List<Product> runCheapInCategory(String cat, int max) {");
    expect(r).toContain(
      "public List<Product> runCheapInCategory(String cat, int max, Integer offset, Integer limit) {",
    );
  });

  it("evaluates the retrieval `where` predicate in memory over rehydrated rows", async () => {
    const r = await impl();
    expect(r).toContain(
      "findAll().stream().filter(x -> Objects.equals(x.category(), cat) && x.price() <= max)",
    );
    expect(r).toContain("import java.util.Objects;");
  });

  it("applies the `sort:` as a Comparator chain (mixed asc/desc)", async () => {
    const r = await impl();
    expect(r).toContain("import java.util.Comparator;");
    expect(r).toContain(
      ".sorted(Comparator.<Product, Comparable>comparing(x -> x.price()).thenComparing(Comparator.<Product, Comparable>comparing(x -> x.name()).reversed()))",
    );
  });

  it("offset/limits the paged overload (null offset → 0, null limit → unbounded)", async () => {
    const r = await impl();
    expect(r).toContain(".skip(offset == null ? 0L : offset.longValue())");
    expect(r).toContain(".limit(limit == null ? Long.MAX_VALUE : limit.longValue())");
  });
});

describe("java event-sourced retrievals (fold-all then filter in memory)", () => {
  async function impl(): Promise<string> {
    return (await files()).get(`${ROOT}/features/accounts/AccountRepositoryImpl.java`)!;
  }

  it("emits both run<Name> overloads folding through findAll() (no throw)", async () => {
    const r = await impl();
    expect(r).toContain("public List<Account> runRichAccounts(int min) {");
    expect(r).toContain(
      "public List<Account> runRichAccounts(int min, Integer offset, Integer limit) {",
    );
    expect(r).toContain("findAll().stream().filter(x -> x.balance() >= min)");
  });

  it("sorts via a Comparator (single desc term reversed)", async () => {
    const r = await impl();
    expect(r).toContain("import java.util.Comparator;");
    expect(r).toContain(
      ".sorted(Comparator.<Account, Comparable>comparing(x -> x.balance()).reversed())",
    );
  });
});

describe("java retrieval port surface for non-relational shapes", () => {
  it("declares the run<Name> overloads on both domain repository ports", async () => {
    const f = await files();
    const productPort = f.get(`${ROOT}/features/products/ProductRepository.java`)!;
    expect(productPort).toContain("    List<Product> runCheapInCategory(String cat, int max);");
    expect(productPort).toContain(
      "    List<Product> runCheapInCategory(String cat, int max, Integer offset, Integer limit);",
    );
    const accountPort = f.get(`${ROOT}/features/accounts/AccountRepository.java`)!;
    expect(accountPort).toContain("    List<Account> runRichAccounts(int min);");
    expect(accountPort).toContain(
      "    List<Account> runRichAccounts(int min, Integer offset, Integer limit);",
    );
  });
});

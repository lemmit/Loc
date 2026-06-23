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
    platform: elixir { foundation: ash }
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

  // DEBT-02 — an embedded Ash resource's root attributes (`is_deleted`) are
  // real columns, so a non-principal capability filter rides the same
  // `base_filter` the relational path emits; only the `contains` parts ride an
  // embedded resource.  The validator now allows elixir + embedded.
  it("emits a base_filter for a non-principal filter on an embedded aggregate", async () => {
    const src = `
system Sys {
  subdomain Sales {
    context Docs {
      aggregate Doc shape(embedded) {
        subject: string
        isDeleted: bool
        filter !this.isDeleted
        contains lines: Line[]
        entity Line { text: string }
      }
      repository Docs for Doc {}
    }
  }
  storage primary { type: postgres }
  resource docsState { for: Docs, kind: state, use: primary }
  ui WebApp {}
  deployable api {
    platform: elixir { foundation: ash }
    contexts: [Docs]
    dataSources: [docsState]
    ui: WebApp
    port: 4000
  }
}
`;
    const doc = find(await generate(src), (k) => k.endsWith("/docs/doc.ex"), "doc.ex");
    expect(doc.split("\n").find((l) => l.includes("base_filter"))).toBe(
      "    base_filter expr(not is_deleted)",
    );
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
    platform: elixir { foundation: ash }
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
    platform: elixir { foundation: ash }
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

// ---------------------------------------------------------------------------
// DEBT-01 — principal-referencing (tenancy) filter on Phoenix/Ash.
// `filter this.tenantId == currentUser.tenantId` becomes an Ash
// `base_filter expr(tenant_id == ^actor(:tenant_id))`, and every read of the
// aggregate runs with `actor: current_user` (the request principal) so the
// actor template resolves.  vanilla Ecto still defers it (validator-gated).
// ---------------------------------------------------------------------------

function tenancySys(): string {
  return `
system Bank {
  user { id: string  tenantId: string }
  subdomain Core {
    context Ledger {
      aggregate Account ids guid {
        tenantId: string
        balance: int
        filter this.tenantId == currentUser.tenantId
      }
      repository Accounts for Account {}
    }
  }
  api LedgerApi from Core
  storage primary { type: postgres }
  resource ledgerState { for: Ledger, kind: state, use: primary }
  deployable api {
    platform: elixir { foundation: ash }
    contexts: [Ledger]
    dataSources: [ledgerState]
    serves: LedgerApi
    auth: required
    port: 4000
  }
}
`;
}

describe("Phoenix capability filter — principal (tenancy) base_filter (DEBT-01)", () => {
  it("renders the principal predicate with ^actor(:field) and threads actor on reads", async () => {
    const files = await generate(tenancySys());
    const acct = find(files, (k) => k.endsWith("/ledger/account.ex"), "account.ex");
    // currentUser.tenantId binds the request actor, not a bare current_user.
    expect(acct).toContain("base_filter expr(tenant_id == ^actor(:tenant_id))");
    expect(acct).not.toContain("current_user");

    // The controller threads the actor into the standard reads so the
    // ^actor template resolves (else the base_filter is fail-closed → no rows).
    const ctrl = find(files, (k) => k.endsWith("_controller.ex"), "controller");
    expect(ctrl).toContain("list_accounts!(actor: conn.assigns.current_user)");
    expect(ctrl).toContain("get_account!(id, actor: conn.assigns.current_user)");
  });
});

// ---------------------------------------------------------------------------
// DEBT-02 Slice A — a PRINCIPAL-referencing (tenancy) capability filter on a
// `shape(embedded)` aggregate (Ash).  The embedded resource's root attributes
// are real columns, so the principal predicate reuses the relational-principal
// path: `base_filter expr(tenant_id == ^actor(:tenant_id))` on a resource that
// ALSO carries an `{:array, Item}` embedded attribute, with `actor:
// current_user` threaded onto every read.  Previously gated by
// `loom.context-filter-unsupported`.
// ---------------------------------------------------------------------------

function embeddedTenancySys(): string {
  return `
system EmbTenancy {
  user { id: string  tenantId: string }
  subdomain D {
    context Shop {
      aggregate Order shape(embedded) {
        tenantId: string
        code: string
        filter this.tenantId == currentUser.tenantId
        contains items: Item[]
        entity Item { sku: string }
        operation addItem(sku: string) { items += Item { sku: sku } }
      }
      repository Orders for Order {}
    }
  }
  api A from D
  storage primary { type: postgres }
  resource st { for: Shop, kind: state, use: primary }
  deployable api {
    platform: elixir { foundation: ash }
    contexts: [Shop]
    dataSources: [st]
    serves: A
    auth: required
    port: 4000
  }
}
`;
}

describe("Phoenix embedded principal (tenancy) base_filter (DEBT-02 Slice A)", () => {
  it("renders the principal base_filter on the embedded resource and threads actor on reads", async () => {
    const files = await generate(embeddedTenancySys());
    const order = find(files, (k) => k.endsWith("/shop/order.ex"), "order.ex");
    expect(order).toContain("base_filter expr(tenant_id == ^actor(:tenant_id))");
    expect(order).not.toContain("current_user");
    // The embedded containment still rides an embedded attribute on the resource.
    expect(order).toContain("items");

    const ctrl = find(files, (k) => k.endsWith("_controller.ex"), "controller");
    expect(ctrl).toContain("list_orders!(actor: conn.assigns.current_user)");
    expect(ctrl).toContain("get_order!(id, actor: conn.assigns.current_user)");
  });
});

// ---------------------------------------------------------------------------
// DEBT-01 follow-up — actor threading through the two read paths the first
// Ash slice deferred: an `or`-union returning op (Ash.get) and a context
// retrieval invoked from a workflow (Repo.run).  Both read the tenancy
// aggregate under its `^actor(:field)` base_filter, so both must pass the
// request actor; else `^actor` is nil and the read is fail-closed (no rows).
// ---------------------------------------------------------------------------

function tenancyOpsSys(): string {
  return `
system Bank {
  user { id: string  tenantId: string }
  subdomain Core {
    context Ledger {
      error NotFound { resource: string }
      criterion Rich(min: int) of Account = balance >= min
      aggregate Account ids guid {
        tenantId: string
        balance: int
        verified: bool
        filter this.tenantId == currentUser.tenantId
        operation verify() { verified := true }
        operation balanceOf(): int or NotFound { return balance }
      }
      repository Accounts for Account {}
      retrieval RichAccounts(min: int) of Account { where: Rich(min)  sort: [balance desc] }
      workflow verifyRich {
        create(min: int) {
          let matched = Accounts.run(RichAccounts(min), page: { offset: 0, limit: 100 })
          for a in matched { a.verify() }
        }
      }
    }
  }
  api LedgerApi from Core
  storage primary { type: postgres }
  resource ledgerState { for: Ledger, kind: state, use: primary }
  deployable api {
    platform: elixir { foundation: ash }
    contexts: [Ledger]
    dataSources: [ledgerState]
    serves: LedgerApi
    auth: required
    port: 4000
  }
}
`;
}

describe("Phoenix tenancy — retrieval + returning-op actor threading (DEBT-01)", () => {
  it("threads the actor into the returning-op Ash.get + its controller call", async () => {
    const files = await generate(tenancyOpsSys());
    const acct = find(files, (k) => k.endsWith("/ledger/account.ex"), "account.ex");
    // The generic action's run fn reads the record with the request actor.
    expect(acct).toContain("run fn input, context ->");
    expect(acct).toContain("Ash.get(__MODULE__, input.arguments.id, actor: context.actor)");

    const ctrl = find(files, (k) => k.endsWith("accounts_controller.ex"), "controller");
    expect(ctrl).toContain("balance_of_account(id, actor: conn.assigns.current_user)");
  });

  it("threads the actor into the workflow retrieval (Repo.run) call", async () => {
    const files = await generate(tenancyOpsSys());
    const wf = find(files, (k) => k.endsWith("/workflows/verify_rich.ex"), "workflow");
    expect(wf).toContain(
      "run_rich_accounts_account!(min, page: [offset: 0, limit: 100], actor: current_user)",
    );
  });
});

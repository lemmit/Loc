// Workflow ↔ repository call-site alignment on .NET (generated-code-ddd-review
// P0s #2/#3):
//
//  - `if let x = Repo.find(<Criterion>)` runs through the repo's synthetic
//    Run<Retrieval>Async method, so the handler must DI-inject that repository
//    even when the workflow contains no other repo statement — the
//    constructor-dependency scan has to recurse into the if-let (and its
//    branches), like the sibling for-each arm.
//
//  - `let x = Repo.<find>(…)` must call the method by the NAME the repository
//    interface actually emits: custom DSL finds carry NO Async suffix
//    (`Task<Order?> Locate(...)` — see emit/repository.ts), only the built-in
//    getById / FindManyByIds / Run* methods do.  `_orders.LocateAsync(...)`
//    is a CS1061 under /warnaserror.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SYS = (workflow: string): string => `
system S {
  subdomain Sales {
    context Orders {
      enum Status { Draft, Cancelled }
      aggregate Order {
        code: string  status: Status  region: string
        operation cancel() { status := Cancelled }
      }
      aggregate Customer {
        name: string
        operation touch() { name := name }
      }
      error OrderNotFound { code: string }
      repository Orders for Order {
        find locate(code: string): Order or OrderNotFound where this.code == code
      }
      repository Customers for Customer { }
      criterion ActiveOrder of Order = status != Cancelled
      event OrderMissing { code: string }
      command C { region: string, cust: Customer id }
      workflow W { create(c: C) { ${workflow} } }
    }
  }
  api A from Sales
  storage pg { type: postgres }
  resource s { for: Orders, kind: state, use: pg }
  deployable d { platform: dotnet  contexts: [Orders]  dataSources: [s]  serves: A  port: 3000 }
}`;

async function handler(workflow: string): Promise<string> {
  const files = await generateSystemFiles(SYS(workflow));
  const key = [...files.keys()].find((k) => k.endsWith("Application/Workflows/WHandler.cs"));
  if (!key) throw new Error(`no WHandler.cs; have:\n${[...files.keys()].join("\n")}`);
  return files.get(key)!;
}

describe(".NET workflow handler — repository call sites", () => {
  it("injects the repository used only by an if-let load", async () => {
    const src = await handler(
      `if let o = Orders.find(ActiveOrder) { o.cancel() } else { emit OrderMissing { code: c.region } }`,
    );
    // The load itself needs the repo — ctor + field, not just the call.
    expect(src).toContain("private readonly IOrderRepository _orders;");
    expect(src).toMatch(/public WHandler\([^)]*IOrderRepository orders/);
    expect(src).toContain("_orders = orders;");
    expect(src).toContain("await _orders.RunFindAllByActiveOrderAsync(");
  });

  it("injects a repository first used inside an if-let branch body (walks the branches)", async () => {
    const src = await handler(
      `if let o = Orders.find(ActiveOrder) { let cu = Customers.getById(c.cust)  cu.touch() }`,
    );
    // Customers appears ONLY inside the then-branch — reachable exclusively
    // by recursing into the if-let's bodies.
    expect(src).toContain("private readonly ICustomerRepository _customers;");
    expect(src).toContain("await _customers.GetByIdAsync(");
  });

  it("calls a custom (union) find by its interface name — no Async suffix", async () => {
    const src = await handler(
      `let outcome = Orders.locate(c.region)
       let label = match outcome {
         Order o => o.code,
         OrderNotFound => "missing"
       }`,
    );
    // Interface emits `Task<Order?> Locate(...)`; the call site must match.
    expect(src).toContain("await _orders.Locate(");
    expect(src).not.toContain("LocateAsync");
  });
});

// A `getById` repo-let returns `Task<T?>`; the emitter appends a `?? throw
// AggregateNotFoundException` guard whenever the bound name is DEREFERENCED.
// The deref scan used to see only op-call TARGETS (`cu.touch()`) and
// domain-service args — a load deref'd exclusively via a member read inside an
// expression (an op-call arg, an emit field seed: `loaded.DataKey + "." + seg`)
// stayed unguarded, a CS8602 under /warnaserror.  Found by the
// tenancy-hierarchy corpus fixture's signUpChild workflow on the dotnet
// compile tier.
describe(".NET workflow handler — getById load-or-throw guard covers expression derefs", () => {
  it("guards a load deref'd only via a member read inside an emit field", async () => {
    const src = await handler(
      `let cu = Customers.getById(c.cust)
       emit OrderMissing { code: cu.name }`,
    );
    expect(src).toContain("await _customers.GetByIdAsync(");
    expect(src).toMatch(/GetByIdAsync\([^;]*\n\s*\?\? throw new AggregateNotFoundException/);
  });

  it("guards a load deref'd only inside an op-call ARGUMENT on another aggregate", async () => {
    const src = await handler(
      `let cu = Customers.getById(c.cust)
       if let o = Orders.find(ActiveOrder) { o.cancel()  emit OrderMissing { code: cu.name } }`,
    );
    // `cu` is never an op-call target — only its member is read inside the
    // if-let branch.  The walk must still see the deref through nested bodies.
    expect(src).toMatch(/GetByIdAsync\([^;]*\n\s*\?\? throw new AggregateNotFoundException/);
  });

  it("leaves a never-dereferenced load unguarded (byte-identity)", async () => {
    const src = await handler(`let cu = Customers.getById(c.cust)`);
    expect(src).toContain("await _customers.GetByIdAsync(");
    expect(src).not.toContain("?? throw new AggregateNotFoundException");
  });
});

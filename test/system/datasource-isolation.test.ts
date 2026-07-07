// End-to-end coverage for `resource X { isolationLevel: <level> }`
// flowing into the .NET BeginTransactionAsync call and the Phoenix
// Ash.transaction `isolation_level:` opt.  The resolver helper is
// unit-tested in `test/ir/resolve-datasource.test.ts`; this gate
// proves the value actually shows up in the generated source.

import { NodeFileSystem } from "langium/node";
import { parseHelper } from "langium/test";
import { describe, expect, it } from "vitest";
import { createDddServices } from "../../src/language/ddd-module.js";
import type { Model } from "../../src/language/generated/ast.js";
import { generateSystems } from "../../src/system/index.js";

async function emit(src: string) {
  const services = createDddServices(NodeFileSystem);
  const helper = parseHelper(services.Ddd);
  const doc = await helper(src, { validation: true });
  return generateSystems(doc.parseResult.value as Model).files;
}

describe("resource isolationLevel — end-to-end emit", () => {
  it(".NET workflow handler picks up the dataSource's isolationLevel when the workflow doesn't set its own", async () => {
    const files = await emit(`
      system Sys {
        subdomain M {
          context C {
            aggregate Customer {
              name: string
              derived display: string = name
              creditLimit: decimal
              operation addCredit(amount: decimal) {
                precondition amount > 0
                creditLimit := creditLimit + amount
              }
            }
            repository Customers for Customer { }
            workflow bumpCredit transactional {
      create(customerId: Customer id, amount: decimal) {
              let c = Customers.getById(customerId)
              c.addCredit(amount)
            }
    }
          }
        }
        storage pg { type: postgres }
        resource cState {
          for: C, kind: state, use: pg, isolationLevel: serializable
        }
        deployable api {
          platform: dotnet, contexts: [C], dataSources: [cState], port: 5000
        }
      }
    `);
    const handler = [...files.keys()].find((k) => k.endsWith("BumpCreditHandler.cs"));
    expect(handler, "BumpCreditHandler.cs emitted").toBeDefined();
    const body = files.get(handler!)!;
    expect(body).toMatch(
      /BeginTransactionAsync\(IsolationLevel\.Serializable, cancellationToken\)/,
    );
    expect(body).toMatch(/using System\.Data;/);
  });

  it(".NET workflow's explicit isolation overrides the resource default", async () => {
    const files = await emit(`
      system Sys {
        subdomain M {
          context C {
            aggregate Customer {
              name: string
              derived display: string = name
              creditLimit: decimal
              operation addCredit(amount: decimal) {
                precondition amount > 0
                creditLimit := creditLimit + amount
              }
            }
            repository Customers for Customer { }
            workflow bumpCredit transactional(readCommitted) {
      create(customerId: Customer id, amount: decimal) {
              let c = Customers.getById(customerId)
              c.addCredit(amount)
            }
    }
          }
        }
        storage pg { type: postgres }
        resource cState {
          for: C, kind: state, use: pg, isolationLevel: serializable
        }
        deployable api {
          platform: dotnet, contexts: [C], dataSources: [cState], port: 5000
        }
      }
    `);
    const handler = [...files.keys()].find((k) => k.endsWith("BumpCreditHandler.cs"));
    const body = files.get(handler!)!;
    // Workflow-level readCommitted wins over resource serializable.
    expect(body).toMatch(
      /BeginTransactionAsync\(IsolationLevel\.ReadCommitted, cancellationToken\)/,
    );
    expect(body).not.toMatch(/Serializable/);
  });

  it(".NET non-transactional workflow ignores the resource isolationLevel entirely", async () => {
    const files = await emit(`
      system Sys {
        subdomain M {
          context C {
            aggregate Customer {
              name: string
              derived display: string = name
              creditLimit: decimal
              operation addCredit(amount: decimal) {
                precondition amount > 0
                creditLimit := creditLimit + amount
              }
            }
            repository Customers for Customer { }
            workflow bumpCredit {
      create(customerId: Customer id, amount: decimal) {
              let c = Customers.getById(customerId)
              c.addCredit(amount)
            }
    }
          }
        }
        storage pg { type: postgres }
        resource cState {
          for: C, kind: state, use: pg, isolationLevel: serializable
        }
        deployable api {
          platform: dotnet, contexts: [C], dataSources: [cState], port: 5000
        }
      }
    `);
    const handler = [...files.keys()].find((k) => k.endsWith("BumpCreditHandler.cs"));
    const body = files.get(handler!)!;
    // No transaction at all when workflow isn't transactional.
    expect(body).not.toMatch(/BeginTransactionAsync/);
    expect(body).not.toMatch(/IsolationLevel/);
  });

  it("Phoenix (vanilla) transactional workflow wraps the body in Repo.transaction/1", async () => {
    const files = await emit(`
      system Sys {
        subdomain M {
          context C {
            aggregate Customer {
              name: string
              derived display: string = name
              creditLimit: decimal
              operation addCredit(amount: decimal) {
                precondition amount > 0
                creditLimit := creditLimit + amount
              }
            }
            repository Customers for Customer { }
            workflow bumpCredit transactional {
      create(customerId: Customer id, amount: decimal) {
              let c = Customers.getById(customerId)
              c.addCredit(amount)
            }
    }
          }
        }
        api CApi from C
        ui Admin with scaffold(subdomains: [M]) { }
        storage pg { type: postgres }
        resource cState {
          for: C, kind: state, use: pg, isolationLevel: repeatableRead
        }
        deployable phoenixApp {
          platform: elixir, contexts: [C], dataSources: [cState],
          serves: CApi, ui: Admin, port: 4000
        }
      }
    `);
    const wf = [...files.keys()].find((k) => k.endsWith("bump_credit.ex"));
    expect(wf, "bump_credit.ex emitted").toBeDefined();
    const body = files.get(wf!)!;
    // The vanilla foundation runs the body inside plain Ecto's
    // `Repo.transaction/1`.  Ecto has no `isolation_level:` opt, so the
    // resolved level (here the dataSource's `repeatableRead`) is set with a
    // `SET TRANSACTION ISOLATION LEVEL …` query as the first statement inside
    // the transaction fn.
    expect(body).toMatch(/Repo\.transaction\(fn ->/);
    expect(body).toMatch(/Repo\.query!\("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ"\)/);
    expect(body).toMatch(/commit_result\(run_inner\(params\)\)/);
    // No Ash-style keyword opt.
    expect(body).not.toMatch(/isolation_level:/);
  });

  it("Phoenix (vanilla) transactional workflow omits the SET line when no isolation level resolves", async () => {
    const files = await emit(`
      system Sys {
        subdomain M {
          context C {
            aggregate Customer {
              name: string
              derived display: string = name
              creditLimit: decimal
              operation addCredit(amount: decimal) {
                precondition amount > 0
                creditLimit := creditLimit + amount
              }
            }
            repository Customers for Customer { }
            workflow bumpCredit transactional {
      create(customerId: Customer id, amount: decimal) {
              let c = Customers.getById(customerId)
              c.addCredit(amount)
            }
    }
          }
        }
        api CApi from C
        ui Admin with scaffold(subdomains: [M]) { }
        storage pg { type: postgres }
        resource cState {
          for: C, kind: state, use: pg
        }
        deployable phoenixApp {
          platform: elixir, contexts: [C], dataSources: [cState],
          serves: CApi, ui: Admin, port: 4000
        }
      }
    `);
    const wf = [...files.keys()].find((k) => k.endsWith("bump_credit.ex"));
    expect(wf, "bump_credit.ex emitted").toBeDefined();
    const body = files.get(wf!)!;
    // No isolation set anywhere → byte-identical to the original bare wrap.
    expect(body).toMatch(/Repo\.transaction\(fn -> commit_result\(run_inner\(params\)\) end\)/);
    expect(body).not.toMatch(/SET TRANSACTION ISOLATION LEVEL/);
  });
});

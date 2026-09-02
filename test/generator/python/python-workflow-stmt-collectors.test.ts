// Python workflow-body COLLECTORS — every statement kind that reads something
// must be walked, or the emitted module names something it never defines.
//
// Three collectors decide what a generated workflow handler binds and imports:
// `collectUsedLetNames` (drop a `let` nothing reads — ruff F841),
// `collectServiceReadPorts` (construct the repo handles a domain-service call
// takes) and `domainServiceImportLinesForWorkflow` (import the service fn).
// All three used to walk a HAND-ENUMERATED `WorkflowStmtIR` switch, and each
// switch was missing a different set of kinds.  That is not a cosmetic
// traversal gap: the reader is still emitted while its binding / handle /
// import is not, so the module references an undefined name — ruff F821 and, at
// runtime, a `NameError` on the first request.
//
// Every case below is built so exactly ONE previously-missing arm decides the
// assertion, and each was reproduced end-to-end (`ruff check` on the generated
// project reports F821 before the fix, passes after).  All three now ride the
// shared `never`-checked walker in `src/ir/util/walk.ts`.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const fileEndingWith = (files: Map<string, string>, suffix: string): string => {
  for (const [p, c] of files) if (p.endsWith(suffix)) return c;
  throw new Error(`no file ending in ${suffix}; have ${[...files.keys()].join(", ")}`);
};

// --- `assign` — the only reader is a saga own-state write. -----------------
const ASSIGN_SRC = `
  system S {
    subdomain C {
      context C {
        aggregate Order {
          status: string
          operation place() { status := "Placed"  emit OrderPlaced { order: id, at: now() } }
        }
        repository Orders for Order {}
        event OrderPlaced { order: Order id, at: datetime }
        channel Lifecycle { carries: OrderPlaced  delivery: broadcast  retention: ephemeral }
        workflow OrderFulfillment {
          orderId: Order id
          attempts: int
          create(p: OrderPlaced) by p.order {
            let bump = 2 + 3
            attempts := bump
          }
        }
      }
    }
    api A from C
    storage pg { type: postgres }
    resource sagaState { for: C, kind: state, use: pg }
    deployable d { platform: python  contexts: [C]  dataSources: [sagaState]  serves: A  port: 4000 }
  }
`;

// --- `domain-service-call` — the only reader is the service call. ----------
const SERVICE_SRC = `system PyMutating {
  subdomain Banking {
    context Banking {
      aggregate Account with crudish {
        holder: string
        balance: decimal
        operation withdraw(amount: decimal) { balance := balance - amount }
        operation deposit(amount: decimal) { balance := balance + amount }
      }
      repository Accounts for Account { }
      domainService Transfer {
        operation run(source: Account, dest: Account, amount: decimal) {
          source.withdraw(amount)
          dest.deposit(amount)
        }
      }
      workflow MoveMoney transactional {
        create(src: Account id, dst: Account id, amount: decimal) {
          let s = Accounts.getById(src)
          let d = Accounts.getById(dst)
          let fee = amount + amount
          Transfer.run(s, d, fee)
        }
      }
    }
  }
  api BankingApi from Banking
  storage pg { type: postgres }
  resource bankingState { for: Banking, kind: state, use: pg }
  deployable api { platform: python  contexts: [Banking]  dataSources: [bankingState]  serves: BankingApi  port: 8000 }
}`;

// --- `repo-delete` — the only reader is the repository delete. -------------
const DELETE_SRC = `system PyDel {
  subdomain C {
    context C {
      aggregate Order with crudish { status: string }
      repository Orders for Order { }
      workflow Purge {
        create(oid: Order id) {
          let target = Orders.getById(oid)
          let doomed = target
          Orders.delete(doomed)
        }
      }
    }
  }
  api A from C
  storage pg { type: postgres }
  resource st { for: C, kind: state, use: pg }
  deployable api { platform: python  contexts: [C]  dataSources: [st]  serves: A  port: 8000 }
}`;

// --- The read-port collector has the SAME statement-kind blind spot. --------
// `collectServiceReadPorts` decides which repositories the route constructs
// for a domain-service call's read-port handles.  A BARE `Audit.record(s, c)`
// statement lowers to `domain-service-call` — the kind the hand-rolled walk
// missed — so its port repo was never constructed while the call site still
// passed the handle.  Only visible when the service reads a repository the
// workflow does NOT read itself; here `Ledgers` is exactly that.
const READ_PORT_SRC = `system PyPorts {
  subdomain Banking {
    context Banking {
      aggregate Account with crudish {
        holder: string
        balance: decimal
        operation deposit(amount: decimal) { balance := balance + amount }
      }
      repository Accounts for Account {
        find byHolder(holder: string): Account? where this.holder == holder
      }
      aggregate Ledger with crudish { code: string }
      repository Ledgers for Ledger {
        find byCode(code: string): Ledger? where this.code == code
      }
      domainService Audit {
        operation record(source: Account, code: string) {
          precondition Ledgers.byCode(code) != null
          source.deposit(1.0)
        }
      }
      workflow Note transactional {
        create(src: Account id, code: string) {
          let s = Accounts.getById(src)
          Audit.record(s, code)
        }
      }
    }
  }
  api BankingApi from Banking
  storage pg { type: postgres }
  resource bankingState { for: Banking, kind: state, use: pg }
  deployable api { platform: python  contexts: [Banking]  dataSources: [bankingState]  serves: BankingApi  port: 8000 }
}`;

describe("python workflow let-liveness — every reader keeps its binding", () => {
  it("a saga own-state `attempts := bump` keeps `bump` bound", async () => {
    const dispatch = fileEndingWith(await generateSystemFiles(ASSIGN_SRC), "app/dispatch.py");
    expect(dispatch).toContain("bump = 2 + 3");
    expect(dispatch).toContain("state.attempts = bump");
    // The bug shape: the binding dropped to a bare RHS statement, leaving the
    // reader pointing at an undefined name.
    expect(dispatch).not.toMatch(/^ +2 \+ 3$/m);
  });

  it("a `domainService` orchestrator call keeps its argument bindings", async () => {
    const wf = fileEndingWith(
      await generateSystemFiles(SERVICE_SRC),
      "app/http/workflows_routes.py",
    );
    expect(wf).toContain("fee = amount + amount");
    expect(wf).toContain("run(s, d, fee)");
    expect(wf).not.toMatch(/^ +amount \+ amount$/m);
  });

  it("a repository delete keeps the binding naming the entity it removes", async () => {
    const wf = fileEndingWith(
      await generateSystemFiles(DELETE_SRC),
      "app/http/workflows_routes.py",
    );
    expect(wf).toContain("doomed = target");
    expect(wf).toContain("await orders.delete(doomed.id)");
    expect(wf).not.toMatch(/^ +target$/m);
  });
});

describe("python workflow service imports — an `assign` RHS is a call site too", () => {
  // `domainServiceImportLinesForWorkflow` (emit/domain-service.ts) had the same
  // hand-enumerated switch with no `assign` arm, so a service called from the
  // RHS of a workflow-state write emitted `quote(base)` with no import.
  const SRC = `system PySvcAssign {
  subdomain C {
    context C {
      aggregate Order { status: string }
      repository Orders for Order {}
      domainService Fee {
        operation quote(base: int): int { return base + 1 }
      }
      workflow Tally {
        total: int
        create(base: int) {
          total := Fee.quote(base)
        }
      }
    }
  }
  api A from C
  storage pg { type: postgres }
  resource st { for: C, kind: state, use: pg }
  deployable d { platform: python  contexts: [C]  dataSources: [st]  serves: A  port: 4000 }
}`;

  it("imports the service fn a workflow-state assignment calls", async () => {
    const wf = fileEndingWith(await generateSystemFiles(SRC), "app/http/workflows_routes.py");
    expect(wf).toContain("quote(base)");
    expect(wf).toContain("from app.domain.services.fee import quote");
  });
});

describe("python workflow read-ports — a BARE domain-service call declares its port", () => {
  it("constructs (and imports) the read-port repo the call site passes", async () => {
    const files = await generateSystemFiles(READ_PORT_SRC);
    const wf = fileEndingWith(files, "app/http/workflows_routes.py");
    // The call site threads the handle…
    expect(wf).toContain("await record(ledgers, s, code)");
    // …so the route must bind it, and the module must import its class —
    // otherwise ruff F821 → runtime NameError on `ledgers`.
    expect(wf).toContain("ledgers = LedgerRepository(session, NoopDomainEventDispatcher())");
    expect(wf).toContain("from app.db.repositories.ledger_repository import LedgerRepository");
  });
});

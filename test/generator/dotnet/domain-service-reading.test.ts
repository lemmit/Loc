// Reading-tier domain services on the .NET / EF Core backend
// (domain-services.md rev. 4, Slice 1).
//
// A `reading` domainService op runs a read-only repository query (lowered to a
// `repo-read` Call).  On .NET / EF it cannot stay a static class — the read
// needs the scoped repository — so the service becomes a DI'd `sealed class`
// with one constructor-injected `I<Aggregate>Repository` per read-port, and the
// orchestrating workflow handler INJECTS the service (the container threads the
// repo) and calls `await _<svc>.<Op>Async(...)`.  A PURE service stays a
// `public static class` and its call site stays the static `Service.Op(...)` —
// byte-identical to pre-rev.4.
//
// The read-port set is DERIVED (not stamped) by `readPortsForOperation`
// (src/ir/util/domain-service-read-ports.ts), shared with the TS trailblazer.

import { describe, expect, it } from "vitest";
import { generateDotnet } from "../../../src/generator/dotnet/index.js";
import { parseValid } from "../../_helpers/parse.js";

// A reading service (`Registration.isEmailAvailable` reads `Accounts.byHolder`),
// a PURE service (`FeeQuote.forAmount`), and a workflow that calls the reading
// service in a precondition.  Avoids the reserved params `from`/`to`.
const SRC = `
  context Banking {
    valueobject Money { amount: decimal currency: string invariant amount >= 0 }
    aggregate Account with crudish { holder: string balance: Money }
    repository Accounts for Account {
      find byHolder(holder: string): Account? where this.holder == holder
    }
    domainService Registration {
      operation isEmailAvailable(holder: string): bool {
        return Accounts.byHolder(holder) == null
      }
    }
    domainService FeeQuote {
      operation forAmount(amount: Money): Money {
        return Money { amount: amount.amount, currency: amount.currency }
      }
    }
    workflow RegisterAccount transactional {
      create(holder: string, balance: Money) {
        precondition Registration.isEmailAvailable(holder)
        let acct = Account.create({ holder: holder, balance: balance })
      }
    }
  }
`;

// A PURE-ONLY system (no reading service) used to pin the byte-identical guard:
// the pure service is a static class, the workflow calls it statically, and
// Program.cs registers no domain service.
const PURE_SRC = `
  context Sales {
    valueobject Money { amount: decimal currency: string invariant amount >= 0 }
    aggregate Cart with crudish { total: Money }
    domainService FeeQuote {
      operation forAmount(amount: Money): Money {
        return Money { amount: amount.amount, currency: amount.currency }
      }
    }
    workflow Recompute transactional {
      create(amount: Money) {
        let q = FeeQuote.forAmount(amount)
        let c = Cart.create({ total: q })
      }
    }
  }
`;

async function files(): Promise<Map<string, string>> {
  return generateDotnet(await parseValid(SRC));
}

describe(".NET generator — reading-tier domainService (domain-services.md rev. 4)", () => {
  it("emits a DI'd sealed class with a constructor-injected repository per read-port", async () => {
    const svc = (await files()).get("Domain/Services/Registration.cs");
    expect(svc).toBeDefined();
    // Sealed class, NOT static — EF read needs the scoped repository.
    expect(svc!).toMatch(/public sealed class Registration/);
    expect(svc!).not.toMatch(/public static class Registration/);
    // One injected I<Aggregate>Repository per read-port + a constructor.
    expect(svc!).toMatch(/private readonly IAccountRepository _accounts;/);
    expect(svc!).toMatch(/public Registration\(IAccountRepository accounts\)/);
    expect(svc!).toMatch(/_accounts = accounts;/);
    // The repository interface namespace is imported.
    expect(svc!).toMatch(/using \w+\.Domain\.Accounts;/);
  });

  it("renders the repo-read against the injected handle in an async Task method", async () => {
    const svc = (await files()).get("Domain/Services/Registration.cs")!;
    // Reading op → `public async Task<bool>` + a trailing CancellationToken,
    // method name carries the .NET `Async` suffix.
    expect(svc).toMatch(
      /public async Task<bool> IsEmailAvailableAsync\(string holder, CancellationToken cancellationToken = default\)/,
    );
    // The `repo-read` Call (`Accounts.byHolder(holder)`) renders against the
    // injected `_accounts` field — the real repository method `ByHolder`, awaited.
    expect(svc).toMatch(/\(await _accounts\.ByHolder\(holder, cancellationToken\)\) == null/);
  });

  it("injects the reading SERVICE into the workflow handler and calls it via the instance", async () => {
    const handler = (await files()).get("Application/Workflows/RegisterAccountHandler.cs");
    expect(handler).toBeDefined();
    // The handler injects the reading service (the container threads the repo) —
    // NOT a positionally-passed read-port handle.
    expect(handler!).toMatch(/private readonly Registration _registration;/);
    expect(handler!).toMatch(/Registration registration\)/);
    expect(handler!).toMatch(/_registration = registration;/);
    // Call site routes through the injected instance + async method, awaited,
    // with the handler's cancellationToken threaded through.
    expect(handler!).toMatch(
      /await _registration\.IsEmailAvailableAsync\(command\.Holder, cancellationToken\)/,
    );
    // It must NOT fall back to the static pure-service call shape.
    expect(handler!).not.toMatch(/Registration\.IsEmailAvailable\(/);
  });

  it("registers the reading service in Program.cs DI", async () => {
    const program = (await files()).get("Program.cs");
    expect(program).toBeDefined();
    expect(program!).toMatch(
      /builder\.Services\.AddScoped<\w+\.Domain\.Services\.Registration>\(\);/,
    );
  });

  it("keeps a PURE service a static class with a static, un-awaited call site (byte-identical)", async () => {
    const svc = (await files()).get("Domain/Services/FeeQuote.cs")!;
    // The pure service in the SAME context is unchanged — static class, static method.
    expect(svc).toMatch(/public static class FeeQuote/);
    expect(svc).toMatch(/public static Money ForAmount\(Money amount\)/);
    expect(svc).not.toMatch(/private readonly/);
    expect(svc).not.toMatch(/public FeeQuote\(/);

    // A PURE-ONLY system: the pure call stays the static `Service.Op(...)` form,
    // no service is injected, and Program.cs registers no domain service.
    const pure = await generateDotnet(await parseValid(PURE_SRC));
    const pureSvc = pure.get("Domain/Services/FeeQuote.cs")!;
    expect(pureSvc).toMatch(/public static class FeeQuote/);
    const handler = pure.get("Application/Workflows/RecomputeHandler.cs")!;
    expect(handler).toMatch(/var q = FeeQuote\.ForAmount\(command\.Amount\);/);
    expect(handler).not.toMatch(/_feeQuote/);
    expect(handler).not.toMatch(/await FeeQuote/);
    const program = pure.get("Program.cs")!;
    expect(program).not.toMatch(/AddScoped<\w+\.Domain\.Services\./);
  });
});

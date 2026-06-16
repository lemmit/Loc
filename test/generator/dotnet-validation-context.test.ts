// Regression: the .NET ValidationBehavior must not share one ValidationContext
// across validators run concurrently.
//
// It built a single `ctx = new ValidationContext<TRequest>(message)` and then
// `Task.WhenAll(_validators.Select(v => v.ValidateAsync(ctx, …)))` — concurrent
// ValidateAsync calls on the SAME context.  FluentValidation's
// ValidationContext is not thread-safe (mutable RootContextData / property
// chain), so this is a latent data race the moment a command has more than one
// registered validator (benign today with exactly one each).  Each validator
// must get its own context.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/index.js";

const SRC = `
system Acme {
  subdomain Sales {
    context S {
      aggregate Order {
        sku: string
        check sku.length > 0
      }
      repository Orders for Order { }
    }
  }
  api SalesApi from Sales
  storage primarySql { type: postgres }
  resource sState { for: S, kind: state, use: primarySql }
  deployable api {
    platform: dotnet
    contexts: [S]
    dataSources: [sState]
    serves: SalesApi
    port: 8080
  }
}
`;

describe("dotnet ValidationBehavior — per-validator context (no shared race)", () => {
  it("constructs a fresh ValidationContext inside the per-validator select, not once outside", async () => {
    const files = await generateSystemFiles(SRC);
    const vb = [...files.entries()].find(([p]) => p.endsWith("ValidationBehavior.cs"))?.[1];
    expect(vb, "ValidationBehavior.cs").toBeDefined();
    // Each validator gets its own context (constructed in the projection).
    expect(vb).toMatch(
      /_validators\.Select\(v => v\.ValidateAsync\(new ValidationContext<TRequest>\(message\), cancellationToken\)\)/,
    );
    // The shared-context form must be gone.
    expect(vb).not.toMatch(/var ctx = new ValidationContext<TRequest>\(message\);/);
  });
});

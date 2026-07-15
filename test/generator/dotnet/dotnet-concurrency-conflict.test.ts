// ---------------------------------------------------------------------------
// .NET / ASP.NET + EF Core backend — the `versioned` capability maps the
// version property as an EF concurrency token (`.IsConcurrencyToken()`,
// Hibernate-style write-time optimistic lock).  A think-time CAS threads the
// client's `If-Match` header through the ambient `RequestContext` into the EF
// `OriginalValue`; a `DbUpdateConcurrencyException` maps to 409 Conflict.  A
// NON-versioned aggregate is byte-identical — gated on `aggregateIsVersioned`.
//
// Sibling of dotnet-unique-conflict.test.ts (the 23505 → 409 mapping).
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const dotnetSystem = (cap: string) => `
  system Shop {
    subdomain Sales {
      context Ordering {
        aggregate Customer ${cap} {
          email: string
          name: string
          operation update(newName: string) { name := newName }
        }
        repository Customers for Customer { }
      }
    }
    api SalesApi from Sales
    storage primarySql { type: postgres }
    resource ordState { for: Ordering, kind: state, use: primarySql }
    deployable api {
      platform: dotnet
      contexts: [Ordering]
      dataSources: [ordState]
      serves: SalesApi
      port: 8081
    }
  }
`;

describe(".NET generator — versioned optimistic-concurrency", () => {
  it("EF configuration maps the version property as a concurrency token", async () => {
    const cfg = (await generateSystemFiles(dotnetSystem("with versioned"))).get(
      "api/Infrastructure/Persistence/Configurations/CustomerConfiguration.cs",
    )!;
    expect(cfg, "CustomerConfiguration.cs missing").toBeTruthy();
    expect(cfg).toContain(
      'builder.Property(x => x.Version).HasColumnName("version").IsConcurrencyToken();',
    );
  });

  it("repository sets the EF OriginalValue from the client's expected version", async () => {
    const repo = (await generateSystemFiles(dotnetSystem("with versioned"))).get(
      "api/Infrastructure/Repositories/CustomerRepository.cs",
    )!;
    expect(repo).toContain("var __version = entry.Property(x => x.Version);");
    expect(repo).toContain("var __expected = RequestContext.Current?.ExpectedVersion;");
    expect(repo).toContain("if (__expected.HasValue) __version.OriginalValue = __expected.Value;");
    expect(repo).toContain("__version.CurrentValue = __version.OriginalValue + 1;");
  });

  it("If-Match middleware populates the ambient RequestContext expected version", async () => {
    const files = await generateSystemFiles(dotnetSystem("with versioned"));
    const ctx = files.get("api/Domain/Common/RequestContext.cs")!;
    const mw = files.get("api/Middleware/RequestContextMiddleware.cs")!;
    expect(ctx).toContain("public int? ExpectedVersion { get; set; }");
    expect(mw).toContain('ctx.Request.Headers.TryGetValue("If-Match", out var __ifMatch)');
    expect(mw).toContain("rootFrame.ExpectedVersion = __expectedVersion;");
  });

  it("DomainExceptionFilter maps DbUpdateConcurrencyException to 409 Conflict", async () => {
    const filter = (await generateSystemFiles(dotnetSystem("with versioned"))).get(
      "api/Api/DomainExceptionFilter.cs",
    )!;
    expect(filter).toContain(
      "if (context.Exception is Microsoft.EntityFrameworkCore.DbUpdateConcurrencyException)",
    );
    expect(filter).toContain(
      'context.Result = Problem(context, 409, "Conflict", "The resource was modified by another request; reload and retry.", trace_id);',
    );
  });

  // Cross-backend parity: the other four backends (Hono / Python / Java /
  // Phoenix) log a DISTINCT `conflict` catalog event on the 409 so a dashboard
  // can separate an optimistic-concurrency conflict from a `when`-gate / unique
  // `disallowed`.  The .NET filter currently logs `"disallowed"` for the
  // concurrency arm — an inconsistency with the spec ("409 emits a distinct
  // `conflict` catalog event") and with parity.  Asserted at spec intent, so a
  // failure flags the divergence rather than freezing it.
  it("logs a distinct `conflict` catalog event on the 409 (parity with other backends)", async () => {
    const filter = (await generateSystemFiles(dotnetSystem("with versioned"))).get(
      "api/Api/DomainExceptionFilter.cs",
    )!;
    // The concurrency arm's LogWarning line — isolate it and assert its event.
    const concurrencyArm = filter
      .split("\n")
      .filter((l) => l.includes("The resource was modified by another request"))
      .join("\n");
    expect(concurrencyArm).toContain('"conflict"');
  });

  // Versioning is default-on (M-T3.4): a plain aggregate with no `with versioned`
  // clause gets the same optimistic-concurrency token wiring as the explicit one.
  // (The old "byte-identical, no concurrency token" opt-out premise no longer
  // exists — there is no way to turn versioning off on a relational aggregate.)
  it("a plain aggregate is versioned by default (concurrency token present)", async () => {
    const files = await generateSystemFiles(dotnetSystem(""));
    const cfg = files.get(
      "api/Infrastructure/Persistence/Configurations/CustomerConfiguration.cs",
    )!;
    const repo = files.get("api/Infrastructure/Repositories/CustomerRepository.cs")!;
    const filter = files.get("api/Api/DomainExceptionFilter.cs")!;
    expect(cfg).toContain(
      'builder.Property(x => x.Version).HasColumnName("version").IsConcurrencyToken();',
    );
    expect(repo).toContain("var __expected = RequestContext.Current?.ExpectedVersion;");
    expect(repo).toContain("if (__expected.HasValue) __version.OriginalValue = __expected.Value;");
    expect(filter).toContain(
      "if (context.Exception is Microsoft.EntityFrameworkCore.DbUpdateConcurrencyException)",
    );
  });
});

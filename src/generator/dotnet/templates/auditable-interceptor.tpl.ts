import { lines } from "../../../util/code-builder.js";

// EF Core SaveChangesInterceptor that stamps audit fields on every
// IAuditable entity tracked by the change tracker.  One interceptor
// per DbContext, not per aggregate — adding `with auditable` to N
// aggregates emits the same interceptor regardless of N.
//
// Current-user resolution: the interceptor optionally pulls
// ICurrentUserAccessor from the service provider when the deployable
// opts into auth.  Without it, audit columns get Guid.Empty as the
// system-user sentinel.  Wrapped in try/catch so a missing accessor
// never breaks SaveChanges.

export function renderAuditableInterceptor(ns: string, hasAuth: boolean): string {
  const accessorImport = hasAuth ? `using ${ns}.Auth;` : null;
  const userExpr = hasAuth
    ? "GetCurrentUserId(eventData.Context)"
    : "new UserId(Guid.Empty)";
  return (
    lines(
      "// Auto-generated.",
      "using Microsoft.EntityFrameworkCore;",
      "using Microsoft.EntityFrameworkCore.Diagnostics;",
      hasAuth ? "using Microsoft.EntityFrameworkCore.Infrastructure;" : null,
      `using ${ns}.Domain.Common;`,
      `using ${ns}.Domain.Ids;`,
      accessorImport,
      "",
      `namespace ${ns}.Infrastructure.Persistence;`,
      "",
      "public sealed class AuditableInterceptor : SaveChangesInterceptor",
      "{",
      "    public override InterceptionResult<int> SavingChanges(",
      "        DbContextEventData eventData,",
      "        InterceptionResult<int> result)",
      "    {",
      "        Stamp(eventData);",
      "        return base.SavingChanges(eventData, result);",
      "    }",
      "",
      "    public override ValueTask<InterceptionResult<int>> SavingChangesAsync(",
      "        DbContextEventData eventData,",
      "        InterceptionResult<int> result,",
      "        CancellationToken cancellationToken = default)",
      "    {",
      "        Stamp(eventData);",
      "        return base.SavingChangesAsync(eventData, result, cancellationToken);",
      "    }",
      "",
      "    private void Stamp(DbContextEventData eventData)",
      "    {",
      "        var ctx = eventData.Context;",
      "        if (ctx is null) return;",
      "        var now = DateTime.UtcNow;",
      `        var who = ${userExpr};`,
      "        foreach (var entry in ctx.ChangeTracker.Entries<IAuditable>())",
      "        {",
      "            if (entry.State == EntityState.Added)",
      "            {",
      "                entry.Entity.CreatedAt = now;",
      "                entry.Entity.CreatedBy = who;",
      "            }",
      "            if (entry.State == EntityState.Added || entry.State == EntityState.Modified)",
      "            {",
      "                entry.Entity.UpdatedAt = now;",
      "                entry.Entity.UpdatedBy = who;",
      "            }",
      "        }",
      "    }",
      hasAuth ? renderUserResolutionHelper(ns) : null,
      "}",
    ) + "\n"
  );
}

function renderUserResolutionHelper(ns: string): string {
  // Reach into the active DI scope via the DbContext's GetService
  // extension.  If ICurrentUserAccessor isn't resolvable (background
  // job, migration, anonymous request), fall back to the sentinel
  // empty UserId — better than throwing inside SaveChanges.
  return lines(
    "",
    "    private static UserId GetCurrentUserId(DbContext? ctx)",
    "    {",
    "        if (ctx is null) return new UserId(Guid.Empty);",
    "        try",
    "        {",
    "            var accessor = ctx.GetService<ICurrentUserAccessor>();",
    "            var rawId = accessor?.User?.Id;",
    "            if (rawId is null) return new UserId(Guid.Empty);",
    "            return Guid.TryParse(rawId.ToString(), out var g)",
    "                ? new UserId(g)",
    "                : new UserId(Guid.Empty);",
    "        }",
    "        catch",
    "        {",
    "            return new UserId(Guid.Empty);",
    "        }",
    "    }",
  );
}

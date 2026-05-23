import { lines } from "../../../util/code-builder.js";

// Capability interfaces emitted into Domain/Common/.  Each is
// emitted only when at least one aggregate in the .NET output set
// has the corresponding flag — keeps the generated tree free of
// unused marker types.  See `src/generator/dotnet/index.ts` for the
// gating logic.

export function renderIAuditable(ns: string): string {
  return (
    lines(
      "// Auto-generated.",
      `namespace ${ns}.Domain.Common;`,
      "",
      "/// <summary>Aggregates that participate in audit-field stamping",
      "/// (createdAt/updatedAt/createdBy/updatedBy).  Generators emit one",
      "/// SaveChangesInterceptor that scans the change tracker for entities",
      "/// implementing this interface and writes the audit columns once per",
      "/// SaveChanges call — no per-aggregate persistence code.</summary>",
      "public interface IAuditable",
      "{",
      "    DateTime CreatedAt { get; set; }",
      "    DateTime UpdatedAt { get; set; }",
      "    UserId CreatedBy { get; set; }",
      "    UserId UpdatedBy { get; set; }",
      "}",
    ) + "\n"
  );
}

export function renderISoftDeletable(ns: string, field: string, timestamp: string): string {
  // The interface always names IsDeleted/DeletedAt regardless of
  // the flag's customizable field/timestamp names — the macro lets
  // users pick column-level naming for their schema, but the
  // .NET-facing capability interface stays canonical so the
  // shared persistence hook is independent of project naming.
  // Field/timestamp are mapped to the user-chosen names in the
  // entity configuration's HasColumnName clauses (added separately).
  void field;
  void timestamp;
  return (
    lines(
      "// Auto-generated.",
      `namespace ${ns}.Domain.Common;`,
      "",
      "/// <summary>Aggregates that support soft-delete semantics.  The DbContext",
      "/// applies a global query filter so soft-deleted rows are excluded from",
      "/// default reads.</summary>",
      "public interface ISoftDeletable",
      "{",
      "    bool IsDeleted { get; set; }",
      "    DateTime? DeletedAt { get; set; }",
      "}",
    ) + "\n"
  );
}

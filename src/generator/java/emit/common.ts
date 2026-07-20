// ---------------------------------------------------------------------------
// Shared domain types for the Java emission: exception classes (one public
// class per file — Java's rule) + the DomainEvent marker interface.
// ---------------------------------------------------------------------------

import { lines } from "../../../util/code-builder.js";

export function renderDomainException(basePkg: string): string {
  return lines(
    `package ${basePkg}.domain.common;`,
    ``,
    `/** Domain-rule violation (preconditions, invariants) — maps to HTTP 400. */`,
    `public class DomainException extends RuntimeException {`,
    `    public DomainException(String message) {`,
    `        super(message);`,
    `    }`,
    `}`,
    ``,
  );
}

export function renderForbiddenException(basePkg: string): string {
  return lines(
    `package ${basePkg}.domain.common;`,
    ``,
    `/**`,
    ` * Authorization failure — raised by {@code requires} expressions when the`,
    ` * resolved currentUser doesn't satisfy the gate.  Maps to HTTP 403,`,
    ` * distinct from DomainException's 400.`,
    ` */`,
    `public class ForbiddenException extends RuntimeException {`,
    `    public ForbiddenException(String message) {`,
    `        super(message);`,
    `    }`,
    `}`,
    ``,
  );
}

export function renderDisallowedException(basePkg: string): string {
  return lines(
    `package ${basePkg}.domain.common;`,
    ``,
    `/**`,
    ` * Operation state-gate failure — raised when a {@code when} predicate is`,
    ` * false at the call site, so the command is disallowed in the aggregate's`,
    ` * current state (criterion.md, use site 2).  Maps to HTTP 409 (Conflict),`,
    ` * distinct from DomainException's 400.`,
    ` */`,
    `public class DisallowedException extends RuntimeException {`,
    `    public DisallowedException(String message) {`,
    `        super(message);`,
    `    }`,
    `}`,
    ``,
  );
}

export function renderAggregateNotFoundException(basePkg: string): string {
  return lines(
    `package ${basePkg}.domain.common;`,
    ``,
    `/** Lookup miss on a getById-style read — maps to HTTP 404. */`,
    `public class AggregateNotFoundException extends RuntimeException {`,
    `    public AggregateNotFoundException(String message) {`,
    `        super(message);`,
    `    }`,
    `}`,
    ``,
  );
}

export function renderPagedRecord(basePkg: string): string {
  return lines(
    `package ${basePkg}.domain.common;`,
    ``,
    `import java.util.List;`,
    ``,
    `/** Cross-backend paged envelope — items/page/pageSize/total/totalPages`,
    ` *  (1-based page), identical wire shape on every backend. */`,
    `public record Paged<T>(List<T> items, int page, int pageSize, int total, int totalPages) {`,
    `}`,
    ``,
  );
}

/** Pure marker interface for aggregates carrying lifecycle-stamp audit
 *  columns (`with auditable` / a context `stamp`).  Zero members — runtime
 *  type identity only; the JPA auditing wiring keys off the field annotations
 *  + AuditingEntityListener, not this interface, but it gives a documented
 *  join point and a single readable "this aggregate is audited" signal.
 *  See §5a of docs/old/plans/capability-stamp-dedup-simulation.md. */
export function renderAuditableInterface(basePkg: string): string {
  return lines(
    `package ${basePkg}.domain.common;`,
    ``,
    `/** Pure tag: this aggregate carries audit columns. Zero members. */`,
    `public interface Auditable {`,
    `}`,
    ``,
  );
}

export function renderDomainEventInterface(basePkg: string): string {
  return lines(
    `package ${basePkg}.domain.events;`,
    ``,
    `/** Marker for domain events recorded by aggregates and drained via pullEvents(). */`,
    `public interface DomainEvent {`,
    `}`,
    ``,
  );
}

/** Package marker — keeps `import <pkg>.*;` wildcard imports valid even
 *  when a deployable's contexts contribute no types to the package (the
 *  Java analog of the dotnet `_namespace.cs` markers). */
export function renderPackageMarker(pkg: string): string {
  return lines(
    `package ${pkg};`,
    ``,
    `/** Auto-generated package marker — keeps wildcard imports of this package valid. */`,
    `public final class _Namespace {`,
    `    private _Namespace() {`,
    `    }`,
    `}`,
    ``,
  );
}
